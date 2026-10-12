/**
 * 坐席 Copilot 辅助（Agent Copilot）
 *
 * 面向人工坐席的实时辅助：当坐席正在处理某个会话时，基于客户最新消息给出
 *   - draftReply：可直接发送/复制的回复草稿（命中高置信知识库答案则引用标准答案）；
 *   - kbHits：相关 FAQ（供坐席引用/发散）；
 *   - insights：客户画像洞察（等级 / 情绪 / 未结工单 / 连续未解决轮次 / 意图）；
 *   - actions：下一步建议动作（安抚 / 引用工单 / 升级转人工 / 重点客户优先）。
 *
 * 依赖 Feature 2 的 RAG 检索（retrieveRag）与既有画像/工单接口，零新外部依赖。
 * 沙箱无 LLM 时草稿来自知识库直答（与降级策略一致），真实环境可在此叠加 LLM 润色。
 */
import * as db from './db.js';
import { retrieveRag } from './rag.js';
import { DIRECT_ANSWER_THRESHOLD } from './knowledge.js';
import { classifyIntent } from './intent.js';
import type { IntentId } from './intent.js';

export interface CopilotKbHit {
  id: string;
  question: string;
  answer: string;
  score: number;
}

export interface CopilotInsight {
  tier?: string | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'angry' | null;
  openTicket: boolean;
  unresolvedStreak: number;
  intent?: IntentId | null;
}

export interface CopilotSuggestion {
  /** 被分析的客户消息 */
  message: string;
  /** 可直接发送/复制的回复草稿（无强匹配时为 null） */
  draftReply: string | null;
  /** 相关 FAQ（已按 RAG 相关性排序） */
  kbHits: CopilotKbHit[];
  /** 客户/会话洞察 */
  insights: CopilotInsight;
  /** 下一步建议动作 */
  actions: string[];
}

function scoreToSentiment(s?: number): CopilotInsight['sentiment'] {
  if (s == null) return null;
  if (s <= -1) return 'negative';
  if (s >= 1) return 'positive';
  return 'neutral';
}

export async function getCopilotSuggestions(opts: {
  sessionId?: string;
  customerId?: string;
  message: string;
}): Promise<CopilotSuggestion> {
  const message = (opts.message || '').trim();

  // ① RAG 检索相关 FAQ
  const hits = await retrieveRag(message, null, 3);

  // ② 草稿：高置信直接引用标准答案；否则给参考片段；无匹配为 null
  let draftReply: string | null = null;
  if (hits.length && hits[0].score >= DIRECT_ANSWER_THRESHOLD) {
    draftReply = hits[0].answer;
  } else if (hits.length) {
    draftReply = `（参考知识库）${hits[0].answer.slice(0, 240)}`;
  }

  // ③ 洞察：画像 + 工单 + 连续未解决轮次 + 意图
  let customerId = opts.customerId || null;
  if (!customerId && opts.sessionId) {
    customerId = db.getSession(opts.sessionId)?.customer_id ?? null;
  }
  const profile = customerId ? db.getCustomerProfile(customerId) : undefined;
  const openTicket = opts.sessionId ? db.hasOpenTicket(opts.sessionId) : false;
  const unresolvedStreak = opts.sessionId ? db.countRecentMisses(opts.sessionId, 3) : 0;
  const intent = classifyIntent(message).intent;
  const insights: CopilotInsight = {
    tier: profile?.tier ?? null,
    sentiment: scoreToSentiment(profile?.sentiment_score),
    openTicket,
    unresolvedStreak,
    intent,
  };

  // ④ 动作建议
  const actions: string[] = [];
  if (hits.length && hits[0].score >= DIRECT_ANSWER_THRESHOLD) {
    actions.push('可直接引用知识库第 1 条标准答案回复（高置信）');
  } else if (hits.length) {
    actions.push('知识库有相关条目，建议人工润色后引用');
  } else {
    actions.push('知识库无强匹配，建议人工撰写或从工单/订单查证');
  }
  if (insights.sentiment === 'negative' || insights.sentiment === 'angry') {
    actions.push('客户情绪偏负面，先共情安抚再给方案');
  }
  if (openTicket) actions.push('该会话已有未结工单，可引用工单号延续跟进');
  if (unresolvedStreak >= 2) {
    actions.push(`连续 ${unresolvedStreak} 轮未解决，建议升级或转人工`);
  }
  if (profile?.tier === 'vip' || profile?.tier === 'key') {
    actions.push('重点客户，优先响应并同步客户经理');
  }

  return { message, draftReply, kbHits: hits, insights, actions };
}
