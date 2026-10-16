#!/usr/bin/env node
/**
 * EmbedDesk 一键验收（hack2skill 参赛版）
 *
 * 一条命令跑完全部验证闭环，输出汇总表：
 *   ① 起本地 mock GCP（mock-vertex.mjs：Gemini / Vertex Search / Firestore / BigQuery / Document AI）
 *   ② 依次运行 9 个验收脚本（tsx）：
 *      - verify_insights     洞察聚合（纯本地 JSONL，12 断言）
 *      - verify_agent_tools  领域工具层（search_knowledge / query_order / create_ticket 防重）
 *      - verify_gemini_agent Gemini 内核 T1–T9（function calling / 降级 / 检索映射 / 路由开关）
 *      - verify_store        Firestore 优先 + SQLite 兜底（PATCH 双写 / 不可达回退）
 *      - verify_events       BigQuery 事件流优先 + JSONL 兜底
 *      - verify_queries      真实 catalog 28 query 检索 Top3 命中率（≥80% 验收线）
 *      - verify_http         HTTP 全端点契约冒烟（40+ API，自起服务）
 *      - verify_award        获奖级四大增强（编排中枢/成效看板/主动关怀/端侧遥测，自起服务）
 *      - verify_llm_providers 多协议直连（400 参数自修复/工具循环/回退链/调用埋点，本地 mock）
 *   ③ 汇总通过/失败，退出码 0=全过 1=有失败
 *
 * 运行：npm run verify   （或 node scripts/verify-all.mjs）
 * 端口：MOCK_PORT 可覆盖（默认 4599）；占用时自动换 4600–4610。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
// 直接跑 tsx 的 CLI 入口（node 执行），避免 Windows 下 .cmd 的 spawn 兼容问题
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');

let PORT = Number(process.env.MOCK_PORT || 4599);

/** 挑选一个可用端口（MOCK_PORT 优先，占用则顺延） */
function pickPort(preferred) {
  return new Promise((done) => {
    const tryPort = (p) => {
      const srv = createServer();
      srv.once('error', () => p < 4620 ? tryPort(p + 1) : done(p));
      srv.once('listening', () => srv.close(() => done(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(preferred);
  });
}

function run(cmd, args, env) {
  return new Promise((done) => {
    // .mjs 脚本直接用 node 执行；.ts 脚本经 tsx CLI 转译
    const isTs = args[0]?.endsWith('.ts');
    const exe = isTs ? process.execPath : process.execPath;
    const execArgs = isTs ? [TSX, ...args] : args;
    const child = spawn(exe, execArgs, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', (e) => { console.error(`[verify-all] 启动失败: ${e.message}`); done(1); });
  });
}

const SUITES = [
  {
    name: 'verify_insights',
    title: '洞察聚合（BigQuery→JSONL 兜底，12 断言）',
    args: ['scripts/verify_insights.ts'],
    env: {},
  },
  {
    name: 'verify_agent_tools',
    title: '领域工具层（检索/订单/建单防重）',
    args: ['scripts/verify_agent_tools.ts'],
    env: {},
  },
  {
    name: 'verify_gemini_agent',
    title: 'Gemini 内核 T1–T9（工具循环/降级/映射/路由）',
    args: ['scripts/verify_gemini_agent.ts'],
    env: {
      GEMINI_BASE_URL: `http://127.0.0.1:${PORT}`,
      VERTEX_SEARCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      VERTEX_SEARCH_ENGINE_ID: 'mock-engine',
      GCP_PROJECT: 'mock-project',
      KNOWLEDGE_PROVIDER: 'vertex',
      AGENT_PROVIDER: 'gemini',
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_TEMPERATURE: '0.3',
      GEMINI_API_KEY: 'mock-key',
      CSA_DB_PATH: 'data/verify_gemini.db',
    },
  },
  {
    name: 'verify_store',
    title: 'Firestore 优先 + SQLite 兜底',
    args: ['scripts/verify_store.ts'],
    env: {
      FIRESTORE_BASE_URL: `http://127.0.0.1:${PORT}`,
      FIRESTORE_PROJECT: 'mock-project',
      DATA_PROVIDER: 'firestore',
      CSA_DB_PATH: 'data/verify_store.db',
    },
  },
  {
    name: 'verify_events',
    title: 'BigQuery 事件流 + JSONL 兜底',
    args: ['scripts/verify_events.ts'],
    env: {
      BIGQUERY_BASE_URL: `http://127.0.0.1:${PORT}`,
      BIGQUERY_PROJECT: 'mock',
      BIGQUERY_DATASET: 'analytics',
      BIGQUERY_TABLE: 'events',
      EVENTS_JSONL_PATH: 'data/events-verify-all.jsonl',
    },
  },
  {
    name: 'verify_queries',
    title: '真实 catalog 检索 Top3 命中率（≥80%）',
    args: ['scripts/verify_queries.ts'],
    env: {
      KNOWLEDGE_PROVIDER: 'vertex',
      VERTEX_SEARCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      VERTEX_SEARCH_ENGINE_ID: 'mock-engine',
      GCP_PROJECT: 'mock-project',
      CSA_DB_PATH: 'data/verify_queries.db',
    },
  },
  {
    name: 'verify_http',
    title: 'HTTP 全端点冒烟（40+ API 契约一致性，自起服务）',
    args: ['scripts/verify_http.mjs'],
    env: {
      // HTTP 套件自起 Express 服务；端口取 mock 端口 +100，避免与 mock 及其余套件（各自独立 db/端口）冲突
      PORT: String(PORT + 100),
      CSA_DB_PATH: 'data/verify_http.db',
      ADMIN_PASSWORD: 'smoke123',
      INGEST_SECRET: 'smoke-secret',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      SEED_DEMO: '1',
    },
  },
  {
    name: 'verify_award',
    title: '获奖级四大增强（编排中枢/成效看板/主动关怀/端侧遥测，自起服务）',
    args: ['scripts/verify_award.mjs'],
    env: {
      // 同样自起 Express 服务；端口再 +10，与 verify_http 隔离；独立 db 保证 v15/v16 迁移基线干净
      PORT: String(PORT + 110),
      CSA_DB_PATH: 'data/verify_award.db',
      ADMIN_PASSWORD: 'award123',
      INGEST_SECRET: 'award-secret',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      SEED_DEMO: '1',
    },
  },
  {
    name: 'verify_llm_providers',
    title: '多协议直连（400 自修复/工具循环/回退链/埋点，本地 mock）',
    args: ['scripts/verify_llm_providers.ts'],
    env: {
      // 自起 mock OpenAI 兼容 + Anthropic 服务；端口与 mock 主端口隔离；独立 db 保证迁移基线干净
      MOCK_PORT: String(PORT + 200),
      CSA_DB_PATH: 'data/verify_llm.db',
    },
  },
];

async function waitMock(timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/__stats`);
      if (r.ok) return true;
    } catch { /* 未起 */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  PORT = await pickPort(PORT);
  console.log(`\n=== EmbedDesk 一键验收（mock GCP @ 127.0.0.1:${PORT}） ===\n`);
  const mock = spawn(process.execPath, ['scripts/mock-vertex.mjs'], {
    cwd: ROOT,
    env: { ...process.env, MOCK_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    if (!(await waitMock())) throw new Error('mock 服务启动超时');
    const results = [];
    for (const s of SUITES) {
      console.log(`\n─── ${s.title} ───`);
      const code = await run(TSX, s.args, s.env);
      results.push({ name: s.name, title: s.title, ok: code === 0 });
      if (code !== 0) console.log(`  ✗ ${s.name} 失败（exit ${code}）`);
    }
    console.log('\n=== 汇总 ===');
    for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.title}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 套件失败`}（${results.length - failed}/${results.length}）`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    mock.kill();
  }
}

main().catch((e) => { console.error('❌ 一键验收异常:', e?.message || e); process.exit(1); });
