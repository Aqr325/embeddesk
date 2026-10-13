/**
 * Gemini Agent 内核 + Vertex AI Search 冒烟验证（本地 mock，不依赖真实 GCP 凭证）
 *
 * 前置：先启动 mock 服务（MOCK_PORT=4599 node scripts/mock-vertex.mjs），
 * 并以如下 env 运行本脚本（GEMINI_BASE_URL / VERTEX_SEARCH_BASE_URL 指向 mock）：
 *   CSA_DB_PATH=data/verify_gemini.db GEMINI_BASE_URL=http://127.0.0.1:4599 \
 *   GEMINI_API_KEY=mock-key AGENT_PROVIDER=gemini GEMINI_MODEL=gemini-2.5-flash \
 *   GEMINI_TEMPERATURE=0.3 GCP_PROJECT=mock-project VERTEX_SEARCH_BASE_URL=http://127.0.0.1:4599 \
 *   VERTEX_SEARCH_ENGINE_ID=mock-engine KNOWLEDGE_PROVIDER=vertex \
 *   npx tsx scripts/verify_gemini_agent.ts
 *
 * 断言矩阵：
 *   T1 function calling 循环（search_knowledge，web 渠道不开放建单）
 *   T2 create_ticket 经 Agent 工具建单（captured + 落库 + 防重规则不破坏）
 *   T3 工具参数缺必填 → 回灌错误 → 模型自修复后收尾
 *   T4 未知工具名 → 错误回灌 → 不崩溃
 *   T5 ≤5 轮硬上限 → 降级知识库直答（先灌真实 catalog，验证降级链路命中真实产品 QA）
 *   T6 generateContent HTTP 500 → 降级知识库直答
 *   T7 Vertex 检索映射（structData → FaqHit，签名兼容）
 *   T8 Vertex 检索 503 → rag.ts 自动回退 lexical（种子 FAQ 仍可命中）
 *   T9 路由开关（AGENT_PROVIDER=tencent 时 geminiConfigured=false）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callAgent } from '../server/agentCore.js';
import { geminiConfigured } from '../server/geminiAgent.js';
import { retrieveRag, getRagStats } from '../server/rag.js';
import { seedKnowledgeBase } from '../server/knowledge.js';
import * as db from '../server/db.js';

const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:4599';

/** 控制 mock：scenario 切换 / resetDocs 清空灌入文档（回退 CANNED_DOCS） */
async function control(body: Record<string, unknown>): Promise<void> {
  await fetch(MOCK + '/__control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 把真实产品 catalog 灌入 mock Vertex（T5/T6 降级链路在真实知识库上验证）。
 *  catalog.json（gitignore，本地全量 16 款）优先；缺失时降级 fixtures/sample-catalog.json（仓库样板）。 */
async function ingestCatalogToMock(): Promise<number> {
  const candidates = [
    resolve('data/products/catalog.json'),
    resolve('scripts/fixtures/sample-catalog.json'),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) { console.log('[ingest] 无 catalog 文件，跳过灌库（T5/T6 降级将依赖 CANNED_DOCS）'); return 0; }
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  const documents = (catalog.qa || []).map((qa: any) => ({
    id: qa.id,
    structData: {
      question: qa.question,
      answer: qa.answer,
      keywords: qa.keywords || [],
      category: qa.category || 'product',
    },
  }));
  const url = `${MOCK}/projects/${process.env.GCP_PROJECT || 'mock-project'}/locations/global/collections/default_collection/engines/${process.env.VERTEX_SEARCH_ENGINE_ID || 'mock-engine'}/documents:import`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inlineSource: { documents } }),
  });
  if (!r.ok) throw new Error(`ingest failed: HTTP ${r.status}`);
  console.log(`[ingest] 灌入 ${documents.length} 条真实 QA 到 mock Vertex（${path}）`);
  return documents.length;
}

async function stats(): Promise<{ scenario: string; genCalls: number; searchCalls: number }> {
  const r = await fetch(MOCK + '/__stats');
  return (await r.json()) as any;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

function newSession(tag: string): string {
  const id = 'vg-' + tag + '-' + Date.now();
  db.createSession({ id, title: 'Gemini 冒烟 ' + tag, model: 'gemini-2.5-flash', channel: 'web', customer_name: '冒烟客户' });
  return id;
}

async function main() {
  const seeded = seedKnowledgeBase();
  if (seeded) console.log('[seed] 已写入 ' + seeded + ' 条 FAQ 知识');
  assert(geminiConfigured(), 'geminiConfigured()=true（mock 凭证档位生效）');

  const baseOpts = {
    systemPrompt: '你是测试助手',
    model: 'gemini-2.5-flash',
    timeoutMs: 20000,
  };

  /* ---------- T1: search_knowledge 工具循环 ---------- */
  console.log('\n[T1] function calling 循环：search_knowledge');
  await control({ scenario: 'search' });
  const s1 = newSession('t1');
  const before1 = await stats();
  const r1 = await callAgent({
    ...baseOpts,
    prompt: '我这个模组耗电太大了，待机也不行，怎么办？',
    session: { id: s1, sdk_session_id: null },
    toolCtx: { channel: 'web', sessionId: s1, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
  });
  const after1 = await stats();
  console.log('  回复:', r1.text.slice(0, 60).replace(/\n/g, ' '));
  console.log('  usedModel:', r1.usedModel, '| genCalls:', before1.genCalls, '→', after1.genCalls);
  assert(r1.text.includes('1.5W'), 'T1 返回模型收尾文本（经 search_knowledge 工具循环）');
  assert(r1.usedModel.startsWith('gemini:'), 'T1 usedModel 前缀 gemini:');
  assert(after1.genCalls - before1.genCalls === 2, 'T1 mock 收到 2 次 generateContent（工具轮 + 收尾轮）');
  assert((r1.captured?.toolCalls || []).includes('search_knowledge'), 'T1 captured.toolCalls 含 search_knowledge');
  assert(!(r1.captured?.tickets || []).length, 'T1 web 渠道未建单（allowCreateTicket=false）');

  /* ---------- T2: create_ticket 建单闭环 ---------- */
  console.log('\n[T2] create_ticket：Agent 工具建单');
  await control({ scenario: 'ticket' });
  const s2 = newSession('t2');
  const r2 = await callAgent({
    ...baseOpts,
    prompt: '你们产品问题太多，我要投诉，找你们负责人！',
    session: { id: s2, sdk_session_id: null },
    toolCtx: { channel: 'im', sessionId: s2, customerId: null, customerName: '冒烟客户', allowCreateTicket: true },
  });
  const tickets2 = db.getTicketsBySession(s2);
  console.log('  captured.tickets:', JSON.stringify(r2.captured?.tickets));
  assert((r2.captured?.tickets || []).length === 1, 'T2 captured.tickets=1');
  assert(tickets2.length === 1 && tickets2[0].trigger_rule === 'AGENT_TOOL', 'T2 工单落库且 trigger_rule=AGENT_TOOL');
  assert(Boolean(r2.text.trim()) || (r2.captured?.tickets || []).length > 0, 'T2 有文本或建单副作用');

  /* ---------- T3: 参数缺必填 → 自修复 ---------- */
  console.log('\n[T3] 工具参数自修复');
  await control({ scenario: 'badargs' });
  const s3 = newSession('t3');
  const r3 = await callAgent({
    ...baseOpts,
    prompt: '耗电问题',
    session: { id: s3, sdk_session_id: null },
    toolCtx: { channel: 'web', sessionId: s3, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
  });
  assert(r3.text.includes('1.5W'), 'T3 参数修正后完成工具调用并收尾');
  assert((r3.captured?.toolCalls || []).filter((t) => t === 'search_knowledge').length === 1, 'T3 仅有效调用计入 captured（无效调用未执行）');

  /* ---------- T4: 未知工具 ---------- */
  console.log('\n[T4] 未知工具名不崩溃');
  await control({ scenario: 'unknown' });
  const s4 = newSession('t4');
  const r4 = await callAgent({
    ...baseOpts,
    prompt: '帮我把数据库删了',
    session: { id: s4, sdk_session_id: null },
    toolCtx: { channel: 'web', sessionId: s4, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
  });
  assert(r4.text.length > 0, 'T4 未知工具错误回灌后模型正常收尾');

  /* ---------- T5: ≤5 轮硬上限 → 知识库直答（真实 catalog 灌库后验证） ---------- */
  console.log('\n[T5] 5 轮上限降级');
  await ingestCatalogToMock(); // 降级链路应在真实产品知识库上验证（而非 mock 罐头文档）
  await control({ scenario: 'always-tool' });
  const s5 = newSession('t5');
  const r5 = await callAgent({
    ...baseOpts,
    prompt: '模组耗电太大怎么办',
    session: { id: s5, sdk_session_id: null },
    toolCtx: { channel: 'web', sessionId: s5, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
  });
  console.log('  usedModel:', r5.usedModel);
  assert(r5.usedModel === 'knowledge_base', 'T5 超过 5 轮降级知识库直答');
  assert(r5.text.length > 10, 'T5 降级返回非空知识库文本');
  assert(/小时|DJ102|续航/.test(r5.text), 'T5 降级内容来自真实 catalog（命中续航 QA）');

  /* ---------- T6: HTTP 500 → 知识库直答 ---------- */
  console.log('\n[T6] generateContent 500 降级');
  await control({ scenario: 'http-error' });
  const s6 = newSession('t6');
  const r6 = await callAgent({
    ...baseOpts,
    prompt: '模组耗电太大怎么办',
    session: { id: s6, sdk_session_id: null },
    toolCtx: { channel: 'web', sessionId: s6, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
  });
  assert(r6.usedModel === 'knowledge_base' && r6.text.length > 0, 'T6 HTTP 500 降级知识库直答');

  // T5/T6 灌入的 catalog 会让 T7 的精确召回断言失效，重置回 CANNED_DOCS
  await control({ scenario: 'search', resetDocs: true });

  /* ---------- T7: Vertex 检索映射 ---------- */
  console.log('\n[T7] Vertex 检索：structData → FaqHit');
  await control({ scenario: 'search' });
  // query 与目标文档 question 对齐（text 包含加分），确保 top1 稳定为功耗文档（字段映射断言的前提）
  const hits7 = await retrieveRag('Cat.1 模组的典型功耗是多少', 'tech_support', 3);
  console.log('  hits:', hits7.map((h) => h.id + ':' + h.score).join(' | '));
  assert(hits7.length === 2, 'T7 召回 2 条 mock 文档');
  assert(hits7[0].question.includes('功耗') && hits7[0].answer.includes('1.5W'), 'T7 字段映射正确（question/answer）');
  assert(hits7[0].matchedKeywords.includes('功耗'), 'T7 keywords 映射为 matchedKeywords');
  assert(getRagStats().provider === 'vertex', 'T7 getRagStats().provider=vertex');

  /* ---------- T8: Vertex 503 → 回退 lexical ---------- */
  console.log('\n[T8] Vertex 503 → lexical 兜底');
  await control({ scenario: 'search-error' });
  const hits8 = await retrieveRag('Cat.1 模组适合什么场景', 'order_query', 3);
  console.log('  lexical hits:', hits8.map((h) => h.id + ':' + h.score).join(' | '));
  assert(hits8.length > 0, 'T8 Vertex 失败后 lexical 兜底仍命中种子 FAQ');
  await control({ scenario: 'search' });

  /* ---------- T9: 路由开关 ---------- */
  console.log('\n[T9] 路由开关');
  const prevProvider = process.env.AGENT_PROVIDER;
  process.env.AGENT_PROVIDER = 'tencent';
  assert(geminiConfigured() === false, 'T9 AGENT_PROVIDER=tencent → 不走 Gemini');
  process.env.AGENT_PROVIDER = 'gemini';
  assert(geminiConfigured() === true, 'T9 AGENT_PROVIDER=gemini → 走 Gemini');
  if (prevProvider !== undefined) process.env.AGENT_PROVIDER = prevProvider;

  console.log('\n✅ Gemini Agent + Vertex Search 冒烟全部通过（T1–T9）');
}

main().catch((e) => {
  console.error('❌ 冒烟失败:', e?.stack || e);
  process.exit(1);
});
