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
