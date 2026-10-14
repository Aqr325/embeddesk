/**
 * 主动式客户关怀评分引擎（Proactive Care）
 *
 * 将客服系统从「被动响应」升级为「主动干预」：基于情绪趋势 + 连续未解决轮次 + 重复接触
 * + 业务意图 + 客户等级，计算风险评分（0-100）。超阈值产出 proactive 建议
 * （主管预警 / 关怀外呼 / 提前介入），可驱动工作流引擎动作。
 *
 * 设计要点：
 *   - 纯确定性评分（无 LLM 依赖），沙箱与真实环境行为一致，现场演示稳定可复现；
 *   - 与情感升级引擎（escalation）互补：情感升级关注「单轮情绪烈度」，本引擎关注
 *     「多轮累积风险与高价值客户」，二者以「取更急」原则合并，只增强不削弱；
 *   - 信号可解释：recommendedAction 与 signals 直接面向坐席/管理后台，支撑「主动关怀」叙事。
 */
import * as db from './db.js';
import { analyzeSentiment } from './sentiment.js';
import { logger } from './logger.js';

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'angry';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ProactiveContext {
  message?: string;
  history?: Array<{ role: string; content: string }>;
  intent?: string | null;
  customerTier?: string | null;
  unresolvedStreak?: number;
  hasOpenTicket?: boolean;
  sessionId?: string;
}

export interface ProactiveResult {
  /** 风险评分 0-100 */
  riskScore: number;
  riskLevel: RiskLevel;
  /** 触发信号（可解释） */
  signals: string[];
  /** 给坐席/系统的建议动作；低风险为 null */
  recommendedAction: string | null;
  /** 是否超阈值需主动干预 */
  shouldIntervene: boolean;
  /** 命中的关怀策略标签（供工作流/看板聚合） */
  careTag?: string;
}

const HIGH_THRESHOLD = 70;
const MEDIUM_THRESHOLD = 40;

/**
 * 计算主动关怀风险评分。
 * 评分子项相互独立累加，便于解释与调参；高价值客户（vip/key）享 1.2× 放大。
 */
export function computeProactiveRisk(ctx: ProactiveContext): ProactiveResult {
  const signals: string[] = [];
  let score = 0;

  const senti: Sentiment | null = ctx.message ? analyzeSentiment(ctx.message).sentiment : null;
  const sentiObj = ctx.message ? analyzeSentiment(ctx.message) : null;
  if (senti === 'angry') {
    score += 40;
    signals.push('当前消息情绪：愤怒');
  } else if (senti === 'negative') {
    score += 25;
    signals.push('当前消息情绪：负面');
  }
  // 情感升级引擎的风险信号（如自伤/法律/投诉升级倾向）直接计入
  if (sentiObj?.risk) {
    score += 20;
    signals.push('检测到高危风险信号');
  }

  // 多轮负面情绪累积
  const negStreak = countNegativeTurns(ctx.history || []);
  if (negStreak >= 2) {
    score += Math.min((negStreak - 1) * 15, 30);
    signals.push(`连续 ${negStreak} 轮负面`);
  }

  // 连续未解决轮次
  const streak = ctx.unresolvedStreak ?? 0;
  if (streak >= 3) {
    score += 20;
    signals.push(`连续 ${streak} 轮未解决`);
  }

  // 业务意图
  if (ctx.intent === 'complaint') {
    score += 15;
    signals.push('意图：投诉');
  } else if (ctx.intent === 'refund') {
    score += 10;
    signals.push('意图：退款/退货');
  }

  // 已有未结工单仍在追问（说明问题未闭环）
  if (ctx.hasOpenTicket && streak >= 1) {
    score += 10;
    signals.push('存在未结工单仍在追问');
  }

  // 重复接触（多次会话）→ 可能体验反复不佳
  if (ctx.sessionId) {
    const custId = db.getSession(ctx.sessionId)?.customer_id;
    if (custId) {
      const prof = db.getCustomerProfile(custId);
      const contacts = prof?.session_count ?? 0;
      if (contacts >= 4) {
        score += 10;
        signals.push(`客户历史接触 ${contacts} 次`);
      }
    }
  }

  // 高价值客户放大（宁可误报不可漏报）
  const tier = ctx.customerTier;
  if (tier === 'vip' || tier === 'key') {
    score = Math.round(score * 1.2);
    signals.push('高价值客户（VIP/重点），优先级放大');
  }

  score = Math.max(0, Math.min(100, score));

  let riskLevel: RiskLevel = 'low';
  let recommendedAction: string | null = null;
  let careTag: string | undefined;
  if (score >= HIGH_THRESHOLD) {
    riskLevel = 'high';
    recommendedAction = '立即主管预警 + 主动外呼关怀，必要时现场介入';
    careTag = '主动预警';
  } else if (score >= MEDIUM_THRESHOLD) {
    riskLevel = 'medium';
    recommendedAction = '坐席主动介入安抚，准备升级预案';
    careTag = '主动关怀';
  }

  const shouldIntervene = riskLevel === 'high';

  return {
    riskScore: score,
    riskLevel,
    signals,
    recommendedAction,
    shouldIntervene,
    careTag,
  };
}

/** 统计历史中负面/愤怒轮次（仅 user 消息） */
function countNegativeTurns(history: Array<{ role: string; content: string }>): number {
  let n = 0;
  for (const m of history) {
    if (m.role !== 'user') continue;
    const s = analyzeSentiment(m.content).sentiment;
    if (s === 'negative' || s === 'angry') n++;
  }
  return n;
}

/**
 * 主动关怀动作落地：将高风险会话的关怀建议推送给工作流引擎，
 * 以「增强」方式合并进升级决策（与 escalation 协同）。返回命中的关怀标签供可观测。
 */
export function proactiveToWorkflowFlag(result: ProactiveResult): { tag?: string; notify?: boolean } {
  if (!result.shouldIntervene) return {};
  logger.info(`[proactive] 高风险会话需主动干预（score=${result.riskScore}）: ${result.recommendedAction}`);
  return { tag: result.careTag, notify: true };
}
