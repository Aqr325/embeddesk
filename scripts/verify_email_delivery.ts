/**
 * CSAT 邮件投递端到端联调（隔离环境，无需外网 / 真实邮箱）。
 *
 * 流程：
 *   1. 起 4 个本地 mock SMTP 服务：capture / fail-transient / fail-permanent / slow；
 *   2. 通过真实 nodemailer SMTP 协议连接它们，验证「发送 → 接收」；
 *   3. 覆盖异常重试：瞬时可恢复(451)→重试、永久错误(550)→不重试、超时(slow)→重试；
 *   4. 校验 emailGateway 投递指标（发送量 / 成功率 / 重试数 / 延迟）随场景正确变化。
 *
 * 运行：node_modules/.bin/tsx scripts/verify_email_delivery.ts
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import process from 'node:process';
import fs from 'node:fs';

const EXEC = 'node';
const MOCK = 'scripts/mock-smtp-server.mjs';

// ---- 端口规划 ----
const CAP = { smtp: 3201, http: 3211, mode: 'capture' };
const TRN = { smtp: 3203, http: 3213, mode: 'fail-transient' };
const PRM = { smtp: 3204, http: 3214, mode: 'fail-permanent' };
const SLOW = { smtp: 3205, http: 3215, mode: 'slow' };

// ---- 环境（真实 SMTP 配置指向本地 mock）----
const DB = `/tmp/csat_email_${Date.now()}.db`;
process.env.CSA_DB_PATH = DB;
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_SMTP_HOST = '127.0.0.1';
process.env.EMAIL_SMTP_PORT = String(CAP.smtp);
process.env.EMAIL_SMTP_SECURE = 'false';
process.env.EMAIL_SMTP_USER = 'test@local';
process.env.EMAIL_SMTP_PASS = 'test';
process.env.EMAIL_FROM = 'csat@local';
process.env.EMAIL_SMTP_MAX_RETRIES = '3';
process.env.EMAIL_SMTP_RETRY_DELAY_MS = '150';
process.env.EMAIL_SMTP_TIMEOUT_MS = '3000';

const children: any[] = [];
function startMock(c: { smtp: number; http: number; mode: string }) {
  const out = `/tmp/smtp_recv_${c.smtp}.jsonl`;
  try {
    fs.writeFileSync(out, '');
  } catch {
    /* ignore */
  }
  const p = spawn(EXEC, [MOCK, '--smtp', String(c.smtp), '--http', String(c.http), '--mode', c.mode, '--out', out], {
    stdio: 'ignore',
  });
  p.on('error', (e) => console.error(`[spawn ${c.mode}] error:`, e));
  children.push(p);
  return p;
}

async function waitHealth(httpPort: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${httpPort}/health`);
      if (r.ok) return true;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function getReceived(httpPort: number): Promise<any[]> {
  const r = await fetch(`http://127.0.0.1:${httpPort}/received`);
  return (await r.json()) as any[];
}
async function pollReceived(httpPort: number, pred: (m: any) => boolean, timeoutMs = 5000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await getReceived(httpPort);
    const hit = list.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ---- 断言工具 ----
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  console.log('=== 启动 mock SMTP 服务 ===');
  startMock(CAP);
  startMock(TRN);
  startMock(PRM);
  startMock(SLOW);
  const okCaps = (await waitHealth(CAP.http)) && (await waitHealth(TRN.http)) && (await waitHealth(PRM.http)) && (await waitHealth(SLOW.http));
  check('mock SMTP 全部就绪', okCaps);
  if (!okCaps) return finish();

  // 动态导入（env 已就绪，db 指向隔离库）
  const db = await import('../server/db.js');
  const csat = await import('../server/csat.js');
  const eg = await import('../server/emailGateway.js');

  // 建会话（csat_surveys 外键依赖）
  const sid = crypto.randomUUID();
  db.createSession({ id: sid, title: 'CSAT e2e 联调', model: 'test' });

  // 场景 1：CSAT 工单 resolved → 派发问卷 → 真实 SMTP 投递 → 接收
  {
    const before = eg.getEmailDeliveryStats();
    csat.dispatchSurvey({ sessionId: sid, channel: 'email', toAddress: 'customer@local', customerName: '测试客户' });
    const decode = (s: string) => {
      if (!s) return '';
      // mock 现已存解码后的明文；仅当字符串是纯 base64 特征时才尝试解码
      if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return s;
      try {
        return Buffer.from(s || '', 'base64').toString('utf8');
      } catch {
        return s || '';
      }
    };
    const msg = await pollReceived(
      CAP.http,
      (m) => m.to === 'customer@local' && decode(m.text).includes('/survey/'),
      6000,
    );
    const after = eg.getEmailDeliveryStats();
    check(
      'CSAT 问卷邮件被 mock SMTP 真实接收（含 /survey/ 链接）',
      !!msg,
      msg ? `to=${msg.to} subject(解码)=${decode(msg.subject).slice(0, 24)} 正文含链接=${decode(msg.text).includes('/survey/')}` : '未收到',
    );
    check(
      'CSAT 投递计入成功指标 (sentByType.csat+1, 成功率=1)',
      !!msg && after.sentByType.csat - (before.sentByType.csat || 0) >= 1 && after.successRate >= before.successRate,
      `csat sent: ${before.sentByType.csat || 0} -> ${after.sentByType.csat || 0}, successRate=${after.successRate}`,
    );
  }

  // 场景 2：瞬时可恢复错误(451) → 应重试 maxRetries 次后失败
  {
    process.env.EMAIL_SMTP_PORT = String(TRN.smtp);
    const before = eg.getEmailDeliveryStats();
    const ok = await eg.sendMail('x@local', 'subj', 'body');
    const after = eg.getEmailDeliveryStats();
    const retries = after.retryTotal - before.retryTotal;
    const fails = (after.failuresByType.csat || 0) - (before.failuresByType.csat || 0);
    check('瞬时可恢复(451)：sendMail 返回 false', ok === false);
    check('瞬时可恢复(451)：触发重试 (retryTotal 增量=3)', retries === 3, `retry delta=${retries}`);
    check('瞬时可恢复(451)：计入 1 次失败', fails === 1, `fail delta=${fails}`);
  }

  // 场景 3：永久错误(550) → 立即放弃，不重试
  {
    process.env.EMAIL_SMTP_PORT = String(PRM.smtp);
    const before = eg.getEmailDeliveryStats();
    const ok = await eg.sendMail('x@local', 'subj', 'body');
    const after = eg.getEmailDeliveryStats();
    const retries = after.retryTotal - before.retryTotal;
    const fails = (after.failuresByType.csat || 0) - (before.failuresByType.csat || 0);
    check('永久错误(550)：sendMail 返回 false', ok === false);
    check('永久错误(550)：不重试 (retryTotal 增量=0)', retries === 0, `retry delta=${retries}`);
    check('永久错误(550)：计入 1 次失败', fails === 1, `fail delta=${fails}`);
  }

  // 场景 4：超时(slow) → 每次 attempt 超时 → 重试 → 记录延迟
  {
    process.env.EMAIL_SMTP_PORT = String(SLOW.smtp);
    const before = eg.getEmailDeliveryStats();
    const ok = await eg.sendMail('x@local', 'subj', 'body');
    const after = eg.getEmailDeliveryStats();
    const retries = after.retryTotal - before.retryTotal;
    check('超时(slow)：sendMail 返回 false', ok === false);
    check('超时(slow)：触发重试 (retryTotal 增量>0)', retries > 0, `retry delta=${retries}`);
    check('超时(slow)：记录到延迟 (latencyLast>0)', after.latencyLastSeconds > 0, `last=${after.latencyLastSeconds}s avg=${after.latencyAvgSeconds}s`);
  }

  // 汇总指标
  const final = eg.getEmailDeliveryStats();
  console.log('\n=== 最终投递指标 ===');
  console.log(JSON.stringify(final, null, 2));
  check('整体错误率与成功率自洽', Math.abs(final.successRate + final.errorRate - 1) < 1e-6, `success=${final.successRate} error=${final.errorRate}`);

  finish();
}

function finish() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
