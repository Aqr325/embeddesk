/**
 * 内存会话索引 —— 异步渠道（邮件 / IM）线程续接的「逻辑真相源」
 *
 * 背景：ingest 写入改为 write-behind 队列后，会话的持久化会延迟数十毫秒才落库。
 * 若同一客户在窗口内连续发来消息，仅查 DB 会看不到尚未 flush 的新会话，从而重复建单、
 * 消息挂错会话。本模块在内存中维护一份「活跃未结会话」索引，写入决策时**同步**更新，
 * 读取时优先命中内存（毫秒级、零 DB 往返），未命中再回退 DB（覆盖冷启动前 / 实时会话创建的会话）。
 *
 * 设计要点：
 *  - 仅缓存未关闭且在 24h 窗口内的会话；过期 / 已关闭的会话不再续接（与 db.getOpenSessionForCustomerChannel 语义一致）。
 *  - 生命周期：服务启动时 preload() 从 DB 载入现有活跃会话；运行中同步维护；进程退出由 writeQueue 负责落库。
 *  - 内存索引是「逻辑视图」，DB 仍是持久真相源；二者在 flush 后最终一致。
 */
import * as db from './db.js';
import { logger } from './logger.js';

interface RegEntry {
  id: string;
  customerId: string;
  channel: string;
  status: db.SessionStatus;
  customerName: string;
  primaryIntent: string | null;
  updatedAt: number; // epoch ms，用于 24h 续接窗口判断
}

const WINDOW_MS = 24 * 3600 * 1000;
const map = new Map<string, RegEntry>();

function keyOf(customerId: string, channel: string): string {
  return `${customerId}|${channel}`;
}

function entryOf(e: RegEntry): db.DbSession {
  const now = new Date().toISOString();
  // 合成一份 DbSession 供 channels.ts 复用（仅包含 ingest 实际读取的字段）
  return {
    id: e.id,
    title: '',
    model: 'external',
    sdk_session_id: null,
    customer_id: e.customerId,
    customer_name: e.customerName,
    channel: e.channel,
    site_id: null,
    visitor_id: null,
    status: e.status,
    primary_intent: e.primaryIntent,
    handoff: 0,
    handoff_reason: null,
    resolved: 0,
    created_at: now,
    updated_at: new Date(e.updatedAt).toISOString(),
  };
}

/** 服务启动时从 DB 预热活跃会话索引，避免冷启动后的首轮续接回退 DB */
export function preload(): void {
  try {
    const rows = db.getRecentOpenSessionsForRegistry(WINDOW_MS);
    for (const r of rows) {
      map.set(keyOf(r.customer_id as string, r.channel), {
        id: r.id,
        customerId: r.customer_id as string,
        channel: r.channel,
        status: r.status,
        customerName: r.customer_name ?? '渠道客户',
        primaryIntent: r.primary_intent,
        updatedAt: new Date(r.updated_at).getTime(),
      });
    }
    logger.info(`[registry] 预载 ${map.size} 个活跃会话索引`);
  } catch (e) {
    logger.warn(`[registry] 预载失败: ${(e as Error)?.message || e}`);
  }
}

/** 注册新会话（ingest 决定新建会话时同步调用） */
export function registerSession(entry: {
  id: string;
  customerId: string;
  channel: string;
  status?: db.SessionStatus;
  customerName?: string;
}): void {
  map.set(keyOf(entry.customerId, entry.channel), {
    id: entry.id,
    customerId: entry.customerId,
    channel: entry.channel,
    status: entry.status ?? 'active',
    customerName: entry.customerName ?? '渠道客户',
    primaryIntent: null,
    updatedAt: Date.now(),
  });
}

/** 触达现有会话：刷新 updatedAt，维持 24h 续接窗口有效 */
export function touchSession(id: string, customerId: string, channel: string): void {
  const e = map.get(keyOf(customerId, channel));
  if (e && e.id === id) e.updatedAt = Date.now();
}

/** 会话状态变更（如转人工 waiting_human）同步更新索引，避免后续读取看到旧状态 */
export function setSessionStatus(id: string, customerId: string, channel: string, status: db.SessionStatus): void {
  const e = map.get(keyOf(customerId, channel));
  if (e && e.id === id) {
    e.status = status;
    e.updatedAt = Date.now();
  } else {
    registerSession({ id, customerId, channel, status });
  }
}

/**
 * 取某客户在某渠道的活跃未结会话（线程续接用）。
 * 优先内存索引（同步、零 DB），未命中或已过期/关闭则回退 DB，并回填内存缓存。
 */
export function getOpenSession(customerId: string, channel: string): db.DbSession | undefined {
  const e = map.get(keyOf(customerId, channel));
  if (e && e.status !== 'closed' && Date.now() - e.updatedAt <= WINDOW_MS) {
    return entryOf(e);
  }
  // 内存未命中（或已过期）：回退 DB，覆盖冷启动前 / 实时会话创建的会话
  const dbSession = db.getOpenSessionForCustomerChannel(customerId, channel, WINDOW_MS);
  if (dbSession) {
    map.set(keyOf(customerId, channel), {
      id: dbSession.id,
      customerId,
      channel: dbSession.channel,
      status: dbSession.status,
      customerName: dbSession.customer_name ?? '渠道客户',
      primaryIntent: dbSession.primary_intent,
      updatedAt: new Date(dbSession.updated_at).getTime(),
    });
  }
  return dbSession;
}
