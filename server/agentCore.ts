/**
 * Agent 核心（AI 内核共享层）
 *
 * 集中管理：模型常量、SDK 可用性探测、Agent 调用（含领域工具注入）、系统提示词构造。
 * 被 server/index.ts（web / embed 实时对话）与 server/channels.ts（email / im 异步渠道）共用，
 * 使全渠道共用同一套「LLM + 工具」AI 能力，避免规则分叉。
 *
 * 不依赖 index.ts / channels.ts，避免循环引用；工具实现见 agentTools.ts。
 */
import { query, unstable_v2_authenticate, type CanUseTool } from '@tencent-ai/agent-sdk';
import * as db from './db.js';
import type { IntentId } from './intent.js';
import { INTENT_META } from './intent.js';
import { HANDOFF_TOKEN } from './handoff.js';
import { createCsaAgentTools, CSA_TOOL_NAMES, type CsaToolContext, type CsaToolCaptured } from './agentTools.js';
import { logger } from './logger.js';
import { getResolvedConfig, DEFAULT_BASE_PROMPT, getGeminiConfig } from './llmConfig.js';
import { callAgentGemini, geminiConfigured, knowledgeFallback } from './geminiAgent.js';
import { callOpenAiCompatible, callAnthropic } from './llmProviders.js';
import { recordLlmCall } from './llmMetrics.js';

/* ============================ 模型与模式常量 ============================ */

const BRAND = process.env.BRAND_NAME || '中科佳晨';

/**
 * 默认模型。必须为本账号「支持模型列表」中的值。
 * 当前账号支持：auto / hy3 / glm-5.2 / glm-5.1 / minimax-m3 / kimi-* / deepseek-v4-* / custom-local:*。
 */
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'auto';
/** 账号确认支持的候选模型，作为兜底链的基础 */
const KNOWN_SUPPORTED_MODELS = ['auto', 'glm-5.2', 'hy3', 'deepseek-v4-flash'];
/** auto: 优先 SDK，失败降级；sdk: 强制 SDK；local: 纯知识库模式 */
const AGENT_MODE = (process.env.AGENT_MODE || 'auto') as 'auto' | 'sdk' | 'local';
/** 首 token 等待上限（单次尝试） */
const AGENT_FIRST_TOKEN_TIMEOUT = Number(process.env.AGENT_TIMEOUT_MS) || 20000;
/** 整条模型兜底链的总等待预算 */
const AGENT_CHAIN_BUDGET = Number(process.env.AGENT_CHAIN_BUDGET_MS) || 45000;

/** 鉴权/登录类错误：出现即判定 SDK 不可用 */
export const AUTH_ERROR_PATTERN = /auth|login|sign in|unauthorized|not signed|401|token/i;
export { BRAND, DEFAULT_MODEL, KNOWN_SUPPORTED_MODELS, AGENT_MODE, AGENT_FIRST_TOKEN_TIMEOUT, AGENT_CHAIN_BUDGET };

/* ============================ SDK 可用性状态 ============================ */

let sdkAvailable: boolean | null = null; // null 表示尚未探测
/** SDK 因鉴权失败（需交互式 /login）等原因彻底不可用，进程内永久禁用 */
let sdkBroken = false;
/** 已知不可用的模型（命中即跳过） */
export const badModels = new Set<string>();

export function isSdkAvailable(): boolean | null {
  return sdkAvailable;
}
export function isSdkBroken(): boolean {
  return sdkBroken;
}
export function markSdkBroken(): void {
  sdkBroken = true;
  sdkAvailable = false;
}

/** 探测 SDK 可用性（仅首次调用时执行） */
export async function probeSdk(): Promise<boolean> {
  if (AGENT_MODE === 'local') return false;
  if (sdkBroken) return false;
  if (sdkAvailable !== null) return sdkAvailable;
  try {
    let needsLogin = false;
    const result = await Promise.race([
      unstable_v2_authenticate({
        environment: 'external',
        onAuthUrl: async () => {
          needsLogin = true;
        },
      }),
      new Promise((resolve) => setTimeout(() => resolve('__TIMEOUT__'), 8000)),
    ]);
    sdkAvailable = !needsLogin && result !== '__TIMEOUT__';
  } catch (e: any) {
    logger.warn('[SDK] 探测失败，进入知识库直答模式:', e?.message || e);
    sdkAvailable = false;
  }
  logger.info(`[SDK] 鉴权通道探测: ${sdkAvailable ? '可达（生成能力将于首轮真实对话确认）' : '不可用（降级为知识库直答）'}`);
  return sdkAvailable;
}

/**
 * 启动期一次性真实探测：用一次极小真实调用确认能否真正生成。
 * 鉴权/模型类错误会令进程内永久禁用 SDK，使首轮用户消息直接走知识库直答。
 * 非阻塞：后台执行，不拖延服务启动。
 */
export async function confirmSdk(): Promise<void> {
  if (AGENT_MODE === 'local' || sdkBroken) return;
  const probeSession = { id: 'probe', sdk_session_id: null as string | null };
  const t0 = Date.now();
  try {
    const r = await callAgent({
      prompt: 'ping',
      systemPrompt: '请只回复「OK」两个字，不要多写。',
      model: 'auto',
      session: probeSession,
      timeoutMs: 12000,
      channel: 'probe',
    });
    if (r.text && r.text.trim()) {
      logger.info(`[SDK] 真实生成探测成功（${Date.now() - t0}ms），LLM 模式可用`);
    } else {
      markSdkBroken();
      logger.info('[SDK] 真实生成返回空，降级为知识库直答');
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (AUTH_ERROR_PATTERN.test(msg) || /model|service info not found|invalid|not found|empty/i.test(msg)) {
      markSdkBroken();
    }
    logger.info(`[SDK] 真实生成探测失败（${Date.now() - t0}ms），降级为知识库直答: ${msg.slice(0, 100)}`);
  }
}

/* ============================ 工具放行策略 ============================ */

/**
 * 受约束工具放行：仅允许我们的客服领域 MCP 工具（名称可能为 mcp__csa__xxx 形态），
 * 其余一切工具（含内置 Bash / 文件 / 网络）一律拒绝——双保险，tools:[] 已禁用内置。
 */
export const csaAllowTool: CanUseTool = async (toolName) => {
  if ((CSA_TOOL_NAMES as readonly string[]).includes(toolName)) return { behavior: 'allow' };
  if ((CSA_TOOL_NAMES as readonly string[]).some((t) => toolName === t || toolName.endsWith('__' + t) || toolName.includes(t))) {
    return { behavior: 'allow' };
  }
  return { behavior: 'deny', message: '仅允许客服领域工具调用' };
};

/* ============================ 系统提示词 ============================ */

/** 将客户画像结构化为注入 prompt 的纯文本（无画像或字段全空返回 null） */
export function formatCustomerProfile(profile: db.DbCustomerProfile | undefined): string | null {
  if (!profile) return null;
  const lines: string[] = [];
  if (profile.name) lines.push(`- 称呼/联系人：${profile.name}`);
  if (profile.company) lines.push(`- 所属企业：${profile.company}`);
  if (profile.industry) lines.push(`- 行业：${profile.industry}`);
  if (profile.contact) lines.push(`- 联系方式：${profile.contact}`);
  if (profile.tags) lines.push(`- 标签：${profile.tags}`);
  if (profile.preferences) lines.push(`- 偏好/诉求：${profile.preferences}`);
  if (profile.notes) lines.push(`- 备注：${profile.notes}`);
  if (profile.history_summary) lines.push(`- 历史概要：${profile.history_summary}`);
  if (profile.session_count > 0) lines.push(`- 历史接触次数：${profile.session_count}`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * 构造 Agent 系统提示词。
 * opts.external=true 时面向 email / im 异步渠道：
 *   - 允许并引导 Agent 使用领域工具（含 create_ticket 建单）；
 *   - 转人工指令改为「调用 create_ticket 工具」，不再依赖 HANDOFF_TOKEN 文本标记。
 */
export function buildSystemPrompt(
  intent: IntentId,
  knowledgeContext: string,
  orderContext: string | null,
  customerProfile?: string | null,
  opts?: { external?: boolean; basePrompt?: string; maxReplyLength?: number },
): string {
  const customerSection = customerProfile
    ? `\n## 客户画像（长期记忆，仅用于个性化服务，不向客户复述、不外泄）\n${customerProfile}`
    : '';
  const toolGuidance = opts?.external
    ? `5. 你可以使用下列工具来检索信息或处理业务：\n   - search_knowledge：检索标准 FAQ 知识库；\n   - query_order：实时查询订单物流 / 售后；\n   - get_customer：查询客户画像；\n   - create_ticket：当判断需转人工 / 升级时，**必须调用此工具创建工单**，并向客户说明已安排专员跟进。\n   不要调用任何未在上述列表中的工具（如文件、命令、网络）。`
    : `5. 禁止调用任何工具（文件、命令、网络），你只需依据给定上下文作答。`;
  const handoffRule = opts?.external
    ? `## 转人工规则\n当需要转人工或升级时，请调用 create_ticket 工具创建工单，并在回复中告知客户已安排专人跟进；不要在文本中输出特殊标记。`
    : `## 转人工规则\n当出现以下任一情形时，在回复的**最后一行**单独输出标记 ${HANDOFF_TOKEN}：\n- 知识库与订单信息均无法支撑回答；\n- 客户要求赔偿、索赔、投诉升级或涉及法律纠纷；\n- 需要修改订单金额、强制退款等超出自助权限的操作。\n输出该标记前，请先用一句话向客户说明将由人工同事接手。`;
  // persona 基础提示词：优先采用管理员在「模型配置」中自定义的内容，否则回退默认；
  // 默认模板含 {BRAND} 占位符，统一替换为实际品牌名（管理员自定义内容若含 {BRAND} 也会被替换，无副作用）。
  const persona = (opts?.basePrompt ?? DEFAULT_BASE_PROMPT).replace(/\{BRAND\}/g, BRAND);
  // 长度约束：当配置的最大回复长度与默认 150 不一致时，追加一条强约束（与 callAgent 的应用层截断形成双保险）
  const lengthRule =
    opts?.maxReplyLength && opts.maxReplyLength !== 150
      ? `\n\n【长度约束】单次回复请严格控制在 ${opts.maxReplyLength} 字以内。`
      : '';
  return `${persona}${lengthRule}
${toolGuidance}

${handoffRule}

## 当前会话上下文
- 识别意图：${INTENT_META[intent].label}（${INTENT_META[intent].description}）${customerSection}

## 知识库参考
${knowledgeContext}

${orderContext ? `## 订单信息（实时查询结果）\n${orderContext}` : '## 订单信息\n（客户本轮未提供订单号）'}

请基于以上信息，直接给出对客户的回复内容。`;
}

/* ============================ Agent 调用（含工具注入） ============================ */

export interface CallAgentOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  session: { id: string; sdk_session_id: string | null };
  timeoutMs: number;
  /** 提供则注入客服领域工具；allowCreateTicket 控制是否开放建单工具 */
  toolCtx?: CsaToolContext;
  /** 多轮上下文：最近若干轮对话的纯文本，拼接到 prompt 之前，使模型具备跨轮记忆 */
  historyText?: string;
  /** 显式协议覆盖（缺省取配置 provider）；用于测试或跨协议调用 */
  provider?: string;
  /** 调用渠道（web/embed/im/email/probe/system），仅用于调用监控埋点 */
  channel?: string;
}

export interface CallAgentResult {
  text: string;
  usedModel: string;
  captured?: CsaToolCaptured;
  /** 模型自报 token 用量（部分引擎不返回，缺省 undefined） */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** 把「配置透传参数被 CLI 拒绝」的典型报错归为一类，用于触发自动降级重试 */
function looksLikeCliArgError(msg: string): boolean {
  return /unknown option|unrecognized|not recognized|invalid argument|unknown argument|temperature/i.test(msg);
}

/**
 * 将历史消息格式化为多轮上下文文本，拼接到 prompt 之前。
 * 取最近 maxTurns 轮（用户/客服交替），过滤空内容；返回 null 表示无历史。
 */
export function buildHistoryText(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTurns = 6,
): string | null {
  const turns = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim())
    .slice(-maxTurns * 2);
  if (turns.length === 0) return null;
  const parts = turns.map((m) => `${m.role === 'user' ? '客户' : '客服'}: ${m.content.trim()}`);
  return `以下是此前对话记录（用于保持上下文连贯，请勿重复已答复的内容）：\n${parts.join('\n')}`;
}

/**
 * 调用 CodeBuddy Agent SDK 生成回复（可选注入领域工具）。
 * 返回完整文本；超时或空响应（且无工具活动）抛错，由调用方决定降级或换模型重试。
 *
 * 配置接入（server/llmConfig.ts）：
 * - model：配置模型优先于调用方传入的 model；
 * - temperature：经 extraArgs 透传（CLI 若不支持则自动降级重试，不影响主链路）；
 * - apiKey / endpoint：经 env / endpoint 透传（best-effort，取决于部署形态）；
 * - maxReplyLength：应用层硬截断（双保险于系统提示词约束），并保护转人工标记不被截断。
 */
async function callAgentSdk(opts: CallAgentOptions): Promise<CallAgentResult> {
  const cfg = getResolvedConfig();
  const bundle = opts.toolCtx ? createCsaAgentTools(opts.toolCtx) : null;

  // 配置透传参数（best-effort）：仅在确有非空值时附加，避免无谓改动 CLI 启动参数
  const configExtras: Record<string, unknown> = {};
  configExtras.extraArgs = { temperature: String(cfg.temperature) };
  if (cfg.apiKey && cfg.apiKey.trim()) configExtras.env = { CODEBUDDY_API_KEY: cfg.apiKey.trim() };
  if (cfg.endpoint && cfg.endpoint.trim()) configExtras.endpoint = cfg.endpoint.trim();

  const runWith = async (extras: Record<string, unknown>): Promise<CallAgentResult> => {
    const stream = query({
      prompt: opts.prompt,
      options: {
        cwd: process.cwd(),
        model: opts.model,
        maxTurns: bundle ? 4 : 1,
        systemPrompt: opts.systemPrompt,
        permissionMode: 'default',
        canUseTool: csaAllowTool,
        tools: [],
        ...(bundle ? { mcpServers: { csa: bundle.server } } : {}),
        ...(opts.session.sdk_session_id ? { resume: opts.session.sdk_session_id } : {}),
        ...extras,
      } as any,
    });
    const iterator = (stream as any)[Symbol.asyncIterator]();
    let full = '';
    let sawToolUse = false;
    const TIMEOUT = Symbol('timeout');
    while (true) {
      const nextPromise = iterator.next();
      const raced = await Promise.race([
        nextPromise,
        new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), opts.timeoutMs)),
      ]);
      if (raced === TIMEOUT) throw new Error('AGENT_TIMEOUT');
      const { done, value: msg } = raced as IteratorResult<any>;
      if (done) break;
      if (msg?.type === 'system' && msg?.subtype === 'init') {
        if (msg.session_id && msg.session_id !== opts.session.sdk_session_id) {
          db.updateSession(opts.session.id, { sdk_session_id: msg.session_id });
        }
      } else if (msg?.type === 'assistant') {
        const content = msg?.message?.content;
        if (typeof content === 'string') full += content;
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text') full += block.text;
            if (block?.type === 'tool_use') sawToolUse = true;
          }
        }
      }
    }
    // Agent 仅调用了工具（如建单）而无文本回复时，交由调用方基于 captured 组装，不视为失败
    if (!full.trim() && !(sawToolUse || bundle?.captured.toolCalls.length)) {
      throw new Error('AGENT_EMPTY_RESPONSE');
    }
    // 应用层硬截断：最大回复长度（双保险于系统提示词约束）；但若含转人工标记则不截断，避免破坏 HANDOFF 信号
    const limit = cfg.maxReplyLength;
    let text = full;
    if (limit > 0 && text.length > limit && !text.includes(HANDOFF_TOKEN)) {
      text = text.slice(0, limit) + '…';
    }
    return { text, usedModel: opts.model, captured: bundle?.captured };
  };

  try {
    return await runWith(configExtras);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 配置透传参数（如 --temperature）被 CLI 拒绝时，自动降级为不传这些参数重试一次，保证主链路可用
    if (looksLikeCliArgError(msg) && (configExtras.extraArgs || configExtras.endpoint || configExtras.env)) {
      logger.warn('[agentCore] 配置透传参数被 CLI 拒绝，已自动降级为不传（温度/密钥/端点将不生效）:', msg.slice(0, 120));
      return await runWith({});
    }
    throw e;
  }
}

/**
 * Agent 统一调用入口：按协议路由 + 引擎回退链 + 调用监控埋点。
 *
 * 路由（provider 由调用方显式传入或取「模型配置」保存值）：
 * - openai / anthropic：原生 fetch 直连（llmProviders），失败进入引擎回退链；
 * - gemini（DB 驱动）或 env 驱动（GEMINI_API_KEY / GOOGLE_APPLICATION_CREDENTIALS）：
 *   走 callAgentGemini；
 * - auto：CodeBuddy Agent SDK 路径（callAgentSdk）。
 *
 * 引擎回退链（仅显式协议直连失败时触发，按序尝试，全部失败才降级知识库直答）：
 *   ① Gemini env 已配置 → callAgentGemini；② SDK 可用 → callAgentSdk；③ knowledgeFallback。
 *   避免「自定义端点一挂就直接掉知识库」的体验断崖。
 */
export async function callAgent(opts: CallAgentOptions): Promise<CallAgentResult> {
  const prompt = opts.historyText ? `${opts.historyText}\n\n【用户当前消息】\n${opts.prompt}` : opts.prompt;
  const cfg = getResolvedConfig();
  const provider = opts.provider || cfg.provider || 'auto';
  const effectiveModel = opts.model || cfg.model;
  const channel = opts.channel || opts.toolCtx?.channel || 'system';
  const runOpts: CallAgentOptions = { ...opts, prompt, model: effectiveModel };

  // 可观测性埋点：每次调用记录引擎/模型/渠道/延迟/状态/token 用量（best-effort）
  const withMetrics = async (fn: () => Promise<CallAgentResult>): Promise<CallAgentResult> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      recordLlmCall({
        provider: r.usedModel.split(':')[0] || provider,
        model: r.usedModel,
        channel,
        sessionId: opts.session.id,
        status: r.usedModel === 'knowledge_base' ? 'degraded' : 'ok',
        latencyMs: Date.now() - t0,
        promptTokens: r.usage?.promptTokens,
        completionTokens: r.usage?.completionTokens,
      });
      return r;
    } catch (e: any) {
      recordLlmCall({
        provider,
        model: effectiveModel,
        channel,
        sessionId: opts.session.id,
        status: 'error',
        latencyMs: Date.now() - t0,
        error: String(e?.message || e).slice(0, 200),
      });
      throw e;
    }
  };

  return withMetrics(async () => {
    // 显式协议直连（OpenAI 兼容 / Anthropic）：原生 fetch 调用，与 SDK / Gemini 同构
    if (provider === 'openai' || provider === 'anthropic') {
      try {
        return provider === 'openai'
          ? await callOpenAiCompatible(runOpts, false)
          : await callAnthropic(runOpts, false);
      } catch (e: any) {
        const reason = String(e?.message || e).slice(0, 120);
        logger.warn(`[agentCore] ${provider} 直连失败（${reason}），进入引擎回退链`);
        if (geminiConfigured()) {
          try {
            return await callAgentGemini(runOpts);
          } catch (ge: any) {
            logger.warn(`[agentCore] 回退 Gemini 失败（${String(ge?.message || ge).slice(0, 100)}），继续回退`);
          }
        }
        if (AGENT_MODE !== 'local' && !sdkBroken && isSdkAvailable() === true) {
          try {
            return await callAgentSdk(runOpts);
          } catch (se: any) {
            logger.warn(`[agentCore] 回退 SDK 失败（${String(se?.message || se).slice(0, 100)}），降级知识库直答`);
          }
        }
        return knowledgeFallback(runOpts, `${provider} 直连失败且回退链耗尽：${reason}`);
      }
    }

    // gemini 协议（DB 驱动）或 env 驱动
    if (provider === 'gemini' || geminiConfigured()) {
      return callAgentGemini(runOpts);
    }

    return callAgentSdk(runOpts);
  });
}
