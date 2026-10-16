/**
 * Gemini Agent 内核（Vertex AI · Hack2skill 赛用替换层）
 *
 * 背景（见 AI-Builder-Cup-2026-改装方案 §3/§4）：
 *   将 AI 内核从 tencent Agent SDK 切换为 Gemini function calling，
 *   但对上层保持 callAgent 的签名与 CallAgentResult 返回结构不变，
 *   使 index.ts（web/embed）与 channels.ts（email/im）零改动。
 *
 * 设计要点：
 *   - 零新依赖：原生 fetch 调 Vertex AI generateContent；服务账号 JWT 用 node:crypto 自签，
 *     不引入 @google-cloud/* 重依赖（Cloud Build 更快、镜像更小）；
 *   - 三档鉴权：GEMINI_API_KEY（API Key 模式）> GOOGLE_APPLICATION_CREDENTIALS（SA JSON）>
 *     Cloud Run 默认服务账号（metadata server）；
 *   - function calling 循环 ≤5 轮硬上限（方案 §10 风险对策）；参数校验失败回灌错误让模型自修复；
 *   - 工具执行复用 agentTools.createCsaAgentTools 的 handler 与 captured 机制，
 *     create_ticket 仅在 allowCreateTicket 时声明（与 SDK 路径的渠道能力差异铁律一致）；
 *   - 失败降级知识库直答（retrieveRag → HIT_THRESHOLD），与 SDK 不可用时的既有降级等价。
 */
import { HANDOFF_TOKEN } from './handoff.js';
import { logger } from './logger.js';
import { HIT_THRESHOLD } from './knowledge.js';
import { retrieveRag } from './rag.js';
import { createCsaAgentTools, type CsaToolCaptured } from './agentTools.js';
import { getResolvedConfig, getGeminiConfig } from './llmConfig.js';
import { authHeaders, googleAuthMode } from './googleAuth.js';
import type { CallAgentOptions, CallAgentResult } from './agentCore.js';

/* ============================ 常量 ============================ */

/** function calling 循环硬上限（方案 §10：≤5 轮） */
const MAX_ROUNDS = 5;

/** functionDeclarations：与 agentTools.ts 的 zod schema 手写对应（方案 §3） */
const FUNCTION_DECLARATIONS: Array<{
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}> = [
  {
    name: 'search_knowledge',
    description:
      '检索客服知识库（FAQ 标准答案）。当用户问题需要依据政策条款、退换货/物流/技术处理流程等标准答案时调用。返回匹配问题与标准答案文本。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户的检索问句' },
        intent: {
          type: 'string',
          description: '可选：已识别的业务意图（refund/order_query/tech_support/complaint 等），用于提升检索精度',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_order',
    description: '实时查询订单状态、物流与售后信息。当用户提供订单号并询问物流、发货、退换货进度时调用。返回订单上下文文本。',
    parameters: {
      type: 'object',
      properties: { orderNo: { type: 'string', description: '订单号，如 SO2026...' } },
      required: ['orderNo'],
    },
  },
  {
    name: 'get_customer',
    description: '查询客户长期画像（企业、行业、等级、历史接触、偏好）。用于个性化服务。仅当已知 customerId 且对服务有必要时调用。',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string', description: '客户标识（customer_id）' } },
      required: ['customerId'],
    },
  },
  {
    name: 'create_ticket',
    description: '创建工单并转人工。当判断问题超出自助处理范围、客户要求投诉/索赔/升级、或需要人工跟进时调用。自动计算优先级、SLA 与坐席分配。',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '业务意图（refund/order_query/tech_support/complaint/human_service 等）' },
        summary: { type: 'string', description: '工单摘要（用户诉求的简要描述）' },
        reason: { type: 'string', description: '建单原因 / 触发规则' },
        priority: {
          type: 'string',
          description: '可选：显式优先级；缺省由系统综合客户等级 / 意图 / 情绪计算',
          enum: ['low', 'medium', 'high', 'urgent'],
        },
      },
      required: ['intent', 'summary', 'reason'],
    },
  },
];

/** 每个工具的必填参数（用于参数校验 + 自修复） */
const REQUIRED_ARGS: Record<string, string[]> = {
  search_knowledge: ['query'],
  query_order: ['orderNo'],
  get_customer: ['customerId'],
  create_ticket: ['intent', 'summary', 'reason'],
};

/* ============================ 鉴权（三档，见 googleAuth.ts） ============================ */

/** 是否配置了 Gemini 引擎（agentCore 路由依据） */
export function geminiConfigured(): boolean {
  const p = (process.env.AGENT_PROVIDER || 'auto').toLowerCase();
  if (p === 'tencent') return false;
  if (p === 'gemini') return true;
  return googleAuthMode() !== 'none';
}

/* ============================ 韧性 fetch（重试 + 限流降级，方案 §8 D5） ============================ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带重试的 fetch：对网络抖动、5xx、429（限流）做有限次退避重试；
 * 重试耗尽仍失败则抛出，由调用方走知识库直答降级（与 SDK 路径一致）。
 * 每次尝试独立 AbortSignal 超时，避免单轮卡死。
 */
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      // 可重试：服务端错误 / 限流
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`GEMINI_HTTP_${r.status}`);
        if (attempt < maxAttempts) {
          logger.warn(`[geminiAgent] 第 ${attempt} 次调用返回 ${r.status}，退避重试`);
          await sleep(300 * attempt);
          continue;
        }
        return r; // 返回最后响应，交由上层按错误处理
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        logger.warn(`[geminiAgent] 第 ${attempt} 次调用异常（${String((e as any)?.message || e).slice(0, 80)}），退避重试`);
        await sleep(300 * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

/* ============================ 端点构造 ============================ */

function baseUrl(): string {
  const override = process.env.GEMINI_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  if (process.env.GEMINI_API_KEY) return 'https://generativelanguage.googleapis.com/v1beta';
  const loc = process.env.GEMINI_LOCATION || 'global';
  return `https://${loc}-aiplatform.googleapis.com/v1`;
}

function generateContentUrl(model: string): string {
  const base = baseUrl();
  if (process.env.GEMINI_BASE_URL || process.env.GEMINI_API_KEY) {
    return `${base}/models/${model}:generateContent`;
  }
  const project = process.env.GCP_PROJECT;
  const loc = process.env.GEMINI_LOCATION || 'global';
  return `${base}/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
}

/** 从 usageMetadata 提取有限数字（null/''/NaN 一律 undefined） */
function numOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/* ============================ 工具参数校验（自修复） ============================ */

/** 校验模型给出的工具参数；返回 null 表示通过，否则返回给模型自修复的错误描述 */
function validateToolArgs(name: string, args: unknown): string | null {
  const required = REQUIRED_ARGS[name];
  if (!required) return `未知工具 ${name}，可用工具：${Object.keys(REQUIRED_ARGS).join('/')}`;
  if (!args || typeof args !== 'object') return `参数必须为 JSON 对象（收到 ${typeof args}）`;
  const obj = args as Record<string, unknown>;
  const missing = required.filter((k) => typeof obj[k] !== 'string' || !(obj[k] as string).trim());
  if (missing.length) {
    const list = missing.join(', ');
    return `缺少必填参数：${list}（必须为非空字符串）`;
  }
  if (name === 'create_ticket' && obj.priority !== undefined) {
    const ok = ['low', 'medium', 'high', 'urgent'].includes(String(obj.priority));
    if (!ok) return `priority 仅支持 low/medium/high/urgent（收到 ${String(obj.priority)}）`;
  }
  return null;
}

/** 执行工具（复用 agentTools handler，captured 副作用原样回传） */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  bundle: ReturnType<typeof createCsaAgentTools> | null,
): Promise<string> {
  if (!bundle) return '工具调用当前不可用。';
  const t = bundle.tools.find((x) => x.name === name);
  if (!t) return `工具 ${name} 当前不可用。`;
  const r: any = await t.handler(args);
  if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text ?? '').join('\n').trim();
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/* ============================ 知识库直答降级 ============================ */

/** Gemini 不可用/失败时的降级：与 SDK 不可用时的既有降级等价（知识库直答） */
async function knowledgeFallback(opts: CallAgentOptions, reason: string): Promise<CallAgentResult> {
  logger.warn(`[geminiAgent] ${reason}，降级知识库直答`);
  const hits = await retrieveRag(opts.prompt, null, 3, {}, 'agent');
  const top = hits[0];
  if (top && top.score >= HIT_THRESHOLD) {
    const related = hits.slice(1).filter((h) => h.score >= 0.18);
    let text = top.answer;
    if (related.length) text += '\n您可能还想了解：\n' + related.map((h) => `· ${h.question}`).join('\n');
    const captured: CsaToolCaptured | undefined = opts.toolCtx ? { toolCalls: [], tickets: [] } : undefined;
    return { text, usedModel: 'knowledge_base', captured };
  }
  throw new Error(`GEMINI_UNAVAILABLE:${reason}`);
}

/** 供多协议直连接入层（llmProviders.ts）复用的知识库直答降级 */
export { knowledgeFallback };

/* ============================ 主入口：Gemini function calling 循环 ============================ */

/**
 * 以 Gemini 引擎执行一次 Agent 调用（签名与返回结构与 SDK 路径一致）。
 * 未配置 Gemini 时直接走知识库直答降级；调用失败（超时/限流/空响应）同样降级。
 */
export async function callAgentGemini(opts: CallAgentOptions): Promise<CallAgentResult> {
  if (!geminiConfigured()) return knowledgeFallback(opts, 'Gemini 未配置');
  const cfg = getResolvedConfig();
  const g = getGeminiConfig();
  const model = g.model || 'gemini-2.5-flash';
  const bundle = opts.toolCtx ? createCsaAgentTools(opts.toolCtx) : null;
  const declarations = FUNCTION_DECLARATIONS.filter((d) => !bundle || bundle.tools.some((t) => t.name === d.name));
  const url = generateContentUrl(model);

  try {
    const headers = await authHeaders();
    const contents: any[] = [{ role: 'user', parts: [{ text: opts.prompt }] }];
    const body = (extraTools: boolean) => ({
      contents,
      systemInstruction: { parts: [{ text: g.systemPrompt || opts.systemPrompt }] },
      generationConfig: {
        temperature: g.temperature,
        maxOutputTokens: 2048,
      },
      ...(extraTools && declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    });

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body(true)),
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        throw new Error(`GEMINI_HTTP_${resp.status}: ${detail}`);
      }
      const j = (await resp.json()) as any;
      const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
      const fnCalls = parts.filter((p) => p?.functionCall);
      const texts = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text as string);

      if (!fnCalls.length) {
        const text = texts.join('').trim();
        if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');
        // 应用层硬截断（与 SDK 路径一致；含转人工标记时不截断）
        const limit = cfg.maxReplyLength;
        let final = text;
        if (limit > 0 && final.length > limit && !final.includes(HANDOFF_TOKEN)) {
          final = final.slice(0, limit) + '…';
        }
        return {
          text: final,
          usedModel: `gemini:${model}`,
          captured: bundle?.captured,
          usage: {
            promptTokens: numOrUndef(j?.usageMetadata?.promptTokenCount),
            completionTokens: numOrUndef(j?.usageMetadata?.candidatesTokenCount),
          },
        };
      }

      // 有工具调用：模型回合入列，逐个执行并把 functionResponse 回灌
      contents.push({ role: 'model', parts });
      const responses: any[] = [];
      for (const fc of fnCalls) {
        const name = String(fc.functionCall?.name || '');
        const args = fc.functionCall?.args ?? {};
        const invalid = validateToolArgs(name, args);
        if (invalid) {
          logger.warn(`[geminiAgent] 工具参数校验失败(${name})，回灌错误让模型自修复：${invalid}`);
          responses.push({ functionResponse: { name, response: { error: invalid, hint: '请修正参数后重新调用该工具' } } });
          continue;
        }
        let out: string;
        try {
          out = await executeTool(name, args as Record<string, unknown>, bundle!);
        } catch (e: any) {
          out = `工具执行失败：${String(e?.message || e).slice(0, 160)}`;
        }
        responses.push({ functionResponse: { name, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: responses });
    }

    // 达到 ≤5 轮硬上限仍有工具调用：按方案 §10 降级知识库直答
    return knowledgeFallback(opts, `Gemini 工具循环超过 ${MAX_ROUNDS} 轮上限`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 已建单等副作用不受降级影响（captured 由 bundle 持有，调用方仍可从 bundle 读）——
    // 但为保持与 SDK 路径一致的返回结构，降级时丢失文本外的 captured，由调用方兜底。
    if (bundle?.captured.tickets.length) {
      logger.warn(`[geminiAgent] 调用失败但已建单 ${bundle.captured.tickets.length} 张，保留副作用返回`);
      return { text: '', usedModel: `gemini:${model}`, captured: bundle.captured };
    }
    return knowledgeFallback(opts, msg.slice(0, 160));
  }
}
