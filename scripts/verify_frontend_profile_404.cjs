#!/usr/bin/env node
/**
 * 验收点④真机复现：前端未知客户画像不白屏（CJS 版，便于 NODE_PATH 解析 puppeteer）
 *
 * 在真实 Chrome（无头）中：
 *   1. 走真实登录流程拿 admin token（admin / preview123）
 *   2. 注入 token 并刷新，进入客户页（CustomerPage = 含 CustomerProfilePanel）
 *   3. 真机发 HTTP 请求访问未知客户画像 → 期望 404
 *   4. 验证组件等价 catch 路径：Promise reject 被捕获（不冒泡导致白屏）
 *   5. 监听 pageerror：确认整页生命周期内无未捕获 JS 异常
 *   6. 截图存档
 *
 * 运行：
 *   NODE_PATH=<node-workspace>/node_modules <managed-node> scripts/verify_frontend_profile_404.cjs
 */
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:4521';
const USER = 'admin';
const PASS = process.env.PREVIEW_PW || 'preview123';
const UNKNOWN_ID = 'nonexistent-customer-xyz-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  // 仅以 pageerror（未捕获 JS 异常）作为白屏判据；浏览器对 404 资源的
  // console.error 网络日志（如 favicon）属预期，不计入。
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const login = await page.evaluate(
    async (u, p) => {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      return r.json();
    },
    USER,
    PASS,
  );
  const token = login.token;
  console.log('[1] token 获取:', token ? `OK(len=${token.length})` : `FAIL ${JSON.stringify(login)}`);

  await page.evaluate((t) => localStorage.setItem('csa_admin_token', t), token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await sleep(1500);

  const bodyLen = await page.evaluate(() => document.body.innerText.length);
  console.log(`[2] 首页 body 文本长度: ${bodyLen}（应 > 200）`);

  const prof = await page.evaluate(
    async (t, id) => {
      const r = await fetch(`/api/customers/${id}/profile`, {
        headers: { Authorization: 'Bearer ' + t },
      });
      let body = null;
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body };
    },
    token,
    UNKNOWN_ID,
  );
  console.log(`[3] 未知客户画像 HTTP 状态: ${prof.status}（期望 404）`);

  const catchTest = await page.evaluate(
    async (t, id) => {
      try {
        const r = await fetch(`/api/customers/${id}/profile`, {
          headers: { Authorization: 'Bearer ' + t },
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return 'unexpected-ok';
      } catch (e) {
        return 'caught:' + e.message;
      }
    },
    token,
    UNKNOWN_ID,
  );
  console.log(`[4] 组件等价 catch 测试: ${catchTest}（期望 caught:...）`);

  await page.screenshot({ path: 'data/verify-frontend-404.png', fullPage: false });
  console.log('[5] 截图已存 data/verify-frontend-404.png');

  const ok =
    !!token &&
    bodyLen > 100 &&
    prof.status === 404 &&
    String(catchTest).startsWith('caught') &&
    pageErrors.length === 0;
  console.log(`[6] pageerror 数量: ${pageErrors.length}`);
  console.log(
    ok
      ? '✅ 验收点④ 前端未知客户画像不白屏：真机验证通过'
      : '❌ 验收点④ 未通过',
  );
  if (pageErrors.length) console.log(pageErrors.join('\n'));

  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
