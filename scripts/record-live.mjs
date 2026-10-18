#!/usr/bin/env node
/**
 * EmbedDesk 实时功能录屏（AI Builder Cup 2026 · working functionality 证据）
 *
 * 录制对象是**真实运行的服务**：
 *   - 前端管理后台  http://localhost:5891  (vite, API_TARGET_PORT=8912)
 *   - 后端 API       http://localhost:8912  (tsx, SEED_DEMO=1, 知识库直答模式)
 *   - 演示页         http://localhost:8912/vidcap_demo.html（挂载真实 embed widget）
 *
 * 走通真实交互：打开 widget → 打字提问 → 知识库实时回答 → 后台看对话/工单/知识库。
 * 技术：Puppeteer + CDP Page.startScreencast 逐帧 JPEG 捕获 → VFR 清单供编码器消费。
 *
 * 运行：
 *   NODE_PATH=C:/Users/HONOR/.workbuddy/binaries/node/workspace/node_modules \
 *     node scripts/record-live.mjs
 * 产物：
 *   .video-live/frames/f_000000.jpg + frame-ts.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = process.env.FRONT || 'http://localhost:5891';
const API = process.env.API || 'http://localhost:8912';
const DEMO = process.env.DEMO || 'http://localhost:8912/vidcap_demo.html';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'admin';
const OUT_DIR = path.join(ROOT, '.video-live');
const FRAMES = path.join(OUT_DIR, 'frames');
const W = 1920;
const H = 1080;
const TOTAL_SECONDS = 96;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let frameNo = 0;
let capturing = false;
const frameTs = [];

function resetFrames() {
  // 注意：不在此处 rmSync 删除旧帧（WorkBuddy safe-delete 会拦截批量删除）；
  // 旧 frames 目录由调用方事先改名移走，这里只负责建空目录。
  fs.mkdirSync(FRAMES, { recursive: true });
}

const OVERLAY_CSS = `
#__demo_sub{position:fixed;left:50%;transform:translateX(-50%);bottom:64px;z-index:2147483647;
  max-width:70%;padding:12px 26px;background:rgba(8,11,22,.86);color:#fff;border-radius:14px;
  font:500 24px/1.55 "Segoe UI",Arial,sans-serif;text-align:center;
  pointer-events:none;opacity:0;transition:opacity .45s ease;box-shadow:0 10px 40px rgba(0,0,0,.4);
  border:1px solid rgba(255,255,255,.08)}
#__demo_sub.on{opacity:1}
#__demo_card{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;
  flex-direction:column;background:linear-gradient(135deg,#0a0f1e 0%,#111a33 55%,#0d2b45 100%);color:#fff;
  font-family:"Segoe UI",Arial,sans-serif;text-align:center;pointer-events:none}
#__demo_card.on{display:flex}
#__demo_card .t{font-size:76px;font-weight:700;letter-spacing:.06em}
#__demo_card .s{font-size:34px;margin-top:22px;color:#c9d6f2;font-weight:500}
#__demo_card .g{font-size:22px;margin-top:44px;color:#8fa3c8;line-height:1.9}
#__demo_card .g b{color:#7dd3fc;font-weight:600}
#__demo_prog{position:fixed;left:0;bottom:0;height:4px;width:0;z-index:2147483647;
  background:linear-gradient(90deg,#38bdf8,#818cf8);pointer-events:none}
`;

async function injectOverlays(page) {
  await page.evaluate((css) => {
    if (document.getElementById('__demo_sub')) return;
    const style = document.createElement('style');
    style.id = '__demo_style';
    style.textContent = css;
    document.head.appendChild(style);
    const sub = document.createElement('div');
    sub.id = '__demo_sub';
    document.body.appendChild(sub);
    const card = document.createElement('div');
    card.id = '__demo_card';
    document.body.appendChild(card);
    const prog = document.createElement('div');
    prog.id = '__demo_prog';
    document.body.appendChild(prog);
    const t0 = Date.now();
    const total = Number(document.body.dataset.totalSeconds || 90) * 1000;
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / total);
      prog.style.width = (p * 100).toFixed(2) + '%';
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, OVERLAY_CSS);
  await page.evaluate((t) => { document.body.dataset.totalSeconds = String(t); }, TOTAL_SECONDS);
}

async function subtitle(page, text) {
  await page.evaluate((t) => {
    const el = document.getElementById('__demo_sub');
    if (!el) return;
    el.textContent = t;
    el.classList.add('on');
  }, text);
}

async function showCard(page, { title, sub, foot }) {
  await page.evaluate(({ title, sub, foot }) => {
    const el = document.getElementById('__demo_card');
    if (!el) return;
    el.innerHTML =
      `<div class="t">${title}</div>` +
      (sub ? `<div class="s">${sub}</div>` : '') +
      (foot ? `<div class="g">${foot}</div>` : '');
    el.classList.add('on');
  }, { title, sub, foot });
}

async function hideCard(page) {
  await page.evaluate(() => document.getElementById('__demo_card')?.classList.remove('on'));
}

async function smoothMouse(page, x1, y1, x2, y2, steps = 26) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e);
    await sleep(10);
  }
}

/** widget shadow-root 内的输入框（宿主页面 <div> → open shadowRoot） */
async function widgetAsk(page, question, answerTimeout = 45000) {
  // 打开面板（embed.js 暴露的 API；shadowRoot 为 open 模式）
  const opened = await page.evaluate(() => {
    const host = document.querySelector('div[style*="position"]') || document.body.firstElementChild;
    // 优先用官方 API
    if (window.CsaEmbed && typeof window.CsaEmbed.open === 'function') {
      window.CsaEmbed.open();
      return true;
    }
    // 兜底：找 shadowRoot 里的 fab 按钮
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const fab = el.shadowRoot.querySelector('.csa-fab');
        if (fab) { fab.click(); return true; }
      }
    }
    return false;
  });
  if (!opened) throw new Error('无法打开 widget 面板');
  await sleep(1200);

  const before = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const body = el.shadowRoot.querySelector('.csa-body');
        if (body) return body.children.length;
      }
    }
    return 0;
  });

  await page.evaluate((text) => {
    for (const el of document.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      const ta = el.shadowRoot.querySelector('textarea');
      if (!ta) continue;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, question);
  await sleep(400);

  // 逐字输入视觉效果：直接设值太快，补一个轻量打字动画由字幕承担；这里点击发送
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      const btn = el.shadowRoot.querySelector('.csa-send');
      if (btn) btn.click();
    }
  });

  // 等回答：body 子元素增长（用户气泡 + typing + 回答气泡）
  const t0 = Date.now();
  while (Date.now() - t0 < answerTimeout) {
    const now = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const body = el.shadowRoot.querySelector('.csa-body');
          if (body) return body.children.length;
        }
      }
      return 0;
    });
    const hasTyping = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot && el.shadowRoot.querySelector('.csa-typing, .csa-msg-typing')) return true;
      }
      return false;
    });
    if (now > before + 1 && !hasTyping && Date.now() - t0 > 2500) break;
    await sleep(500);
  }
  await sleep(2200); // 等回答渲染落定
}

async function clickAdminTab(page, label) {
  const clicked = await page.evaluate((lb) => {
    const nav = document.querySelector('aside nav');
    if (!nav) return false;
    const btn = [...nav.querySelectorAll('button')].find((b) => b.textContent.includes(lb));
    if (!btn) return false;
    btn.scrollIntoView({ block: 'nearest' });
    btn.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`未找到后台 Tab：${label}`);
  await sleep(1800);
}

async function main() {
  resetFrames();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const loginRes = await fetch(`${API}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PW }),
  });
  if (!loginRes.ok) throw new Error(`登录失败：HTTP ${loginRes.status}`);
  const { token } = await loginRes.json();
  console.log('[record] admin token ok');

  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const executablePath = candidates.find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: W, height: H },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'],
  });
  const page = await browser.newPage();

  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('csa_admin_token', t); } catch { /* ignore */ }
  }, token);

  const client = await page.target().createCDPSession();
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
  capturing = true;
  client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    if (!capturing) return;
    try {
      await client.send('Page.screencastFrameAck', { sessionId });
      const name = `f_${String(frameNo).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(FRAMES, name), Buffer.from(data, 'base64'));
      frameTs.push({ name, ts: Number(metadata?.timestamp ?? 0) });
      frameNo++;
    } catch { /* 忽略单帧写入失败 */ }
  });
  console.log('[record] screencast started');

  const t0 = Date.now();
  const mark = (name) => console.log(`[record] ${name}  t=${((Date.now() - t0) / 1000).toFixed(1)}s  frames=${frameNo}`);

  try {
    /* S0 片头 */
    await page.goto(DEMO, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await showCard(page, {
      title: 'EmbedDesk',
      sub: 'Live functionality walkthrough',
      foot: 'AI Builder Cup 2026 · real service, real knowledge base, real tickets',
    });
    await sleep(3500);
    await hideCard(page);
    mark('S0 intro');

    /* S1 widget 真实问答 #1 */
    await subtitle(page, 'One line of code embeds the widget. Visitor asks about NPU modules...');
    await smoothMouse(page, 960, 540, 1860, 980, 18);
    await sleep(600);
    await widgetAsk(page, '哪款模组带 NPU，算力多少？');
    await subtitle(page, 'Agent retrieves the real product knowledge base and answers in seconds');
    await sleep(4000);
    mark('S1 widget Q1');

    /* S2 widget 真实问答 #2 */
    await subtitle(page, 'Second question: low-power design...');
    await widgetAsk(page, '如何降低模组待机功耗？');
    await subtitle(page, 'Grounded answer from the knowledge base, no hallucination');
    await sleep(4000);
    mark('S2 widget Q2');

    /* S3 admin 仪表盘 */
    await page.goto(`${FRONT}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await sleep(1500);
    await subtitle(page, 'Admin console: live KPIs, intent distribution and 7-day trend');
    await sleep(5500);
    mark('S3 dashboard');

    /* S4 对话记录 */
    await clickAdminTab(page, '对话记录');
    await subtitle(page, 'Conversation history: every channel session with AI confidence badges');
    await sleep(4500);
    mark('S4 conversations');

    /* S5 工单 */
    await clickAdminTab(page, '工单');
    await subtitle(page, 'Tickets: auto-created with priority, SLA deadline and sentiment tags');
    await sleep(4500);
    mark('S5 tickets');

    /* S6 知识库 */
    await clickAdminTab(page, '知识库');
    await subtitle(page, 'Knowledge base: the RAG source the agent answers from');
    await sleep(4500);
    mark('S6 knowledge base');

    /* S7 知识盲区 */
    await clickAdminTab(page, '知识盲区');
    await subtitle(page, 'Knowledge gaps surface automatically, so coverage keeps improving');
    await sleep(4500);
    mark('S7 knowledge gaps');

    /* S8 AI 成效 */
    await clickAdminTab(page, 'AI 成效');
    await subtitle(page, 'AI effectiveness: knowledge hit-rate, escalation and CSAT over time');
    await sleep(4500);
    mark('S8 AI effectiveness');

    /* S9 模型配置 */
    await clickAdminTab(page, '模型配置');
    await subtitle(page, 'Model layer: provider agnostic, connection test and call monitoring');
    await sleep(4500);
    mark('S9 model config');

    /* S10 片尾 */
    await showCard(page, {
      title: 'EmbedDesk',
      sub: 'One line of code. Expert-grade support on any site.',
      foot:
        'Stack: Gemini · Firestore (Firebase) · Cloud Run · Vertex AI Search · BigQuery<br>' +
        'Repo: github.com/Aqr325/embeddesk (branch hack2skill)',
    });
    await sleep(3500);
    mark('S10 outro');

    const elapsed = Date.now() - t0;
    const remain = TOTAL_SECONDS * 1000 - elapsed;
    if (remain > 0) await sleep(remain);
  } finally {
    capturing = false;
    await sleep(600);
    await client.send('Page.stopScreencast').catch(() => {});
    await browser.close();
  }

  console.log(`[record] done: ${frameNo} frames -> ${FRAMES}`);
  if (frameTs.length >= 2) {
    fs.writeFileSync(path.join(OUT_DIR, 'frame-ts.json'), JSON.stringify(frameTs));
    const span = frameTs[frameTs.length - 1].ts - frameTs[0].ts;
    console.log(`[record] span ${span.toFixed(1)}s, avg ${(frameTs.length / Math.max(span, 0.001)).toFixed(1)}fps`);
  }
}

main().catch((e) => {
  console.error('[record] FAILED:', e);
  process.exit(1);
});
