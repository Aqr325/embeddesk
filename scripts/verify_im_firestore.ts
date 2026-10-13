/**
 * D4 集成验收：IM 渠道级建单必须经 persistTicket 落 Firestore（修复 openIngestTicket 绕过 persistTicket 的回归）
 *
 * 驱动方式：本地拉起 mock-vertex（4599），Gemini 场景设为 `handoff`（仅回文本 HANDOFF_TOKEN、不调工具），
 * 触发 channels.ts 的 detectAgentSignal → openIngestTicket 分支（此前该分支经 writeQueue 直接 db.createTicket，绕过 Firestore）。
 * 断言：result.ticketId 存在 且 mock 的 fsWrites ≥ 1（持久化层确实写了 Firestore）。
 *
 * 用法：MOCK_PORT=4599 PORT 任意 npx tsx scripts/verify_im_firestore.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MOCK_PORT = Number(process.env.MOCK_PORT || 4599);
const BASE = `http://127.0.0.1:${MOCK_PORT}`;

// —— 所有 env 必须在 import 服务端模块之前设置（db.ts 在 import 时读 CSA_DB_PATH）——
const tmpDb = join(mkdtempSync(join(tmpdir(), 'csa-im-')), 'verify-im.db');
process.env.CSA_DB_PATH = tmpDb;
process.env.DATA_PROVIDER = 'firestore';
process.env.FIRESTORE_PROJECT = 'mock-project';
process.env.FIRESTORE_BASE_URL = BASE;
process.env.BIGQUERY_PROJECT = 'mock-project';
process.env.BIGQUERY_DATASET = 'analytics';
process.env.BIGQUERY_TABLE = 'events';
process.env.BIGQUERY_BASE_URL = BASE;
process.env.KNOWLEDGE_PROVIDER = 'vertex';
process.env.VERTEX_SEARCH_ENGINE_ID = 'mock-engine';
process.env.VERTEX_SEARCH_BASE_URL = BASE;
process.env.GEMINI_BASE_URL = BASE;
process.env.AGENT_PROVIDER = 'auto'; // 由 googleAuthMode() 推导为 mock

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitMock(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/__stats`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(100);
  }
  throw new Error('mock 服务在超时内未就绪');
}

async function setScenario(name: string): Promise<void> {
  await fetch(`${BASE}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: name }),
  });
}

async function getStats(): Promise<any> {
  const r = await fetch(`${BASE}/__stats`);
  return r.json();
}

type Case = { name: string; scenario: string; message: string; expectFs: number };
const CASES: Case[] = [
  { name: 'IM-handoff(openIngestTicket 分支)', scenario: 'handoff', message: '我要投诉，你们产品质量太差了，要求退款并追责', expectFs: 1 },
  { name: 'IM-ticket(Agent 工具分支)', scenario: 'ticket', message: '产品坏了要求人工跟进', expectFs: 1 },
];

async function main(): Promise<void> {
  const mock = spawn('node', [join(ROOT, 'scripts', 'mock-vertex.mjs')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'ignore',
  });

  const failures: string[] = [];
  try {
    await waitMock();

    const { ingestExternalMessage } = await import(pathToFileURL(join(ROOT, 'server', 'channels.js')).href);
    const { dataProviderConfigured } = await import(pathToFileURL(join(ROOT, 'server', 'store.js')).href);

    if (!dataProviderConfigured()) {
      throw new Error('dataProviderConfigured() 应为 true（DATA_PROVIDER=firestore 已设）');
    }

    for (const c of CASES) {
      await setScenario(c.scenario);
      const before = await getStats();
      const res: any = await ingestExternalMessage({
        channel: 'im',
        externalId: `im-${c.scenario}-${Date.now()}`,
        from: `wxid_${c.scenario}`,
        message: c.message,
        customerName: '验证客户',
      });
      const after = await getStats();
      const dFs = (after.fsWrites ?? 0) - (before.fsWrites ?? 0);
      const okTicket = Boolean(res?.ticketId);
      const okFs = dFs >= c.expectFs;
      const okBq = (after.bqInserts ?? 0) - (before.bqInserts ?? 0) >= 1;
      const pass = okTicket && okFs && okBq;
      console.log(
        `[${pass ? 'PASS' : 'FAIL'}] ${c.name}: ticketId=${res?.ticketId ? res.ticketId.slice(0, 8) : 'NONE'} ` +
          `priority=${res?.priority ?? 'N/A'} fsΔ=${dFs} bqΔ=${(after.bqInserts ?? 0) - (before.bqInserts ?? 0)} ` +
          `(handoff=${res?.handoff})`,
      );
      if (!pass) failures.push(`${c.name} -> ticket=${okTicket} fsΔ=${dFs} bqΔ=${(after.bqInserts ?? 0) - (before.bqInserts ?? 0)}`);
    }
  } finally {
    mock.kill('SIGKILL');
  }

  if (failures.length) {
    console.error(`\n❌ D4 IM→Firestore 集成验收失败：\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\n✅ D4 IM 渠道级建单已统一经 persistTicket 落 Firestore（openIngestTicket 绕过问题已修复）');
}

main().catch((e) => {
  console.error('verify_im_firestore 运行异常:', e);
  process.exit(1);
});
