/**
 * 真实邮件网关：IMAP 收件轮询 + SMTP 发件回执
 *
 * 职责边界（与既有架构一致）：
 *  - 本模块是「渠道投递层」：负责把邮件从邮箱拉进来、把自动回复发回去。
 *  - 业务理解（意图识别 / 知识库 / 转人工 / 建单）全部复用 channels.ts 的
 *    ingestExternalMessage，与 web / embed / im 同源，规则不分裂。
 *  - 幂等：以邮件 Message-ID 为去重键落库 processed_emails，并对已处理邮件标记 \Seen / 移入归档目录，
 *    双重保险避免重复回复。
 *
 * 配置（环境变量；缺省即自动禁用，服务照常运行）：
 *  EMAIL_ENABLED=true
 *  EMAIL_IMAP_HOST / EMAIL_IMAP_PORT(993) / EMAIL_IMAP_USER / EMAIL_IMAP_PASS / EMAIL_IMAP_MAILBOX(INBOX)
 *  EMAIL_SMTP_HOST / EMAIL_SMTP_PORT(465) / EMAIL_SMTP_USER / EMAIL_SMTP_PASS
 *  EMAIL_SMTP_SECURE(true) / EMAIL_FROM
 *  EMAIL_POLL_INTERVAL_MS(30000) / EMAIL_BATCH_SIZE(20)
 *  EMAIL_SMTP_MAX_RETRIES(3) / EMAIL_SMTP_RETRY_DELAY_MS(800) / EMAIL_SMTP_TIMEOUT_MS(10000)
 *    投递重试与超时：仅对瞬时可恢复错误重试（超时 / 4xx 临时 / 连接抖动）；
 *    鉴权 / 收件人 / 配置类永久错误立即放弃。每次投递计入发送量 / 成功率 / 延迟 / 错误率指标。
 *
 * 沙箱 / 无凭证时：startEmailGateway() 仅打印告警并置 disabled，不启动轮询；
 * 可通过 simulateInboundEmail() 跑完整「收信 → 处理 → 回执」管线做本地验证（无需真实邮箱）。
 *
 * 容错：邮件依赖（imapflow / nodemailer / mailparser）以动态 import 加载，缺失时仅在真正启用
 * 网关时才报错，不污染服务启动；真实收发路径完全由配置开关 gate，未配置即零副作用。
 */
import * as db from './db.js';
import { ingestExternalMessage } from './channels.js';
import { logger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

/* ----------------------------- 配置 ----------------------------- */

interface ImapConf {
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox: string;
}
interface SmtpConf {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}
interface EmailConfig {
  enabled: boolean;
  smtpEnabled: boolean;
  reason: string | null;
  imap: ImapConf;
  smtp: SmtpConf;
  pollIntervalMs: number;
  batchSize: number;
}

function readConfig(): EmailConfig {
  const enabled = process.env.EMAIL_ENABLED === 'true';

  const imap: ImapConf = {
    host: process.env.EMAIL_IMAP_HOST || '',
    port: Number(process.env.EMAIL_IMAP_PORT) || 993,
    user: process.env.EMAIL_IMAP_USER || '',
    pass: process.env.EMAIL_IMAP_PASS || '',
    mailbox: process.env.EMAIL_IMAP_MAILBOX || 'INBOX',
  };
  const smtp: SmtpConf = {
    host: process.env.EMAIL_SMTP_HOST || '',
    port: Number(process.env.EMAIL_SMTP_PORT) || 465,
    secure: (process.env.EMAIL_SMTP_SECURE ?? 'true') !== 'false',
    user: process.env.EMAIL_SMTP_USER || '',
    pass: process.env.EMAIL_SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER || '',
  };
  const pollIntervalMs = Number(process.env.EMAIL_POLL_INTERVAL_MS) || 30000;
  const batchSize = Math.min(100, Math.max(1, Number(process.env.EMAIL_BATCH_SIZE) || 20));

  // SMTP 发件（CSAT 问卷 / 自动回执）与 IMAP 轮询解耦：
  // 仅 SMTP 配置齐全即可发件（满足只发问卷、不收信的场景）；
  // 完整网关（轮询收件）需 IMAP + SMTP 同时就绪。
  const imapReason: string[] = [];
  if (!imap.host) imapReason.push('EMAIL_IMAP_HOST 缺失');
  if (!imap.user) imapReason.push('EMAIL_IMAP_USER 缺失');
  if (!imap.pass) imapReason.push('EMAIL_IMAP_PASS 缺失');
  const smtpReason: string[] = [];
  if (!smtp.host) smtpReason.push('EMAIL_SMTP_HOST 缺失');
  if (!smtp.user) smtpReason.push('EMAIL_SMTP_USER 缺失');
  if (!smtp.pass) smtpReason.push('EMAIL_SMTP_PASS 缺失');
  if (!smtp.from) smtpReason.push('EMAIL_FROM 缺失');

  const smtpEnabled = enabled && smtpReason.length === 0;
  const gatewayEnabled = enabled && imapReason.length === 0 && smtpReason.length === 0;
  const reason = gatewayEnabled ? null : [...imapReason, ...smtpReason].join('；') || 'EMAIL_ENABLED != true';
  return {
    enabled: gatewayEnabled,
    smtpEnabled,
    reason,
    imap,
    smtp,
    pollIntervalMs,
    batchSize,
  };
}

/* ----------------------------- 运行状态 ----------------------------- */

export interface GatewayStatus {
  enabled: boolean;
  smtpEnabled: boolean;
  connected: boolean;
  reason: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  processedTotal: number;
  errorTotal: number;
  simulatedTotal: number;
}

let status: GatewayStatus = {
  enabled: false,
  smtpEnabled: false,
  connected: false,
  reason: null,
  lastPollAt: null,
  lastError: null,
  processedTotal: 0,
  errorTotal: 0,
  simulatedTotal: 0,
};

let timer: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

export function getEmailGatewayStatus(): GatewayStatus {
  return { ...status };
}

/* ----------------------------- 生命周期 ----------------------------- */

export function startEmailGateway(): void {
  const cfg = readConfig();
  if (!cfg.enabled) {
    status = { ...status, enabled: false, smtpEnabled: cfg.smtpEnabled, connected: false, reason: cfg.reason, lastError: null };
    logger.warn(`[EmailGateway] 未启用完整网关（缺 IMAP/SMTP 配置），跳过 IMAP 轮询${cfg.smtpEnabled ? '；但 SMTP 发件已可用' : ''}：${cfg.reason ?? ''}`);
    return;
  }
  status.enabled = true;
  status.smtpEnabled = cfg.smtpEnabled;
  status.reason = null;
  logger.info(
    `[EmailGateway] 启动邮件网关：IMAP ${cfg.imap.host}:${cfg.imap.port} 邮箱 ${cfg.imap.mailbox}，每 ${cfg.pollIntervalMs}ms 轮询`,
  );
  void pollCycle(cfg); // 启动即跑一轮，不必等首个间隔
  timer = setInterval(() => void pollCycle(cfg), cfg.pollIntervalMs);
  if (timer.unref) timer.unref();
}

export function stopEmailGateway(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  status.connected = false;
  logger.info('[EmailGateway] 已停止轮询');
}

/* ----------------------------- 轮询主循环 ----------------------------- */

async function pollCycle(cfg: EmailConfig): Promise<void> {
  if (cycleRunning) return; // 防止上一轮未完成时重叠启动
  cycleRunning = true;
  let client: any = null;
  try {
    // 动态加载可选依赖：以变量作为 specifier，使编译器将其视为 any（无需在编译期安装），
    // 运行时仅在 EMAIL_ENABLED 且依赖存在时真正加载；缺失则仅在该路径被触发时报错。
    const imapflowName = 'imapflow';
    const { ImapFlow } = await import(imapflowName);
    client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: true,
      auth: { user: cfg.imap.user, pass: cfg.imap.pass },
      logger: false,
    });
    await client.connect();
    status.connected = true;

    const lock = await client.getMailboxLock(cfg.imap.mailbox);
    try {
      const uids: number[] = await client.search({ seen: false }, { uid: true });
      if (uids.length) {
        const batch = uids.slice(-cfg.batchSize);
        for await (const msg of client.fetch(batch, { uid: true, source: true })) {
          await processMessage(cfg, msg);
        }
        // 标记已读，已处理邮件不再二次拉取
        await client.messageFlagsAdd(batch, ['\\Seen']);
        // 尝试移入归档目录（目录不存在时静默忽略）
        try {
          await client.messageMove(batch, 'Processed');
        } catch {
          /* 归档目录非必需 */
        }
      }
    } finally {
      lock.release();
    }
    status.lastPollAt = new Date().toISOString();
    status.lastError = null;
  } catch (e: any) {
    status.connected = false;
    status.lastError = e?.message || String(e);
    status.errorTotal++;
    logger.error(`[EmailGateway] 轮询异常: ${status.lastError}`);
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
    cycleRunning = false;
  }
}

/* ----------------------------- 单封邮件处理 ----------------------------- */

async function processMessage(cfg: EmailConfig, msg: any): Promise<void> {
  const messageId: string = msg.envelope?.messageId || `<uid-${msg.uid}@mailbox>`;
  // 幂等：已处理则直接跳过（processed_emails 跨重启持久化）
  if (db.isEmailProcessed(messageId)) return;

  const mailparserName = 'mailparser';
  const { simpleParser } = await import(mailparserName);
  const parsed = await simpleParser(msg.source as Buffer);
  const fromAddr: string = parsed.from?.value?.[0]?.address || '';
  const subject: string = parsed.subject || '(无主题)';
  const text: string = (parsed.text || (parsed as any).textAsHtml || '').toString().slice(0, 2000);
  if (!fromAddr || !text.trim()) {
    logger.warn(`[EmailGateway] 跳过无法解析的邮件 messageId=${messageId} from=${fromAddr}`);
    return;
  }

  const result = await ingestExternalMessage({
    channel: 'email',
    externalId: messageId,
    from: fromAddr,
    message: text,
    subject,
  });
  if ('error' in result) {
    logger.warn(`[EmailGateway] 业务处理失败 messageId=${messageId}: ${result.error}`);
    return;
  }

  const sent = await sendReply(cfg, fromAddr, subject, result.reply);
  if (sent) {
    // 仅在成功回执后才标记已处理，发送失败则保留重试
    db.recordProcessedEmail(messageId, result.sessionId, fromAddr, subject);
    status.processedTotal++;
    logger.info(
      `[EmailGateway] 已处理并回执: from=${fromAddr} session=${result.sessionId.slice(0, 8)} intent=${result.intent} handoff=${result.handoff}`,
    );
  } else {
    logger.warn(`[EmailGateway] 回执发送失败，保留重试: from=${fromAddr} messageId=${messageId}`);
  }
}

/* ----------------------------- 投递指标（供 Prometheus / Grafana） ----------------------------- */

export interface EmailDeliveryStats {
  sentTotal: number;
  sentByType: Record<string, number>;
  failuresByType: Record<string, number>;
  failureTotal: number;
  retryTotal: number;
  latencySumSeconds: number;
  latencyLastSeconds: number;
  latencyAvgSeconds: number;
  successRate: number;
  errorRate: number;
  lastError: string | null;
  lastSuccessAt: string | null;
}

const delivery = {
  sent: 0,
  sentByType: {} as Record<string, number>,
  failuresByType: {} as Record<string, number>,
  failures: 0,
  retries: 0,
  latencySum: 0,
  latencyLast: 0,
  lastError: null as string | null,
  lastSuccessAt: null as string | null,
};

function bumpSent(type: string): void {
  delivery.sent++;
  delivery.sentByType[type] = (delivery.sentByType[type] || 0) + 1;
  delivery.lastSuccessAt = new Date().toISOString();
}
function bumpFail(type: string, err: string): void {
  delivery.failures++;
  delivery.failuresByType[type] = (delivery.failuresByType[type] || 0) + 1;
  delivery.lastError = err;
}
function recordLatency(sec: number): void {
  delivery.latencySum += sec;
  delivery.latencyLast = sec;
}

/**
 * 投递错误分类：区分「瞬时可恢复（应重试）」与「永久（放弃）」。
 * - 永久：鉴权失败（535/534/530 auth）、收件人被拒（550/551/552/553/554）、请求语法（501/503/504）、
 *   TLS 证书错误、域名解析失败（ENOTFOUND）、连接被拒（ECONNREFUSED，属配置错误不应刷重试）。
 * - 可重试：超时（ETIMEDOUT/ECONNABORTED）、连接重置（ECONNRESET）、临时 DNS（EAI_AGAIN）、
 *   临时 4xx（421/450/451）、限流 / 临时不可用。
 * 兜底：保守判定为可重试（多数网络抖动会在重试中恢复）。
 */
function classification(type: string, err: any): 'retry' | 'fail' {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.responseCode || '').toLowerCase();
  if (/535|534|530/.test(msg) && /auth/i.test(msg)) return 'fail';
  if (/\b(550|551|552|553|554|501|503|504)\b/.test(msg) || /\b(550|551|552|553|554|501|503|504)\b/.test(code)) return 'fail';
  if (/self[- ]?signed|certificate|tls/.test(msg) && /(error|invalid|expired|verify)/.test(msg)) return 'fail';
  if (/enotfound|getaddrinfo|econnrefused/.test(msg)) return 'fail';
  if (/etimedout|econnaborted|econnreset|eai_again/.test(msg)) return 'retry';
  if (/\b(421|450|451)\b/.test(msg) || /\b(421|450|451)\b/.test(code)) return 'retry';
  if (/temporar|timeout|throttl|rate limit|busy/.test(msg)) return 'retry';
  return 'retry';
}

/**
 * 通过真实 SMTP 投递一封邮件，内置重试 + 超时 + 错误分类。
 * - 仅对「瞬时可恢复」错误（超时 / 4xx 临时 / 连接抖动）重试，最多 maxRetries 次（默认 3）；
 * - 鉴权 / 收件人 / 配置类「永久」错误立即放弃，不空转重试；
 * - 每次 attempt 与最终结果都计入投递指标（供 Prometheus / Grafana）。
 * type 区分业务来源：'csat'（满意度问卷）/ 'reply'（入站邮件自动回执）。
 */
async function sendWithRetry(
  cfg: EmailConfig,
  mail: { from: string; to: string; subject: string; text: string },
  type: 'csat' | 'reply',
): Promise<boolean> {
  const maxRetries = Math.max(0, Number(process.env.EMAIL_SMTP_MAX_RETRIES ?? 3));
  const retryDelay = Math.max(0, Number(process.env.EMAIL_SMTP_RETRY_DELAY_MS ?? 800));
  const timeoutMs = Math.max(1000, Number(process.env.EMAIL_SMTP_TIMEOUT_MS ?? 10000));
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now();
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      await transporter.sendMail({ from: cfg.smtp.from, to: mail.to, subject: mail.subject, text: mail.text });
      recordLatency((Date.now() - started) / 1000);
      bumpSent(type);
      if (attempt > 0) logger.warn(`[EmailGateway] ${type} 第 ${attempt} 次重试投递成功`);
      return true;
    } catch (e: any) {
      lastErr = e;
      const verdict = classification(type, e);
      const exhausted = attempt === maxRetries;
      if (verdict === 'fail' || exhausted) {
        recordLatency((Date.now() - started) / 1000);
        bumpFail(type, e?.message || String(e));
        logger.error(`[EmailGateway] ${type} 投递失败（${verdict === 'fail' ? '永久错误' : '重试用尽'}，attempt=${attempt}）: ${e?.message || e}`);
        return false;
      }
      delivery.retries++;
      logger.warn(`[EmailGateway] ${type} 投递失败，将重试 (${attempt + 1}/${maxRetries}，延迟 ${retryDelay}ms): ${e?.message || e}`);
      if (retryDelay > 0) await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
  recordLatency(0);
  bumpFail(type, lastErr?.message || 'unknown');
  return false;
}

export function getEmailDeliveryStats(): EmailDeliveryStats {
  const total = delivery.sent + delivery.failures;
  const avg = total > 0 ? delivery.latencySum / total : 0;
  return {
    sentTotal: delivery.sent,
    sentByType: { ...delivery.sentByType },
    failuresByType: { ...delivery.failuresByType },
    failureTotal: delivery.failures,
    retryTotal: delivery.retries,
    latencySumSeconds: Number(delivery.latencySum.toFixed(4)),
    latencyLastSeconds: Number(delivery.latencyLast.toFixed(4)),
    latencyAvgSeconds: Number(avg.toFixed(4)),
    successRate: total > 0 ? Number((delivery.sent / total).toFixed(4)) : 1,
    errorRate: total > 0 ? Number((delivery.failures / total).toFixed(4)) : 0,
    lastError: delivery.lastError,
    lastSuccessAt: delivery.lastSuccessAt,
  };
}

/* ----------------------------- SMTP 回执 ----------------------------- */

async function sendReply(cfg: EmailConfig, to: string, originalSubject: string, body: string): Promise<boolean> {
  const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
  return sendWithRetry(cfg, { from: cfg.smtp.from, to, subject, text: body }, 'reply');
}

/**
 * 通用文本邮件发送（供 CSAT 满意度问卷等场景复用）。
 * 配置开关 gate：未启用真实 SMTP 时模拟发送（仅记日志、返回 true，不计入投递指标）；
 * 启用时走真实 SMTP 投递（含重试 / 超时 / 指标）。
 */
export async function sendMail(to: string, subject: string, body: string): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg.smtpEnabled) {
    logger.info(`[EmailGateway][CSAT] 未启用真实 SMTP，模拟发送问卷邮件给 ${to}:\n--- BEGIN ---\n${body}\n--- END ---`);
    return true;
  }
  return sendWithRetry(cfg, { from: cfg.smtp.from, to, subject, text: body }, 'csat');
}

/* ----------------------------- 本地模拟（无需真实邮箱） ----------------------------- */

/**
 * 模拟一封入站邮件走完整管线：ingest → 生成回执 → （配置了 SMTP 则真实发送，否则记日志模拟）→ 落库去重。
 * 用于沙箱 / CI 验证邮件渠道闭环，不必依赖 IMAP 服务器。
 */
export async function simulateInboundEmail(input: {
  from: string;
  subject?: string;
  message: string;
}): Promise<{ messageId: string; sessionId: string; reply: string; sent: boolean; ticketId?: string }> {
  const messageId = `<sim-${uuidv4()}@local>`;
  const subject = input.subject || '(无主题)';
  const result = await ingestExternalMessage({
    channel: 'email',
    externalId: messageId,
    from: input.from,
    message: input.message,
    subject,
  });
  if ('error' in result) throw new Error(result.error);

  const cfg = readConfig();
  let sent: boolean;
  if (cfg.enabled) {
    sent = await sendReply(cfg, input.from, subject, result.reply);
  } else {
    logger.info(`[EmailGateway][SIM] 将向 ${input.from} 发送回执（未配置真实 SMTP，模拟发送）:\n--- BEGIN ---\n${result.reply}\n--- END ---`);
    sent = true;
  }
  db.recordProcessedEmail(messageId, result.sessionId, input.from, subject);
  status.simulatedTotal++;
  status.processedTotal++;
  return {
    messageId,
    sessionId: result.sessionId,
    reply: result.reply,
    sent,
    ticketId: result.ticketId,
  };
}
