/**
 * 分析事件流（Hack2skill 改装方案 §4 · D4）
 *
 * 四类核心事件（漏斗分析 / 质量监控）：
 *   - question：用户提问（含意图、渠道、session）
 *   - search_hit：知识库/检索命中（含命中 doc id、相关度、来源 provider）
 *   - latency：关键路径耗时（如 Agent 首 token、检索耗时）
 *   - ticket_created：建单事件（含优先级、升级标记）
 *
 * 投递：BigQuery Streaming Insert（insertAll REST），零依赖；
 *       未配置 BigQuery 时落本地 JSONL（data/analytics-events.jsonl）兜底，保证可观测不丢。
 * 策略：fire-and-forget + best-effort，失败只记日志，绝不阻塞主业务链路。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.js';
import { authHeaders } from './googleAuth.js';

export type AnalyticsEventType = 'question' | 'search_hit' | 'latency' | 'ticket_created';

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  ts: string;
  [k: string]: unknown;
}

/* ============================ 配置 ============================ */

function bqConfigured(): boolean {
  return Boolean(
    process.env.BIGQUERY_PROJECT &&
      process.env.BIGQUERY_DATASET &&
      process.env.BIGQUERY_TABLE,
  );
}

function bqInsertUrl(): string {
  const override = process.env.BIGQUERY_BASE_URL;
  const project = process.env.BIGQUERY_PROJECT!;
  const dataset = process.env.BIGQUERY_DATASET!;
  const table = process.env.BIGQUERY_TABLE!;
  if (override) {
    return `${override.replace(/\/+$/, '')}/projects/${project}/datasets/${dataset}/tables/${table}/insertAll`;
  }
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}/tables/${table}/insertAll`;
}

function localJsonlPath(): string {
  return process.env.EVENTS_JSONL_PATH || 'data/analytics-events.jsonl';
}

/* ============================ 可观测性 ============================ */

let emitted = 0;
let bqErrors = 0;
let localFallback = 0;

export function getEventsStats(): { enabled: boolean; emitted: number; bqErrors: number; localFallback: number } {
  return { enabled: bqConfigured(), emitted, bqErrors, localFallback };
}

/* ============================ 投递 ============================ */

function writeLocal(ev: AnalyticsEvent): void {
  try {
    const p = localJsonlPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + '\n', 'utf8');
    localFallback++;
  } catch (e: any) {
    logger.warn('[events] 本地 JSONL 兜底写入失败：', String(e?.message || e).slice(0, 120));
  }
}

async function sendBq(events: AnalyticsEvent[]): Promise<void> {
  const headers = await authHeaders();
  const rows = events.map((e) => ({ json: e }));
  const r = await fetch(bqInsertUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ rows }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    bqErrors++;
    throw new Error(`BIGQUERY_HTTP_${r.status}`);
  }
}

/**
 * 发送一条分析事件。BigQuery 优先；失败（含未配置）落本地 JSONL 兜底。
 * 全程 best-effort，异常不向外抛出。
 */
export function trackEvent(type: AnalyticsEventType, payload: Record<string, unknown> = {}): void {
  const ev: AnalyticsEvent = { type, ts: new Date().toISOString(), ...payload };
  emitted++;
  if (!bqConfigured()) {
    writeLocal(ev);
    return;
  }
  // fire-and-forget：不 await，避免阻塞主链路
  sendBq([ev]).catch((e: any) => {
    logger.warn('[events] BigQuery 投递失败，转本地 JSONL：', String(e?.message || e).slice(0, 120));
    writeLocal(ev);
  });
}

/* 常用便捷封装 */
export const trackQuestion = (p: { sessionId: string; channel: string; intent?: string; query: string }) =>
  trackEvent('question', p);
export const trackSearchHit = (p: { query: string; docId?: string; score?: number; provider?: string; hit: boolean }) =>
  trackEvent('search_hit', p);
export const trackLatency = (p: { stage: string; ms: number; sessionId?: string }) => trackEvent('latency', p);
export const trackTicketCreated = (p: { ticketId: string; priority: string; escalated: boolean; channel: string }) =>
  trackEvent('ticket_created', p);
