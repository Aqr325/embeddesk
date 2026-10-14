/** 智能客服 Agent —— 前端类型定义 */

export type Theme = 'light' | 'dark';

export type IntentId =
  | 'refund'
  | 'order_query'
  | 'tech_support'
  | 'complaint'
  | 'human_service'
  | 'greeting'
  | 'other';

export interface IntentMeta {
  id: IntentId;
  label: string;
  color: string;
  core: boolean;
  description: string;
}

export interface FaqHitBrief {
  id: string;
  question: string;
  category: string;
  score: number;
}

/** 单轮分析结果（意图 + 知识库 + 订单） */
export interface TurnAnalysis {
  intent: IntentId;
  label: string;
  confidence: number;
  matchedKeywords: string[];
  runnerUp: { intent: IntentId; confidence: number } | null;
  orderNo: string | null;
  orderFound: boolean;
  faqHits: FaqHitBrief[];
  scores: Array<{ intent: IntentId; score: number }>;
}

export interface HandoffInfo {
  ticketId: string;
  rule: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  queuePosition: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  isStreaming?: boolean;
  analysis?: TurnAnalysis;
  handoff?: HandoffInfo;
  source?: string;
  latencyMs?: number;
  noticed?: string;
  rated?: boolean;
  /** 「猜你想问」推荐（知识库未命中时由服务端下发） */
  recommendations?: Array<{ id: string; question: string; category: string; score: number }>;
  /** 智能体编排中枢推理链路（消费 SSE `agentTrace` 事件，可视化「AI 如何决策」） */
  trace?: AgentTrace;
}

export interface SessionSummary {
  id: string;
  title: string;
  customer_name: string | null;
  status: 'active' | 'waiting_human' | 'human_serving' | 'closed';
  primary_intent: IntentId | null;
  handoff: number;
  resolved: number;
  created_at: string;
  updated_at: string;
  messageCount?: number;
}

export interface ConversationRow extends SessionSummary {
  message_count: number;
  avg_rating: number | null;
  ticket_count: number;
  intent_label: string;
  handoff_reason: string | null;
  channel?: string;
  site_name?: string | null;
}

/* ============================ 坐席 Copilot 辅助 ============================ */
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
  intent?: string | null;
}
export interface CopilotSuggestion {
  message: string;
  draftReply: string | null;
  kbHits: CopilotKbHit[];
  insights: CopilotInsight;
  actions: string[];
  /** 主动式客户关怀风险评分（0-100；超阈值需主动干预） */
  risk?: {
    riskScore: number;
    riskLevel: string;
    signals: string[];
    recommendedAction: string | null;
    shouldIntervene: boolean;
    careTag?: string;
  };
}
export interface CopilotExecuteResult {
  ok: boolean;
  ticketId?: string;
  priority?: string;
  message: string;
}

/* ============================ 知识盲区自学习（企业知识助手）============================ */
export interface KnowledgeGap {
  id: string;
  query: string;
  intent: string | null;
  source: string | null;
  missCount: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  resolvedFaqId: string | null;
  sampleSession: string | null;
}
export interface KnowledgeGapStats {
  pending: number;
  resolved: number;
  dismissed: number;
}

/* ============================ 工作流自动化（规则引擎）============================ */
export interface WorkflowConditions {
  intent?: string[];
  sentiment?: string[];
  customerTier?: string[];
  channel?: string[];
  keywords?: string[];
  unresolvedStreakGte?: number;
  hasOpenTicket?: boolean;
}
export interface WorkflowActions {
  escalate?: boolean;
  createTicket?: boolean;
  autoHandoff?: boolean;
  notify?: boolean;
  setPriority?: 'low' | 'medium' | 'high' | 'urgent';
  tag?: string;
}
export interface WorkflowRule {
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

export interface Ticket {
  id: string;
  session_id: string;
  customer_name: string | null;
  intent: string | null;
  reason: string;
  trigger_rule: string | null;
  summary: string | null;
  /** AI 会话摘要产出的客户情绪（positive|neutral|negative|angry） */
  sentiment?: string | null;
  /** 逗号分隔的标签（AI 摘要或人工归类） */
  tags?: string | null;
  /** 是否经情感/风险智能升级（0/1） */
  escalated?: number;
  /** 智能升级触发原因 */
  escalation_reason?: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'pending' | 'processing' | 'resolved' | 'closed';
  assignee: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Faq {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string;
  enabled: number;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

export interface SatisfactionRecord {
  id: string;
  session_id: string;
  message_id: string | null;
  rating: number;
  tags: string | null;
  comment: string | null;
  resolved: number;
  created_at: string;
}

export interface DashboardStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  handoffSessions: number;
  handoffRate: number;
  resolutionRate: number;
  avgRating: number;
  ratingCount: number;
  npsLike: number;
  intentDistribution: Array<{ intent: string; count: number; label: string; color: string }>;
  ratingDistribution: Array<{ rating: number; count: number }>;
  dailyTrend: Array<{ date: string; sessions: number; messages: number; avgRating: number | null }>;
  topFaqs: Array<{ id: string; question: string; category: string; hit_count: number }>;
  ticketStats: Array<{ status: string; count: number }>;
  avgLatencyMs: number;
  kbHitRate: number;
  /** 渠道分布（web / embed / email / im） */
  channelDistribution: Array<{ channel: string; count: number }>;
  /** 客户等级分布（new / regular / vip） */
  customerTierDistribution: Array<{ tier: string; count: number }>;
  /** 未结工单按优先级分布 */
  unresolvedByPriority: Array<{ priority: string; count: number }>;
  /** 工单 SLA 概览：未结总数 / 已超时 / 在时限内 */
  ticketSla: { open: number; breached: number; withinSla: number };
  /** 首次响应时延（秒）：均值 / 中位数 / P95 与样本量 */
  responseTimes: { avg: number; median: number; p95: number; sampleSize: number };
}

/** 事件流洞察聚合（server/insights.ts getInsights；方案 §8 D5 后台洞察页） */
export interface InsightsData {
  /** 数据来源：bigquery=真实事件流；local=本地 JSONL 兜底；empty=无数据 */
  source: 'bigquery' | 'local' | 'empty';
  /** 统计窗口（天） */
  windowDays: number;
  totals: {
    questions: number;
    searchHits: number;
    tickets: number;
    latencySamples: number;
  };
  /** 检索命中率（百分比，0–100） */
  searchHitRate: number;
  /** TOP 知识点（search_hit.docId 聚合） */
  topDocs: Array<{ docId: string; label: string; count: number }>;
  /** 热门查询（question.query 聚合） */
  topQueries: Array<{ query: string; count: number }>;
  /** 渠道分布（question.channel） */
  channelDistribution: Array<{ channel: string; count: number }>;
  /** 工单趋势（ticket_created 按天） */
  ticketTrend: Array<{ date: string; tickets: number }>;
  /** 提问趋势（question 按天） */
  questionTrend: Array<{ date: string; questions: number }>;
  /** 本赛事数据为演示数据（方案 §7 统一口径） */
  demo: boolean;
}

export interface AppMeta {
  brand: string;
  mode: string;
  sdkAvailable: boolean;
  engine: string;
  intents: IntentMeta[];
  faqCount: number;
}

export const INTENT_COLORS: Record<string, string> = {
  refund: '#e37318',
  order_query: '#0052d9',
  tech_support: '#00a870',
  complaint: '#d54941',
  human_service: '#8e56dd',
  greeting: '#8b8b8b',
  other: '#606060',
  general: '#606060',
};

export const INTENT_LABELS: Record<string, string> = {
  refund: '退款退货',
  order_query: '订单查询',
  tech_support: '技术支持',
  complaint: '投诉抱怨',
  human_service: '转人工',
  greeting: '寒暄问候',
  other: '其它咨询',
  general: '通用政策',
};

/* ============================ 智能体编排中枢（Agent Orchestration Hub）============================ */
export type OrchestratorStepStatus = 'ok' | 'skip' | 'warn';
export interface OrchestratorStep {
  id: string;
  label: string;
  status: OrchestratorStepStatus;
  detail: string;
  latencyMs: number;
}
export type FinalAction = 'answer' | 'handoff' | 'ticket' | 'proactive_alert';
export interface AgentTrace {
  runId: string;
  sessionId: string | null;
  channel: string | null;
  startedAt: number;
  finishedAt: number;
  steps: OrchestratorStep[];
  intent: string | null;
  intentLabel: string;
  knowledgeHit: boolean;
  topScore: number;
  sentiment: string | null;
  sentimentScore: number;
  riskScore: number;
  riskLevel: string;
  workflowMatched: string[];
  finalAction: FinalAction;
  model: string | null;
  source: string | null;
  proactiveAction: string | null;
}

/* ============================ AI 成效看板（Impact Dashboard）============================ */
export interface ImpactKpi {
  /** 自助解决率：编排以「知识库直答」闭环的会话占比 */
  selfServiceRate: number;
  /** 副驾驶采纳率：由 AI 副驾驶一键执行创建的工单占比 */
  copilotAdoptionRate: number;
  /** 工作流自动执行率：编排命中工作流规则的会话占比 */
  workflowAutoRate: number;
  /** 知识盲区收敛率：已补全/处理的盲区占历史盲区总量比例 */
  gapClosureRate: number;
  /** 平均编排时延（ms） */
  avgLatencyMs: number;
}
export interface ImpactData {
  source: 'db' | 'empty';
  windowDays: number;
  totals: {
    runs: number;
    tickets: number;
    copilotTickets: number;
    workflowHits: number;
    gaps: number;
    gapsResolved: number;
    anomalies: number;
  };
  kpis: ImpactKpi;
  /** 动作分布趋势（按天）：自助回复 vs 转人工 */
  actionTrend: Array<{ date: string; answer: number; handoff: number }>;
  /** 风险趋势（按天）：平均风险分 + 高风险会话数 */
  riskTrend: Array<{ date: string; avgRisk: number; high: number }>;
  /** 工作流规则命中 TOP */
  workflowTop: Array<{ name: string; hits: number }>;
  /** 本赛事数据为演示数据（方案 §7 统一口径），前端显式标注 */
  demo: boolean;
}

/* ============================ 端侧遥测（Edge Telemetry）============================ */
export interface DeviceTelemetry {
  id: string;
  device_id: string;
  product: string | null;
  model: string | null;
  snapshot: string | null;
  anomaly: number;
  anomaly_reason: string | null;
  ticket_id: string | null;
  created_at: string;
}

/* ============================ 智能体编排留痕（agent_runs 列表）============================ */
export interface AgentRunRow {
  id: string;
  session_id: string | null;
  channel: string | null;
  intent: string | null;
  knowledge_hit: number;
  top_score: number;
  sentiment: string | null;
  sentiment_score: number | null;
  risk_score: number | null;
  risk_level: string | null;
  workflow_matched: string | null;
  final_action: string | null;
  model: string | null;
  source: string | null;
  steps: string | null;
  latency_ms: number | null;
  created_at: string;
}

export const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  waiting_human: '等待人工',
  human_serving: '人工服务中',
  closed: '已结束',
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: '低',
  medium: '普通',
  high: '高',
  urgent: '紧急',
};

export const SENTIMENT_LABELS: Record<string, string> = {
  positive: '正面',
  neutral: '中性',
  negative: '负面',
  angry: '愤怒',
};

export const TICKET_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};
