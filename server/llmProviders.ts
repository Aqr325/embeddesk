/**
 * 多协议大模型直连接入层（Hack2skill 改装方案 §5：可接入多种协议端点）
 *
 * 目标：管理后台「模型配置」按 WorkBuddy 式方案接入——供应商预设（仅 OpenAI 兼容协议 API）、
 *   - discoverModels：填入接口地址后自动探测该端点可用模型列表（前端下拉自动填充）；
 *   - testProviderConnection：保存前用「表单当前值」做最小真实请求，即「测试连接」；
 *   - callOpenAiCompatible / callAnthropic：原生 fetch 直连生成（含 function calling 工具循环，
 *     受高级配置「工具调用 / 输入输出 Tokens / 思考模式」开关控制），
 *     与 geminiAgent.callAgentGemini 保持 CallAgentResult 同构，失败时降级知识库直答。
 *
 * 设计要点：
 *   - 零新依赖：复用原生 fetch（超时 + 5xx/429 退避重试），工具执行复用 agentTools；
 *   - 工具集与 agentTools.ts / geminiAgent.ts 保持一致（4 个客服领域工具）；
 *   - 接口地址归一化：完整 URL（…/chat/completions）/ 版本层级（…/v1）/ 根地址均可；
 *   - 应用层硬截断 + 转人工标记保护，与 SDK / Gemini 路径一致；
 *   - 降级复用 geminiAgent.knowledgeFallback，保证无 hit 时行为一致（抛错交由调用方链决定）。
 */
import { HANDOFF_TOKEN } from './handoff.js';
import { logger } from './logger.js';
import { createCsaAgentTools, type CsaToolCaptured } from './agentTools.js';
import { getResolvedConfig, type ProviderId } from './llmConfig.js';
import { knowledgeFallback } from './geminiAgent.js';
import type { CallAgentOptions, CallAgentResult } from './agentCore.js';

/* ============================ 常量 ============================ */

/** 工具循环硬上限（与 geminiAgent 一致，≤5 轮） */
const MAX_ROUNDS = 5;
/** 单次 HTTP 超时 */
const CALL_TIMEOUT_MS = 20000;

/* ============================ 工具声明（OpenAI / Anthropic 共用 JSON Schema） ============================ */

/** 与 agentTools.ts 的 zod schema、geminiAgent.FUNCTION_DECLARATIONS 手写对应 */
const CSA_TOOL_DEFS: Array<{
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
        intent: { type: 'string', description: '可选：已识别的业务意图（refund/order_query/tech_support/complaint 等）' },
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

/** 每个工具的必填参数（参数校验 + 自修复） */
const REQUIRED_ARGS: Record<string, string[]> = {
  search_knowledge: ['query'],
  query_order: ['orderNo'],
  get_customer: ['customerId'],
  create_ticket: ['intent', 'summary', 'reason'],
};

/** 探测时直接排除的非对话类模型 id 关键词（embedding / 音频 / 图像等） */
const NON_CHAT_KEYWORDS = ['embedding', 'tts', 'whisper', 'audio', 'transcribe', 'image', 'dall', 'realtime', 'moderation', 'instruct', 'rerank', 'reranking'];

/** Anthropic 无公开模型列表接口，探测返回官方已知模型清单 */
const ANTHROPIC_KNOWN = [
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
];

/* ============================ 工具参数校验 + 执行 ============================ */

function validateToolArgs(name: string, args: unknown): string | null {
  const required = REQUIRED_ARGS[name];
  if (!required) return `未知工具 ${name}，可用工具：${Object.keys(REQUIRED_ARGS).join('/')}`;
  if (!args || typeof args !== 'object') return `参数必须为 JSON 对象（收到 ${typeof args}）`;
  const obj = args as Record<string, unknown>;
  const missing = required.filter((k) => typeof obj[k] !== 'string' || !(obj[k] as string).trim());
  if (missing.length) return `缺少必填参数：${missing.join(', ')}（必须为非空字符串）`;
  if (name === 'create_ticket' && obj.priority !== undefined) {
    const ok = ['low', 'medium', 'high', 'urgent'].includes(String(obj.priority));
    if (!ok) return `priority 仅支持 low/medium/high/urgent（收到 ${String(obj.priority)}）`;
  }
  return null;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  bundle: ReturnType<typeof createCsaAgentTools>,
): Promise<string> {
  const t = bundle.tools.find((x) => x.name === name);
  if (!t) return `工具 ${name} 当前不可用。`;
  const r: any = await t.handler(args);
  if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text ?? '').join('\n').trim();
  return typeof r === 'string' ? r : JSON.stringify(r);
}

/* ============================ 韧性 HTTP ============================ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带超时 + 有限重试（5xx/429 退避）的 fetch，超时/耗尽抛错交由上层降级 */
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`HTTP_${r.status}`);
        if (attempt < maxAttempts) {
          logger.warn(`[llmProviders] 第 ${attempt} 次调用返回 ${r.status}，退避重试`);
          await sleep(300 * attempt);
          continue;
        }
        return r;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        logger.warn(`[llmProviders] 第 ${attempt} 次调用异常（${String((e as any)?.message || e).slice(0, 80)}），退避重试`);
        await sleep(300 * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

/* ============================ 端点归一化 ============================ */

/**
 * 归一化 OpenAI 兼容 chat/completions 完整地址（WorkBuddy 式：接口地址填完整路径）。
 * 接受三种形态：完整 URL（…/chat/completions）、版本层级（…/v1、…/v4）、根地址。
 */
export function openaiChatUrl(endpoint: string): string {
  const e = (endpoint || '').trim().replace(/\/+$/, '');
  if (!e) return 'https://api.openai.com/v1/chat/completions';
  if (/\/chat\/completions$/.test(e)) return e;
  if (/\/v\d+[a-z]*$/i.test(e)) return `${e}/chat/completions`;
  return `${e}/v1/chat/completions`;
}

/** 由接口地址推导 /models 探测地址（剥离 chat/completions 段） */
function openaiModelsUrl(endpoint: string): string {
  return openaiChatUrl(endpoint).replace(/\/chat\/completions$/, '') + '/models';
}

/** 归一化 Anthropic base（确保以 /v1 结尾） */
function anthropicBase(endpoint: string): string {
  const e = (endpoint || '').replace(/\/+$/, '');
  if (/\/v\d+$/.test(e)) return e;
  return `${e}/v1`;
}

/** 按输入 token 预算裁剪历史（粗略 1 token ≈ 2 字符，中英混合），保留最近消息 */
function fitPrompt(prompt: string, maxInputTokens: number | null): string {
  if (!maxInputTokens) return prompt;
  const budget = Math.max(1000, maxInputTokens * 2);
  if (prompt.length <= budget) return prompt;
  return `…（早期对话已按输入上限 ${maxInputTokens} tokens 裁剪）\n` + prompt.slice(-budget);
}

/** 应用层硬截断（与 SDK / Gemini 路径一致；含转人工标记时不截断） */
function truncate(text: string, limit: number): string {
  if (limit > 0 && text.length > limit && !text.includes(HANDOFF_TOKEN)) {
    return text.slice(0, limit) + '…';
  }
  return text;
}

/** 从响应 usage 字段提取有限数字（否则 undefined，避免把 null/NaN 写进埋点） */
function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/* ============================ 探测可用模型 ============================ */

export interface DiscoveredModel {
  modelId: string;
  name: string;
}
export interface DiscoverResult {
  ok: boolean;
  models?: DiscoveredModel[];
  error?: string;
}

/**
 * 按协议探测端点可用模型列表。
 * - openai：GET {base}/models（Bearer 鉴权），过滤非对话类；
 * - gemini：GET v1beta/models?key=...，过滤支持 generateContent 者；
 * - anthropic：无公开列表，返回官方已知清单；
 * - auto：不适用（模型列表由平台默认提供），返回明确提示。
 */
export async function discoverModels(
  provider: ProviderId | string,
  endpoint: string,
  apiKey: string,
): Promise<DiscoverResult> {
  const p = provider as ProviderId;
  try {
    if (p === 'openai') {
      if (!(endpoint || '').trim()) return { ok: false, error: '请先填写接口地址（完整 URL，如 https://api.example.com/v1/chat/completions）' };
      const url = openaiModelsUrl(endpoint);
      const resp = await fetchWithRetry(url, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        return { ok: false, error: `端点返回 ${resp.status}：${detail}` };
      }
      const j = (await resp.json().catch(() => null)) as any;
      const data: Array<{ id?: string }> = Array.isArray(j?.data) ? j.data : [];
      const ids = data
        .map((m) => String(m?.id || ''))
        .filter((id) => id && !NON_CHAT_KEYWORDS.some((k) => id.toLowerCase().includes(k)));
      if (!ids.length) return { ok: false, error: '未在该端点发现可用对话模型' };
      return { ok: true, models: ids.map((id) => ({ modelId: id, name: id })) };
    }

    if (p === 'gemini') {
      const key = apiKey || process.env.GEMINI_API_KEY || '';
      if (!key) return { ok: false, error: '请先填写 API Key（或配置 GEMINI_API_KEY 环境变量）' };
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const resp = await fetchWithRetry(url, { method: 'GET' });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        return { ok: false, error: `Gemini 返回 ${resp.status}：${detail}` };
      }
      const j = (await resp.json().catch(() => null)) as any;
      const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = Array.isArray(j?.models)
        ? j.models
        : [];
      const ids = models
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m?.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      if (!ids.length) return { ok: false, error: '未获取到可生成内容的 Gemini 模型' };
      return { ok: true, models: ids.map((id) => ({ modelId: id, name: id })) };
    }

    if (p === 'anthropic') {
      return {
        ok: true,
        models: ANTHROPIC_KNOWN.map((id) => ({ modelId: id, name: id })),
      };
    }

    // auto：不适用端点探测
    return { ok: false, error: 'auto（自动）模式无需探测，模型列表由平台默认提供' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/* ============================ OpenAI 兼容直连 ============================ */

/** OpenAI 兼容（/v1/chat/completions）生成，含 function calling 循环；失败降级知识库直答 */
export async function callOpenAiCompatible(opts: CallAgentOptions, fallbackToKb = true): Promise<CallAgentResult> {
  const cfg = getResolvedConfig();
  const url = openaiChatUrl(cfg.endpoint);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey && cfg.apiKey.trim()) headers['Authorization'] = `Bearer ${cfg.apiKey.trim()}`;

  const bundle = opts.toolCtx ? createCsaAgentTools(opts.toolCtx) : null;
  // 高级配置「工具调用」关闭时不注入工具（纯对话模式）
  const tools =
    bundle && cfg.toolCalling
      ? CSA_TOOL_DEFS.filter((d) => bundle.tools.some((t) => t.name === d.name)).map((d) => ({
          type: 'function',
          function: { name: d.name, description: d.description, parameters: d.parameters },
        }))
      : null;

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: fitPrompt(opts.prompt, cfg.maxInputTokens) },
  ];
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxOutputTokens ?? 2048,
    messages,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
  };
  // 思考模式：智谱端点（GLM-4.5+）启用 thinking 参数；其余 OpenAI 兼容网关忽略未知字段风险高，不注入
  if (cfg.thinkingMode && /open\.bigmodel\.cn/i.test(url)) {
    body.thinking = { type: 'enabled' };
  }

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const resp = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        throw new Error(`OPENAI_HTTP_${resp.status}: ${detail}`);
      }
      const j = (await resp.json()) as any;
      const msg = j?.choices?.[0]?.message;
      const toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> =
        Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      const texts: string[] = typeof msg?.content === 'string' ? [msg.content] : [];

      if (!toolCalls.length) {
        const text = texts.join('').trim();
        if (!text) throw new Error('OPENAI_EMPTY_RESPONSE');
        return {
          text: truncate(text, cfg.maxReplyLength),
          usedModel: `openai:${opts.model}`,
          captured: bundle?.captured,
          usage: {
            promptTokens: numOrUndef(j?.usage?.prompt_tokens),
            completionTokens: numOrUndef(j?.usage?.completion_tokens),
          },
        };
      }

      // 回灌助手消息（含 tool_calls）+ 工具结果，继续循环
      messages.push({ role: 'assistant', content: msg?.content ?? '', tool_calls: toolCalls });
      const toolResults: Array<Record<string, unknown>> = [];
      for (const tc of toolCalls) {
        const name = String(tc.function?.name || '');
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        const invalid = validateToolArgs(name, args);
        let out: string;
        if (invalid) {
          out = `参数校验失败：${invalid}`;
        } else {
          try {
            out = await runTool(name, args, bundle!);
          } catch (e: any) {
            out = `工具执行失败：${String(e?.message || e).slice(0, 160)}`;
          }
        }
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: out });
      }
      messages.push(...toolResults);
    }
    return knowledgeFallback(opts, `OpenAI 工具循环超过 ${MAX_ROUNDS} 轮上限`);
  } catch (e: any) {
    if (bundle?.captured.tickets.length) {
      logger.warn(`[llmProviders] OpenAI 调用失败但已建单 ${bundle.captured.tickets.length} 张，保留副作用返回`);
      return { text: '', usedModel: `openai:${opts.model}`, captured: bundle.captured };
    }
    // fallbackToKb=false：抛错交由上层（agentCore）编排引擎回退链
    if (!fallbackToKb) throw e;
    return knowledgeFallback(opts, String(e?.message || e).slice(0, 160));
  }
}

/* ============================ Anthropic 直连 ============================ */

/** Anthropic（/v1/messages）生成，含 tool_use 循环；失败降级知识库直答 */
export async function callAnthropic(opts: CallAgentOptions, fallbackToKb = true): Promise<CallAgentResult> {
  const cfg = getResolvedConfig();
  const base = anthropicBase(cfg.endpoint);
  const url = `${base}/messages`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (cfg.apiKey && cfg.apiKey.trim()) headers['x-api-key'] = cfg.apiKey.trim();

  const bundle = opts.toolCtx ? createCsaAgentTools(opts.toolCtx) : null;
  // 高级配置「工具调用」关闭时不注入工具（纯对话模式）
  const tools =
    bundle && cfg.toolCalling
      ? CSA_TOOL_DEFS.filter((d) => bundle.tools.some((t) => t.name === d.name)).map((d) => ({
          name: d.name,
          description: d.description,
          input_schema: d.parameters,
        }))
      : null;

  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: fitPrompt(opts.prompt, cfg.maxInputTokens) }];
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: cfg.maxOutputTokens ?? 2048,
    system: opts.systemPrompt,
    messages,
    ...(tools ? { tools } : {}),
  };

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const resp = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        throw new Error(`ANTHROPIC_HTTP_${resp.status}: ${detail}`);
      }
      const j = (await resp.json()) as any;
      const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> =
        Array.isArray(j?.content) ? j.content : [];
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text || '');

      if (!toolUses.length) {
        const text = texts.join('').trim();
        if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE');
        return {
          text: truncate(text, cfg.maxReplyLength),
          usedModel: `anthropic:${opts.model}`,
          captured: bundle?.captured,
          usage: {
            promptTokens: numOrUndef(j?.usage?.input_tokens),
            completionTokens: numOrUndef(j?.usage?.output_tokens),
          },
        };
      }

      // 回灌助手消息（含工具调用块）+ tool_result，继续循环
      messages.push({ role: 'assistant', content: blocks });
      const toolResults: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const name = String(tu.name || '');
        const args = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>;
        const invalid = validateToolArgs(name, args);
        let out: string;
        if (invalid) {
          out = `参数校验失败：${invalid}`;
        } else {
          try {
            out = await runTool(name, args, bundle!);
          } catch (e: any) {
            out = `工具执行失败：${String(e?.message || e).slice(0, 160)}`;
          }
        }
        toolResults.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tu.id, content: out }],
        });
      }
      messages.push(...toolResults);
    }
    return knowledgeFallback(opts, `Anthropic 工具循环超过 ${MAX_ROUNDS} 轮上限`);
  } catch (e: any) {
    if (bundle?.captured.tickets.length) {
      logger.warn(`[llmProviders] Anthropic 调用失败但已建单 ${bundle.captured.tickets.length} 张，保留副作用返回`);
      return { text: '', usedModel: `anthropic:${opts.model}`, captured: bundle.captured };
    }
    // fallbackToKb=false：抛错交由上层（agentCore）编排引擎回退链
    if (!fallbackToKb) throw e;
    return knowledgeFallback(opts, String(e?.message || e).slice(0, 160));
  }
}

/* ============================ 测试连接（保存前，表单值直连） ============================ */

export interface ConnectionTestResult {
  ok: boolean;
  usedModel?: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

/**
 * 测试连接：用「表单当前值」（未保存）做一次最小真实请求，供「测试连接」按钮即时验证。
 * - openai：POST {chatUrl}，messages=[{user:'ping'}]，max_tokens=16；
 * - anthropic：POST {base}/messages，x-api-key 鉴权；
 * - gemini：POST v1beta/models/{model}:generateContent?key=；
 * - auto：平台默认 SDK 路径不适用（提示保存后测试）。
 */
export async function testProviderConnection(input: {
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
}): Promise<ConnectionTestResult> {
  const t0 = Date.now();
  const p = input.provider;
  try {
    if (p === 'openai') {
      const url = openaiChatUrl(input.endpoint);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (input.apiKey.trim()) headers['Authorization'] = `Bearer ${input.apiKey.trim()}`;
      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 160);
        return { ok: false, error: `HTTP_${resp.status}: ${detail}`, latencyMs: Date.now() - t0 };
      }
      const j = (await resp.json()) as any;
      const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
      return { ok: true, usedModel: `openai:${input.model}`, latencyMs: Date.now() - t0, reply: text.slice(0, 60) || '（已连通）' };
    }

    if (p === 'anthropic') {
      const url = `${anthropicBase(input.endpoint)}/messages`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (input.apiKey.trim()) headers['x-api-key'] = input.apiKey.trim();
      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 160);
        return { ok: false, error: `HTTP_${resp.status}: ${detail}`, latencyMs: Date.now() - t0 };
      }
      const j = (await resp.json()) as any;
      const blocks: Array<{ type: string; text?: string }> = Array.isArray(j?.content) ? j.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
      return { ok: true, usedModel: `anthropic:${input.model}`, latencyMs: Date.now() - t0, reply: text.slice(0, 60) || '（已连通）' };
    }

    if (p === 'gemini') {
      const key = input.apiKey.trim() || process.env.GEMINI_API_KEY || '';
      if (!key) return { ok: false, error: '请先填写 API Key（或配置 GEMINI_API_KEY 环境变量）', latencyMs: Date.now() - t0 };
      const model = input.model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 160);
        return { ok: false, error: `HTTP_${resp.status}: ${detail}`, latencyMs: Date.now() - t0 };
      }
      const j = (await resp.json()) as any;
      const parts: Array<{ text?: string }> = j?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((x) => x.text || '').join('').trim();
      return { ok: true, usedModel: `gemini:${model}`, latencyMs: Date.now() - t0, reply: text.slice(0, 60) || '（已连通）' };
    }

    return { ok: false, error: 'auto（平台默认）模式请保存配置后再测试', latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), latencyMs: Date.now() - t0 };
  }
}
