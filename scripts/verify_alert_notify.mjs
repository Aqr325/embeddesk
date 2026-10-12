/**
 * 告警通知端到端验证（无需 Docker / 无需真实企点 / 无需真实 SMTP）
 *
 * 启动：
 *   - mock SMTP 服务（scripts/mock-smtp-server.mjs，capture 模式）
 *   - mock 腾讯企点 webhook（本脚本内 HTTP，记录收到的 POST body）
 *   - 真实 alert-relay 服务（scripts/alert-relay.mjs），指向上述两个 mock
 * 然后模拟 Alertmanager 分别 POST「触发(firing)」与「恢复(resolved)」告警，
 * 断言邮件与企点两路都正确接收且内容包含告警关键信息。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMTP_PORT = 3401;
const SMTP_HTTP = 3411;
const QIDIAN_PORT = 3421;
const RELAY_PORT = 9099;
const ALERT_EMAIL = 'cx-ops@example.com';

// ---- mock 企点 webhook ----
const qidianReceived = [];
const qidianServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/qidian') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        qidianReceived.push(JSON.parse(raw));
      } catch {
        qidianReceived.push({ raw });
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }
  res.writeHead(404);
  res.end('nf');
});

// ---- 工具 ----
const children = [];
function spawnProc(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(p);
  return p;
}
function get(url) {
  return new Promise((resolve) => {
    http
      .get(url, (r) => {
        let s = '';
        r.on('data', (d) => (s += d));
        r.on('end', () => {
          try {
            resolve(JSON.parse(s));
          } catch {
            resolve(s);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}
function post(url, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (r) => {
        let s = '';
        r.on('data', (d) => (s += d));
        r.on('end', () => {
          try {
            resolve({ status: r.statusCode, body: JSON.parse(s) });
          } catch {
            resolve({ status: r.statusCode, body: s });
          }
        });
      },
    );
    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}
function decodeQP(text) {
  // nodemailer 对含非 ASCII 的 text 使用 quoted-printable 编码（=XX 十六进制字节）
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /[A-Fa-f0-9]{2}/.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
function decodeMail(text) {
  // mock SMTP 把含 MIME 头的整段当作 text 存，正文是 base64；提取并解码 base64 段
  const m = /Content-Transfer-Encoding:\s*base64/i.exec(text);
  if (m) {
    const after = text.slice(m.index);
    const parts = after.split(/\r?\n\r?\n/);
    const b64 = parts[parts.length - 1].replace(/\s+/g, '');
    try {
      const d = Buffer.from(b64, 'base64').toString('utf8');
      if (d) return d;
    } catch {}
  }
  return text;
}
function contains(needle, haystack) {
  if (!haystack) return false;
  if (haystack.includes(needle)) return true;
  try {
    if (decodeQP(haystack).includes(needle)) return true;
  } catch {}
  try {
    if (decodeMail(haystack).includes(needle)) return true;
  } catch {}
  return false;
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' :: ' + extra : ''));
  cond ? pass++ : fail++;
}

const firingPayload = {
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'EmailErrorRateHigh', severity: 'critical', team: 'support-platform' },
      annotations: {
        summary: '邮件投递错误率过高 (35%)',
        description: '邮件投递错误率持续 5 分钟超过 20%（当前 35%）。可能 SMTP 凭证失效。',
      },
    },
  ],
};
const resolvedPayload = {
  alerts: [
    {
      status: 'resolved',
      labels: { alertname: 'EmailErrorRateHigh', severity: 'critical', team: 'support-platform' },
      annotations: { summary: '邮件投递错误率过高 (35%)', description: '已恢复。' },
    },
  ],
};

async function main() {
  // 启动依赖
  spawnProc('node', ['scripts/mock-smtp-server.mjs', '--smtp', String(SMTP_PORT), '--http', String(SMTP_HTTP), '--mode', 'capture', '--out', '/tmp/relay_smtp.jsonl']);
  qidianServer.listen(QIDIAN_PORT);
  spawnProc('node', ['scripts/alert-relay.mjs'], {
    ALERT_RELAY_PORT: String(RELAY_PORT),
    ALERT_EMAIL,
    QIDIAN_WEBHOOK_URL: `http://127.0.0.1:${QIDIAN_PORT}/qidian`,
    QIDIAN_MSG_TYPE: 'markdown',
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: String(SMTP_PORT),
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_SMTP_USER: 'test@local',
    EMAIL_SMTP_PASS: 'test',
    EMAIL_FROM: 'alert@local',
  });

  const relayUp = await poll(() => get(`http://127.0.0.1:${RELAY_PORT}/health`), 30, 200);
  check('relay 服务健康启动', !!relayUp, relayUp ? `smtpEnabled=${relayUp.smtpEnabled} qidianEnabled=${relayUp.qidianEnabled}` : '无响应');
  check('relay 报告 smtpEnabled=true', !!relayUp && relayUp.smtpEnabled === true);
  check('relay 报告 qidianEnabled=true', !!relayUp && relayUp.qidianEnabled === true);
  check('relay 报告 alertEmail 命中', !!relayUp && Array.isArray(relayUp.alertEmail) && relayUp.alertEmail[0] === ALERT_EMAIL);

  // 场景 A：firing 告警
  const r1 = await post(`http://127.0.0.1:${RELAY_PORT}/webhook`, firingPayload);
  check('firing: relay 返回 200', r1.status === 200, 'status=' + r1.status);
  check('firing: relay 两路均 sent/simulated', r1.body && /sent|simulated/.test(r1.body.results.email) && /sent|simulated/.test(r1.body.results.qidian), JSON.stringify(r1.body && r1.body.results));

  const mailA = await poll(() => get(`http://127.0.0.1:${SMTP_HTTP}/received`).then((a) => Array.isArray(a) ? a.find((m) => m.to === ALERT_EMAIL) : null), 30, 200);
  check('firing: 邮件被 mock SMTP 真实接收 (to=运维邮箱)', !!mailA, mailA ? `to=${mailA.to}` : '未收到');
  check('firing: 邮件内容含告警名 EmailErrorRateHigh', !!mailA && contains('EmailErrorRateHigh', mailA.text), mailA ? 'subject=' + (mailA.subject || '') : '');
  check('firing: 邮件内容含「触发」状态', !!mailA && contains('触发', mailA.text));

  const qdA = await poll(() => qidianReceived.find((m) => m.markdown && m.markdown.content.includes('EmailErrorRateHigh')), 30, 200);
  check('firing: 企点 webhook 收到 markdown 含告警名', !!qdA, qdA ? 'msgtype=' + qdA.msgtype : '未收到');
  check('firing: 企点消息类型为 markdown', !!qdA && qdA.msgtype === 'markdown', qdA ? qdA.msgtype : '');
  check('firing: 企点内容含「触发」状态', !!qdA && qdA.markdown.content.includes('触发'));

  // 场景 B：resolved 告警
  const r2 = await post(`http://127.0.0.1:${RELAY_PORT}/webhook`, resolvedPayload);
  check('resolved: relay 返回 200', r2.status === 200, 'status=' + r2.status);

  const mailB = await poll(() => get(`http://127.0.0.1:${SMTP_HTTP}/received`).then((a) => Array.isArray(a) ? [...a].reverse().find((m) => m.to === ALERT_EMAIL && contains('已恢复', m.text)) : null), 30, 200);
  check('resolved: 邮件含「已恢复」', !!mailB);
  const qdB = await poll(() => qidianReceived.find((m) => m.markdown && m.markdown.content.includes('已恢复')), 30, 200);
  check('resolved: 企点消息含「已恢复」', !!qdB);

  // 场景 C：企点未配置时，邮件仍应发送（qidian 跳过，不报错）
  const relayNoQidian = spawnProc('node', ['scripts/alert-relay.mjs'], {
    ALERT_RELAY_PORT: String(RELAY_PORT + 50),
    ALERT_EMAIL,
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: String(SMTP_PORT),
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_SMTP_USER: 'test@local',
    EMAIL_SMTP_PASS: 'test',
    EMAIL_FROM: 'alert@local',
  });
  const up2 = await poll(() => get(`http://127.0.0.1:${RELAY_PORT + 50}/health`), 30, 200);
  check('无企点配置: relay 仍健康 (qidianEnabled=false)', !!up2 && up2.qidianEnabled === false);
  const r3 = await post(`http://127.0.0.1:${RELAY_PORT + 50}/webhook`, firingPayload);
  check('无企点配置: 邮件仍发送成功 (200)', r3.status === 200 && /sent|simulated/.test(r3.body.results.email), JSON.stringify(r3.body && r3.body.results));
  check('无企点配置: qidian 状态 skipped', r3.body && r3.body.results.qidian === 'skipped(no QIDIAN_WEBHOOK_URL)');

  // 清理
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  qidianServer.close();

  console.log('\n=== 总判定 ===');
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(2);
});
