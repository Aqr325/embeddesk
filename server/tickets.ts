/**
 * 工单分配与优先级引擎
 *
 * 职责边界（与 handoff.ts 区分）：
 *  - handoff.ts 负责「是否转人工」的短路决策（基于会话上下文规则）；
 *  - 本模块负责「转人工之后」的工程化处理：依据意图紧急度、客户等级、知识盲区、
 *    长会话、负面情绪等维度综合计算优先级，推导 SLA 时限，并执行坐席分配。
 * 两个模块通过 runChatPipeline 串联：先 handoff 判定「要不要转」，再本模块决定「多急、给谁」。
 *
 * 设计原则：优先级与 SLA 均「可解释」——computePriority 返回打分明细与理由，便于
 * 后台展示与审计；分配默认负载均衡，保证小团队不过载、分配稳定可复现。
 */
import * as db from './db.js';
import type { IntentId } from './intent.js';
import { logger } from './logger.js';

/** 意图紧急度基线：决定同档优先级的排序权重（不覆盖 handoff 的显式 urgent 规则） */
export const INTENT_PRIORITY_WEIGHT: Record<IntentId, number> = {
  human_service: 0, // 已被 handoff 显式转人工规则接管，不在此二次加权
  complaint: 8,
  refund: 6,
  tech_support: 5,
  order_query: 3,
  other: 2,
  greeting: 1,
};

/** 客户等级加权：VIP 客户工单获得更高优先级 */
const TIER_WEIGHT: Record<string, number> = { vip: 2, regular: 1, new: 0 };

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

/** SLA 时限矩阵（分钟）：优先级越高，响应时限越短 */
export const SLA_MINUTES: Record<TicketPriority, number> = {
  urgent: 30,
  high: 120,
  medium: 480,
  low: 1440,
};

export interface PriorityInput {
  intent: IntentId;
  /** 客户等级（来自画像 tier），缺省按 new 处理 */
  customerTier?: string;
  /** 连续未命中知识库轮次 */
  missStreak?: number;
  /** 用户提问总轮次 */
  userTurns?: number;
  /** 会话内负面情绪累计次数 */
  negativeCount?: number;
}

export interface PriorityResult {
  priority: TicketPriority;
  /** 综合优先级分值（用于排序与展示） */
  score: number;
  reasons: string[];
}

/**
 * 综合优先级计算。各维度权重经过平衡，使：
 *  - 投诉 + VIP 客户 → 直接 high/urgent
 *  - 单纯长会话 / 知识盲区 → medium
 *  - 普通咨询 → low/medium
 * 阈值与 handoff 的 urgent/high 短路规则互补，避免重复升级。
 */
export function computePriority(input: PriorityInput): PriorityResult {
  let score = 0;
  const reasons: string[] = [];

  const base = INTENT_PRIORITY_WEIGHT[input.intent] ?? 2;
  score += base;
  reasons.push(`意图「${input.intent}」基线 +${base}`);

  const tier = input.customerTier || 'new';
  const tw = TIER_WEIGHT[tier] ?? 0;
  if (tw > 0) {
    score += tw;
    reasons.push(`客户等级（${tier}） +${tw}`);
  }

  const miss = input.missStreak ?? 0;
  if (miss >= 3) {
    score += 3;
    reasons.push(`连续 ${miss} 轮未命中知识库 +3`);
  }

  const turns = input.userTurns ?? 0;
  if (turns >= 8) {
    score += 2;
    reasons.push(`长会话 ${turns} 轮 +2`);
  }

  const neg = input.negativeCount ?? 0;
  if (neg >= 2) {
    score += 2;
    reasons.push(`累计 ${neg} 次负面情绪 +2`);
  }

  let priority: TicketPriority = 'medium';
  if (score >= 12) priority = 'urgent';
  else if (score >= 8) priority = 'high';
  else if (score >= 4) priority = 'medium';
  else priority = 'low';

  return { priority, score, reasons };
}

/** 依据优先级与创建时间推导 SLA 截止时间（ISO 字符串） */
export function computeSlaDue(priority: TicketPriority, createdAt?: string): string {
  const created = createdAt ? new Date(createdAt) : new Date();
  const due = new Date(created.getTime() + SLA_MINUTES[priority] * 60000);
  return due.toISOString();
}

export type AssignStrategy = 'load_balance' | 'skill_match';

export interface AssignResult {
  assignee: string | null;
  strategy: AssignStrategy;
}

/**
 * 工单分配：
 *  - preferredAgentId 指定时优先（用于手动指派 / 技能匹配覆盖），并标记为 skill_match；
 *  - 否则默认「负载均衡」：选取当前未结工单最少的在职坐席（agent/manager），
 *    同负载时 manager 优先（资深兜底），再按 id 稳定排序，保证分配可复现、不倾斜。
 * 无在职坐席时返回 null（工单进入公共队列，由管理员后续认领）。
 */
export function assignTicket(
  _intent: IntentId,
  opts: { preferredAgentId?: string | null; strategy?: AssignStrategy } = {},
): AssignResult {
  const agents = db
    .listUsers()
    .filter((u) => u.status === 'active' && (u.role === 'agent' || u.role === 'manager'));
  if (!agents.length) return { assignee: null, strategy: 'load_balance' };

  if (opts.preferredAgentId) {
    const pref = agents.find((a) => a.id === opts.preferredAgentId);
    if (pref) return { assignee: pref.id, strategy: opts.strategy ?? 'skill_match' };
  }

  // 计算每位坐席的未结工单负载（pending / processing）
  const openCounts = new Map<string, number>();
  for (const a of agents) {
    const open = db
      .getTicketsByAssignee(a.id)
      .filter((t) => t.status === 'pending' || t.status === 'processing').length;
    openCounts.set(a.id, open);
  }

  const sorted = [...agents].sort((x, y) => {
    const cx = openCounts.get(x.id)!;
    const cy = openCounts.get(y.id)!;
    if (cx !== cy) return cx - cy; // 负载轻者优先
    const rx = x.role === 'manager' ? 0 : 1;
    const ry = y.role === 'manager' ? 0 : 1;
    if (rx !== ry) return rx - ry; // 同负载资深优先
    return x.id < y.id ? -1 : 1; // 稳定兜底
  });

  return { assignee: sorted[0].id, strategy: opts.strategy ?? 'load_balance' };
}

/**
 * 补算存量工单的 SLA 截止时间（无 sla_due_at 的历史工单迁移用）。
 * 返回受影响行数。幂等：已有 sla_due_at 的不再覆盖。
 */
export function backfillSlaDue(): number {
  try {
    const tickets = db.getTickets().filter((t) => !t.sla_due_at);
    let n = 0;
    for (const t of tickets) {
      const due = computeSlaDue(t.priority as TicketPriority, t.created_at);
      if (db.updateTicket(t.id, { sla_due_at: due } as any)) n += 1;
    }
    if (n) logger.info(`[tickets] 已为 ${n} 张存量工单补算 SLA 截止时间`);
    return n;
  } catch (e) {
    logger.warn(`[tickets] backfillSlaDue 失败: ${(e as Error)?.message || e}`);
    return 0;
  }
}
