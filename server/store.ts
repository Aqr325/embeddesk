/**
 * 统一数据持久化层（Hack2skill 改装方案 §4 · D4）
 *
 * 背景：工单/会话数据从单一 SQLite 升级为「Firestore 主存 + SQLite 兜底」的双写/回退架构。
 * 对外提供与 db.ts 同语义的读写函数，调用方（agentTools.create_ticket 等）无需感知底层存储。
 *
 * 开关：DATA_PROVIDER=firestore|sqlite（默认 sqlite）。
 *   - firestore 且 FIRESTORE_PROJECT 已配 → 优先 Firestore；
 *   - Firestore 调用失败（网络/鉴权/配额）→ 自动回退 SQLite，记 warn 日志，不阻断主链路。
 *
 * 零依赖：Firestore REST（PATCH upsert / GET / runQuery）+ googleAuth 三档鉴权（含 mock 档）。
 */
import { logger } from './logger.js';
import * as db from './db.js';
import { authHeaders } from './googleAuth.js';
import { trackTicketCreated } from './events.js';
import { flushNow } from './writeQueue.js';

/* ============================ 配置 ============================ */

export function dataProviderConfigured(): boolean {
  return (
    (process.env.DATA_PROVIDER || 'sqlite').toLowerCase() === 'firestore' &&
    Boolean((process.env.FIRESTORE_PROJECT || '').trim())
  );
}

function fsBase(): string {
  const override = process.env.FIRESTORE_BASE_URL; // 本地 mock 端点可覆盖
  if (override) {
    return `${override.replace(/\/+$/, '')}/projects/${process.env.FIRESTORE_PROJECT || 'local'}/databases/(default)/documents`;
  }
  const project = process.env.FIRESTORE_PROJECT;
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
}

/* ============================ Firestore 值编解码 ============================ */

type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values: FsValue[] } }
  | { mapValue: { fields: Record<string, FsValue> } };

function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v: FsValue | undefined): unknown {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out: Record<string, unknown> = {};
    const f = v.mapValue.fields || {};
    for (const [k, val] of Object.entries(f)) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFsValue(v);
  return fields;
}

/* ============================ 可观测性 ============================ */

let fsWrites = 0;
let fsWriteErrors = 0;
let fsReads = 0;
let fsReadErrors = 0;

export function getStoreStats(): { provider: string; configured: boolean; fsWrites: number; fsWriteErrors: number; fsReads: number; fsReadErrors: number } {
  return {
    provider: dataProviderConfigured() ? 'firestore' : 'sqlite',
    configured: dataProviderConfigured(),
    fsWrites,
    fsWriteErrors,
    fsReads,
    fsReadErrors,
  };
}

/* ============================ 工单读写 ============================ */

const TICKET_COLLECTION = 'tickets';

/** 把 DbTicket 落 Firestore（PATCH upsert）；失败记日志并抛错（由调用方回退 SQLite） */
async function writeTicketFs(ticket: db.DbTicket): Promise<void> {
  fsWrites++;
  const name = `${fsBase()}/${TICKET_COLLECTION}/${ticket.id}`;
  const headers = await authHeaders();
  const r = await fetch(name, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ fields: encodeFields(ticket as unknown as Record<string, unknown>) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    fsWriteErrors++;
    throw new Error(`FIRESTORE_WRITE_HTTP_${r.status}`);
  }
}

/** 从 Firestore 读单条工单；失败记日志并抛错（由调用方回退 SQLite） */
async function readTicketFs(id: string): Promise<db.DbTicket | null> {
  fsReads++;
  const name = `${fsBase()}/${TICKET_COLLECTION}/${id}`;
  const headers = await authHeaders();
  const r = await fetch(name, { headers, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) {
    fsReadErrors++;
    throw new Error(`FIRESTORE_READ_HTTP_${r.status}`);
  }
  const j = (await r.json()) as any;
  const fields = j?.fields || {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v as FsValue);
  return out as unknown as db.DbTicket;
}

/**
 * 创建工单：Firestore 优先 + SQLite 兜底（D4 验收点：create_ticket 落 Firestore）。
 * 返回落库后的工单对象（来自实际使用的存储）。
 */
export async function persistTicket(
  ticket: Partial<db.DbTicket> & { id: string; session_id: string; reason: string },
): Promise<db.DbTicket> {
  // D4 修复：先刷写 write-behind 缓冲，确保会话行（createSession 经 enqueue 异步落库）已存在，
  // 否则 tickets.session_id 外键约束会失败（建单是同步路径，必须还原与消息同批 FIFO 的顺序保证）。
  flushNow();
  const full = db.createTicket(ticket); // 先构造规范化对象（含默认值 + 时间戳）
  // 分析事件：建单漏斗（BigQuery 优先 + 本地 JSONL 兜底，best-effort）
  trackTicketCreated({
    ticketId: full.id,
    priority: full.priority,
    escalated: Boolean(full.escalated),
    channel: full.channel,
  });
  if (!dataProviderConfigured()) return full; // sqlite 模式：直接 SQLite
  try {
    await writeTicketFs(full);
    logger.info(`[store] 工单 ${full.id} 已写入 Firestore`);
    return full;
  } catch (e: any) {
    logger.warn('[store] Firestore 写入失败，回退 SQLite：', String(e?.message || e).slice(0, 140));
    return full; // SQLite 已在本函数首行写入
  }
}

/** 读工单：Firestore 优先 + SQLite 兜底 */
export async function fetchTicket(id: string): Promise<db.DbTicket | undefined> {
  if (!dataProviderConfigured()) return db.getTicket(id);
  try {
    const fs = await readTicketFs(id);
    if (fs) return fs;
  } catch (e: any) {
    logger.warn('[store] Firestore 读取失败，回退 SQLite：', String(e?.message || e).slice(0, 140));
  }
  return db.getTicket(id);
}

/** 列工单：聚合 Firestore + SQLite（去重，Firestore 优先）；只读模式下直接 SQLite */
export async function listTickets(status?: string): Promise<db.DbTicket[]> {
  const local = db.getTickets(status);
  if (!dataProviderConfigured()) return local;
  // 双源聚合：Firestore 为主，SQLite 兜底补齐（按 id 去重）
  try {
    const fsList = await listTicketsFs(status);
    const byId = new Map<string, db.DbTicket>();
    for (const t of fsList) byId.set(t.id, t);
    for (const t of local) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  } catch (e: any) {
    logger.warn('[store] Firestore 列表失败，回退 SQLite：', String(e?.message || e).slice(0, 140));
    return local;
  }
}

async function listTicketsFs(status?: string): Promise<db.DbTicket[]> {
  fsReads++;
  const url = `${fsBase()}/${TICKET_COLLECTION}:runQuery`;
  const headers = await authHeaders();
  const structuredQuery: any = {
    structuredQuery: { from: [{ collectionId: TICKET_COLLECTION }], limit: 200 },
  };
  if (status) {
    structuredQuery.structuredQuery.where = {
      fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: status } },
    };
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(structuredQuery),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    fsReadErrors++;
    throw new Error(`FIRESTORE_QUERY_HTTP_${r.status}`);
  }
  const rows = (await r.json()) as any[];
  return rows
    .filter((row) => row?.document?.fields)
    .map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row.document.fields)) out[k] = fromFsValue(v as FsValue);
      return out as unknown as db.DbTicket;
    });
}
