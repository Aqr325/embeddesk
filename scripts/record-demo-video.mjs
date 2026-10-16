#!/usr/bin/env node
/**
 * EmbedDesk 演示视频真机录制（AI Builder Cup 2026 提交用）
 *
 * 录制对象是**真实运行的服务**（后端 :8899 + 前端 :5199 + 演示 LLM 端点 :4799），
 * 走通全链路：客户提问 → Agent 工具调用（search_knowledge 检索真实知识库）→ 流式回答 →
 * 采购意向 → [[HANDOFF]] 转人工 → 真实建单（优先级/SLA/坐席）→ 后台工单/调用监控可见。
 *
 * 技术：Puppeteer + CDP Page.startScreencast 逐帧捕获 JPEG → 供 ffmpeg 编码 MP4。
 * 画面内字幕 / 片头片尾卡 / 底部进度条均为页面 DOM 覆盖层（随录制同轴，无需后期对时）。
 *
 * 前置（已由调用方启动）：
 *   - 后端  CSA_DB_PATH=data/demo_video.db PORT=8899 ... npx tsx server/index.ts
 *   - 前端  API_TARGET_PORT=8899 npx vite --port 5199
 *   - 演示端点  MOCK_PORT=4799 node scripts/mock-demo-llm.mjs
 *
 * 运行：
 *   NODE_PATH=<managed workspace>/node_modules node scripts/record-demo-video.mjs
 * 产物：
 *   .video-demo/frames/f_000000.jpg ...   （编码后由 encode 步骤消费，可删）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// NODE_PATH 仅对 CJS require 生效；ESM 顶层 import 不读 NODE_PATH，故经 createRequire 桥接
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = process.env.FRONT || 'http://127.0.0.1:5199';
const API = process.env.API || 'http://127.0.0.1:8899';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'VideoDemo2026';
const OUT_DIR = path.join(ROOT, '.video-demo');
const FRAMES = path.join(OUT_DIR, 'frames');
const W = 1920;
const H = 1080;
const FPS = 15;

/** 视频总时长（秒）——驱动底部进度条动画，同时保证 screencast 持续产帧 */
const TOTAL_SECONDS = 96;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 帧捕获（同时记录每帧 metadata.timestamp，供编码器按真实节奏合成 VFR）  */
/* ------------------------------------------------------------------ */
let frameNo = 0;
let capturing = false;
const frameTs = [];

function resetFrames() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* 覆盖层：字幕条 / 片头片尾卡 / 底部进度条                             */
/* ------------------------------------------------------------------ */
const OVERLAY_CSS = `
#__demo_sub{position:fixed;left:50%;transform:translateX(-50%);bottom:64px;z-index:2147483647;
  max-width:70%;padding:12px 26px;background:rgba(8,11,22,.86);color:#fff;border-radius:14px;
  font:500 24px/1.55 "Microsoft YaHei","PingFang SC",sans-serif;text-align:center;
  pointer-events:none;opacity:0;transition:opacity .45s ease;box-shadow:0 10px 40px rgba(0,0,0,.4);
  border:1px solid rgba(255,255,255,.08)}
#__demo_sub.on{opacity:1}
#__demo_card{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;
  flex-direction:column;background:linear-gradient(135deg,#0a0f1e 0%,#111a33 55%,#0d2b45 100%);color:#fff;
  font-family:"Microsoft YaHei","PingFang SC",sans-serif;text-align:center;pointer-events:none}
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
    // 进度条：rAF 持续更新 → 保证 screencast 在整个录制期持续产帧（静态画面不停录）
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

async function hideSubtitle(page) {
  await page.evaluate(() => document.getElementById('__demo_sub')?.classList.remove('on'));
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

/* ------------------------------------------------------------------ */
/* 交互助手                                                            */
/* ------------------------------------------------------------------ */
async function smoothMouse(page, x1, y1, x2, y2, steps = 26) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e);
    await sleep(10);
  }
}

async function typeChinese(page, selector, text) {
  await page.click(selector);
  await sleep(300);
  await page.keyboard.type(text, { delay: 70 });
  await sleep(400);
  // 校验：中文经 Input.insertText 写入 React 受控组件；失败则回退原生赋值
  const ok = await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    return !!el && String(el.value || '').length >= Math.min(4, val.length);
  }, selector, text);
  if (!ok) {
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, selector, text);
    await sleep(300);
  }
}

/** 等待本轮回答完成：流式中「发送」按钮被「停止生成」替换，结束后复原 */
async function waitAnswerDone(page, timeout = 90000) {
  await page.waitForSelector('button[title="停止生成"]', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => b.title === '发送'),
    { timeout, polling: 250 },
  );
  await sleep(1800); // 等末尾渲染（引用 / 建单卡片）落定
}

/** 点击后台侧栏 Tab（aside nav 内按钮，按文本匹配） */
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
  await sleep(1600);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
async function main() {
  resetFrames();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* ---- 预置：登录拿 token + 保存模型配置（指向演示端点） ---- */
  const loginRes = await fetch(`${API}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PW }),
  });
  if (!loginRes.ok) throw new Error(`登录失败：HTTP ${loginRes.status}`);
  const { token } = await loginRes.json();

  const cfgRes = await fetch(`${API}/api/admin/llm-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      provider: 'openai',
      endpoint: 'http://127.0.0.1:4799/v1',
      apiKey: 'mock-key',
      model: 'demo-gpt-pro',
      toolCalling: true,
      maxReplyLength: 600,
    }),
  });
  if (!cfgRes.ok) throw new Error(`模型配置保存失败：HTTP ${cfgRes.status}`);
  console.log('[record] 模型配置已指向演示端点 http://127.0.0.1:4799/v1');

  /* ---- 启动浏览器 ---- */
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

  /* ---- 登录态：页面脚本执行前注入 token（BrowserRouter /admin 直接进） ---- */
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('csa_admin_token', t); } catch { /* ignore */ }
  }, token);

  /* ---- 启动 screencast ---- */
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
  console.log('[record] screencast 已启动');

  const t0 = Date.now();
  const mark = (name) => console.log(`[record] ${name}  t=${((Date.now() - t0) / 1000).toFixed(1)}s  frames=${frameNo}`);

  try {
    /* ========== S0 片头 ========== */
    await page.goto(`${FRONT}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await showCard(page, {
      title: 'EmbedDesk · 云嵌',
      sub: '一行代码嵌入官网的 AI 客服 Agent',
      foot: 'AI Builder Cup 2026 · Future of Work &amp; Enterprise Productivity',
    });
    await sleep(5000);
    await hideCard(page);
    mark('S0 片头');

    /* ========== S1 管理后台 · 模型配置（多协议接入） ========== */
    await page.goto(`${FRONT}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await sleep(1200);
    await subtitle(page, '管理后台 · 多协议大模型接入：OpenAI 兼容 / Gemini / Anthropic / DeepSeek / 智谱…');
    await clickAdminTab(page, '模型配置');
    await sleep(2600); // 展示端点与模型配置
    // 点击「测试连接」（用当前表单值，真实请求演示端点）
    const testClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '测试连接');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (testClicked) {
      await page.waitForFunction(
        () => document.body.innerText.includes('连接成功') || document.body.innerText.includes('连接失败'),
        { timeout: 20000, polling: 300 },
      ).catch(() => {});
      await sleep(1600); // 展示「连接成功 · 模型 demo-gpt-pro · 耗时 xx ms」
    }
    mark('S1 模型配置');

    /* ========== S2 客户咨询 · 技术问答（真实工具调用） ========== */
    await page.goto(`${FRONT}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await sleep(1000);
    await subtitle(page, '客户咨询：Agent 检索真实产品知识库后作答（16 款产品资料）');
    await smoothMouse(page, 960, 540, 900, 860, 18);
    await typeChinese(page, 'textarea', '如何降低模组待机功耗？');
    await page.keyboard.press('Enter');
    await sleep(600);
    await subtitle(page, 'Agent 调用 search_knowledge 工具 → 命中知识库 → 流式生成回答');
    await waitAnswerDone(page);
    await sleep(2200);
    mark('S2 技术问答');

    /* ========== S3 采购意向 · 转人工自动建单 ========== */
    await subtitle(page, '访客流露采购意向：500 套模组 · 招标流程');
    await smoothMouse(page, 900, 860, 900, 860, 10);
    await typeChinese(page, 'textarea', '我们计划采购 500 套模组用于项目，能走招标流程吗？');
    await page.keyboard.press('Enter');
    await sleep(600);
    await subtitle(page, '识别到高价值商机 → 自动转人工 → 创建工单（优先级 / SLA / 坐席分配）');
    await waitAnswerDone(page);
    await sleep(2600);
    mark('S3 采购意向建单');

    /* ========== S4 后台 · 工单跟进 ========== */
    await page.goto(`${FRONT}/admin`, { waitUntil: 'networkidle2', timeout: 30000 });
    await injectOverlays(page);
    await sleep(1000);
    await subtitle(page, '销售跟进：采购意向已转化为工单，含情感标签与 SLA 时限');
    await clickAdminTab(page, '工单');
    await sleep(3400);
    mark('S4 工单列表');

    /* ========== S5 调用监控 ========== */
    await clickAdminTab(page, '模型配置');
    await sleep(1200);
    await subtitle(page, '每次模型调用全程可观测：引擎 / 延迟 / Token / 状态');
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.includes('调用监控'));
      els[0]?.scrollIntoView({ block: 'center' });
    });
    await sleep(3200);
    mark('S5 调用监控');

    /* ========== S6 渠道接入（一行代码嵌入） ========== */
    await clickAdminTab(page, '渠道接入');
    await sleep(800);
    await subtitle(page, '一行代码嵌入任意网站：Shadow DOM 隔离，不影响宿主页面');
    await sleep(3400);
    mark('S6 渠道接入');

    /* ========== S7 片尾 ========== */
    await showCard(page, {
      title: 'EmbedDesk · 云嵌',
      sub: '把客服会话变成销售线索',
      foot:
        '技术栈：Vertex AI (Gemini) · Vertex AI Search · Firestore · BigQuery · Cloud Run<br>' +
        '代码仓库：github.com/Aqr325/embeddesk<br>' +
        '<b>演示说明</b>：视频中模型端点可替换为 Gemini / Vertex AI / 任意 OpenAI 兼容服务',
    });
    await sleep(5200);
    mark('S7 片尾');

    /* ---- 收尾：等进度条走满，停录 ---- */
    const elapsed = Date.now() - t0;
    const remain = TOTAL_SECONDS * 1000 - elapsed;
    if (remain > 0) await sleep(remain);
  } finally {
    capturing = false;
    await sleep(600); // 等最后一帧 ack 落盘
    await client.send('Page.stopScreencast').catch(() => {});
    await browser.close();
  }

  console.log(`[record] 完成：${frameNo} 帧 → ${FRAMES}`);
  if (frameTs.length >= 2) {
    fs.writeFileSync(path.join(OUT_DIR, 'frame-ts.json'), JSON.stringify(frameTs));
    const span = frameTs[frameTs.length - 1].ts - frameTs[0].ts;
    console.log(`[record] 时间跨度 ${span.toFixed(1)}s，均帧率 ${(frameTs.length / Math.max(span, 0.001)).toFixed(1)}fps`);
  }
  console.log('[record] 下一步：node scripts/encode-demo-video.mjs');
}

main().catch((e) => {
  console.error('[record] 失败：', e);
  process.exit(1);
});
