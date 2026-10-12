/**
 * 智能升级引擎。
 *
 * 输入：当前消息 / 历史会话 / 当前优先级 / 是否已解决。
 * 输出：是否升级（escalate）、升级后优先级（priority）、升级原因（reason）、
 *       是否强制转人工（autoHandoff）、是否触发通知（notify）。
 *
 * 与转人工决策（handoff.ts / evaluateHandoff）的关系：
 *  handoff 决定「是否转人工」（兜底逃逸），本引擎决定「转人工后/建单时的智能升级」
 *  —— 即依据情绪与风险进一步抬高优先级、打标、通知。两者互补，不重复。
 *  本引擎对所有建单路径统一生效（web 转人工 / IM·邮件 ingest / Agent 工具建单）。
 */
import { logger } from './logger.js';
import type { Sentiment } from './summarize.js';
import type { TicketPriority } from './db.js';
import { analyzeSentiment, type SentimentResult } from './sentiment.js';

export interface EscalationDecision {
  escalate: boolean;
  priority: TicketPriority;
  reason: string | null;
  /** 是否强制转人工（高风险/愤怒时即使原路径未转人工也应转） */
  autoHandoff: boolean;
  /** 是否触发升级通知（企点/邮件/Webhook） */
  notify: boolean;
}

const RANK: Record<TicketPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

/** 取两者中更紧急的优先级 */
export function higherPriority(a: TicketPriority, b: TicketPriority): TicketPriority {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * 升级决策。规则按严重度短路：
 *  1) 触及法务/舆情风险词 -> 紧急 + 强制转人工 + 通知
 *  2) 愤怒情绪 -> 高优先级 + 强制转人工 + 通知
 *  3) 负面 + 连续 ≥2 次 -> 高优先级 + 通知
 *  4) 负面 + 未解决 -> 高优先级 + 通知
 *  5) 仅负面（未达阈值）-> 不升级，但保证优先级不低于 medium
 */
export function decideEscalation(opts: {
  sentiment?: Sentiment | null;
  negativeStreak?: number;
  riskSignals?: string[];
  currentPriority?: TicketPriority;
  unresolved?: boolean;
}): EscalationDecision {
  const base: TicketPriority = opts.currentPriority || 'medium';
  const riskWords = opts.riskSignals && opts.riskSignals.length > 0 ? opts.riskSignals : [];

  if (riskWords.length > 0) {
    return {
      escalate: true,
      priority: higherPriority(base, 'urgent'),
      reason: `触及高危/法务风险词（${riskWords.join('、')}），已升级至紧急并通知专员`,
      autoHandoff: true,
      notify: true,
    };
  }
  if (opts.sentiment === 'angry') {
    return {
      escalate: true,
      priority: higherPriority(base, 'high'),
      reason: '识别到强烈负面情绪（愤怒），自动升级人工优先安抚并通知',
      autoHandoff: true,
      notify: true,
    };
  }
  if (opts.sentiment === 'negative' && (opts.negativeStreak ?? 0) >= 2) {
    return {
      escalate: true,
      priority: higherPriority(base, 'high'),
      reason: `会话内连续 ${(opts.negativeStreak ?? 0)} 次负面情绪，自动升级人工跟进`,
      autoHandoff: false,
      notify: true,
    };
  }
  if (opts.sentiment === 'negative' && opts.unresolved) {
    return {
      escalate: true,
      priority: higherPriority(base, 'high'),
      reason: '负面情绪且问题未解决，自动升级人工',
      autoHandoff: false,
      notify: true,
    };
  }
  if (opts.sentiment === 'negative') {
    // 负面但未达升级阈值：不升级，但保证基础关注度（不低于 medium）
    return { escalate: false, priority: higherPriority(base, 'medium'), reason: null, autoHandoff: false, notify: false };
  }
  return { escalate: false, priority: base, reason: null, autoHandoff: false, notify: false };
}

/** 统计历史 + 当前消息中「用户负面/愤怒」的连续累计次数（用于升级判定） */
function countNegativeTurns(messages: Array<{ role: string; content: string }>): number {
  return messages.filter((m) => {
    if (m.role !== 'user') return false;
    const s = analyzeSentiment(m.content).sentiment;
    return s === 'negative' || s === 'angry';
  }).length;
}

/**
 * 统一入口：给定当前消息 + 历史，产出情感分析结果 + 升级决策。
 * 供各建单路径一次性调用，避免重复计算。
 */
export function escalateFromContext(opts: {
  message?: string;
  history?: Array<{ role: string; content: string }>;
  currentPriority?: TicketPriority;
  unresolved?: boolean;
}): { sentiment: Sentiment | null; sentimentScore: number; decision: EscalationDecision } {
  const senti: SentimentResult = analyzeSentiment(opts.message || '');
  const full = [
    ...(opts.history || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.message || '' },
  ];
  const negativeStreak = countNegativeTurns(full);
  const decision = decideEscalation({
    sentiment: senti.sentiment,
    negativeStreak,
    riskSignals: senti.risk ? senti.signals : [],
    currentPriority: opts.currentPriority,
    unresolved: opts.unresolved,
  });
  return { sentiment: senti.sentiment, sentimentScore: senti.score, decision };
}

/**
 * 升级通知（best-effort）：配置了 ESCALATION_WEBHOOK_URL 则 POST，否则仅记录日志。
 * 与告警中继（alert-relay）解耦——升级是业务事件，可直接对接企点/邮件/值班群。
 */
export async function notifyEscalation(payload: {
  ticketId: string;
  priority: TicketPriority;
  reason: string;
  channel: string;
  customer?: string | null;
}): Promise<void> {
  const url = process.env.ESCALATION_WEBHOOK_URL;
  if (!url) {
    logger.info(`[Escalation] 升级通知（未配置 webhook，仅记录）: ${payload.reason} | ticket=${payload.ticketId} priority=${payload.priority}`);
    return;
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ticket_escalation', ts: Date.now(), ...payload }),
    });
  } catch (e) {
    logger.warn(`[Escalation] 通知发送失败: ${(e as Error)?.message || e}`);
  }
}
