#!/usr/bin/env node
/**
 * ingest-products.mjs —— 产品资料 → Vertex AI Search 灌库（Hack2skill D2/D3，方案 §3 文档入库）
 *
 * 三条资料路径（方案 §7 降级分支）：
 *   ① --pdf-dir <dir>   Document AI（OCR/Form Parser REST）解析 PDF/图片 → 启发式结构化 → 灌库
 *   ② --input <json>    人工结构化 JSON 直灌（catalog.json， branches 3）
 *   ③ --dry-run         只本地解析，不灌库（验证结构化质量）
 *
 * Discovery Engine 契约（structured data store）：
 *   POST .../dataStores/{ds}/branches/0/documents:import
 *   body: { inlineSource: { documents: [{ id, structData, content }] }, reconciliationMode: "INCREMENTAL" }
 *   返回 LRO（{ name, done }），--wait 时轮询至完成。
 *
 * 用法：
 *   node scripts/ingest-products.mjs --input data/products/catalog.json --dry-run
 *   node scripts/ingest-products.mjs --input data/products/catalog.json \
 *        GCP_PROJECT=... VERTEX_SEARCH_DATA_STORE_ID=... （真实灌库）
 *   VERTEX_SEARCH_BASE_URL=http://127.0.0.1:4599 node scripts/ingest-products.mjs \
 *        --input scripts/fixtures/sample-catalog.json   （mock 灌库）
 *   node scripts/ingest-products.mjs --pdf-dir data/products/raw --docai-processor <id> ...
 *
 * 凭证：GOOGLE_APPLICATION_CREDENTIALS（SA JSON）或 GEMINI_API_KEY（API key 模式，
 *       与 server/googleAuth.ts 同规则；mock 模式用 VERTEX_SEARCH_BASE_URL 指向本地）。
 * 零依赖：原生 fetch + node:fs/path。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/* ============================ 参数 ============================ */

const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name) => argv.includes(name);

const INPUT = argOf('--input');
const PDF_DIR = argOf('--pdf-dir');
const DRY_RUN = has('--dry-run');
const WAIT = has('--wait');
const REPORT = argOf('--report') || 'data/products/ingest-report.json';

if (!INPUT && !PDF_DIR) {
  console.error('用法：--input <catalog.json> | --pdf-dir <dir> [--dry-run] [--wait] [--report <path>]');
  process.exit(2);
}

/* ============================ 配置 ============================ */

const GCP_PROJECT = process.env.GCP_PROJECT || 'local';
const DATA_STORE_ID = process.env.VERTEX_SEARCH_DATA_STORE_ID || 'csa-products';
const LOCATION = process.env.VERTEX_SEARCH_LOCATION || 'global';
const BASE_OVERRIDE = process.env.VERTEX_SEARCH_BASE_URL; // mock 模式
const DOCAI_PROCESSOR = process.env.DOCAI_PROCESSOR_ID || argOf('--docai-processor');
const DOCAI_LOCATION = process.env.DOCAI_LOCATION || 'asia-east1';

function importUrl() {
  if (BASE_OVERRIDE) {
    return `${BASE_OVERRIDE.replace(/\/+$/, '')}/projects/${GCP_PROJECT}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents:import`;
  }
  return `https://discoveryengine.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${LOCATION}/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents:import`;
}

function processUrl() {
  if (BASE_OVERRIDE) {
    return `${BASE_OVERRIDE.replace(/\/+$/, '')}/v1/projects/${GCP_PROJECT}/locations/${DOCAI_LOCATION}/processors/${DOCAI_PROCESSOR}:process`;
  }
  return `https://${DOCAI_LOCATION}-documentai.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${DOCAI_LOCATION}/processors/${DOCAI_PROCESSOR}:process`;
}

/* ============================ 鉴权（与 server/googleAuth.ts 同规则） ============================ */

let saCache;
let tokenCache;
function loadSa() {
  if (saCache !== undefined) return saCache;
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!p || !existsSync(p)) {
    saCache = null;
    return null;
  }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    saCache = j.client_email && j.private_key ? j : null;
  } catch {
    saCache = null;
  }
  return saCache;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchSaToken(sa) {
  const { createSign } = await import('node:crypto');
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`SA token exchange failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('SA token exchange: no access_token');
  return j.access_token;
}

async function authHeaders() {
  if (BASE_OVERRIDE && process.env.GEMINI_API_KEY) return { 'x-goog-api-key': process.env.GEMINI_API_KEY };
  if (process.env.GEMINI_API_KEY && !loadSa()) return { 'x-goog-api-key': process.env.GEMINI_API_KEY };
  const sa = loadSa();
  if (!sa) {
    if (BASE_OVERRIDE) return {}; // mock 无鉴权
    throw new Error('无凭证：设置 GOOGLE_APPLICATION_CREDENTIALS 或 GEMINI_API_KEY，或使用 VERTEX_SEARCH_BASE_URL 指向 mock');
  }
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 60000) return { Authorization: `Bearer ${tokenCache.token}` };
  const token = await fetchSaToken(sa);
  tokenCache = { token, exp: now + 3300 * 1000 };
  return { Authorization: `Bearer ${token}` };
}

/* ============================ Document AI 解析（分支①②） ============================ */

const MODEL_RE = /(?:DJ|DT|SDJ|BT)[- ]?\d{2,4}[A-Za-z0-9-]*/g;

/**
 * OCR 文本 → 候选 QA（启发式）：
 * 按行扫描，识别产品型号（DJ9341/DT900/...），把型号首次出现起的后续非空行聚合为资料段；
 * 每段产出 2 条 QA（"是什么/参数" 与 "特点"）。真实参数表到位后此段可换人工结构化。
 */
function ocrToQaDocs(text, sourceFile) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const docs = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join(' ').slice(0, 600);
    if (body.length >= 20) {
      docs.push({
        id: `ocr-${cur.model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        category: 'product',
        question: `${cur.model} 的产品信息与关键参数是什么？`,
        answer: body,
        keywords: [cur.model, sourceFile],
      });
      docs.push({
        id: `ocr-${cur.model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-feature`,
        category: 'product',
        question: `${cur.model} 有哪些技术特点？`,
        answer: body,
        keywords: [cur.model, '特点', sourceFile],
      });
    }
    cur = null;
  };
  for (const line of lines) {
    const m = line.match(MODEL_RE);
    if (m && m[0] && !cur) {
      cur = { model: m[0], lines: [line] };
    } else if (cur) {
      // 出现新型号则换段
      if (m && m[0] && m[0] !== cur.model) {
        flush();
        cur = { model: m[0], lines: [line] };
      } else {
        cur.lines.push(line);
      }
    }
  }
  flush();
  return docs;
}

async function docaiProcess(filePath) {
  if (!DOCAI_PROCESSOR) {
    console.warn(`[ingest] 跳过 ${basename(filePath)}：未配置 DOCAI_PROCESSOR_ID（--docai-processor）`);
    return null;
  }
  const mime = extname(filePath).toLowerCase() === '.pdf' ? 'application/pdf' : 'image/jpeg';
  const content = readFileSync(filePath).toString('base64');
  const headers = await authHeaders();
  const r = await fetch(processUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ rawDocument: { content, mimeType: mime } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`DocumentAI process failed: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const text = j?.document?.text || '';
  const entities = (j?.document?.entities || []).map((e) => `${e.type || 'entity'}: ${e.mentionText || ''}`).filter((s) => s.length > 8);
  return text + (entities.length ? `\n${entities.join('\n')}` : '');
}

/* ============================ 灌库 ============================ */

function docFromQa(qa) {
  const content = `${qa.question}\n${qa.answer}`;
  return {
    id: qa.id,
    structData: {
      id: qa.id,
      category: qa.category || 'product',
      question: qa.question,
      answer: qa.answer,
      keywords: Array.isArray(qa.keywords) ? qa.keywords : [],
    },
    content: { mimeType: 'text/plain', data: Buffer.from(content, 'utf8').toString('base64') },
  };
}

async function importDocs(docs) {
  const headers = await authHeaders();
  const r = await fetch(importUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      inlineSource: { documents: docs },
      reconciliationMode: 'INCREMENTAL',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`documents:import failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (WAIT && j?.name) {
    // LRO 轮询（真实 GCP）；mock 同步返回 done
    for (let i = 0; i < 10; i++) {
      const q = await fetch(`https://discoveryengine.googleapis.com/v1/${j.name}`, { headers });
      const oj = await q.json();
      if (oj?.done) return { operation: j.name, done: true, error: oj.error || null };
      await new Promise((s) => setTimeout(s, 1500));
    }
    return { operation: j.name, done: false, error: null };
  }
  return { operation: j?.name || null, done: j?.done !== false, error: j?.error || null };
}

/* ============================ 主流程 ============================ */

async function main() {
  const t0 = Date.now();
  const qaDocs = [];
  const skipped = [];

  if (INPUT) {
    const catalog = JSON.parse(readFileSync(INPUT, 'utf8'));
    const qa = Array.isArray(catalog.qa) ? catalog.qa : [];
    for (const q of qa) {
      if (!q.id || !q.question || !q.answer) {
        skipped.push({ file: basename(INPUT), reason: 'QA 缺 id/question/answer' });
        continue;
      }
      qaDocs.push(q);
    }
    console.log(`[ingest] JSON 直灌：${INPUT} → ${qaDocs.length} 条 QA`);
  }

  if (PDF_DIR) {
    const files = readdirSync(PDF_DIR).filter((f) => ['.pdf', '.jpg', '.jpeg', '.png'].includes(extname(f).toLowerCase()));
    console.log(`[ingest] Document AI 解析：${PDF_DIR} → ${files.length} 个文件`);
    for (const f of files) {
      const p = join(PDF_DIR, f);
      if (!statSync(p).isFile()) continue;
      try {
        const text = await docaiProcess(p);
        if (!text) {
          skipped.push({ file: f, reason: '无 DOCAI_PROCESSOR_ID' });
          continue;
        }
        const docs = ocrToQaDocs(text, basename(f, extname(f)));
        console.log(`[ingest]   ${f}: OCR ${text.length} 字符 → ${docs.length} 条候选 QA`);
        qaDocs.push(...docs);
      } catch (e) {
        skipped.push({ file: f, reason: String(e?.message || e).slice(0, 120) });
      }
    }
  }

  if (!qaDocs.length) {
    console.error('[ingest] 无可灌库文档');
    process.exit(1);
  }

  const payload = qaDocs.map(docFromQa);
  const report = {
    at: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : BASE_OVERRIDE ? 'mock' : 'gcp',
    input: INPUT || PDF_DIR,
    docs: payload.length,
    skipped,
    sample: payload[0],
    elapsedMs: Date.now() - t0,
  };

  if (DRY_RUN) {
    console.log(`[ingest] dry-run：解析 ${payload.length} 条文档（未灌库）`);
    console.log(JSON.stringify(payload.slice(0, 2), null, 2));
  } else {
    const res = await importDocs(payload);
    report.importResult = res;
    console.log(`[ingest] documents:import → ${payload.length} 条，operation=${res.operation || 'n/a'} done=${res.done}`);
    if (res.error) console.error('[ingest] import 返回错误：', JSON.stringify(res.error).slice(0, 300));
  }

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`[ingest] 报告 → ${REPORT}（${report.elapsedMs}ms）`);
  if (skipped.length) console.warn(`[ingest] 跳过 ${skipped.length} 项：`, skipped.map((s) => `${s.file}(${s.reason})`).join('; '));
}

main().catch((e) => {
  console.error('[ingest] 失败：', e?.message || e);
  process.exit(1);
});
