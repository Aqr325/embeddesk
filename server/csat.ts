/**
 * 客户满意度评价（CSAT）业务模块
 *
 * 定位：在工单解决 / 会话关闭后，自动向客户派发满意度问卷（邮件或应用内链接），
 * 客户通过匿名 token 链接提交 1-5 星评分 + 留言，系统回收并聚合。
 *
 * 与既有架构的关系：
 *  - 派发：复用 emailGateway.sendMail 发邮件；应用内场景仅生成 token + 链接，由坐席/前端派发。
 *  - 回收存储：csat_surveys 表记录「邀请 + 状态机」（pending/completed/expired）；
 *    提交成功后再写入既有 satisfaction 响应表（rating 1-5），供运营看板/评分分布复用。
 *  - 触发：工单被置为 resolved（POST /api/admin/tickets/:id/resolve）时自动派发；
 *    也可由管理员手动 POST /api/admin/csat/dispatch。
 *
 * 设计要点（防滥用 / 边界）：
 *  - 匿名提交凭 survey_token，无需登录；token 一次性、UNIQUE 约束防止重复派发。
 *  - 7 天有效期（SURVEY_TTL_MS）；过期提交返回 410 并惰性标记 expired。
 *  - 重复提交返回 409（已评价）。
 *  - rating 必须是 1-5 整数，否则 400。
 */
import * as db from './db.js';
import { sendMail } from './emailGateway.js';
import { logger } from './logger.js';
import crypto from 'crypto';

/** 问卷有效期：7 天 */
export const SURVEY_TTL_MS = 7 * 24 * 3600 * 1000;

export function generateSurveyToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 拼接问卷链接；baseUrl 缺省时回退到 CSA_PUBLIC_BASE_URL 环境变量，再回退为相对路径（前端 SPA 内可用） */
function buildSurveyUrl(token: string, baseUrl?: string): string {
  const base = (baseUrl || process.env.CSA_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const path = `/survey/${token}`;
  return base ? `${base}${path}` : path;
}

export interface DispatchInput {
  sessionId: string;
  ticketId?: string | null;
  channel?: string;
  toAddress?: string | null;
  customerName?: string | null;
  baseUrl?: string;
}

export interface DispatchResult {
  surveyToken: string;
  surveyUrl: string;
  /** 是否为本次新建派发（false 表示命中已有未完成问卷，已复用） */
  dispatched: boolean;
  channel: string;
}

/**
 * 派发满意度问卷。幂等：同一会话已有 pending 问卷则复用，避免重复打扰客户。
 * 邮件渠道且有收件人时发送问卷邮件；否则仅生成 token + 链接（供应用内/坐席派发）。
 */
export function dispatchSurvey(input: DispatchInput): DispatchResult {
  const channel = input.channel || 'web';
  const existing = db.getOpenCsatSurveyForSession(input.sessionId);
  if (existing) {
    return {
      surveyToken: existing.survey_token,
      surveyUrl: buildSurveyUrl(existing.survey_token, input.baseUrl),
      dispatched: false,
      channel,
    };
  }
  const token = generateSurveyToken();
  const now = new Date().toISOString();
  db.createCsatSurvey({
    id: crypto.randomUUID(),
    session_id: input.sessionId,
    ticket_id: input.ticketId ?? null,
    channel,
    survey_token: token,
    customer_name: input.customerName ?? null,
    to_address: input.toAddress ?? null,
    survey_sent_at: now,
    created_at: now,
  });
  const url = buildSurveyUrl(token, input.baseUrl);
  if (channel === 'email' && input.toAddress) {
    const body = buildEmailBody(input.customerName ?? null, url);
    // 发送失败不阻断派发（链接仍可经其他渠道到达），失败仅记日志
    sendMail(input.toAddress, '请为本次客服服务评分', body).catch(() => {});
  }
  logger.info(`[CSAT] 已派发问卷 session=${input.sessionId.slice(0, 8)} channel=${channel} token=${token.slice(0, 8)}`);
  return { surveyToken: token, surveyUrl: url, dispatched: true, channel };
}

export type SubmitStatus = 'ok' | 'already' | 'expired' | 'notfound';

/**
 * 提交问卷。返回状态机结果；'ok' 时同步写入 satisfaction 响应表（rating 1-5，resolved = 好评>=4）。
 * 校验：rating 必须为 1-5 整数（否则抛错，由路由转 400）。
 */
export function submitSurvey(token: string, rating: number, comment: string | null, tags: string | null): SubmitStatus {
  const row = db.getCsatSurveyByToken(token);
  if (!row) return 'notfound';
  if (row.survey_status === 'completed') return 'already';
  if (row.survey_status === 'expired') return 'expired';
  // 惰性过期：超过有效期则标记 expired 并拒绝
  if (Date.now() - new Date(row.survey_sent_at).getTime() > SURVEY_TTL_MS) {
    db.expireCsatSurvey(token);
    return 'expired';
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('评分 rating 必须是 1-5 的整数');
  }
  const now = new Date().toISOString();
  db.completeCsatSurvey(token, rating, comment, tags, now);
  db.createSatisfaction({
    id: crypto.randomUUID(),
    session_id: row.session_id,
    rating,
    comment,
    tags,
    resolved: rating >= 4 ? 1 : 0,
    created_at: now,
  });
  logger.info(`[CSAT] 已回收问卷 token=${token.slice(0, 8)} rating=${rating}`);
  return 'ok';
}

/** 公开元信息：供前端渲染问卷页（不泄露 PII） */
export function getSurveyMeta(token: string): { status: 'pending' | 'completed' | 'expired' | 'notfound'; rating: number | null } {
  const row = db.getCsatSurveyByToken(token);
  if (!row) return { status: 'notfound', rating: null };
  if (row.survey_status === 'pending' && Date.now() - new Date(row.survey_sent_at).getTime() > SURVEY_TTL_MS) {
    db.expireCsatSurvey(token);
    return { status: 'expired', rating: null };
  }
  return { status: row.survey_status, rating: row.rating };
}

function buildEmailBody(name: string | null, url: string): string {
  const greet = name ? `${name} 您好，` : '您好，';
  return [
    greet,
    '',
    '感谢您联系智能客服。请点击下方链接为本次服务打分（1-5 星）：',
    url,
    '',
    '该问卷 7 天内有效，您的反馈将帮助我们持续改进服务质量。',
    '',
    '—— 智能客服团队',
  ].join('\n');
}
