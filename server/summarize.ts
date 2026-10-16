/**
 * 会话摘要与工单自动填充。
 *
 * 转人工 / 自动建单时，由 LLM 对整段对话生成结构化摘要（summary / intents / tags /
 * sentiment / priorityHint / unresolved），用于自动填充工单描述、情绪标记与检索标签，
 * 显著降低坐席接手成本。
 *
 * 降级策略（关键）：本模块依赖 callAgent（CodeBuddy CLI）。当 CLI 不可达或返回非合规
 * JSON 时，自动回退为「规则摘要」（取对话文本截断 / 当前消息），保证建单链路不阻断。
 * 因此即便在无大模型环境，工单仍会携带一条可读的兜底摘要。
 */
import { callAgent } from './agentCore.js';
import { getResolvedConfig } from './llmConfig.js';
import { stripHandoffToken } from './handoff.js';
import type { DbMessage } from './db.js';

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'angry';
export type PriorityHint = 'low' | 'medium' | 'high' | 'urgent';

export interface ConversationSummary {
  /** 2-3 句话概括客户问题、已尝试的解决方式、当前状态 */
  summary: string;
  /** 核心意图标签，最多 5 个 */
  intents: string[];
  /** 便于检索的分类标签，最多 8 个 */
  tags: string[];
  /** 客户情绪（规则回退时可能为 null，表示未分析） */
  sentiment: Sentiment | null;
  /** 建议优先级 */
  priorityHint: PriorityHint;
  /** 问题是否已解决 */
  unresolved: boolean;
}

export interface SummarizeMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SUMMARY_SYSTEM_PROMPT = `你是客服工单助理。阅读一段客服对话，输出严格的 JSON（不要包含任何解释文字，也不要用 markdown 代码块包裹），结构如下：
{
  "summary": "用 2-3 句话概括客户的核心问题、已尝试的解决方式、当前状态",
  "intents": ["核心意图标签，最多 3 个，例如 退款退货/技术支持/投诉/订单查询"],
  "tags": ["便于检索与归类的标签，最多 5 个"],
  "sentiment": "positive | neutral | negative | angry 之一",
  "priorityHint": "low | medium | high | urgent 之一，依据客户情绪与问题严重性判断",
  "unresolved": true 或 false（客户的问题是否仍未解决）
}`;

const SENTIMENTS: Sentiment[] = ['positive', 'neutral', 'negative', 'angry'];
const PRIORITIES: PriorityHint[] = ['low', 'medium', 'high', 'urgent'];

/** 将消息列表与可选当前消息拼成对话文本 */
export function buildConversationText(messages: SummarizeMessage[], currentMessage?: string): string {
  const lines = messages
    .filter((m) => m.content && m.content.trim())
    .map((m) => `${m.role === 'user' ? '客户' : '客服'}: ${m.content.trim()}`);
  if (currentMessage && currentMessage.trim()) lines.push(`客户: ${currentMessage.trim()}`);
  return lines.join('\n');
}

function toMessage(m: DbMessage): SummarizeMessage {
  return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
}

function parseSummaryJson(text: string): ConversationSummary | null {
  // 去除可能的 ```json ... ``` 包裹
  const cleaned = text.replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const sentiment = (SENTIMENTS.includes(obj.sentiment) ? obj.sentiment : 'neutral') as Sentiment;
    const priorityHint = (PRIORITIES.includes(obj.priorityHint) ? obj.priorityHint : 'medium') as PriorityHint;
    return {
      summary: String(obj.summary ?? '').slice(0, 1000).trim(),
      intents: Array.isArray(obj.intents) ? obj.intents.map(String).slice(0, 5) : [],
      tags: Array.isArray(obj.tags) ? obj.tags.map(String).slice(0, 8) : [],
      sentiment,
      priorityHint,
      unresolved: Boolean(obj.unresolved),
    };
  } catch {
    return null;
  }
}

/**
 * 生成会话摘要。成功返回结构化结果；CLI 不可达 / 超时 / 返回非合规 JSON 时回退规则摘要。
 * 永不抛错（保证建单链路不被摘要失败阻断）。
 */
export async function summarizeConversation(
  messages: SummarizeMessage[],
  opts?: { sessionId?: string; currentMessage?: string; timeoutMs?: number },
): Promise<ConversationSummary | null> {
  const transcript = buildConversationText(messages, opts?.currentMessage);
  if (!transcript.trim()) return null;

  const fallback = (override?: string): ConversationSummary => ({
    summary: (override || transcript).slice(0, 300).trim(),
    intents: [],
    tags: [],
    // 规则回退时情绪未知，留 null（前端不显示徽章），避免误导坐席"已判定中性"
    sentiment: null,
    priorityHint: 'medium',
    unresolved: true,
  });

  try {
    const cfg = getResolvedConfig();
    const res = await callAgent({
      prompt: `请总结以下对话：\n${transcript}`,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      model: cfg.model,
      session: { id: opts?.sessionId ?? 'summary', sdk_session_id: null },
      timeoutMs: opts?.timeoutMs ?? 15000,
    });
    const parsed = parseSummaryJson(res.text);
    if (parsed && parsed.summary) return parsed;
    // 模型未返回合规 JSON：用其文本作为摘要回退。
    // 防御：剥离可能混入的转人工令牌——否则聊天型模型在非 JSON 回复中带上令牌时，
    // 会把 "[[HANDOFF]]" 原文写进工单摘要（坐席端可见，属于展示层污染）。
    const cleaned = stripHandoffToken(res.text || '').slice(0, 500).trim();
    return { ...fallback(), summary: cleaned || fallback().summary };
  } catch {
    return fallback();
  }
}

/** 便捷封装：直接从 DbMessage[] 生成摘要 */
export async function summarizeDbMessages(
  messages: DbMessage[],
  opts?: { sessionId?: string; currentMessage?: string; timeoutMs?: number },
): Promise<ConversationSummary | null> {
  return summarizeConversation(messages.map(toMessage), opts);
}
