// ingest 写入队列化效果压测（对比 PERF_REPORT 基线 ~84.6 req/s @100 并发）
// 聚焦最重路径：退款类业务意图 → 触发建单（ticket 写入入队）。
// 可通过环境变量隔离：CSA_DB_PATH 指定服务端/落库路径，BASE 指定服务地址。
const BASE = process.env.BASE || 'http://localhost:3000';
const DB_PATH = process.env.CSA_DB_PATH || 'data/chat.db';
const SECRET = process.env.INGEST_SECRET || 'testsecret';
const now = () => performance.now();

function reqIngest(from, ext, msg) {
  return fetch(BASE + '/api/ingest/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, externalId: ext, from, message: msg, subject: '退款咨询' }),
  }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

async function timeit(fn) {
  const s = now();
  let ok = true, err = null;
  try { await fn(); } catch (e) { ok = false; err = e && e.message ? e.message : String(e); }
  return { ok, dur: now() - s, err };
}

async function bench(name, c, total) {
  const lats = [];
  let ok = 0, fail = 0;
  const errs = {};
  let i = 0;
  const wall0 = now();
  const workers = Array.from({ length: c }, async () => {
    while (i < total) {
      const idx = i++;
      const r = await timeit(() =>
        reqIngest('perf' + Math.random().toString(36).slice(2) + '@x.com', 'perf-' + idx + '-' + Math.random().toString(36).slice(2), '我要退款，订单号' + (Math.random() * 1e6 | 0)),
      );
      if (r.ok) ok++; else { fail++; errs[r.err] = (errs[r.err] || 0) + 1; }
      lats.push(r.dur);
    }
  });
  await Promise.all(workers);
  const wall = now() - wall0;
  lats.sort((a, b) => a - b);
  const pct = (p) => (lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p / 100))].toFixed(1) : '0');
  const avg = lats.length ? (lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1) : '0';
  const tput = (total / (wall / 1000)).toFixed(1);
  console.log(`### ${name}  c=${c} total=${total}  ok=${ok} fail=${fail} err=${(fail/total*100).toFixed(2)}%  tput=${tput}/s  avg=${avg}ms p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${lats.length?lats[lats.length-1].toFixed(1):'0'}ms`);
  return { name, c, ok, fail, errorRate: fail/total, throughput: Number(tput), avg: Number(avg), p95: Number(pct(95)) };
}

async function waitDrain(timeoutMs = 15000) {
  const t0 = now();
  let seen = 0;
  while (now() - t0 < timeoutMs) {
    const j = await (await fetch(BASE + '/api/health')).json();
    seen = Math.max(seen, j.writeQueue.enqueued);
    if (j.writeQueue.pending === 0 && j.writeQueue.enqueued > 0) return j.writeQueue;
    await new Promise((r) => setImmediate(r));
  }
  return null;
}

async function readCounts() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const c = (sql) => db.prepare(sql).get().c;
  const out = {
    sessions: c('SELECT COUNT(*) AS c FROM sessions'),
    messages: c('SELECT COUNT(*) AS c FROM messages'),
    tickets: c('SELECT COUNT(*) AS c FROM tickets'),
    intentLogs: c('SELECT COUNT(*) AS c FROM intent_logs'),
  };
  db.close();
  return out;
}

(async () => {
  console.log('=== ingest 写入队列化压测（基线 ~84.6/s @100，p95 1198ms）===');
  const before = await readCounts();

  // 线程续接正确性：同一客户发 5 条（不同 externalId），应复用同一会话、不重复建单
  const cont = 'cont-' + Date.now() + '@x.com';
  for (let k = 0; k < 5; k++) {
    await reqIngest(cont, 'cont-ext-' + k, '我的模组经常掉线，怎么处理' + k);
  }
  await waitDrain();
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const cid = 'ext_email:' + cont.toLowerCase();
  const contSession = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE customer_id=?').get(cid).c;
  const contMsg = db.prepare('SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON m.session_id=s.id WHERE s.customer_id=?').get(cid).c;
  const contTicket = db.prepare('SELECT COUNT(*) AS c FROM tickets t JOIN sessions s ON t.session_id=s.id WHERE s.customer_id=?').get(cid).c;
  db.close();
  console.log(`\n--- 线程续接校验（customer=${cid}）---`);
  console.log(`  sessions=${contSession} (期望 1)  messages=${contMsg} (期望 10: 5用户+5助手)  tickets=${contTicket} (期望 0: 技术咨询非业务意图)`);
  console.log(contSession === 1 && contTicket === 0 ? '  ✅ 续接正确：未重复建单' : '  ⚠️ 续接异常，请检查');

  console.log('\n--- 吞吐梯度（退款业务意图，最重路径）---');
  const r = [];
  for (const [c, total] of [[100, 600], [200, 800], [400, 1000]]) {
    const res = await bench('ingest/email(business)', c, total);
    const q = await waitDrain();
    const pending = q ? q.pending : '?';
    console.log(`   队列剩余=${pending} batches=${q?q.batches:'?'} flushed=${q?q.flushed:'?'} errors=${q?q.errors:'?'}`);
    r.push(res);
  }

  // 重复查询场景：真实流量中大量相似问题（如「怎么退款」反复出现），LRU 命中后跳过整轮打分。
  // 用固定 12 条代表性质询轮换作为 message（触发 LRU 命中），externalId 仍唯一以避开 ingest 幂等。
  const REPEAT_QUERIES = [
    'NB-IoT 和 Cat.1 怎么选', '你们主推哪些蜂窝模组系列', '模组支持 OpenCPU 二次开发吗',
    '哪款模组带 NPU 算力多少', '支持哪些模型框架和量化方式', '如何降低模组待机功耗',
    '一节电池大概能用多久', '模组有哪些认证整机出口要补什么', '无线认证周期大概多久',
    '编译开发环境怎么搭建', '固件 OTA 升级失败怎么排查', '最小起订量和标准交期',
  ];
  async function reqRepeat(from, ext, qi) {
    return fetch(BASE + '/api/ingest/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, externalId: ext, from, message: REPEAT_QUERIES[qi % REPEAT_QUERIES.length], subject: '咨询' }),
    }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  async function benchRepeat(name, c, total) {
    const lats = []; let ok = 0, fail = 0; const errs = {}; let i = 0; const wall0 = now();
    const workers = Array.from({ length: c }, async () => {
      while (i < total) {
        const idx = i++;
        const r = await timeit(() => reqRepeat('repeat' + Math.random().toString(36).slice(2) + '@x.com', 'rep-' + idx + '-' + Math.random().toString(36).slice(2), idx));
        if (r.ok) ok++; else { fail++; errs[r.err] = (errs[r.err] || 0) + 1; }
        lats.push(r.dur);
      }
    });
    await Promise.all(workers);
    const wall = now() - wall0; lats.sort((a, b) => a - b);
    const pct = (p) => (lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p / 100))].toFixed(1) : '0');
    const tput = (total / (wall / 1000)).toFixed(1);
    console.log(`### ${name}  c=${c} total=${total}  ok=${ok} fail=${fail} err=${(fail/total*100).toFixed(2)}%  tput=${tput}/s  p95=${pct(95)}ms (LRU 命中路径)`);
  }
  console.log('\n--- 重复查询（LRU 命中）场景 @c=100 ---');
  await benchRepeat('ingest/email(repeat-query)', 100, 600);
  await waitDrain();

  const after = await readCounts();
  console.log('\n=== 落库校验（写后队列最终一致）===');
  console.log(`  sessions ${before.sessions} -> ${after.sessions} (+${after.sessions-before.sessions})`);
  console.log(`  messages ${before.messages} -> ${after.messages} (+${after.messages-before.messages})`);
  console.log(`  tickets  ${before.tickets} -> ${after.tickets} (+${after.tickets-before.tickets})`);
  console.log(`  intentLogs ${before.intentLogs} -> ${after.intentLogs} (+${after.intentLogs-before.intentLogs})`);

  console.log('\n=== SUMMARY ===');
  console.log(`  ${'场景'.padEnd(22)} c=${'100'.padStart(3)} 基线84.6/s -> 现 ${'吞吐'.padStart(8)} p95`);
  for (const x of r) console.log(`  ${x.name.padEnd(22)} c=${String(x.c).padStart(3)}  ${(x.throughput).toFixed(1)}/s  err=${(x.errorRate*100).toFixed(1)}%  p95=${x.p95}ms`);
})();
