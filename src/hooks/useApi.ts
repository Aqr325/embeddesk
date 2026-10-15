/** 后端 API 客户端 —— 严格对齐 server/index.ts 的接口契约 */
import type {
  AppMeta,
  DashboardStats,
  ConversationRow,
  Ticket,
  Faq,
  SatisfactionRecord,
  IntentId,
  CopilotSuggestion,
  CopilotExecuteResult,
  InsightsData,
  KnowledgeGap,
  KnowledgeGapStats,
  WorkflowRule,
  WorkflowConditions,
  WorkflowActions,
  ImpactData,
  DeviceTelemetry,
  AgentRunRow,
  DeviceHealthData,
  RootCauseData,
} from '../types';

const BASE = '/api';
const TOKEN_KEY = 'csa_admin_token';

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function notifyUnauthorized() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('csa:unauthorized'));
}

async function http<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + url, { headers, ...options });

  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const e = await res.json();
      if (e?.error) msg = e.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** 裸请求封装：供需要原始响应体（CSV / Prometheus 文本 / 二进制备份）的接口复用，
 *  与 http 共用同一套鉴权头与 401 失效处理，避免三处重复实现。返回原始 Response，
 *  由调用方按需读取 text()/blob() 与响应头（如 Content-Disposition 文件名）。 */
async function rawRequest(url: string): Promise<Response> {
  const token = getToken();
  const res = await fetch(BASE + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  return res;
}

export type SessionStatus = 'active' | 'waiting_human' | 'human_serving' | 'closed';

export interface SessionDTO {
  id: string;
  title: string;
  customer_name: string | null;
  status: SessionStatus;
  primary_intent: IntentId | null;
  handoff: number;
  resolved: number;
  created_at: string;
  updated_at: string;
  model?: string;
  sdk_session_id?: string | null;
  messageCount?: number;
}

export interface HistoryMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  intent?: IntentId | null;
  intent_confidence?: number | null;
  faq_ids?: string | null;
  source?: string | null;
  latency_ms?: number | null;
}

export interface HistoryResponse {
  session: SessionDTO;
  messages: HistoryMessage[];
  tickets: Ticket[];
  satisfaction: SatisfactionRecord[];
}

export interface DbMeta {
  dbPath: string;
  sizeBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  schemaVersion: number;
  journalMode: string;
  pageSize: number;
}

export interface DbIntegrity {
  ok: boolean;
  integrity: string[];
  foreignKeyIssues: Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  tableCounts: Record<string, number>;
}

export interface DbVacuumResult {
  success: boolean;
  sizeBefore: number;
  sizeAfter: number;
  reclaimedBytes: number;
}

export interface MetricsSnapshot {
  uptimeSec: number;
  startedAt: string;
  total: number;
  byBucket: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  samples: number;
  /** KB 检索 LRU 缓存指标（与「答案命中率」语义不同：本组衡量检索被缓存直接返回、跳过整轮打分的收益） */
  kbCache?: {
    lruSize: number;
    lruMax: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  /** RAG 检索增强指标（同义词扩展召回 + 可选语义向量融合） */
  rag?: {
    enabled: boolean;
    semantic: boolean;
    retrievals: number;
    expanded: number;
    semanticUsed: number;
  };
}

/** CSAT 满意度问卷聚合统计（对齐 server/db.ts getCsatStats） */
export interface CsatStats {
  total: number;
  responded: number;
  pending: number;
  expired: number;
  /** 回收率（响应数 / 派发数，百分比） */
  responseRate: number;
  avgRating: number;
  ratingCount: number;
  /** NPS 近似：好评率 - 差评率（rating>=4 为正，<=2 为负），百分比 */
  npsLike: number;
  ratingDistribution: Array<{ rating: number; count: number }>;
  byChannel: Array<{ channel: string; total: number; responded: number }>;
  recent: Array<{
    token: string;
    channel: string;
    rating: number | null;
    comment: string | null;
    responded_at: string | null;
    created_at: string;
  }>;
}

export type EmployeeRole = 'admin' | 'manager' | 'agent';
export type EmployeeStatus = 'active' | 'disabled';

/** 大模型配置（对外脱敏形态：apiKey 不返回明文，仅 hasApiKey 布尔） */
export interface LlmConfigPublic {
  model: string;
  hasApiKey: boolean;
  endpoint: string;
  temperature: number;
  maxReplyLength: number;
  systemPrompt: string;
  updatedAt: string;
}

export interface LlmConfigTestResult {
  ok: boolean;
  usedModel?: string;
  latencyMs?: number;
  reply?: string;
  error?: string;
}

export interface Employee {
  id: string;
  username: string;
  display_name: string;
  role: EmployeeRole;
  status: EmployeeStatus;
  created_at: string;
  updated_at: string;
}

export interface CustomerProfile {
  customer_id: string;
  name: string;
  company: string;
  industry: string;
  contact: string;
  tags: string;
  preferences: string;
  notes: string;
  history_summary: string;
  last_session_id: string | null;
  session_count: number;
  updated_at: string;
}

/** 接入站点（嵌入渠道）。列表项不含 embed_token（敏感），创建时返回的 Site 含 token */
export interface Site {
  id: string;
  site_id: string;
  name: string;
  domain: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
  embed_token?: string;
  session_count?: number;
}

export const api = {
  getMeta: () => http<AppMeta & { mode: string; engine: string }>('/meta'),

  /** 公开模型列表（无需鉴权），供「模型配置」下拉框使用 */
  getModels: () => http<{ models: Array<{ modelId: string; name: string }>; defaultModel: string; sdkBroken: boolean }>('/models'),

  listSessions: () => http<{ sessions: SessionDTO[] }>('/sessions'),

  createSession: (customerName?: string) =>
    http<{ session: SessionDTO }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ customerName: customerName ?? '访客用户' }),
    }),

  getSession: (id: string) => http<HistoryResponse>(`/sessions/${id}`),

  closeSession: (id: string, resolved = true) =>
    http<{ success: boolean }>(`/sessions/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),

  getTickets: (status?: string) =>
    http<{ tickets: Ticket[] }>('/tickets' + (status ? `?status=${encodeURIComponent(status)}` : '')),

  updateTicket: (
    id: string,
    patch: Partial<Pick<Ticket, 'status' | 'assignee' | 'note' | 'priority'>>,
  ) => http<{ success: boolean }>(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  getFaqs: (category?: string) =>
    http<{ faqs: Faq[] }>('/faqs' + (category ? `?category=${encodeURIComponent(category)}` : '')),

  /** 坐席 Copilot 辅助：基于会话/客户消息返回草稿、知识库参考、画像洞察与下一步动作 */
  copilotSuggest: (body: { sessionId?: string; customerId?: string; message: string }) =>
    http<CopilotSuggestion>('/copilot/suggest', { method: 'POST', body: JSON.stringify(body) }),

  /** 坐席 Copilot 一键执行：确认后直接建单 / 升级转人工（AI 副驾驶） */
  copilotExecute: (body: { sessionId: string; action: 'create_ticket' | 'escalate'; message?: string }) =>
    http<CopilotExecuteResult>('/copilot/execute', { method: 'POST', body: JSON.stringify(body) }),

  createFaq: (data: {
    category: string;
    question: string;
    answer: string;
    keywords?: string;
    enabled?: number;
  }) => http<{ faq: Faq }>('/faqs', { method: 'POST', body: JSON.stringify(data) }),

  deleteFaq: (id: string) => http<{ success: boolean }>(`/faqs/${id}`, { method: 'DELETE' }),

  postSatisfaction: (data: {
    sessionId: string;
    messageId?: string | null;
    rating: number;
    tags?: string[];
    comment?: string;
    resolved?: boolean;
  }) => http<{ satisfaction: SatisfactionRecord }>('/satisfaction', { method: 'POST', body: JSON.stringify(data) }),

  adminStats: () => http<DashboardStats>('/admin/stats'),

  adminConversations: (params: { status?: string; intent?: string; keyword?: string; channel?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.intent) qs.set('intent', params.intent);
    if (params.keyword) qs.set('keyword', params.keyword);
    if (params.channel) qs.set('channel', params.channel);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const q = qs.toString();
    return http<{ conversations: ConversationRow[]; total: number; page: number; pageSize: number }>(
      '/admin/conversations' + (q ? `?${q}` : ''),
    );
  },

  /** 导出对话记录为 CSV 文本（需管理员鉴权，由调用方触发下载） */
  exportConversations: async (params: { status?: string; intent?: string; keyword?: string; channel?: string } = {}): Promise<string> => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.intent) qs.set('intent', params.intent);
    if (params.keyword) qs.set('keyword', params.keyword);
    if (params.channel) qs.set('channel', params.channel);
    const q = qs.toString();
    return (await rawRequest('/admin/conversations/export' + (q ? `?${q}` : ''))).text();
  },

  getOrders: () => http<{ orders: Array<Record<string, unknown>> }>('/orders'),

  resetDemo: () => http<{ success: boolean; seeded: number }>('/admin/reset-demo', { method: 'POST' }),

  /* ---------- 数据管理（备份 / 完整性 / 空间回收） ---------- */
  dbMeta: () => http<DbMeta>('/admin/db/meta'),

  dbIntegrity: () => http<DbIntegrity>('/admin/db/integrity'),

  dbVacuum: () => http<DbVacuumResult>('/admin/db/vacuum', { method: 'POST' }),

  getMetrics: () => http<MetricsSnapshot>('/admin/metrics'),

  /** CSAT 满意度问卷聚合统计（需管理员鉴权） */
  getCsat: () => http<CsatStats>('/admin/csat'),

  /** 事件流洞察聚合（需管理员鉴权；BigQuery 优先，本地 JSONL 兜底） */
  getInsights: () => http<InsightsData>('/admin/insights'),

  /** 获取 Prometheus text exposition（需管理员鉴权，由调用方触发下载或展示） */
  getPrometheus: async (): Promise<string> => (await rawRequest('/admin/metrics/prometheus')).text(),

  /** 下载数据库一致性快照（流式，触发浏览器下载） */
  dbBackup: async (): Promise<void> => {
    const res = await rawRequest('/admin/db/backup');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disposition = res.headers.get('Content-Disposition') || '';
    const m = disposition.match(/filename="?([^";]+)"?/);
    const filename = m ? m[1] : `chat-backup-${Date.now()}.db`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /* ---------- 员工 / 坐席管理 ---------- */
  getEmployees: () => http<{ employees: Employee[] }>('/employees'),

  createEmployee: (data: { username: string; display_name?: string; role: EmployeeRole; password: string }) =>
    http<{ employee: Employee }>('/employees', { method: 'POST', body: JSON.stringify(data) }),

  updateEmployee: (
    id: string,
    patch: { role?: EmployeeRole; status?: EmployeeStatus; display_name?: string; password?: string },
  ) => http<{ employee: Employee }>(`/employees/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteEmployee: (id: string) => http<{ ok: boolean }>(`/employees/${id}`, { method: 'DELETE' }),

  /* ---------- 数据导入 ---------- */
  importFaqs: (format: 'json' | 'csv', data: unknown) =>
    http<{ imported: number; errors: string[] }>('/admin/import/faqs', {
      method: 'POST',
      body: JSON.stringify({ format, data }),
    }),

  /* ---------- 客户长期画像 ---------- */
  getCustomerProfile: (customerId: string) =>
    http<{ profile: CustomerProfile | null }>(`/customers/${encodeURIComponent(customerId)}/profile`),

  upsertCustomerProfile: (customerId: string, data: Partial<CustomerProfile>) =>
    http<{ profile: CustomerProfile }>(`/customers/${encodeURIComponent(customerId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  /* ---------- 接入站点（嵌入渠道） ---------- */
  getSites: () => http<{ sites: Site[] }>('/admin/sites'),

  /** 创建站点：仅此刻返回含 embed_token 的完整 Site（用于生成嵌入码） */
  createSite: (data: { name: string; domain?: string }) =>
    http<{ site: Site }>('/admin/sites', { method: 'POST', body: JSON.stringify(data) }),

  updateSite: (id: string, patch: { name?: string; domain?: string; status?: 'active' | 'disabled' }) =>
    http<{ site: Site }>(`/admin/sites/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** 软停用站点（保留历史会话数据） */
  deleteSite: (id: string) => http<{ success: boolean }>(`/admin/sites/${id}`, { method: 'DELETE' }),

  /* ---------- 大模型（LLM）配置 ---------- */
  getLlmConfig: () => http<{ config: LlmConfigPublic }>('/admin/llm-config'),

  saveLlmConfig: (data: Partial<Pick<LlmConfigPublic, 'model' | 'endpoint' | 'temperature' | 'maxReplyLength' | 'systemPrompt'>> & { apiKey?: string }) =>
    http<{ config: LlmConfigPublic }>('/admin/llm-config', { method: 'POST', body: JSON.stringify(data) }),

  testLlmConfig: () => http<LlmConfigTestResult>('/admin/llm-config/test', { method: 'POST' }),

  /* ---------- 知识盲区自学习（企业知识助手） ---------- */
  getKnowledgeGaps: (status = 'pending') =>
    http<{ gaps: KnowledgeGap[]; stats: KnowledgeGapStats }>(`/admin/knowledge-gaps?status=${status}`),

  /** 一键从盲区补全 FAQ（补全即消解盲区，自进化闭环终点） */
  createFaqFromGap: (id: string, data: { answer: string; category?: string }) =>
    http<{ faq: Faq }>(`/admin/knowledge-gaps/${id}/create-faq`, { method: 'POST', body: JSON.stringify(data) }),

  /** 标记盲区已解决（可关联 FAQ） */
  resolveKnowledgeGap: (id: string, faqId?: string) =>
    http<{ success: boolean }>(`/admin/knowledge-gaps/${id}/resolve`, { method: 'POST', body: JSON.stringify({ faqId }) }),

  /** 忽略盲区（误报 / 无需补知识） */
  dismissKnowledgeGap: (id: string) =>
    http<{ success: boolean }>(`/admin/knowledge-gaps/${id}`, { method: 'DELETE' }),

  /* ---------- 工作流自动化规则 ---------- */
  getWorkflowRules: () => http<{ rules: WorkflowRule[] }>('/admin/workflow/rules'),

  createWorkflowRule: (data: {
    name: string;
    description?: string;
    enabled?: boolean;
    priority?: number;
    conditions: WorkflowConditions;
    actions: WorkflowActions;
  }) => http<{ rule: WorkflowRule }>('/admin/workflow/rules', { method: 'POST', body: JSON.stringify(data) }),

  updateWorkflowRule: (
    id: string,
    patch: Partial<{ name: string; description: string; enabled: boolean; priority: number; conditions: WorkflowConditions; actions: WorkflowActions }>,
  ) => http<{ rule: WorkflowRule }>(`/admin/workflow/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteWorkflowRule: (id: string) => http<{ success: boolean }>(`/admin/workflow/rules/${id}`, { method: 'DELETE' }),

  /* ---------- AI 成效看板（商业价值量化） ---------- */
  getImpact: () => http<ImpactData>('/admin/impact'),

  /* ---------- 端侧遥测看板（设备异常自动建单） ---------- */
  getTelemetry: (limit = 100) =>
    http<{ total: number; anomalies: number; recent: DeviceTelemetry[] }>(`/admin/telemetry?limit=${limit}`),

  /* ---------- 智能体编排留痕（可视化推理链路） ---------- */
  getAgentRuns: (sessionId?: string) =>
    http<{ runs: AgentRunRow[]; total: number }>(
      `/admin/agent-runs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    ),

  /* ---------- 设备健康度看板（预测性维护） ---------- */
  getDeviceHealth: () => http<DeviceHealthData>('/admin/device-health'),

  /* ---------- 工单根因聚类洞察 ---------- */
  getRootCauses: (windowDays = 30) => http<RootCauseData>(`/admin/root-causes?windowDays=${windowDays}`),
};
