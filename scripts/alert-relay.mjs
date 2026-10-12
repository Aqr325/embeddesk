/**
 * 告警中继服务（alert-relay）
 *
 * 接收 Prometheus Alertmanager 的 webhook 回调（标准 payload），把告警分流到两个渠道：
 *   1) 邮件（SMTP）—— 复用服务端 EMAIL_SMTP_* 凭证，发给 ALERT_EMAIL（可逗号分隔多人）
 *   2) 腾讯企点（webhook）—— POST 到 QIDIAN_WEBHOOK_URL，支持 markdown / text 两种消息类型
 *
 * 设计要点：
 *   - 纯 Node（仅依赖项目已装的 nodemailer），零框架；作为独立轻量进程运行，与业务服务解耦。
 *   - Alertmanager 已负责重试，本服务尽力发送所有「启用」的渠道，并逐渠道独立容错。
 *     仅当「所有启用的渠道都失败」时才返回 500（让 Alertmanager 重试）；部分成功返回 200。
 *   - send_resolved=true 时，告警恢复（status=resolved）也会回调，发送「已恢复」通知。
 *
 * 环境变量：
 *   ALERT_RELAY_PORT(9099)        监听端口
 *   ALERT_EMAIL                   收告警邮件地址（逗号分隔）；为空则跳过邮件渠道
 *   QIDIAN_WEBHOOK_URL            腾讯企点机器人 webhook；为空则跳过企点渠道
 *   QIDIAN_MSG_TYPE(markdown)     markdown | text
 *   QIDIAN_MENTION                企点消息 @ 成员（逗号分隔，仅 markdown 生效）
 *   EMAIL_SMTP_* / EMAIL_FROM     邮件发送凭证（与 CSAT 问卷共用同一套 SMTP 配置）
 */
import http from 'node:http';
import { Buffer } from 'node:buffer';

const PORT = Number(process.env.ALERT_RELAY_PORT || 9099);
const ALERT_EMAIL = (process.env.ALERT_EMAIL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const QIDIAN_URL = process.env.QIDIAN_WEBHOOK_URL || '';
const QIDIAN_MSG_TYPE = process.env.QIDIAN_MSG_TYPE || 'markdown';
const QIDIAN_MENTION = process.env.QIDIAN_MENTION || '';

const smtp = {
  host: process.env.EMAIL_SMTP_HOST || '',
  port: Number(process.env.EMAIL_SMTP_PORT || 465),
  secure: (process.env.EMAIL_SMTP_SECURE ?? 'true') !== 'false',
  user: process.env.EMAIL_SMTP_USER || '',
  pass: process.env.EMAIL_SMTP_PASS || '',
  from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER || '',
};
const smtpEnabled = !!(smtp.host && smtp.user && smtp.pass && smtp.from);

function fmtAlert(a) {
  const status = a.status === 'resolved' ? '✅ 已恢复' : '🔥 触发';
  const sev = a.labels?.severity || 'unknown';
  const name = a.labels?.alertname || 'unknown';
  const summary = a.annotations?.summary || '';
  const desc = a.annotations?.description || '';
  return { status, sev, name, summary, desc };
}

function buildText(alerts) {
  return alerts
    .map((a) => {
      const f = fmtAlert(a);
      return `[${f.status}] (${f.sev}) ${f.name}\n${f.summary}\n${f.desc}`;
    })
    .join('\n\n---\n\n');
}

function buildMarkdown(alerts) {
  let m = `### 🚨 智能客服 Agent 告警（${alerts.length} 条）\n`;
  if (QIDIAN_MENTION) m += `> 提醒：${QIDIAN_MENTION}\n`;
  for (const a of alerts) {
    const f = fmtAlert(a);
    m += `> **[${f.status}] ${f.name}**　级别：${f.sev}\n> ${f.summary}\n> ${f.desc}\n\n`;
  }
  return m.trim();
}

async function sendEmail(subject, text) {
  if (!smtpEnabled) {
    console.log('[relay][email] SMTP 未配置，模拟发送:', subject);
    return 'simulated';
  }
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  await transport.sendMail({ from: smtp.from, to: ALERT_EMAIL.join(','), subject, text });
  return 'sent';
}

async function sendQidian(markdown, text) {
  if (!QIDIAN_URL) {
    console.log('[relay][qidian] 未配置 QIDIAN_WEBHOOK_URL，模拟发送');
    return 'simulated';
  }
  const body =
    QIDIAN_MSG_TYPE === 'text'
      ? { msgtype: 'text', text: { content: text } }
      : { msgtype: 'markdown', markdown: { content: markdown } };
  const r = await fetch(QIDIAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('qidian http ' + r.status);
  return 'sent';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        smtpEnabled,
        qidianEnabled: !!QIDIAN_URL,
        alertEmail: ALERT_EMAIL,
        qidianMsgType: QIDIAN_MSG_TYPE,
      }),
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    let raw = '';
    let tooBig = false;
    for await (const c of req) {
      raw += c;
      if (raw.length > 1_000_000) {
        tooBig = true;
        break;
      }
    }
    if (tooBig) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      return;
    }

    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    const results = {};
    try {
      if (ALERT_EMAIL.length) {
        const subj = `[客服告警] ${alerts.length} 条 · ${new Date().toLocaleString('zh-CN')}`;
        results.email = await sendEmail(subj, buildText(alerts));
      } else {
        results.email = 'skipped(no ALERT_EMAIL)';
      }
    } catch (e) {
      results.email = 'error:' + e.message;
    }
    try {
      if (QIDIAN_URL) {
        results.qidian = await sendQidian(buildMarkdown(alerts), buildText(alerts));
      } else {
        results.qidian = 'skipped(no QIDIAN_WEBHOOK_URL)';
      }
    } catch (e) {
      results.qidian = 'error:' + e.message;
    }

    const allFailed =
      String(results.email).startsWith('error') && String(results.qidian).startsWith('error');
    res.writeHead(allFailed ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !allFailed, processed: alerts.length, results }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(
    `[relay] listening on :${PORT} | smtp=${smtpEnabled} qidian=${!!QIDIAN_URL} email=${
      ALERT_EMAIL.join(',') || '-'
    }`,
  );
});
