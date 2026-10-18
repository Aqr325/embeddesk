/**
 * 冒烟测试：模拟 Cloud Functions 环境验证 bundle 可用性。
 *  - 设 FUNCTION_TARGET 触发函数模式（跳过 app.listen）
 *  - 独立测试库 /tmp/smoke-test.db，不碰本地 data/chat.db
 *  - 起本地 http 把请求转给 api handler（等同函数运行时行为）
 *  - 验证 /api/health + 一次真实知识库问答
 */
process.env.FUNCTION_TARGET = 'api';
process.env.CSA_DB_PATH = '/tmp/smoke-test.db';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { api } = require('../functions-bundle/index.cjs');
const server = http.createServer((req, res) => api(req, res));

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  await new Promise((r) => server.listen(3999, r));
  await new Promise((r) => setTimeout(r, 3000)); // 等 seed 完成

  // 1) 健康检查
  const health = await get('http://127.0.0.1:3999/api/health');
  console.log('[1] /api/health =>', health.status, health.body.slice(0, 120));

  // 2) 挂件页面（Express 托管 dist）
  const root = await get('http://127.0.0.1:3999/');
  console.log('[2] / (SPA) =>', root.status, 'len', root.body.length, 'hasWidget:', root.body.includes('csa'));

  // 3) 后台登录页
  const admin = await get('http://127.0.0.1:3999/admin');
  console.log('[3] /admin =>', admin.status, 'len', admin.body.length);

  // 4) 真实知识库问答（siteId 取自 site.json）
  let siteId = '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site.json'), 'utf8'));
    siteId = s.siteId || s.id || '';
  } catch {}
  if (siteId) {
    const chat = await post('http://127.0.0.1:3999/api/chat', {
      siteId,
      sessionId: 'smoke-' + Date.now(),
      message: '哪款模组带 NPU，算力多少？',
    });
    console.log('[4] /api/chat =>', chat.status, chat.body.slice(0, 300));
  } else {
    console.log('[4] site.json 无 siteId，跳过 chat（health/SPA/admin 已足够验证挂载）');
  }

  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE FAIL:', e);
  process.exit(1);
});
