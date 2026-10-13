/**
 * 洞察聚合（Hack2skill 改装方案 §8 D5 · BigQuery 事件流洞察页后端）
 *
 * 数据源：与 events.ts 同一套事件（question / search_hit / latency / ticket_created）。
 *   - BigQuery 已配置（bqConfigured）：优先用 jobs.query 拉全量事件聚合；
 *   - 未配置或 BQ 查询失败：回退读本地 JSONL（EVENTS_JSONL_PATH），保证演示可观测不空。
 * 聚合结果供管理后台「洞察」页复用现有图表组件（DonutChart / TrendArea）展示：
 *   TOP 知识点（search_hit.docId）、渠道分布（question.channel）、工单趋势（ticket_created 按天）、
 *   检索命中率、热门查询等。
 *
 * 全程 best-effort：任何异常都降级为「空数据 + 来源标记」，绝不抛出阻塞后台。
 */
import { readFileSync, existsSync } from 'node:fs';
import { bqConfigured } from './events.js';
import { authHeaders } from './googleAuth.js';
import { logger } from './logger.js';

export interface InsightsData {
  /** 数据来源：bigquery=真实事件流；local=本地 JSONL 兜底；empty=无任何数据 */
  source: 'bigquery' | 'local' | 'empty';
  /** 统计窗口（天） */
  windowDays: number;
  totals: {
    questions: number;
    searchHits: number;
    tickets: number;
    latencySamples: number;
  };
  /** 检索命中率（search_hit.hit=true 占比，百分比，0–100） */
  searchHitRate: number;
  /** TOP 知识点（按 search_hit.docId 聚合） */
  topDocs: Array<{ docId: string; label: string; count: number }>;
  /** 热门查询（按 question.query 聚合） */
  topQueries: Array<{ query: string; count: number }>;
  /** 渠道分布（question.channel） */
  channelDistribution: Array<{ channel: string; count: number }>;
  /** 工单趋势（ticket_created 按天） */
  ticketTrend: Array<{ date: string; tickets: number }>;
  /** 提问趋势（question 按天） */
  questionTrend: Array<{ date: string; questions: number }>;
  /** 本赛事数据为演示数据（方案 §7 统一口径），前端显式标注 */
  demo: boolean;
}

/** 产品代号 → 中文名（来自 data/products/catalog.json 真实产品，便于看板可读） */
const PRODUCT_ALIAS: Record<string, string> = {
  dt900: 'DT900 侦打一体机',
  dj9341: 'DJ9341 干扰枪',
  dj8341: 'DJ8341 干扰枪',
  dj100: 'DJ100 干扰枪',
  dj102: 'DJ102 大功率枪',
  dj886: 'DJ886 干扰枪',
  dj500: 'DJ500 基站款',
  dj600: 'DJ600 反制盾',
  dj300: 'DJ300 便携枪',
  'dj-bt2': 'DJ-BT2 手持探测器',
  sdj800: 'SDJ800 查打一体',
  pcba: 'PCBA/射频模块',
};

/** 由 docId（如 qa-dt900-intro）推导可读标签 */
function labelFromDocId(docId: string): string {
  const lower = docId.toLowerCase();
  for (const [code, name] of Object.entries(PRODUCT_ALIAS)) {
    if (lower.includes(code)) return name;
  }
  return docId.replace(/^qa-/, '').replace(/-/g, ' ');
}

interface RawEvent {
  type: string;
  ts?: string;
  channel?: string;
  query?: string;
  docId?: string;
  hit?: boolean;
  priority?: string;
  [k: string]: unknown;
}

/* ============================ 数据拉取 ============================ */

function readLocalEvents(): RawEvent[] {
  const p = process.env.EVENTS_JSONL_PATH || 'data/analytics-events.jsonl';
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as RawEvent;
        } catch {
          return null;
        }
      })
      .filter((x): x is RawEvent => x !== null);
  } catch (e: any) {
    logger.warn('[insights] 本地 JSONL 读取失败：', String(e?.message || e).slice(0, 120));
    return [];
  }
}

/** BigQuery jobs.query 拉全量事件（best-effort；失败返回 null） */
async function readBqEvents(): Promise<RawEvent[] | null> {
  try {
    const project = process.env.BIGQUERY_PROJECT!;
    const dataset = process.env.BIGQUERY_DATASET!;
    const table = process.env.BIGQUERY_TABLE!;
    const url = `${process.env.BIGQUERY_BASE_URL?.replace(/\/+$/, '') || 'https://bigquery.googleapis.com/bigquery/v2'}/projects/${project}/queries`;
    const headers = await authHeaders();
    const sql = `SELECT * FROM \`${project}.${dataset}.${table}\` ORDER BY ts ASC LIMIT 100000`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query: sql, useLegacySql: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`BIGQUERY_HTTP_${r.status}`);
    const j = (await r.json()) as any;
    const fields: Array<{ name: string }> = j?.schema?.fields || [];
    const rows: any[] = j?.rows || [];
    return rows.map((row) => {
      const ev: RawEvent = { type: '' };
      fields.forEach((f, i) => {
        const v = row?.f?.[i]?.v;
        ev[f.name] = v ?? undefined;
      });
      return ev;
    });
  } catch (e: any) {
    logger.warn('[insights] BigQuery 查询失败，回退本地 JSONL：', String(e?.message || e).slice(0, 120));
    return null;
  }
}

/* ============================ 聚合 ============================ */

function dayKey(ts?: string): string {
  if (!ts) return 'unknown';
  return ts.slice(0, 10); // YYYY-MM-DD
}

function aggregate(events: RawEvent[]): InsightsData {
  const questions = events.filter((e) => e.type === 'question');
  const hits = events.filter((e) => e.type === 'search_hit');
  const tickets = events.filter((e) => e.type === 'ticket_created');
  const latency = events.filter((e) => e.type === 'latency');

  const hitCount = hits.filter((e) => Boolean(e.hit)).length;
  const searchHitRate = hits.length ? Math.round((hitCount / hits.length) * 100) : 0;

  // TOP 知识点
  const docMap = new Map<string, number>();
  for (const h of hits) {
    const id = h.docId || 'unknown';
    docMap.set(id, (docMap.get(id) || 0) + 1);
  }
  const topDocs = [...docMap.entries()]
    .map(([docId, count]) => ({ docId, label: labelFromDocId(docId), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // 热门查询
  const qMap = new Map<string, number>();
  for (const q of questions) {
    const key = (q.query || '').trim();
    if (key) qMap.set(key, (qMap.get(key) || 0) + 1);
  }
  const topQueries = [...qMap.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // 渠道分布
  const chMap = new Map<string, number>();
  for (const q of questions) {
    const ch = q.channel || 'unknown';
    chMap.set(ch, (chMap.get(ch) || 0) + 1);
  }
  const channelDistribution = [...chMap.entries()]
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);

  // 工单趋势
  const tkMap = new Map<string, number>();
  for (const t of tickets) tkMap.set(dayKey(t.ts), (tkMap.get(dayKey(t.ts)) || 0) + 1);
  const ticketTrend = [...tkMap.entries()]
    .map(([date, tickets]) => ({ date, tickets }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  // 提问趋势
  const qdMap = new Map<string, number>();
  for (const q of questions) qdMap.set(dayKey(q.ts), (qdMap.get(dayKey(q.ts)) || 0) + 1);
  const questionTrend = [...qdMap.entries()]
    .map(([date, questions]) => ({ date, questions }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  return {
    source: 'local',
    windowDays: questionTrend.length || ticketTrend.length || 0,
    totals: {
      questions: questions.length,
      searchHits: hits.length,
      tickets: tickets.length,
      latencySamples: latency.length,
    },
    searchHitRate,
    topDocs,
    topQueries,
    channelDistribution,
    ticketTrend,
    questionTrend,
    demo: true,
  };
}

/* ============================ 入口 ============================ */

/**
 * 聚合洞察数据。优先 BigQuery，失败/未配置回退本地 JSONL。
 * 任意异常均返回空结构（source='empty'），不向上抛出。
 */
export async function getInsights(): Promise<InsightsData> {
  let events: RawEvent[] | null = null;
  let source: InsightsData['source'] = 'empty';

  if (bqConfigured()) {
    events = await readBqEvents();
    if (events) source = 'bigquery';
  }
  if (!events || events.length === 0) {
    events = readLocalEvents();
    if (events.length) source = 'local';
  }

  if (!events || events.length === 0) {
    return {
      source: 'empty',
      windowDays: 0,
      totals: { questions: 0, searchHits: 0, tickets: 0, latencySamples: 0 },
      searchHitRate: 0,
      topDocs: [],
      topQueries: [],
      channelDistribution: [],
      ticketTrend: [],
      questionTrend: [],
      demo: true,
    };
  }

  const result = aggregate(events);
  result.source = source;
  return result;
}
