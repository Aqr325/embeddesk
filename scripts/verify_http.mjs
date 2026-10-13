/**
 * HTTP 全端点冒烟（D6 全面质量审查 · 补齐验收覆盖）
 *
 * 起真实 Express 服务（better-sqlite3，全新 db）+ 全新 DB，对全部 API 端点逐一打真实 HTTP：
 *   - 公开端点：直接断言 200/400 语义
 *   - 鉴权端点：先 /api/admin/login 拿 token → 带 Bearer 断言 200；无 token 断言 401
 *   - 写入端点：用带运行后缀的独立资源 id，保证幂等可重放
 *
 * 运行（沙箱/CI 无头）：
 *   CSA_DB_PATH=data/verify_http.db PORT=4710 ADMIN_PASSWORD=smoke123 SEED_DEMO=1 \
 *   INGEST_SECRET=smoke-secret ALLOWED_ORIGINS=http://localhost:5173 \
 *   node scripts/verify_http.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 4710);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36); // 运行唯一后缀（幂等）

const cases = [
  // [method, path, needAuth, validBody, note]
  ['GET', '/api/health', false, null, '健康检查'],
  ['GET', '/api/meta', false, null, '站点元信息'],
  ['GET', '/api/models', false, null, '模型列表'],
  ['GET', '/api/faqs', false, null, 'FAQ 列表'],
  ['POST', '/api/faqs/search', false, { query: '干扰距离' }, 'FAQ 检索'],
  ['POST', '/api/faqs/recommend', false, { query: 'DT900' }, 'FAQ 推荐'],
  ['POST', '/api/satisfaction', false, { sessionId: 'nope', message_id: null, rating: 5, tags: '', comment: '' }, '匿名满意度（未知会话→400/404 语义）'],
  ['POST', '/api/chat', false, { message: 'DT900 是什么', sessionId: `smoke-${RUN}` }, 'SSE 对话（mock 降级知识库）'],
  ['POST', '/api/embed/chat', 'secret', { siteId: 'site-smoke', token: 'tok-x', message: '有效距离', sessionId: `embed-${RUN}` }, '嵌入对话（未注册站点→403 语义）'],
  // 管理鉴权（token）
  ['GET', '/api/admin/metrics', true, null, '管理指标'],
  ['GET', '/api/admin/insights', true, null, '洞察聚合'],
  ['GET', '/api/admin/metrics/prometheus', true, null, 'Prometheus 文本'],
  ['GET', '/api/admin/llm-config', true, null, 'LLM 配置读'],
  ['POST', '/api/employees', true, { username: `agent${RUN}`, display_name: `测试坐席${RUN}`, role: 'agent', password: 'test123' }, '新建员工'],
  ['GET', '/api/employees', true, null, '员工列表'],
  ['GET', '/api/sessions', true, null, '会话列表'],
  ['GET', '/api/customers/unknown-cust-404/profile', true, null, '客户画像（未知→404 语义）'],
  ['POST', '/api/copilot/suggest', true, { message: '客户问干扰距离', sessionId: `smoke-${RUN}` }, 'Copilot 建议'],
  ['POST', '/api/admin/import/faqs', true, { format: 'json', data: [{ question: `测试Q${RUN}`, answer: `测试A${RUN}`, keywords: '测试' }] }, 'FAQ 批量导入'],
  // 外部渠道接入（secret 鉴权）
  ['POST', '/api/ingest/email', 'secret', { secret: 'smoke-secret', externalId: `smk-${RUN}`, from: 'a@b.c', message: '设备故障' }, '邮件接入'],
  ['POST', '/api/ingest/im', 'secret', { secret: 'smoke-secret', externalId: `im-${RUN}`, from: 'im-user', message: '询价' }, 'IM 接入'],
];

let pass = 0;
let fail = 0;
const failures = [];

function logCase(ok, label, detail) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label} ${detail}`);
  } else {
    fail++;
    failures.push(`${label} ${detail}`);
    console.log(`  ❌ ${label} ${detail}`);
  }
}

async function main() {
  const srv = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      CSA_DB_PATH: process.env.CSA_DB_PATH || 'data/verify_http.db',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'smoke123',
      INGEST_SECRET: process.env.INGEST_SECRET || 'smoke-secret',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
      SEED_DEMO: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));

  // 等待服务就绪
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { up = true; break; }
    } catch { /* 未起 */ }
  }
  if (!up) {
    console.log('❌ 服务未就绪：\n' + srvOut.slice(-1500));
    srv.kill();
    process.exit(1);
  }

  // 登录拿 token
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'smoke123' }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const token = loginBody.token;
  if (!token) {
    console.log('❌ 登录失败：', JSON.stringify(loginBody).slice(0, 200));
    srv.kill();
    process.exit(1);
  }
  console.log(`\n=== HTTP 全端点冒烟（服务 ${BASE}，运行后缀 ${RUN}） ===\n`);

  for (const [method, path, auth, body, note] of cases) {
    const headers = { 'Content-Type': 'application/json' };
    let expected = 200;
    if (method === 'POST' && path === '/api/employees') expected = 201; // 资源创建成功 → 201 Created；GET 列表仍 200
    if (auth === true) headers.Authorization = `Bearer ${token}`;
    // 语义：未知会话的 satisfaction → 400/404；未知客户画像 → 404；未注册站点 embed → 403
    if (path === '/api/satisfaction') expected = [400, 404, 422];
    if (path.startsWith('/api/customers/')) expected = [404];
    if (auth === 'secret' && path.startsWith('/api/embed/')) expected = [403];

    const r = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
    logCase(ok, `[${method}] ${path}（${note}）`, `→ ${r.status}`);

    // 鉴权端点额外验证 401 语义（去 token 再打一次；method 必须保持原端点方法，否则 POST 路由收到 GET → 404）
    if (auth === true) {
      const r2 = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      logCase(r2.status === 401, `[${method}] ${path} 无 token`, `→ ${r2.status}（应 401）`);
    }
    // secret 端点额外验证 403 语义
    if (auth === 'secret') {
      const r3 = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, secret: 'wrong' }),
      });
      logCase(r3.status === 403, `[${method}] ${path} 错误密钥`, `→ ${r3.status}（应 403）`);
    }
  }

  srv.kill();
  console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 断言） ===`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
  console.log('✅ HTTP 全端点冒烟全部通过');
  process.exit(0);
}

main();
