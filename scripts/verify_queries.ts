/**
 * D2 验收脚本：28 条测试 query 验证 Vertex 检索 Top3 命中率（≥80%）
 *
 * 自包含：
 *   ① 把 data/products/catalog.json 的 QA 灌入本地 mock Vertex（documents:import）；
 *   ② 对 28 条覆盖「型号 / 参数 / 场景」三类的 query 调 retrieveRag(query,null,3)；
 *   ③ 统计期望目标 doc 是否落在 Top3，输出 Markdown 报告到 stdout + 文件。
 *
 * 运行（mock 已在 4599 跑着）：
 *   KNOWLEDGE_PROVIDER=vertex VERTEX_SEARCH_ENGINE_ID=mock-engine \
 *   VERTEX_SEARCH_BASE_URL=http://127.0.0.1:4599 GCP_PROJECT=mock-project \
 *   CSA_DB_PATH=data/verify_queries.db npx tsx scripts/verify_queries.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { retrieveRag } from '../server/rag.js';

const MOCK = (process.env.VERTEX_SEARCH_BASE_URL || 'http://127.0.0.1:4599').replace(/\/+$/, '');
const GCP_PROJECT = process.env.GCP_PROJECT || 'mock-project';
const ENGINE = process.env.VERTEX_SEARCH_ENGINE_ID || 'mock-engine';
const LOCATION = process.env.VERTEX_SEARCH_LOCATION || 'global';

/** 28 条测试 query：q=用户问题 expect=期望命中的 catalog QA id cat=分类 */
const QUERIES: { q: string; expect: string; cat: '型号' | '参数' | '场景' }[] = [
  // 型号类（14 条）
  { q: 'DJ9341 干扰枪支持哪些反制频段', expect: 'qa-dj9341-bands', cat: '型号' },
  { q: 'DT900 侦测打击一体机是什么产品', expect: 'qa-dt900-intro', cat: '型号' },
  { q: 'DJ500 基站款反制设备有什么特点', expect: 'qa-dj500-base', cat: '型号' },
  { q: 'DJ600 反制盾适合什么场景用', expect: 'qa-dj600-shield', cat: '型号' },
  { q: 'SDJ800 查打一体设备的工作原理是什么', expect: 'qa-sdj800-principle', cat: '型号' },
  { q: '有没有手持式无人机探测器', expect: 'qa-bt2-detector', cat: '型号' },
  { q: 'DJ8341 支持几个频段可以选配吗', expect: 'qa-dj8341-flex', cat: '型号' },
  { q: '有没有超大功率的反制枪', expect: 'qa-dj102-power', cat: '型号' },
  { q: 'DT900 有用户手册吗', expect: 'qa-dt900-manual', cat: '型号' },
  { q: '有没有射频干扰模块或者 PCBA 方案', expect: 'qa-pcba-modules', cat: '型号' },
  { q: 'DJ100 标准款干扰枪有什么特点', expect: 'qa-dj100-intro', cat: '型号' },
  { q: 'DJ886 旧款反制枪怎么样适合谁用', expect: 'qa-dj886-specs', cat: '型号' },
  { q: '考场手机信号屏蔽器有吗', expect: 'qa-exam-shield', cat: '型号' },
  { q: '便携箱 DJ300 有什么特点干扰距离多远', expect: 'qa-dj300-specs', cat: '型号' },
  // 参数类（8 条）
  { q: '无人机干扰枪的有效干扰距离是多少', expect: 'qa-dj9341-range', cat: '参数' },
  { q: '干扰类型有哪些能干扰什么信号', expect: 'qa-dj9341-types', cat: '参数' },
  { q: '无人机反制设备都有哪些频段', expect: 'qa-dj9341-bands', cat: '参数' },
  { q: '户外基站长时间工作会不会发热', expect: 'qa-heat-design', cat: '参数' },
  { q: 'DJ9341 的功率和天线增益是多少', expect: 'qa-dj9341-specs', cat: '参数' },
  { q: 'DJ102 的功率电池和重量是多少', expect: 'qa-dj102-specs', cat: '参数' },
  { q: 'SDJ800 的检测距离和反制距离是多少', expect: 'qa-sdj800-specs', cat: '参数' },
  { q: 'DJ-BT2 探测器的侦测距离和续航是多少', expect: 'qa-bt2-specs', cat: '参数' },
  // 场景类（6 条）
  { q: '中科佳晨是一家什么公司', expect: 'qa-company-profile', cat: '场景' },
  { q: '你们的反制设备用了什么专利技术', expect: 'qa-patents', cat: '场景' },
  { q: '你们有哪些无人机反制产品', expect: 'qa-product-range', cat: '场景' },
  { q: '机场监狱变电站这类场景用什么设备', expect: 'qa-scenario-selection', cat: '场景' },
  { q: '单兵巡逻固定点位考场场景分别推荐什么设备', expect: 'qa-selection-guide', cat: '场景' },
  { q: '侦测设备和反制设备有什么区别该先配哪个', expect: 'qa-detection-vs-jamming', cat: '场景' },
];

async function ingestCatalog() {
  const catalogPath = resolve('data/products/catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const documents = (catalog.qa || []).map((qa: any) => ({
    id: qa.id,
    structData: {
      id: qa.id,
      category: qa.category,
      question: qa.question,
      answer: qa.answer,
      keywords: qa.keywords || [],
    },
  }));
  const url = `${MOCK}/projects/${GCP_PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/documents:import`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inlineSource: { documents } }),
  });
  if (!r.ok) throw new Error(`ingest failed: HTTP ${r.status} ${await r.text()}`);
  console.log(`[ingest] 灌入 ${documents.length} 条 QA 到 mock Vertex`);
}

async function main() {
  await ingestCatalog();
  console.log(`[verify] 运行 ${QUERIES.length} 条 query（KNOWLEDGE_PROVIDER=vertex → mock）\n`);

  const rows: { q: string; expect: string; cat: string; top: string[]; hit: boolean }[] = [];
  for (const item of QUERIES) {
    const hits = await retrieveRag(item.q, null, 3);
    const top = hits.slice(0, 3).map((h) => h.id);
    const hit = top.includes(item.expect);
    rows.push({ q: item.q, expect: item.expect, cat: item.cat, top, hit });
  }

  const total = rows.length;
  const hits = rows.filter((r) => r.hit).length;
  const rate = ((hits / total) * 100).toFixed(1);

  // 分类统计
  const byCat: Record<string, { total: number; hits: number }> = {};
  for (const r of rows) {
    byCat[r.cat] ??= { total: 0, hits: 0 };
    byCat[r.cat].total++;
    if (r.hit) byCat[r.cat].hits++;
  }

  const pass = hits / total >= 0.8;
  const report = [
    '# Vertex 检索质量验证报告（28 条 query）',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- 检索提供方：Vertex AI Search（mock 端点 ${MOCK}）`,
    `- 总 query 数：**${total}**`,
    `- Top3 命中数：**${hits}**`,
    `- **Top3 命中率：${rate}%**（验收线 ≥80% → **${pass ? '✅ 通过' : '❌ 未达标'}**）`,
    '',
    '## 分类命中率',
    '',
    '| 分类 | 命中 | 总数 | 命中率 |',
    '| --- | --- | --- | --- |',
    ...Object.entries(byCat).map(
      ([c, v]) => `| ${c} | ${v.hits} | ${v.total} | ${((v.hits / v.total) * 100).toFixed(1)}% |`,
    ),
    '',
    '## 逐条明细',
    '',
    '| # | 分类 | query | 期望命中 | Top3 实际 | 结果 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${r.cat} | ${r.q} | ${r.expect} | ${r.top.join(', ') || '(空)'} | ${r.hit ? '✅' : '❌'} |`,
    ),
    '',
  ].join('\n');

  writeFileSync('data/products/query-verify-report.md', report);
  console.log(report);
  console.log(`\n[verify] 报告已写入 data/products/query-verify-report.md`);
  process.exit(pass ? 0 : 2);
}

main().catch((e) => {
  console.error('[verify] 失败：', e);
  process.exit(1);
});
