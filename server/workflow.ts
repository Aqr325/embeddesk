/**
 * 工作流自动化引擎（Workflow Automation）
 *
 * 「条件 → 动作」可视化规则引擎。运营在后台编排规则，对所有建单路径统一生效：
 *   意图 / 情绪 / 客户等级 / 渠道 / 关键词 / 连续未解决轮次
 *     → 升级转人工 / 建工单 / 提升优先级 / 通知值班 / 打标签
 *
 * 设计要点：
 *   - 结构化条件求值（绝不 eval 用户输入），同字段多值为 OR、不同字段为 AND；
 *   - 由 escalation.escalateFromContext 统一调用，规则动作以「增强」方式合并进升级决策
 *     （只提升优先级 / 触发通知 / 强制升级，不削弱情感升级引擎的既有决策）；
 *   - 命中计数（hit_count）供可观测：哪些规则真正在起作用；
 *   - 纯读 + 求值无外部副作用，notify 交由调用方既有链路执行，避免循环依赖。
 */
import * as db from './db.js';
import type { DbWorkflowRule, TicketPriority } from './db.js';
import { logger } from './logger.js';

export interface WorkflowConditions {
  /** 命中任一意图（refund/order_query/tech_support/complaint/human_service…） */
  intent?: string[];
  /** 命中任一情绪（positive/neutral/negative/angry） */
  sentiment?: string[];
  /** 命中任一客户等级（new/regular/vip/key） */
  customerTier?: string[];
  /** 命中任一渠道（web/embed/email/im） */
  channel?: string[];
  /** 消息包含任一关键词 */
  keywords?: string[];
  /** 连续未解决轮次 ≥ N */
  unresolvedStreakGte?: number;
  /** 是否已有未结工单 */
  hasOpenTicket?: boolean;
}

export interface WorkflowActions {
  /** 触发智能升级（转人工） */
  escalate?: boolean;
  /** 建工单 */
  createTicket?: boolean;
  /** 强制转人工（即使原路径未转） */
  autoHandoff?: boolean;
  /** 触发通知（企点/邮件/Webhook） */
  notify?: boolean;
  /** 覆盖优先级（与既有决策取更急者） */
  setPriority?: TicketPriority;
  /** 打标签（追加到工单 tags） */
  tag?: string;
}

export interface WorkflowEvalContext {
  channel?: string | null;
  customerTier?: string | null;
  intent?: string | null;
  message?: string;
  sentiment?: string | null;
  unresolvedStreak?: number;
  hasOpenTicket?: boolean;
}

export interface WorkflowBoost {
  /** 命中的规则名（用于决策原因与可观测） */
  matchedRules: string[];
  priority?: TicketPriority;
  forceEscalate: boolean;
  forceCreateTicket: boolean;
  forceAutoHandoff: boolean;
  forceNotify: boolean;
  tag?: string;
}

const PRANK: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
function higher(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return (PRANK[a] ?? 0) >= (PRANK[b] ?? 0) ? a : b;
}

/** 结构化条件求值：同字段多值 OR，不同字段 AND；无任何条件字段视为恒真（谨慎使用） */
function matchConditions(c: WorkflowConditions, ctx: WorkflowEvalContext): boolean {
  const { intent, sentiment, customerTier, channel } = ctx;
  if (c.intent?.length && (!intent || !c.intent.includes(intent))) return false;
  if (c.sentiment?.length && (!sentiment || !c.sentiment.includes(sentiment))) return false;
  if (c.customerTier?.length && (!customerTier || !c.customerTier.includes(customerTier))) return false;
  if (c.channel?.length && (!channel || !c.channel.includes(channel))) return false;
  if (c.keywords?.length) {
    const msg = ctx.message || '';
    if (!c.keywords.some((k) => msg.includes(k))) return false;
  }
  if (c.unresolvedStreakGte != null && (ctx.unresolvedStreak ?? 0) < c.unresolvedStreakGte) return false;
  if (c.hasOpenTicket != null && Boolean(ctx.hasOpenTicket) !== c.hasOpenTicket) return false;
  return true;
}

/**
 * 规则求值（纯读 + 结构化匹配，无外部副作用执行）。
 * 由 escalation.escalateFromContext 在所有建单路径统一调用。
 */
export function evaluateWorkflow(ctx: WorkflowEvalContext): WorkflowBoost {
  const empty: WorkflowBoost = {
    matchedRules: [],
    forceEscalate: false,
    forceCreateTicket: false,
    forceAutoHandoff: false,
    forceNotify: false,
  };
  let rules: DbWorkflowRule[] = [];
  try {
    rules = db.listWorkflowRules(true);
  } catch (e) {
    logger.warn(`[workflow] 加载规则失败: ${(e as Error).message}`);
    return empty;
  }
  const matched: DbWorkflowRule[] = [];
  for (const r of rules) {
    try {
      if (matchConditions(JSON.parse(r.conditions) as WorkflowConditions, ctx)) matched.push(r);
    } catch {
      /* 跳过损坏规则 */
    }
  }
  if (!matched.length) return empty;

  let priority: string | undefined;
  let forceEscalate = false;
  let forceCreateTicket = false;
  let forceAutoHandoff = false;
  let forceNotify = false;
  let tag: string | undefined;
  for (const r of matched) {
    try {
      const a = JSON.parse(r.actions) as WorkflowActions;
      if (a.setPriority) priority = higher(priority, a.setPriority);
      if (a.escalate) forceEscalate = true;
      if (a.createTicket) forceCreateTicket = true;
      if (a.autoHandoff) forceAutoHandoff = true;
      if (a.notify) forceNotify = true;
      if (a.tag) tag = tag ? `${tag},${a.tag}` : a.tag;
    } catch {
      /* 跳过损坏动作 */
    }
  }
  try {
    db.bumpWorkflowRuleHits(matched.map((r) => r.id));
  } catch {
    /* 命中计数失败不影响主链路 */
  }
  return {
    matchedRules: matched.map((r) => r.name),
    priority: priority as TicketPriority | undefined,
    forceEscalate,
    forceCreateTicket,
    forceAutoHandoff,
    forceNotify,
    tag,
  };
}

/* ============================ 规则 CRUD（管理后台可视化编排） ============================ */

export interface WorkflowRuleView {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  conditions: WorkflowConditions;
  actions: WorkflowActions;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function mapRule(r: DbWorkflowRule): WorkflowRuleView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled === 1,
    priority: r.priority,
    conditions: safeParse<WorkflowConditions>(r.conditions, {}),
    actions: safeParse<WorkflowActions>(r.actions, {}),
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRules(): WorkflowRuleView[] {
  return db.listWorkflowRules(false).map(mapRule);
}

export function getRule(id: string): WorkflowRuleView | null {
  const r = db.getWorkflowRule(id);
  return r ? mapRule(r) : null;
}

export function createRule(input: {
  name: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  conditions: WorkflowConditions;
  actions: WorkflowActions;
}): WorkflowRuleView {
  return mapRule(
    db.createWorkflowRule({
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled === false ? 0 : 1,
      priority: input.priority ?? 100,
      conditions: JSON.stringify(input.conditions),
      actions: JSON.stringify(input.actions),
    }),
  );
}

export function updateRule(
  id: string,
  patch: {
    name?: string;
    description?: string;
    enabled?: boolean;
    priority?: number;
    conditions?: WorkflowConditions;
    actions?: WorkflowActions;
  },
): WorkflowRuleView | null {
  const p: Partial<DbWorkflowRule> = {};
  if (patch.name != null) p.name = patch.name;
  if (patch.description != null) p.description = patch.description;
  if (patch.enabled != null) p.enabled = patch.enabled ? 1 : 0;
  if (patch.priority != null) p.priority = patch.priority;
  if (patch.conditions != null) p.conditions = JSON.stringify(patch.conditions);
  if (patch.actions != null) p.actions = JSON.stringify(patch.actions);
  const r = db.updateWorkflowRule(id, p);
  return r ? mapRule(r) : null;
}

export function deleteRule(id: string): boolean {
  return db.deleteWorkflowRule(id);
}

/** 预置默认规则（仅当表为空时），开箱即用的工作流自动化基线 */
export function seedDefaultRules(): number {
  if (db.countWorkflowRules(false) > 0) return 0;
  const defaults: Array<Parameters<typeof createRule>[0]> = [
    {
      name: '重点客户负面情绪紧急升级',
      description: 'VIP/重点客户出现负面或愤怒情绪时，紧急优先级并强制通知',
      priority: 10,
      conditions: { customerTier: ['vip', 'key'], sentiment: ['negative', 'angry'] },
      actions: { escalate: true, autoHandoff: true, notify: true, setPriority: 'urgent', tag: '重点客诉' },
    },
    {
      name: '退款意图高优先级跟进',
      description: '客户表达退款/退货意图时，提高优先级便于人工主动跟进',
      priority: 20,
      conditions: { intent: ['refund'] },
      actions: { setPriority: 'high', notify: true, tag: '退款跟进' },
    },
    {
      name: '多轮未解决自动升级',
      description: '同一会话连续 3 轮未解决，自动升级人工',
      priority: 30,
      conditions: { unresolvedStreakGte: 3 },
      actions: { escalate: true, setPriority: 'high', notify: true, tag: '多轮未解决' },
    },
    {
      name: '投诉意图强制通知',
      description: '识别到投诉意图时强制通知值班，防舆情放大',
      priority: 40,
      conditions: { intent: ['complaint'] },
      actions: { notify: true, setPriority: 'high', escalate: true, tag: '投诉预警' },
    },
  ];
  for (const d of defaults) createRule(d);
  logger.info(`[workflow] 已预置 ${defaults.length} 条默认工作流规则`);
  return defaults.length;
}
