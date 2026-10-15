/**
 * 模型调用可观测性（Hack2skill 改装方案：多协议接入后的运行观测）
 *
 * 职责：
 *   - recordLlmCall：agentCore 每次 callAgent 出口统一埋点（best-effort，失败仅告警）；
 *   - getLlmMetrics：为管理后台「调用监控」面板提供聚合数据——
 *       汇总（总调用/成功率/平均延迟/降级次数/token 合计）、
 *       引擎明细（按 provider 分组）、近 7 天趋势（按天）、最近调用列表。
 *
 * 设计要点：
 *   - 零新依赖：SQLite 直查（llm_call_logs，DB v19）；
 *   - 写入与主链路隔离：任何异常都不影响对话主流程；
 *   - 滚动保留：insertLlmCallLog 每累积 500 次触发一次 cleanupLlmCallLogs（保留最近 5000 条）。
 */
import { insertLlmCallLog, cleanupLlmCallLogs, queryLlmCallLogs, queryRecentLlmCallLogs } from './db.js';
import { logger } from './logger.js';

/** 调用状态：ok=正常生成；degraded=降级知识库直答；error=调用失败（抛错） */
export type LlmCallStatus = 'ok' | 'degraded' | 'error';

export interface LlmCallEntry {
  provider: string;
  model: string;
  channel: string | null;
  sessionId: string | null;
  status: LlmCallStatus;
  latencyMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: string | null;
}

/* ============================ 写入 ============================ */

let sinceCleanup = 0;

/** 记录一次 LLM 调用（best-effort：绝不因埋点失败影响主链路） */
export function recordLlmCall(entry: LlmCallEntry): void {
  try {
    insertLlmCallLog({
      provider: entry.provider || 'unknown',
      model: entry.model || 'unknown',
      channel: entry.channel ?? null,
      sessionId: entry.sessionId ?? null,
      status: entry.status,
      latencyMs: entry.latencyMs,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      error: entry.error ?? null,
    });
    if (++sinceCleanup >= 500) {
      sinceCleanup = 0;
      cleanupLlmCallLogs();
    }
  } catch (e: any) {
    logger.warn('[llmMetrics] 埋点失败（已忽略）:', e?.message || e);
  }
}

/* ============================ 聚合查询 ============================ */

export interface LlmMetricsSummary {
  totalCalls: number;
  okCount: number;
  degradedCount: number;
  errorCount: number;
  successRate: number; // 0-1（ok 占比）
  avgLatencyMs: number;
  maxLatencyMs: number;
  fallbackRate: number; // 0-1（degraded 占比）
  totalPromptTokens: number;
  totalCompletionTokens: number;
  sinceDays: number;
}

export interface LlmEngineStat {
  provider: string;
  calls: number;
  okCount: number;
  degradedCount: number;
  errorCount: number;
  avgLatencyMs: number;
  totalTokens: number;
  lastUsedAt: string | null;
}

export interface LlmTrendPoint {
  date: string; // YYYY-MM-DD
  calls: number;
  degraded: number;
  error: number;
}

export interface LlmRecentCall {
  id: number;
  time: string;
  provider: string;
  model: string;
  channel: string | null;
  status: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
}

export interface LlmMetrics {
  summary: LlmMetricsSummary;
  byEngine: LlmEngineStat[];
  trend: LlmTrendPoint[];
  recent: LlmRecentCall[];
}

interface CallRow {
  id: number;
  provider: string;
  model: string;
  channel: string | null;
  status: string;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  created_at: string;
}

/**
 * 聚合调用指标。窗口：最近 trendDays 天（默认 7）；recent 取最近 limit 条（默认 50）。
 * 任何查询异常都返回空结构（best-effort，不炸管理端面板）。
 */
export async function getLlmMetrics(trendDays = 7, limit = 50): Promise<LlmMetrics> {
  const rows = queryLlmCallLogs(trendDays) as CallRow[];
  const recentRows = queryRecentLlmCallLogs(limit) as CallRow[];

  const totalCalls = rows.length;
  const okCount = rows.filter((r) => r.status === 'ok').length;
  const degradedCount = rows.filter((r) => r.status === 'degraded').length;
  const errorCount = rows.filter((r) => r.status === 'error').length;
  const latencies = rows.map((r) => r.latency_ms || 0);
  const totalPromptTokens = rows.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const totalCompletionTokens = rows.reduce((s, r) => s + (r.completion_tokens || 0), 0);

  const byEngineMap = new Map<string, LlmEngineStat>();
  for (const r of rows) {
    let stat = byEngineMap.get(r.provider);
    if (!stat) {
      stat = {
        provider: r.provider,
        calls: 0,
        okCount: 0,
        degradedCount: 0,
        errorCount: 0,
        avgLatencyMs: 0,
        totalTokens: 0,
        lastUsedAt: null,
      };
      byEngineMap.set(r.provider, stat);
    }
    stat.calls += 1;
    if (r.status === 'ok') stat.okCount += 1;
    else if (r.status === 'degraded') stat.degradedCount += 1;
    else stat.errorCount += 1;
    stat.totalTokens += (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    if (!stat.lastUsedAt || r.created_at > stat.lastUsedAt) stat.lastUsedAt = r.created_at;
  }
  const byEngine: LlmEngineStat[] = Array.from(byEngineMap.values()).map((s) => {
    const engineRows = rows.filter((r) => r.provider === s.provider);
    const engineLat = engineRows.map((r) => r.latency_ms || 0);
    return {
      ...s,
      avgLatencyMs: engineLat.length ? Math.round(engineLat.reduce((a, b) => a + b, 0) / engineLat.length) : 0,
    };
  });
  byEngine.sort((a, b) => b.calls - a.calls);

  // 近 N 天按天趋势（UTC+8 自然日）
  const trendMap = new Map<string, LlmTrendPoint>();
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    trendMap.set(key, { date: key, calls: 0, degraded: 0, error: 0 });
  }
  for (const r of rows) {
    const key = (r.created_at || '').slice(0, 10);
    const point = trendMap.get(key);
    if (!point) continue;
    point.calls += 1;
    if (r.status === 'degraded') point.degraded += 1;
    else if (r.status === 'error') point.error += 1;
  }

  return {
    summary: {
      totalCalls,
      okCount,
      degradedCount,
      errorCount,
      successRate: totalCalls ? Math.round((okCount / totalCalls) * 1000) / 1000 : 0,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
      fallbackRate: totalCalls ? Math.round((degradedCount / totalCalls) * 1000) / 1000 : 0,
      totalPromptTokens,
      totalCompletionTokens,
      sinceDays: trendDays,
    },
    byEngine,
    trend: Array.from(trendMap.values()),
    recent: recentRows.map((r) => ({
      id: r.id,
      time: r.created_at,
      provider: r.provider,
      model: r.model,
      channel: r.channel,
      status: r.status,
      latencyMs: r.latency_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      error: r.error,
    })),
  };
}
