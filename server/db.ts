/**
 * 数据持久化层 —— 智能客服 Agent
 *
 * 表结构：
 *   sessions            会话（含客户信息、状态、主意图、转人工标记）
 *   messages            消息（含意图、置信度、命中 FAQ、来源）
 *   faqs                FAQ 知识库
 *   tickets             人工工单
 *   satisfaction        满意度评价
 *   intent_logs         意图识别流水（用于统计分析）
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 默认 data/chat.db；测试 / CI 可通过 CSA_DB_PATH 指向独立库，避免与运行实例争用同一文件
const dbPath = process.env.CSA_DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 并发与写入健壮性：忙等待避免「database is locked」；WAL 下 NORMAL 同步即可保证崩溃一致性且显著提速
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
// 16MB 页缓存 + 临时表/索引落内存，提升统计聚合查询吞吐
db.pragma('cache_size = -16000');
db.pragma('temp_store = MEMORY');

db.exec(`
  -- ============ 会话表 ============
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    customer_id TEXT,
    customer_name TEXT,
    channel TEXT DEFAULT 'web',
    status TEXT NOT NULL DEFAULT 'active',      -- active | waiting_human | human_serving | closed
    primary_intent TEXT,
    handoff INTEGER NOT NULL DEFAULT 0,
    handoff_reason TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- ============ 消息表 ============
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    intent TEXT,
    intent_confidence REAL,
    faq_ids TEXT,
    source TEXT,                                 -- agent | knowledge_base | handoff | system
    latency_ms INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

  -- ============ FAQ 知识库 ============
  CREATE TABLE IF NOT EXISTS faqs (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,                      -- 模组选型 | 端侧AI推理 | 功耗续航 | 认证入网 | 开发工具链 | 量产采购 | 商务支持
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',           -- 逗号分隔
    enabled INTEGER NOT NULL DEFAULT 1,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs(category);

  -- ============ 人工工单 ============
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    customer_name TEXT,
    intent TEXT,
    reason TEXT NOT NULL,                        -- 转人工原因
    trigger_rule TEXT,                           -- 触发的规则标识
    summary TEXT,                                -- 会话摘要
    priority TEXT NOT NULL DEFAULT 'medium',     -- low | medium | high | urgent
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | processing | resolved | closed
    assignee TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

  -- ============ 满意度评价 ============
  CREATE TABLE IF NOT EXISTS satisfaction (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    tags TEXT,
    comment TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_satisfaction_session ON satisfaction(session_id);

  -- ============ 意图识别流水 ============
  CREATE TABLE IF NOT EXISTS intent_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    text TEXT NOT NULL,
    intent TEXT NOT NULL,
    confidence REAL NOT NULL,
    matched_keywords TEXT,
    hit_faq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_intent_logs_intent ON intent_logs(intent);

  -- ============ 员工/坐席账户 ============
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'agent',          -- admin | manager | agent
    password_hash TEXT NOT NULL,                  -- 格式: <saltHex>$<scryptHex>
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

  -- ============ 客户长期画像 ============
  CREATE TABLE IF NOT EXISTS customer_profiles (
    customer_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',                -- 逗号分隔
    preferences TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    history_summary TEXT NOT NULL DEFAULT '',
    last_session_id TEXT,
    session_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_customer_profiles_company ON customer_profiles(company);

  -- ============ 接入站点（第三方网站 / 嵌入渠道） ============
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    embed_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',          -- active | disabled
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sites_site_id ON sites(site_id);

  -- ============ 访客标识（嵌入渠道跨会话身份识别） ============
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL UNIQUE,
    site_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '',                   -- JSON：自定义扩展字段
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(site_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_visitors_visitor_id ON visitors(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_visitors_site ON visitors(site_id);
`);

/* ---------- 兼容旧库的列迁移（基于 user_version 的幂等迁移框架） ---------- */
function ensureColumn(table: string, column: string, ddl: string) {
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      logger.info(`[DB] 迁移: ${table}.${column} 已添加`);
    }
  } catch {
    /* 忽略 */
  }
}

interface Migration {
  version: number;
  name: string;
  up: () => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'sessions/messages 历史列补齐（兼容旧库）',
    up: () => {
      ensureColumn('sessions', 'sdk_session_id', 'sdk_session_id TEXT');
      ensureColumn('sessions', 'customer_id', 'customer_id TEXT');
      ensureColumn('sessions', 'customer_name', 'customer_name TEXT');
      ensureColumn('sessions', 'channel', "channel TEXT DEFAULT 'web'");
      ensureColumn('sessions', 'status', "status TEXT NOT NULL DEFAULT 'active'");
      ensureColumn('sessions', 'primary_intent', 'primary_intent TEXT');
      ensureColumn('sessions', 'handoff', 'handoff INTEGER NOT NULL DEFAULT 0');
      ensureColumn('sessions', 'handoff_reason', 'handoff_reason TEXT');
      ensureColumn('sessions', 'resolved', 'resolved INTEGER NOT NULL DEFAULT 0');
      ensureColumn('messages', 'intent', 'intent TEXT');
      ensureColumn('messages', 'intent_confidence', 'intent_confidence REAL');
      ensureColumn('messages', 'faq_ids', 'faq_ids TEXT');
      ensureColumn('messages', 'source', 'source TEXT');
      ensureColumn('messages', 'latency_ms', 'latency_ms INTEGER');
    },
  },
  {
    version: 2,
    name: '性能索引（会话状态/意图/时间、消息角色、意图流水、工单/满意度关联）',
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_primary_intent ON sessions(primary_intent);
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
        CREATE INDEX IF NOT EXISTS idx_intent_logs_session_id ON intent_logs(session_id);
        CREATE INDEX IF NOT EXISTS idx_intent_logs_created_at ON intent_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_tickets_session_id ON tickets(session_id);
        CREATE INDEX IF NOT EXISTS idx_satisfaction_rating ON satisfaction(rating);
      `);
    },
  },
  {
    version: 3,
    name: 'FAQ 标签列（faqs.tags，用于人工归类与检索加权）',
    up: () => {
      ensureColumn('faqs', 'tags', "tags TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 4,
    name: '嵌入渠道：sessions 增加 site_id/visitor_id（关联接入站点与访客标识）',
    up: () => {
      ensureColumn('sessions', 'site_id', 'site_id TEXT');
      ensureColumn('sessions', 'visitor_id', 'visitor_id TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_site_id ON sessions(site_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_visitor_id ON sessions(visitor_id);
      `);
    },
  },
  {
    version: 5,
    name: '画像增强与工单 SLA：customer_profiles 增加 tier/last_intent/sentiment_score/last_contact_at；tickets 增加 sla_due_at/channel',
    up: () => {
      ensureColumn('customer_profiles', 'tier', "tier TEXT NOT NULL DEFAULT 'new'");
      ensureColumn('customer_profiles', 'last_intent', 'last_intent TEXT');
      ensureColumn('customer_profiles', 'sentiment_score', 'sentiment_score REAL NOT NULL DEFAULT 0');
      ensureColumn('customer_profiles', 'last_contact_at', 'last_contact_at TEXT');
      ensureColumn('tickets', 'sla_due_at', 'sla_due_at TEXT');
      ensureColumn('tickets', 'channel', "channel TEXT NOT NULL DEFAULT 'web'");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_customer_profiles_tier ON customer_profiles(tier);
        CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
        CREATE INDEX IF NOT EXISTS idx_tickets_sla_due_at ON tickets(sla_due_at);
      `);
    },
  },
  {
    version: 6,
    name: '会话跨渠道续接索引：sessions(customer_id, channel) 复合索引，消除 getOpenSessionForCustomerChannel 全表扫描',
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_customer_channel ON sessions(customer_id, channel);
      `);
    },
  },
  {
    version: 7,
    name: '邮件网关幂等表：processed_emails(message_id 主键)，保证 IMAP 轮询跨重启不重复回复',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_emails (
          message_id TEXT PRIMARY KEY,
          session_id TEXT,
          from_addr TEXT,
          subject TEXT,
          processed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processed_emails_from ON processed_emails(from_addr);
      `);
    },
  },
  {
    version: 8,
    name: 'CSAT 问卷表：csat_surveys（派发/回收/状态机），与 satisfaction 响应表解耦',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS csat_surveys (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ticket_id TEXT,
          channel TEXT NOT NULL DEFAULT 'web',
          survey_token TEXT NOT NULL UNIQUE,
          customer_name TEXT,
          to_address TEXT,
          survey_status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | expired
          survey_sent_at TEXT NOT NULL,
          responded_at TEXT,
          rating INTEGER,
          comment TEXT,
          tags TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_csat_token ON csat_surveys(survey_token);
        CREATE INDEX IF NOT EXISTS idx_csat_session ON csat_surveys(session_id);
        CREATE INDEX IF NOT EXISTS idx_csat_status ON csat_surveys(survey_status);
      `);
    },
  },
  {
    // 大模型（LLM）配置：单行表（id 恒为 1），供管理后台可视化配置与持久化。
    // api_key 以明文存储于数据库（属敏感字段，对外接口一律脱敏返回 hasApiKey 布尔）。
    version: 9,
    name: 'LLM 配置表：llm_config（模型/密钥/温度/最大长度/系统提示词）',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          model TEXT NOT NULL DEFAULT 'auto',
          api_key TEXT NOT NULL DEFAULT '',
          endpoint TEXT NOT NULL DEFAULT '',
          temperature REAL NOT NULL DEFAULT 0.7,
          max_reply_length INTEGER NOT NULL DEFAULT 600,
          system_prompt TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO llm_config (id, model, api_key, endpoint, temperature, max_reply_length, system_prompt, updated_at)
        VALUES (1, 'auto', '', '', 0.7, 600, '', datetime('now'));
      `);
    },
  },
  {
    // 工单 AI 摘要增强列：sentiment（客户情绪，用于高亮与筛选）+ tags（逗号分隔标签，用于检索归类）。
    // 二者此前均不存在于 tickets 表，本版本一并补齐；createTicket 已写入这两列。
    version: 10,
    name: '工单 AI 摘要列：tickets(sentiment, tags)',
    up: () => {
      ensureColumn('tickets', 'sentiment', 'sentiment TEXT');
      ensureColumn('tickets', 'tags', 'tags TEXT');
    },
  },
  {
    // 智能升级标记：escalated（是否经情感/风险自动升级）、escalation_reason（升级触发原因）。
    // createTicket 已写入这两列；v10 的 sentiment/tags 由情感识别层与摘要层共用。
    version: 11,
    name: '工单智能升级标记：tickets(escalated, escalation_reason)',
    up: () => {
      ensureColumn('tickets', 'escalated', 'escalated INTEGER NOT NULL DEFAULT 0');
      ensureColumn('tickets', 'escalation_reason', 'escalation_reason TEXT');
    },
  },
];

/** 按 user_version 顺序应用未执行的迁移，保证 schema 演进可追踪、幂等、可重放 */
function runMigrations() {
  const current = Number(db.pragma('user_version', { simple: true }) || 0);
  for (const m of migrations) {
    if (m.version > current) {
      const tx = db.transaction(m.up);
      tx();
      db.exec(`PRAGMA user_version = ${m.version}`);
      logger.info(`[DB] 已应用迁移 v${m.version}: ${m.name}`);
    }
  }
}
runMigrations();

/* ============================ 类型定义 ============================ */

export type SessionStatus = 'active' | 'waiting_human' | 'human_serving' | 'closed';
export type TicketStatus = 'pending' | 'processing' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  channel: string;
  site_id: string | null;
  visitor_id: string | null;
  status: SessionStatus;
  primary_intent: string | null;
  handoff: number;
  handoff_reason: string | null;
  resolved: number;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
  intent: string | null;
  intent_confidence: number | null;
  faq_ids: string | null;
  source: string | null;
  latency_ms: number | null;
}

export interface DbFaq {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string;
  tags: string;
  enabled: number;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

export interface DbTicket {
  id: string;
  session_id: string;
  customer_name: string | null;
  intent: string | null;
  reason: string;
  trigger_rule: string | null;
  summary: string | null;
  /** AI 会话摘要产出的客户情绪（positive|neutral|negative|angry），v10 新增 */
  sentiment: string | null;
  /** 逗号分隔的标签（AI 摘要或人工归类），初始建表已存在，v10 规范化接入 */
  tags: string | null;
  /** 是否经情感/风险智能升级（v11 新增，0/1） */
  escalated: number;
  /** 智能升级触发原因（v11 新增） */
  escalation_reason: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: string | null;
  note: string | null;
  /** SLA 截止时间（ISO），v5 新增 */
  sla_due_at: string | null;
  /** 来源渠道（web / embed / email / im），v5 新增 */
  channel: string;
  created_at: string;
  updated_at: string;
}

export interface DbSatisfaction {
  id: string;
  session_id: string;
  message_id: string | null;
  rating: number;
  tags: string | null;
  comment: string | null;
  resolved: number;
  created_at: string;
}

/* ============================ 员工/坐席账户 ============================ */

export type UserRole = 'admin' | 'manager' | 'agent';
export type UserStatus = 'active' | 'disabled';

export interface DbUser {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

/** 对外公开的用户信息（不含口令哈希） */
export interface DbUserPublic {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface DbCustomerProfile {
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
  /** 客户等级（new / regular / vip），由接触频次与企业信息推导 */
  tier: string;
  /** 最近一次会话识别到的意图 */
  last_intent: string | null;
  /** 情绪滚动均值，约 [-1, 1]，0 为中性 */
  sentiment_score: number;
  /** 最近一次接触时间 */
  last_contact_at: string | null;
  updated_at: string;
}

/** 接入站点（第三方网站 / 嵌入渠道） */
export interface DbSite {
  id: string;
  site_id: string;
  name: string;
  domain: string;
  embed_token: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

/** 站点列表聚合（含会话数，隐藏 embed_token） */
export type DbSiteListItem = Omit<DbSite, 'embed_token'> & { session_count: number };

/** 嵌入渠道访客标识（跨会话持久，用于身份识别与画像挂载） */
export interface DbVisitor {
  id: string;
  visitor_id: string;
  site_id: string;
  name: string;
  contact: string;
  meta: string;
  created_at: string;
  updated_at: string;
}

/* ============================ 会话操作 ============================ */

export function getAllSessions(): DbSession[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSession[];
}

/** 批量统计各会话消息数，避免逐会话查询（N+1）。返回 session_id -> 消息数 映射 */
export function getSessionMessageCounts(): Record<string, number> {
  const rows = db
    .prepare('SELECT session_id, COUNT(*) AS c FROM messages GROUP BY session_id')
    .all() as { session_id: string; c: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.session_id] = r.c;
  return map;
}

export function getSession(id: string): DbSession | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined;
}

export function createSession(session: Partial<DbSession> & { id: string; title: string; model: string }): DbSession {
  const now = new Date().toISOString();
  const full: DbSession = {
    id: session.id,
    title: session.title,
    model: session.model,
    sdk_session_id: session.sdk_session_id ?? null,
    customer_id: session.customer_id ?? null,
    customer_name: session.customer_name ?? '访客用户',
    channel: session.channel ?? 'web',
    site_id: session.site_id ?? null,
    visitor_id: session.visitor_id ?? null,
    status: session.status ?? 'active',
    primary_intent: session.primary_intent ?? null,
    handoff: session.handoff ?? 0,
    handoff_reason: session.handoff_reason ?? null,
    resolved: session.resolved ?? 0,
    created_at: session.created_at ?? now,
    updated_at: session.updated_at ?? now,
  };
  db.prepare(
    `INSERT INTO sessions
     (id, title, model, sdk_session_id, customer_id, customer_name, channel, site_id, visitor_id, status,
      primary_intent, handoff, handoff_reason, resolved, created_at, updated_at)
     VALUES (@id, @title, @model, @sdk_session_id, @customer_id, @customer_name, @channel, @site_id, @visitor_id, @status,
             @primary_intent, @handoff, @handoff_reason, @resolved, @created_at, @updated_at)`
  ).run(full);
  return full;
}

type SessionUpdatable = Pick<
  DbSession,
  'title' | 'model' | 'sdk_session_id' | 'customer_id' | 'customer_name' | 'channel' | 'site_id' | 'visitor_id' | 'status' | 'primary_intent' | 'handoff' | 'handoff_reason' | 'resolved'
>;

export function updateSession(id: string, updates: Partial<SessionUpdatable>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  (Object.keys(updates) as Array<keyof SessionUpdatable>).forEach((key) => {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  });
  if (fields.length === 0) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  const result = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

/* ============================ 消息操作 ============================ */

export function getMessagesBySession(sessionId: string): DbMessage[] {
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(sessionId) as DbMessage[];
}

// 模块级预处理语句，供 persistMessageNoTx 复用（避免每条消息重新编译 SQL）
const insertMsgStmt = db.prepare(
  `INSERT INTO messages
   (id, session_id, role, content, model, created_at, tool_calls, intent, intent_confidence, faq_ids, source, latency_ms)
   VALUES (@id, @session_id, @role, @content, @model, @created_at, @tool_calls, @intent, @intent_confidence, @faq_ids, @source, @latency_ms)`
);
const touchSessionStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');

/**
 * 落库单条消息 + 更新所属会话时间戳。**不含事务**，由调用方决定是否需要事务包裹
 * （实时聊天链路用 createMessage 包裹单事务；异步渠道 ingest 由 writeQueue 批量包裹）。
 */
export function persistMessageNoTx(
  message: Partial<DbMessage> & { id: string; session_id: string; role: DbMessage['role']; content: string },
): DbMessage {
  const full: DbMessage = {
    id: message.id,
    session_id: message.session_id,
    role: message.role,
    content: message.content,
    model: message.model ?? null,
    created_at: message.created_at ?? new Date().toISOString(),
    tool_calls: message.tool_calls ?? null,
    intent: message.intent ?? null,
    intent_confidence: message.intent_confidence ?? null,
    faq_ids: message.faq_ids ?? null,
    source: message.source ?? null,
    latency_ms: message.latency_ms ?? null,
  };
  insertMsgStmt.run(full);
  touchSessionStmt.run(new Date().toISOString(), message.session_id);
  return full;
}

/** 落库消息（含会话时间戳更新）并包裹在单事务中，供实时聊天链路同步持久化使用 */
export function createMessage(
  message: Partial<DbMessage> & { id: string; session_id: string; role: DbMessage['role']; content: string },
): DbMessage {
  return db.transaction(() => persistMessageNoTx(message))();
}

export function countUserMessages(sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'")
    .get(sessionId) as { c: number };
  return row.c;
}

/** 最近 N 条未命中知识库的用户提问数（用于连续未解决判定） */
export function countRecentMisses(sessionId: string, limit = 3): number {
  const rows = db
    .prepare(
      `SELECT faq_ids, intent_confidence FROM messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(sessionId, limit) as Array<{ faq_ids: string | null; intent_confidence: number | null }>;
  let streak = 0;
  for (const r of rows) {
    const missed = !r.faq_ids || r.faq_ids === '[]' || r.faq_ids === '';
    if (missed) streak += 1;
    else break;
  }
  return streak;
}

/* ============================ FAQ 操作 ============================ */

export function getAllFaqs(onlyEnabled = false): DbFaq[] {
  const sql = onlyEnabled
    ? 'SELECT * FROM faqs WHERE enabled = 1 ORDER BY hit_count DESC, created_at ASC'
    : 'SELECT * FROM faqs ORDER BY hit_count DESC, created_at ASC';
  return db.prepare(sql).all() as DbFaq[];
}

export function getFaq(id: string): DbFaq | undefined {
  return db.prepare('SELECT * FROM faqs WHERE id = ?').get(id) as DbFaq | undefined;
}

export function upsertFaq(faq: Partial<DbFaq> & { id: string; category: string; question: string; answer: string }): DbFaq {
  const now = new Date().toISOString();
  const full: DbFaq = {
    id: faq.id,
    category: faq.category,
    question: faq.question,
    answer: faq.answer,
    keywords: faq.keywords ?? '',
    tags: faq.tags ?? '',
    enabled: faq.enabled ?? 1,
    hit_count: faq.hit_count ?? 0,
    created_at: faq.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO faqs (id, category, question, answer, keywords, tags, enabled, hit_count, created_at, updated_at)
     VALUES (@id, @category, @question, @answer, @keywords, @tags, @enabled, @hit_count, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category, question = excluded.question, answer = excluded.answer,
       keywords = excluded.keywords, tags = excluded.tags, enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(full);
  return full;
}

export function deleteFaq(id: string): boolean {
  return db.prepare('DELETE FROM faqs WHERE id = ?').run(id).changes > 0;
}

export function incrementFaqHits(ids: string[]): void {
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?');
  const tx = db.transaction((list: string[]) => list.forEach((id) => stmt.run(id)));
  tx(ids);
}

/* ============================ 工单操作 ============================ */

export function createTicket(ticket: Partial<DbTicket> & { id: string; session_id: string; reason: string }): DbTicket {
  const now = new Date().toISOString();
  const full: DbTicket = {
    id: ticket.id,
    session_id: ticket.session_id,
    customer_name: ticket.customer_name ?? null,
    intent: ticket.intent ?? null,
    reason: ticket.reason,
    trigger_rule: ticket.trigger_rule ?? null,
    summary: ticket.summary ?? null,
    sentiment: ticket.sentiment ?? null,
    tags: ticket.tags ?? null,
    escalated: ticket.escalated ?? 0,
    escalation_reason: ticket.escalation_reason ?? null,
    priority: ticket.priority ?? 'medium',
    status: ticket.status ?? 'pending',
    assignee: ticket.assignee ?? null,
    note: ticket.note ?? null,
    sla_due_at: ticket.sla_due_at ?? null,
    channel: ticket.channel ?? 'web',
    created_at: ticket.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO tickets
     (id, session_id, customer_name, intent, reason, trigger_rule, summary, sentiment, tags, escalated, escalation_reason, priority, status, assignee, note, sla_due_at, channel, created_at, updated_at)
     VALUES (@id, @session_id, @customer_name, @intent, @reason, @trigger_rule, @summary, @sentiment, @tags, @escalated, @escalation_reason, @priority, @status, @assignee, @note, @sla_due_at, @channel, @created_at, @updated_at)`
  ).run(full);
  return full;
}

export function getTickets(status?: string): DbTicket[] {
  const sql = status
    ? 'SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM tickets ORDER BY created_at DESC';
  return (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as DbTicket[];
}

/** 按状态统计工单数量（索引命中，O(1) 量级，供队列位次等高频读使用，避免 SELECT * 全表拉取） */
export function countTicketsByStatus(status: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM tickets WHERE status = ?').get(status) as { c: number }).c;
}

export function getTicketsBySession(sessionId: string): DbTicket[] {
  return db.prepare('SELECT * FROM tickets WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as DbTicket[];
}

/** 按受理坐席查询工单（用于工单分配负载均衡统计） */
export function getTicketsByAssignee(assignee: string): DbTicket[] {
  return db.prepare('SELECT * FROM tickets WHERE assignee = ? ORDER BY created_at DESC').all(assignee) as DbTicket[];
}

/** 取该客户全渠道的最近一次会话（跨渠道画像聚合时使用） */
export function getLatestSessionForCustomer(customerId: string): DbSession | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(customerId) as DbSession | undefined;
}

/**
 * 取该客户在某渠道 24h 内（默认）的未结会话，实现邮件/IM 线程级的连续性续接。
 * 已关闭或超过时间窗的会话不复用，避免把历史会话错误地接回。
 */
export function getOpenSessionForCustomerChannel(
  customerId: string,
  channel: string,
  withinMs = 24 * 3600 * 1000,
): DbSession | undefined {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE customer_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 10')
    .all(customerId, channel) as DbSession[];
  const now = Date.now();
  for (const s of rows) {
    if (s.status === 'closed') continue;
    if (now - new Date(s.updated_at).getTime() <= withinMs) return s;
  }
  return undefined;
}

export function updateTicket(id: string, updates: Partial<Pick<DbTicket, 'status' | 'assignee' | 'note' | 'priority' | 'sla_due_at' | 'channel'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  Object.entries(updates).forEach(([k, v]) => {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  });
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  return db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

/**
 * 取所有未关闭且近期活跃的会话（用于服务启动时预热内存会话索引）。
 * 仅返回会话索引所需的轻量字段，避免全字段传输。
 */
export function getRecentOpenSessionsForRegistry(withinMs = 24 * 3600 * 1000): Array<{
  id: string;
  customer_id: string | null;
  channel: string;
  status: SessionStatus;
  customer_name: string | null;
  primary_intent: string | null;
  updated_at: string;
}> {
  const rows = db
    .prepare('SELECT id, customer_id, channel, status, customer_name, primary_intent, updated_at FROM sessions WHERE status != ?')
    .all('closed') as Array<{
    id: string;
    customer_id: string | null;
    channel: string;
    status: SessionStatus;
    customer_name: string | null;
    primary_intent: string | null;
    updated_at: string;
  }>;
  const now = Date.now();
  return rows.filter((r) => r.customer_id && now - new Date(r.updated_at).getTime() <= withinMs);
}

export function hasOpenTicket(sessionId: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM tickets WHERE session_id = ? AND status IN ('pending','processing')")
    .get(sessionId) as { c: number };
  return row.c > 0;
}

/* ============================ 邮件已处理去重（邮件网关幂等） ============================ */

const isEmailProcessedStmt = db.prepare('SELECT 1 FROM processed_emails WHERE message_id = ?');
const recordProcessedEmailStmt = db.prepare(
  `INSERT OR IGNORE INTO processed_emails (message_id, session_id, from_addr, subject, processed_at)
   VALUES (?, ?, ?, ?, ?)`,
);

/** 该邮件 Message-ID 是否已处理（用于 IMAP 轮询幂等，避免重复回复） */
export function isEmailProcessed(messageId: string): boolean {
  return !!isEmailProcessedStmt.get(messageId);
}

/** 记录已处理邮件（同步直写，不进 writeQueue，确保重启后仍能去重） */
export function recordProcessedEmail(
  messageId: string,
  sessionId: string,
  fromAddr: string,
  subject: string,
): void {
  recordProcessedEmailStmt.run(messageId, sessionId, fromAddr, subject, new Date().toISOString());
}

/* ============================ 满意度操作 ============================ */

export function createSatisfaction(item: Partial<DbSatisfaction> & { id: string; session_id: string; rating: number }): DbSatisfaction {
  const full: DbSatisfaction = {
    id: item.id,
    session_id: item.session_id,
    message_id: item.message_id ?? null,
    rating: item.rating,
    tags: item.tags ?? null,
    comment: item.comment ?? null,
    resolved: item.resolved ?? 0,
    created_at: item.created_at ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO satisfaction (id, session_id, message_id, rating, tags, comment, resolved, created_at)
     VALUES (@id, @session_id, @message_id, @rating, @tags, @comment, @resolved, @created_at)`
  ).run(full);
  return full;
}

export function getSatisfactionBySession(sessionId: string): DbSatisfaction[] {
  return db.prepare('SELECT * FROM satisfaction WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as DbSatisfaction[];
}

export function getAllSatisfaction(): DbSatisfaction[] {
  return db.prepare('SELECT * FROM satisfaction ORDER BY created_at DESC').all() as DbSatisfaction[];
}

/* ============================ 工单单条查询 ============================ */

export function getTicket(id: string): DbTicket | undefined {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as DbTicket | undefined;
}

/* ============================ CSAT 满意度问卷（派发 / 回收 / 状态机） ============================ */

export type CsatSurveyStatus = 'pending' | 'completed' | 'expired';

export interface DbCsatSurvey {
  id: string;
  session_id: string;
  ticket_id: string | null;
  channel: string;
  survey_token: string;
  customer_name: string | null;
  to_address: string | null;
  survey_status: CsatSurveyStatus;
  survey_sent_at: string;
  responded_at: string | null;
  rating: number | null;
  comment: string | null;
  tags: string | null;
  created_at: string;
}

export function createCsatSurvey(s: {
  id: string;
  session_id: string;
  ticket_id?: string | null;
  channel?: string;
  survey_token: string;
  customer_name?: string | null;
  to_address?: string | null;
  survey_sent_at: string;
  created_at: string;
}): DbCsatSurvey {
  const full: DbCsatSurvey = {
    id: s.id,
    session_id: s.session_id,
    ticket_id: s.ticket_id ?? null,
    channel: s.channel ?? 'web',
    survey_token: s.survey_token,
    customer_name: s.customer_name ?? null,
    to_address: s.to_address ?? null,
    survey_status: 'pending',
    survey_sent_at: s.survey_sent_at,
    responded_at: null,
    rating: null,
    comment: null,
    tags: null,
    created_at: s.created_at,
  };
  db.prepare(
    `INSERT INTO csat_surveys
     (id, session_id, ticket_id, channel, survey_token, customer_name, to_address, survey_status, survey_sent_at, responded_at, rating, comment, tags, created_at)
     VALUES (@id, @session_id, @ticket_id, @channel, @survey_token, @customer_name, @to_address, @survey_status, @survey_sent_at, @responded_at, @rating, @comment, @tags, @created_at)`,
  ).run(full);
  return full;
}

export function getCsatSurveyByToken(token: string): DbCsatSurvey | undefined {
  return db.prepare('SELECT * FROM csat_surveys WHERE survey_token = ?').get(token) as DbCsatSurvey | undefined;
}

/** 取该会话尚未回收的问卷（用于派发幂等，避免重复打扰客户） */
export function getOpenCsatSurveyForSession(sessionId: string): DbCsatSurvey | undefined {
  return db
    .prepare("SELECT * FROM csat_surveys WHERE session_id = ? AND survey_status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(sessionId) as DbCsatSurvey | undefined;
}

export function completeCsatSurvey(
  token: string,
  rating: number,
  comment: string | null,
  tags: string | null,
  respondedAt: string,
): void {
  db.prepare(
    `UPDATE csat_surveys SET survey_status = 'completed', responded_at = ?, rating = ?, comment = ?, tags = ? WHERE survey_token = ?`,
  ).run(respondedAt, rating, comment, tags, token);
}

export function expireCsatSurvey(token: string): void {
  db.prepare("UPDATE csat_surveys SET survey_status = 'expired' WHERE survey_token = ? AND survey_status = 'pending'").run(token);
}

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

export function getCsatStats(): CsatStats {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM csat_surveys').get() as { c: number }).c;
  const responded = (
    db.prepare("SELECT COUNT(*) AS c FROM csat_surveys WHERE survey_status = 'completed'").get() as { c: number }
  ).c;
  const pending = (
    db.prepare("SELECT COUNT(*) AS c FROM csat_surveys WHERE survey_status = 'pending'").get() as { c: number }
  ).c;
  const expired = (
    db.prepare("SELECT COUNT(*) AS c FROM csat_surveys WHERE survey_status = 'expired'").get() as { c: number }
  ).c;
  const avgRow = db
    .prepare('SELECT AVG(rating) AS a, COUNT(*) AS c FROM csat_surveys WHERE rating IS NOT NULL')
    .get() as { a: number | null; c: number };
  const positive = (db.prepare('SELECT COUNT(*) AS c FROM csat_surveys WHERE rating >= 4').get() as { c: number }).c;
  const negative = (db.prepare('SELECT COUNT(*) AS c FROM csat_surveys WHERE rating <= 2').get() as { c: number }).c;
  const ratingDistribution = db
    .prepare('SELECT rating, COUNT(*) AS count FROM csat_surveys WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating ASC')
    .all() as Array<{ rating: number; count: number }>;
  const byChannel = db
    .prepare(
      `SELECT channel, COUNT(*) AS total,
              SUM(CASE WHEN survey_status = 'completed' THEN 1 ELSE 0 END) AS responded
       FROM csat_surveys GROUP BY channel ORDER BY total DESC`,
    )
    .all() as Array<{ channel: string; total: number; responded: number }>;
  const recent = db
    .prepare(
      `SELECT survey_token AS token, channel, rating, comment, responded_at, created_at
       FROM csat_surveys WHERE survey_status = 'completed' ORDER BY responded_at DESC LIMIT 20`,
    )
    .all() as Array<{
    token: string;
    channel: string;
    rating: number | null;
    comment: string | null;
    responded_at: string | null;
    created_at: string;
  }>;
  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    total,
    responded,
    pending,
    expired,
    responseRate: total ? round((responded / total) * 100, 1) : 0,
    avgRating: avgRow.a ? round(avgRow.a, 2) : 0,
    ratingCount: avgRow.c,
    npsLike: avgRow.c ? round(((positive - negative) / avgRow.c) * 100, 1) : 0,
    ratingDistribution: ratingDistribution.map((d) => ({ rating: d.rating, count: d.count })),
    byChannel,
    recent,
  };
}

/* ============================ 意图流水 ============================ */

export function createIntentLog(log: {
  id: string;
  session_id: string;
  message_id: string | null;
  text: string;
  intent: string;
  confidence: number;
  matched_keywords: string;
  hit_faq: number;
}): void {
  db.prepare(
    `INSERT INTO intent_logs (id, session_id, message_id, text, intent, confidence, matched_keywords, hit_faq, created_at)
     VALUES (@id, @session_id, @message_id, @text, @intent, @confidence, @matched_keywords, @hit_faq, @created_at)`
  ).run({ ...log, created_at: new Date().toISOString() });
}

/* ============================ 统计分析 ============================ */

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
  intentDistribution: Array<{ intent: string; count: number }>;
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

export function getDashboardStats(): DashboardStats {
  const totalSessions = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  const activeSessions = (
    db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status IN ('active','waiting_human','human_serving')").get() as { c: number }
  ).c;
  const totalMessages = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
  const handoffSessions = (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE handoff = 1').get() as { c: number }).c;
  const resolvedSessions = (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE resolved = 1').get() as { c: number }).c;

  const ratingAgg = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS c FROM satisfaction').get() as {
    avg: number | null;
    c: number;
  };
  const positive = (db.prepare('SELECT COUNT(*) AS c FROM satisfaction WHERE rating >= 4').get() as { c: number }).c;
  const negative = (db.prepare('SELECT COUNT(*) AS c FROM satisfaction WHERE rating <= 2').get() as { c: number }).c;

  const intentDistribution = db
    .prepare("SELECT intent, COUNT(*) AS count FROM intent_logs GROUP BY intent ORDER BY count DESC")
    .all() as Array<{ intent: string; count: number }>;

  const ratingDistribution = db
    .prepare('SELECT rating, COUNT(*) AS count FROM satisfaction GROUP BY rating ORDER BY rating ASC')
    .all() as Array<{ rating: number; count: number }>;

  const dailyTrend = db
    .prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS sessions
       FROM sessions GROUP BY date(created_at) ORDER BY date DESC LIMIT 14`
    )
    .all() as Array<{ date: string; sessions: number }>;

  const dailyMessages = db
    .prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS messages
       FROM messages GROUP BY date(created_at)`
    )
    .all() as Array<{ date: string; messages: number }>;

  const dailyRating = db
    .prepare(
      `SELECT date(created_at) AS date, AVG(rating) AS avgRating
       FROM satisfaction GROUP BY date(created_at)`
    )
    .all() as Array<{ date: string; avgRating: number }>;

  const msgMap = new Map(dailyMessages.map((d) => [d.date, d.messages]));
  const rateMap = new Map(dailyRating.map((d) => [d.date, d.avgRating]));

  const topFaqs = db
    .prepare('SELECT id, question, category, hit_count FROM faqs ORDER BY hit_count DESC LIMIT 8')
    .all() as Array<{ id: string; question: string; category: string; hit_count: number }>;

  const ticketStats = db
    .prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status')
    .all() as Array<{ status: string; count: number }>;

  const latencyRow = db
    .prepare("SELECT AVG(latency_ms) AS avg FROM messages WHERE role = 'assistant' AND latency_ms IS NOT NULL")
    .get() as { avg: number | null };

  const kbTotal = (db.prepare('SELECT COUNT(*) AS c FROM intent_logs').get() as { c: number }).c;
  const kbHit = (db.prepare('SELECT COUNT(*) AS c FROM intent_logs WHERE hit_faq = 1').get() as { c: number }).c;

  /* ---- 渠道分布 ---- */
  const channelDistribution = db
    .prepare("SELECT COALESCE(channel, 'web') AS channel, COUNT(*) AS count FROM sessions GROUP BY channel ORDER BY count DESC")
    .all() as Array<{ channel: string; count: number }>;

  /* ---- 客户等级分布 ---- */
  const customerTierDistribution = db
    .prepare("SELECT COALESCE(tier, 'new') AS tier, COUNT(*) AS count FROM customer_profiles GROUP BY tier ORDER BY count DESC")
    .all() as Array<{ tier: string; count: number }>;

  /* ---- 未结工单按优先级分布 ---- */
  const unresolvedByPriority = db
    .prepare(
      "SELECT COALESCE(priority, 'medium') AS priority, COUNT(*) AS count FROM tickets WHERE status IN ('pending','processing') GROUP BY priority ORDER BY count DESC",
    )
    .all() as Array<{ priority: string; count: number }>;

  /* ---- 工单 SLA 概览 ---- */
  const openTickets = db
    .prepare("SELECT sla_due_at FROM tickets WHERE status IN ('pending','processing')")
    .all() as Array<{ sla_due_at: string | null }>;
  const nowMs = Date.now();
  const slaOpen = openTickets.length;
  const slaBreached = openTickets.filter((t) => t.sla_due_at && new Date(t.sla_due_at).getTime() < nowMs).length;
  const ticketSla = { open: slaOpen, breached: slaBreached, withinSla: slaOpen - slaBreached };

  /* ---- 首次响应时延（秒）：单条查询取出每会话首条 user/assistant 时间，JS 用 new Date 算差值，
         把原本逐会话万次子查询（1 万次 DB 往返）降为 1 次查询；配合路由层 15s TTL 缓存，高并发近乎秒回 ---- */
  const responseTimes = (() => {
    const rows = db
      .prepare(
        `SELECT
           (SELECT MIN(created_at) FROM messages WHERE session_id = s.id AND role = 'user') AS ut,
           (SELECT MIN(created_at) FROM messages WHERE session_id = s.id AND role = 'assistant') AS at
         FROM sessions s
         WHERE s.updated_at >= datetime('now', '-90 days')
         ORDER BY s.updated_at DESC
         LIMIT 5000`,
      )
      .all() as Array<{ ut: string | null; at: string | null }>;
    const diffs: number[] = [];
    for (const r of rows) {
      if (r.ut && r.at) {
        const d = (new Date(r.at).getTime() - new Date(r.ut).getTime()) / 1000;
        if (d >= 0 && d < 3600) diffs.push(d); // 过滤异常值（跨天/脏数据）
      }
    }
    if (!diffs.length) return { avg: 0, median: 0, p95: 0, sampleSize: 0 };
    diffs.sort((x, y) => x - y);
    const avg = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const median = diffs[Math.floor(diffs.length / 2)];
    const p95 = diffs[Math.floor(diffs.length * 0.95)] ?? diffs[diffs.length - 1];
    const r2 = (n: number) => Math.round(n * 10) / 10;
    return { avg: r2(avg), median: r2(median), p95: r2(p95), sampleSize: diffs.length };
  })();

  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  return {
    totalSessions,
    activeSessions,
    totalMessages,
    handoffSessions,
    handoffRate: totalSessions ? round((handoffSessions / totalSessions) * 100, 1) : 0,
    resolutionRate: totalSessions ? round((resolvedSessions / totalSessions) * 100, 1) : 0,
    avgRating: ratingAgg.avg ? round(ratingAgg.avg, 2) : 0,
    ratingCount: ratingAgg.c,
    npsLike: ratingAgg.c ? round(((positive - negative) / ratingAgg.c) * 100, 1) : 0,
    intentDistribution,
    ratingDistribution,
    dailyTrend: dailyTrend
      .map((d) => ({
        date: d.date,
        sessions: d.sessions,
        messages: msgMap.get(d.date) ?? 0,
        avgRating: rateMap.has(d.date) ? round(rateMap.get(d.date)!, 2) : null,
      }))
      .reverse(),
    topFaqs,
    ticketStats,
    avgLatencyMs: latencyRow.avg ? Math.round(latencyRow.avg) : 0,
    kbHitRate: kbTotal ? round((kbHit / kbTotal) * 100, 1) : 0,
    channelDistribution,
    customerTierDistribution,
    unresolvedByPriority,
    ticketSla,
    responseTimes,
  };
}

/** 管理后台会话列表（带聚合字段 + 分页） */
export function getConversationList(
  filters: { status?: string; intent?: string; keyword?: string; channel?: string } = {},
  pagination: { page?: number; pageSize?: number } = {},
): { rows: Array<DbSession & { message_count: number; avg_rating: number | null; ticket_count: number; site_name: string | null }>; total: number; page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(pagination.page || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(pagination.pageSize || 20)));
  const where: string[] = [];
  const params: any[] = [];
  if (filters.status) {
    where.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.intent) {
    where.push('s.primary_intent = ?');
    params.push(filters.intent);
  }
  if (filters.keyword) {
    // 同时支持标题 / 客户名 / 会话内消息内容的模糊检索
    where.push('(s.title LIKE ? OR s.customer_name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ?))');
    params.push(`%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`);
  }
  if (filters.channel) {
    where.push('s.channel = ?');
    params.push(filters.channel);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM sessions s ${whereSql}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(`
    SELECT s.*,
      (SELECT name FROM sites st WHERE st.site_id = s.site_id) AS site_name,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT AVG(rating) FROM satisfaction sf WHERE sf.session_id = s.id) AS avg_rating,
      (SELECT COUNT(*) FROM tickets t WHERE t.session_id = s.id) AS ticket_count
    FROM sessions s
    ${whereSql}
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `)
    .all(...params, pageSize, (page - 1) * pageSize) as Array<
    DbSession & { message_count: number; avg_rating: number | null; ticket_count: number; site_name: string | null }
  >;
  return { rows, total, page, pageSize };
}

/** 导出用：返回全部匹配的会话扁平记录（不受分页限制，用于 CSV 生成） */
export function getConversationExport(filters: { status?: string; intent?: string; keyword?: string; channel?: string } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filters.status) {
    where.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.intent) {
    where.push('s.primary_intent = ?');
    params.push(filters.intent);
  }
  if (filters.keyword) {
    where.push('(s.title LIKE ? OR s.customer_name LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ?))');
    params.push(`%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`);
  }
  if (filters.channel) {
    where.push('s.channel = ?');
    params.push(filters.channel);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db
    .prepare(`
    SELECT s.id, s.title, s.customer_name, s.primary_intent, s.status, s.resolved,
      (SELECT name FROM sites st WHERE st.site_id = s.site_id) AS site_name,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT AVG(rating) FROM satisfaction sf WHERE sf.session_id = s.id) AS avg_rating,
      (SELECT COUNT(*) FROM tickets t WHERE t.session_id = s.id) AS ticket_count,
      s.handoff_reason, s.created_at, s.updated_at
    FROM sessions s
    ${whereSql}
    ORDER BY s.updated_at DESC
  `)
    .all(...params) as Array<Record<string, unknown>>;
}

/** 数据库探活（供 /api/health 使用） */
export function ping(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function clearAllData(): void {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM satisfaction; DELETE FROM tickets; DELETE FROM intent_logs; DELETE FROM messages; DELETE FROM sessions;');
  });
  tx();
}

export function faqCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM faqs').get() as { c: number }).c;
}

/* ============================ 数据库运维（备份 / 完整性 / 空间回收） ============================ */

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

/** 返回数据库文件体积、schema 版本与运行模式，供管理后台展示 */
export function getDbMeta(): DbMeta {
  const sizeOf = (f: string): number => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  return {
    dbPath,
    sizeBytes: sizeOf(dbPath),
    walBytes: sizeOf(walPath),
    shmBytes: sizeOf(shmPath),
    totalBytes: sizeOf(dbPath) + sizeOf(walPath) + sizeOf(shmPath),
    schemaVersion: Number(db.pragma('user_version', { simple: true }) || 0),
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    pageSize: Number(db.pragma('page_size', { simple: true }) || 0),
  };
}

/* ============================ LLM 配置（llm_config 单行表） ============================ */

export interface DbLlmConfig {
  model: string;
  apiKey: string;
  endpoint: string;
  temperature: number;
  maxReplyLength: number;
  systemPrompt: string;
  updatedAt: string;
}

/** 读取当前 LLM 配置（含明文 apiKey，仅内部/鉴权后使用，对外须脱敏） */
export function getLlmConfig(): DbLlmConfig {
  const row = db
    .prepare(
      `SELECT model, api_key, endpoint, temperature, max_reply_length, system_prompt, updated_at FROM llm_config WHERE id = 1`,
    )
    .get() as
    | {
        model: string;
        api_key: string;
        endpoint: string;
        temperature: number;
        max_reply_length: number;
        system_prompt: string;
        updated_at: string;
      }
    | undefined;
  return {
    model: row?.model ?? 'auto',
    apiKey: row?.api_key ?? '',
    endpoint: row?.endpoint ?? '',
    temperature: typeof row?.temperature === 'number' ? row.temperature : 0.7,
    maxReplyLength: typeof row?.max_reply_length === 'number' ? row.max_reply_length : 600,
    systemPrompt: row?.system_prompt ?? '',
    updatedAt: row?.updated_at ?? '',
  };
}

/** 局部更新 LLM 配置（仅更新传入字段），返回更新后的完整配置 */
export function saveLlmConfig(patch: Partial<Omit<DbLlmConfig, 'updatedAt'>>): DbLlmConfig {
  const current = getLlmConfig();
  const next: DbLlmConfig = {
    model: patch.model ?? current.model,
    apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey,
    endpoint: patch.endpoint !== undefined ? patch.endpoint : current.endpoint,
    temperature: patch.temperature !== undefined ? patch.temperature : current.temperature,
    maxReplyLength: patch.maxReplyLength !== undefined ? patch.maxReplyLength : current.maxReplyLength,
    systemPrompt: patch.systemPrompt !== undefined ? patch.systemPrompt : current.systemPrompt,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE llm_config SET model = ?, api_key = ?, endpoint = ?, temperature = ?, max_reply_length = ?, system_prompt = ?, updated_at = ? WHERE id = 1`,
  ).run(next.model, next.apiKey, next.endpoint, next.temperature, next.maxReplyLength, next.systemPrompt, next.updatedAt);
  return next;
}

/**
 * 生成一致性的数据库快照：先 wal_checkpoint(TRUNCATE) 将 WAL 刷入主库，
 * 再连同 -wal/-shm 一并拷贝到临时文件返回路径。调用方负责传输后的清理。
 */
export function backupDb(): string {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dataDir, '.backups', `chat-${stamp}.db`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(dbPath, dest);
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.copyFileSync(`${dbPath}${ext}`, `${dest}${ext}`);
    } catch {
      /* 该附属文件可能不存在（如 checkpoint 后已截断） */
    }
  }
  logger.info(`[DB] 已生成备份快照: ${dest}`);
  return dest;
}

export interface DbIntegrity {
  ok: boolean;
  integrity: string[];
  foreignKeyIssues: Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  tableCounts: Record<string, number>;
}

/** 数据库完整性自检：integrity_check + foreign_key_check + 各表行数 */
export function checkIntegrity(): DbIntegrity {
  const raw = db.pragma('integrity_check') as Array<Record<string, unknown>> | string;
  const integrity = Array.isArray(raw) ? raw.map((r) => String(Object.values(r)[0])) : [String(raw)];
  const ok = integrity.length === 1 && integrity[0].toLowerCase() === 'ok';
  const fk = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  const tables = ['sessions', 'messages', 'faqs', 'tickets', 'satisfaction', 'intent_logs'];
  const tableCounts: Record<string, number> = {};
  for (const t of tables) {
    try {
      tableCounts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    } catch {
      tableCounts[t] = -1;
    }
  }
  return { ok, integrity, foreignKeyIssues: fk || [], tableCounts };
}

export interface VacuumResult {
  sizeBefore: number;
  sizeAfter: number;
  reclaimedBytes: number;
}

/** 回收空闲空间（VACUUM）。仅管理员手动触发；大库耗时较长，会短暂独占数据库 */
export function vacuumDb(): VacuumResult {
  const sizeOf = (f: string): number => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  const before = sizeOf(dbPath);
  db.exec('VACUUM');
  const after = sizeOf(dbPath);
  return { sizeBefore: before, sizeAfter: after, reclaimedBytes: Math.max(0, before - after) };
}

/* ============================ 员工/坐席账户操作 ============================ */

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function getUserByUsername(username: string): DbUser | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as DbUser | undefined;
}

export function getUserById(id: string): DbUser | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUser | undefined;
}

export function listUsers(): DbUserPublic[] {
  return db
    .prepare(
      'SELECT id, username, display_name, role, status, created_at, updated_at FROM users ORDER BY created_at ASC',
    )
    .all() as DbUserPublic[];
}

export interface CreateUserInput {
  username: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  status?: UserStatus;
}

export function createUser(input: CreateUserInput): DbUser {
  const now = new Date().toISOString();
  const user: DbUser = {
    id: crypto.randomUUID(),
    username: input.username,
    display_name: input.display_name,
    role: input.role,
    password_hash: input.password_hash,
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, status, created_at, updated_at)
     VALUES (@id, @username, @display_name, @role, @password_hash, @status, @created_at, @updated_at)`,
  ).run(user);
  return user;
}

export type UserUpdatable = Partial<Pick<DbUser, 'display_name' | 'role' | 'status' | 'password_hash'>>;

export function updateUser(id: string, updates: UserUpdatable): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  (Object.keys(updates) as Array<keyof UserUpdatable>).forEach((key) => {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  });
  if (fields.length === 0) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

/* ============================ 客户长期画像操作 ============================ */

export function getCustomerProfile(customerId: string): DbCustomerProfile | undefined {
  return db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(customerId) as
    | DbCustomerProfile
    | undefined;
}

export interface UpsertCustomerProfileInput {
  customer_id: string;
  name?: string;
  company?: string;
  industry?: string;
  contact?: string;
  tags?: string;
  preferences?: string;
  notes?: string;
  history_summary?: string;
  last_session_id?: string | null;
  /** 画像增强字段（v5） */
  tier?: string;
  last_intent?: string | null;
  sentiment_score?: number;
  last_contact_at?: string | null;
}

export function upsertCustomerProfile(input: UpsertCustomerProfileInput): DbCustomerProfile {
  const now = new Date().toISOString();
  const existing = getCustomerProfile(input.customer_id);
  const merged: DbCustomerProfile = {
    customer_id: input.customer_id,
    name: input.name ?? existing?.name ?? '',
    company: input.company ?? existing?.company ?? '',
    industry: input.industry ?? existing?.industry ?? '',
    contact: input.contact ?? existing?.contact ?? '',
    tags: input.tags ?? existing?.tags ?? '',
    preferences: input.preferences ?? existing?.preferences ?? '',
    notes: input.notes ?? existing?.notes ?? '',
    history_summary: input.history_summary ?? existing?.history_summary ?? '',
    last_session_id:
      input.last_session_id !== undefined ? input.last_session_id : (existing?.last_session_id ?? null),
    session_count: existing?.session_count ?? 0,
    tier: input.tier ?? existing?.tier ?? 'new',
    last_intent: input.last_intent !== undefined ? input.last_intent : (existing?.last_intent ?? null),
    sentiment_score: input.sentiment_score ?? existing?.sentiment_score ?? 0,
    last_contact_at:
      input.last_contact_at !== undefined ? input.last_contact_at : (existing?.last_contact_at ?? null),
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO customer_profiles
      (customer_id, name, company, industry, contact, tags, preferences, notes, history_summary, last_session_id, session_count, tier, last_intent, sentiment_score, last_contact_at, updated_at)
     VALUES (@customer_id, @name, @company, @industry, @contact, @tags, @preferences, @notes, @history_summary, @last_session_id, @session_count, @tier, @last_intent, @sentiment_score, @last_contact_at, @updated_at)
     ON CONFLICT(customer_id) DO UPDATE SET
       name=excluded.name, company=excluded.company, industry=excluded.industry, contact=excluded.contact,
       tags=excluded.tags, preferences=excluded.preferences, notes=excluded.notes, history_summary=excluded.history_summary,
       last_session_id=excluded.last_session_id, session_count=excluded.session_count,
       tier=excluded.tier, last_intent=excluded.last_intent, sentiment_score=excluded.sentiment_score,
       last_contact_at=excluded.last_contact_at, updated_at=excluded.updated_at`,
  ).run(merged);
  return merged;
}

/** 记录一次会话接触：会话数 +1 并更新最近会话与访问时间（session_count 在存量基础上递增，避免覆盖其他字段） */
export function touchCustomerSession(customerId: string, sessionId: string): void {
  const existing = getCustomerProfile(customerId);
  const count = (existing?.session_count ?? 0) + 1;
  db.prepare(
    `INSERT INTO customer_profiles (customer_id, last_session_id, session_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET
       last_session_id=excluded.last_session_id, session_count=?, updated_at=?`,
  ).run(customerId, sessionId, count, new Date().toISOString(), count, new Date().toISOString());
}

/* ============================ 接入站点 / 访客（嵌入渠道） ============================ */

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 生成标准 UUID（依赖 Node 内置 crypto，无需额外依赖） */
function uuid4Fallback(): string {
  return crypto.randomUUID();
}

export function getSiteBySiteId(siteId: string): DbSite | undefined {
  return db.prepare('SELECT * FROM sites WHERE site_id = ?').get(siteId) as DbSite | undefined;
}

export function getSiteByToken(token: string): DbSite | undefined {
  return db.prepare('SELECT * FROM sites WHERE embed_token = ?').get(token) as DbSite | undefined;
}

/** 站点列表（聚合会话数，隐藏 embed_token 以免泄露） */
export function listSites(): DbSiteListItem[] {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM sessions ss WHERE ss.site_id = s.site_id) AS session_count
       FROM sites s ORDER BY s.created_at DESC`,
    )
    .all() as Array<DbSite & { session_count: number }>;
  return rows.map(({ embed_token, ...rest }) => rest);
}

export interface CreateSiteInput {
  name: string;
  domain?: string;
}

export function createSite(input: CreateSiteInput): DbSite {
  const now = new Date().toISOString();
  const site: DbSite = {
    id: uuid4Fallback(),
    site_id: 'site_' + randomToken(8),
    name: input.name,
    domain: input.domain ?? '',
    embed_token: randomToken(24),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO sites (id, site_id, name, domain, embed_token, status, created_at, updated_at)
     VALUES (@id, @site_id, @name, @domain, @embed_token, @status, @created_at, @updated_at)`,
  ).run(site);
  return site;
}

export interface UpdateSiteInput {
  name?: string;
  domain?: string;
  status?: 'active' | 'disabled';
}

export function updateSite(id: string, patch: UpdateSiteInput): DbSite | undefined {
  const existing = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbSite | undefined;
  if (!existing) return undefined;
  const next: DbSite = {
    ...existing,
    name: patch.name ?? existing.name,
    domain: patch.domain ?? existing.domain,
    status: patch.status ?? existing.status,
    updated_at: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE sites SET name=@name, domain=@domain, status=@status, updated_at=@updated_at WHERE id=@id`,
  ).run(next);
  return next;
}

export function upsertVisitor(input: {
  visitor_id: string;
  site_id: string;
  name?: string;
  contact?: string;
  meta?: string;
}): DbVisitor {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM visitors WHERE visitor_id = ?').get(input.visitor_id) as
    | DbVisitor
    | undefined;
  const merged: DbVisitor = {
    id: existing?.id ?? uuid4Fallback(),
    visitor_id: input.visitor_id,
    site_id: input.site_id,
    name: input.name ?? existing?.name ?? '',
    contact: input.contact ?? existing?.contact ?? '',
    meta: input.meta ?? existing?.meta ?? '',
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO visitors (id, visitor_id, site_id, name, contact, meta, created_at, updated_at)
     VALUES (@id, @visitor_id, @site_id, @name, @contact, @meta, @created_at, @updated_at)
     ON CONFLICT(visitor_id) DO UPDATE SET
       name=excluded.name, contact=excluded.contact, meta=excluded.meta, updated_at=excluded.updated_at`,
  ).run(merged);
  return merged;
}

export function getVisitor(visitorId: string): DbVisitor | undefined {
  return db.prepare('SELECT * FROM visitors WHERE visitor_id = ?').get(visitorId) as DbVisitor | undefined;
}

/** 取该访客在某站点下的最近一次会话（用于跨页面刷新续接对话，保证消息实时收发与后台同步的连续性） */
export function getLatestSessionForVisitor(siteId: string, visitorId: string): DbSession | undefined {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(siteId, visitorId) as DbSession | undefined;
}

export default db;
