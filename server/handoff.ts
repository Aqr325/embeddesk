/**
 * 转人工决策引擎
 *
 * 设计原则：转人工是「兜底」而非「逃逸」。规则按优先级短路求值，
 * 首个命中的规则决定工单优先级，确保高危场景（投诉、法务风险）优先升级。
 */
import { containsAny } from './nlp.js';
import { isNegativeSentiment, type IntentId } from './intent.js';
import type { TicketPriority } from './db.js';

export type HandoffRule =
  | 'EXPLICIT_REQUEST'   // 用户显式要求人工
  | 'LEGAL_RISK'         // 法务/舆情风险词
  | 'COMPLAINT'          // 投诉意图或强负面情绪
  | 'KB_MISS_STREAK'     // 连续未命中知识库
  | 'LONG_UNRESOLVED'    // 轮次过多仍未解决
  | 'AGENT_SIGNAL';      // Agent 自主判定需要人工

export interface HandoffDecision {
  shouldHandoff: boolean;
  rule: HandoffRule | null;
  reason: string;
  priority: TicketPriority;
}

const NO_HANDOFF: HandoffDecision = { shouldHandoff: false, rule: null, reason: '', priority: 'medium' };

const LEGAL_RISK_WORDS = ['起诉', '律师', '消协', '12315', '315', '工商局', '媒体', '曝光', '维权', '法院', '仲裁'];

export interface HandoffContext {
  text: string;
  intent: IntentId;
  confidence: number;
  /** 本轮知识库最高相关度 */
  topFaqScore: number;
  /** 连续未命中知识库的轮次 */
  missStreak: number;
  /** 当前会话的用户提问总轮次 */
  userTurns: number;
  /** 会话内负面情绪累计次数 */
  negativeCount: number;
}

export function evaluateHandoff(ctx: HandoffContext): HandoffDecision {
  // R1 显式请求 —— 最高优先级，无条件转接
  if (ctx.intent === 'human_service') {
    return {
      shouldHandoff: true,
      rule: 'EXPLICIT_REQUEST',
      reason: '用户明确要求转接人工客服',
      priority: 'high',
    };
  }

  // R2 法务/舆情风险 —— 立即升级为紧急工单
  const legalHits = containsAny(ctx.text, LEGAL_RISK_WORDS);
  if (legalHits.length > 0) {
    return {
      shouldHandoff: true,
      rule: 'LEGAL_RISK',
      reason: `触及法务或舆情风险词（${legalHits.join('、')}），需专员介入`,
      priority: 'urgent',
    };
  }

  // R3 投诉意图 / 情绪持续恶化
  if (ctx.intent === 'complaint' || (isNegativeSentiment(ctx.text) && ctx.negativeCount >= 2)) {
    return {
      shouldHandoff: true,
      rule: 'COMPLAINT',
      reason: '识别到投诉倾向或持续负面情绪，自动升级人工安抚',
      priority: 'high',
    };
  }

  // R4 连续 3 轮知识库未覆盖
  if (ctx.missStreak >= 3 && ctx.topFaqScore < 0.3) {
    return {
      shouldHandoff: true,
      rule: 'KB_MISS_STREAK',
      reason: `连续 ${ctx.missStreak} 轮未匹配到知识库答案，判定为知识盲区`,
      priority: 'medium',
    };
  }

  // R5 长会话未解决
  if (ctx.userTurns >= 8 && ctx.confidence < 0.5 && ctx.topFaqScore < 0.4) {
    return {
      shouldHandoff: true,
      rule: 'LONG_UNRESOLVED',
      reason: `对话已进行 ${ctx.userTurns} 轮仍未有效收敛，转人工避免体验恶化`,
      priority: 'medium',
    };
  }

  return NO_HANDOFF;
}

/** Agent 回复中的转人工信号标记 */
export const HANDOFF_TOKEN = '[[HANDOFF]]';

export function detectAgentSignal(response: string): boolean {
  return response.includes(HANDOFF_TOKEN);
}

export function stripHandoffToken(response: string): string {
  return response.split(HANDOFF_TOKEN).join('').trim();
}

/** 生成面向用户的转人工话术 */
export function buildHandoffMessage(decision: HandoffDecision, ticketId: string, queuePosition: number): string {
  const head =
    decision.rule === 'EXPLICIT_REQUEST'
      ? '好的，正在为您转接人工客服。'
      : decision.rule === 'LEGAL_RISK' || decision.rule === 'COMPLAINT'
      ? '非常抱歉给您带来了不好的体验，我已将您的问题升级至人工专员优先处理。'
      : '这个问题超出了我当前的知识范围，为避免耽误您的时间，我已为您转接人工客服。';

  return [
    head,
    '',
    `工单编号：**${ticketId.slice(0, 8).toUpperCase()}**`,
    `转接原因：${decision.reason}`,
    `优先级：${{ low: '低', medium: '普通', high: '高', urgent: '紧急' }[decision.priority]}`,
    `当前排队：第 ${queuePosition} 位，预计等待 ${Math.max(1, queuePosition * 2)} 分钟`,
    '',
    '人工客服服务时间为每日 09:00–21:00。在等待期间，您可以继续在此补充问题描述，专员接入后可直接查看完整对话记录，无需重复描述。',
  ].join('\n');
}
