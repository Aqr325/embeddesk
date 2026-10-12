// 性能压测脚本（聚焦优化项）：复用原生 fetch 并发压测，统计吞吐/延迟分位/错误率。
// 用法：先启动服务并取得 token.txt，再 `node bench2.cjs`
const fs = require('fs');
const BASE = 'http://localhost:3000';
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const now = () => performance.now();

async function timeit(fn) {
  const s = now(); let ok = true, err = null;
  try { await fn(); } catch (e) { ok = false; err = e && e.message ? e.message : String(e); }
  return { ok, dur: now() - s, err };
}
async function bench(name, fn, concurrency, total) {
  const lats = []; let ok = 0, fail = 0; const errs = {};
  let i = 0; const wall0 = now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < total) { const idx = i++; const r = await timeit(fn);
      if (r.ok) ok++; else { fail++; errs[r.err] = (errs[r.err] || 0) + 1; } lats.push(r.dur); }
  });
  await Promise.all(workers);
  const wall = now() - wall0; lats.sort((a, b) => a - b);
  const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p / 100))].toFixed(1) : '0';
  const avg = lats.length ? (lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1) : '0';
  console.log(`\n### ${name}  (c=${concurrency}, total=${total})`);
  console.log(`  ok=${ok} fail=${fail} errorRate=${(fail / total * 100).toFixed(2)}%  throughput=${(total / (wall / 1000)).toFixed(1)}/s`);
  console.log(`  latency ms: avg=${avg} p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${lats.length ? lats[lats.length - 1].toFixed(1) : '0'}`);
  if (fail) console.log(`  errors: ${JSON.stringify(errs)}`);
  return { name, concurrency, ok, fail, errorRate: fail / total, throughput: Number((total / (wall / 1000)).toFixed(1)), avg: Number(avg), p95: Number(pct(95)) };
}
function reqStats() { return fetch(BASE + '/api/admin/stats', { headers: { Authorization: 'Bearer ' + TOKEN } }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); }); }
function reqIngest() {
  return fetch(BASE + '/api/ingest/email', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'testsecret', externalId: 'b2-' + Math.random().toString(36).slice(2), from: 'b2' + Math.random().toString(36).slice(2) + '@x.com', message: '我的模组经常掉线，怎么处理', subject: '技术支持' }) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); });
}
(async () => {
  const r = [];
  r.push(await bench('admin/stats (cached)', reqStats, 50, 200));
  r.push(await bench('admin/stats (cached)', reqStats, 150, 400));
  r.push(await bench('ingest/email (faq cache)', reqIngest, 100, 200));
  console.log('\n=== SUMMARY (post-optimization) ===');
  for (const x of r) console.log(`${x.name.padEnd(26)} c=${String(x.concurrency).padStart(3)} ok=${x.ok} fail=${x.fail} err=${(x.errorRate*100).toFixed(1)}% tput=${x.throughput}/s avg=${x.avg}ms p95=${x.p95}ms`);
})();
