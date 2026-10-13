/**
 * 本地 mock Vertex AI 服务（Hack2skill D2/D3 冒烟用，不进生产）
 *
 * 模拟的 GCP 端点，使无凭证环境也能端到端验证 geminiAgent / vertexSearch / ingest 的逻辑闭环：
 *   ① POST /models/{model}:generateContent —— Gemini function calling
 *      （按 /__control 切换场景：search / ticket / badargs / unknown / always-tool / http-error）
 *   ② POST .../servingConfigs/default:search —— Discovery Engine 检索
 *      （按 /__control 切换场景：normal / search-error）
 *   ③ POST .../dataStores/{ds}/branches/0/documents:import —— 灌库（ingest-products.mjs）
 *      文档存入内存 DOCS；search 优先检索 DOCS（INCREMENTAL 累积），空则回退 CANNED_DOCS
 *   ④ POST .../processors/{id}:process —— Document AI OCR（返回含型号的样板文本）
 *
 * 用法：MOCK_PORT=4599 node scripts/mock-vertex.mjs
 * 控制：curl -X POST http://127.0.0.1:4599/__control -H 'Content-Type: application/json' -d '{"scenario":"search"}'
 * 统计：curl http://127.0.0.1:4599/__stats
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4599);
let scenario = 'search'; // search | ticket | badargs | unknown | always-tool | http-error | search-error
let genCalls = 0;
let searchCalls = 0;
let importCalls = 0;
let docaiCalls = 0;
let lastGenBody = null;
const DOCS = []; // documents:import 灌入的文档（内存态）
const FS_DOCS = new Map(); // Firestore 内存态：`${collection}/${id}` -> { fields }
let fsWrites = 0;
let fsReads = 0;
let bqInserts = 0;

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(s);
}

const CANNED_DOCS = [
  {
    id: 'doc-p1',
    structData: {
      id: 'faq-power-1',
      category: 'product',
      question: 'Cat.1 模组的典型功耗是多少？',
      answer: 'Cat.1 模组典型功耗 1.5W，待机电流低于 5mA，支持 PSM/eDRX 省电模式。',
      keywords: ['功耗', '待机', 'Cat.1', 'PSM'],
    },
  },
  {
    id: 'doc-p2',
    structData: {
      id: 'faq-power-2',
      category: 'product',
      question: '模组耗电太大怎么优化？',
      answer: '建议开启 PSM 省电模式、缩短心跳周期，并核对外围电路漏电；典型场景可将待机电流控制在 5mA 以内。',
      keywords: ['耗电', '功耗', '省电', 'PSM'],
    },
  },
];

/* ---- 中文 bigram 相关性打分（模拟 Discovery Engine 语义排序） ---- */
function bigrams(s) {
  const out = new Set();
  const clean = String(s || '').replace(/\s+/g, '');
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

function scoreDoc(query, doc) {
  const sd = doc.structData || {};
  const qb = bigrams(query);
  if (!qb.size) return 0;
  const text = [sd.question, sd.answer, (sd.keywords || []).join(' ')].join(' ');
  const tb = bigrams(text);
  let hit = 0;
  for (const g of qb) if (tb.has(g)) hit++;
  let score = (hit / qb.size) * 0.7;
  for (const k of sd.keywords || []) {
    if (k && String(k).length >= 2 && query.includes(String(k))) score += 0.15;
  }
  if (text.includes(query)) score += 0.2;
  return score;
}

const DOCAI_SAMPLE_TEXT = [
  '便携式无人机管制设备 型号：DT900 用户使用手册 V1.0',
  '产品简介：DT900 无人机侦测打击设备是深圳市中科佳晨技术有限公司自主研发的一款反黑飞设备。',
  '内置业界领先的八个频段的飞控阻断频率，以及GPS/QZSS/GLONASS/Galileo卫星定位阻断频率。',
  '无人机干扰枪DJ9341 战技性能指标：',
  '1. 反制频段：433M,900M,1.2G,1.4G,1.5G,2.4G,5.2G,5.8G',
  '2. 干扰类型：图传，遥控，定位',
  '3. 干扰距离：100M-2KM',
  '无人机反制-基站款DJ500：采用超大功率射频器件，可对无人机迫降，返航，悬停等。',
  '自主研发射频核心技术，采用VCO射频设计，以及电流负反馈技术，长时间工作不发热发烫。',
].join('\n');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};

    if (url.pathname === '/__control') {
      if (body.scenario) scenario = body.scenario;
      console.log(`[mock] scenario -> ${scenario}`);
      return json(res, 200, { scenario });
    }
    if (url.pathname === '/__stats') {
      return json(res, 200, { scenario, genCalls, searchCalls, importCalls, docaiCalls, docCount: DOCS.length, fsWrites, fsReads, bqInserts });
    }

    // ⑤ Firestore REST（store.ts 双写验证）：PATCH 写 / GET 读 / :runQuery 列
    const fsMatch = url.pathname.match(/\/documents\/([^/]+)\/([^/]+)$/);
    if (req.method === 'PATCH' && fsMatch) {
      fsWrites++;
      const [, collection, id] = fsMatch;
      FS_DOCS.set(`${collection}/${id}`, { fields: body.fields || {} });
      console.log(`[mock] firestore PATCH ${collection}/${id}`);
      return json(res, 200, { name: `projects/mock/databases/(default)/documents/${collection}/${id}`, fields: body.fields || {} });
    }
    if (req.method === 'GET' && fsMatch) {
      fsReads++;
      const [, collection, id] = fsMatch;
      const doc = FS_DOCS.get(`${collection}/${id}`);
      if (!doc) return json(res, 404, { error: { message: 'not found' } });
      console.log(`[mock] firestore GET ${collection}/${id}`);
      return json(res, 200, doc);
    }
    if (req.method === 'POST' && url.pathname.endsWith(':runQuery')) {
      fsReads++;
      const collection = body?.structuredQuery?.from?.[0]?.collectionId || 'tickets';
      const rows = [];
      for (const [key, val] of FS_DOCS.entries()) {
        if (key.startsWith(`${collection}/`)) {
          rows.push({ document: { name: `projects/mock/databases/(default)/documents/${key}`, fields: val.fields } });
        }
      }
      console.log(`[mock] firestore runQuery ${collection} -> ${rows.length}`);
      return json(res, 200, rows);
    }

    // ⑥ BigQuery Streaming Insert（events.ts 分析事件流验证）
    if (req.method === 'POST' && url.pathname.endsWith('/insertAll')) {
      bqInserts++;
      const rows = body?.rows || [];
      console.log(`[mock] bigquery insertAll -> ${rows.length} 行`);
      return json(res, 200, { kind: 'bigquery#tableDataInsertAllResponse' });
    }

    // ③ Discovery Engine 灌库：documents:import（INCREMENTAL 累积）
    if (url.pathname.endsWith(':import')) {
      importCalls++;
      const docs = body?.inlineSource?.documents || body?.documents || [];
      let upserted = 0;
      for (const d of docs) {
        if (!d?.id) continue;
        const i = DOCS.findIndex((x) => x.id === d.id);
        const doc = { id: d.id, structData: d.structData || {}, content: d.content || null };
        if (i >= 0) DOCS[i] = doc;
        else DOCS.push(doc);
        upserted++;
      }
      console.log(`[mock] documents:import #${importCalls} upserted=${upserted} total=${DOCS.length}`);
      return json(res, 200, { name: 'operations/mock-import-' + importCalls, done: true, metadata: { upserted } });
    }

    // ④ Document AI：processor process（返回样板 OCR 文本）
    if (url.pathname.includes('/processors/') && url.pathname.endsWith(':process')) {
      docaiCalls++;
      console.log(`[mock] documentai process #${docaiCalls}`);
      return json(res, 200, { document: { text: DOCAI_SAMPLE_TEXT, entities: [], mimeType: 'application/pdf' } });
    }

    if (url.pathname.endsWith(':generateContent')) {
      genCalls++;
      lastGenBody = body;
      const hasFnResponse = (body.contents || []).some((c) =>
        (c.parts || []).some((p) => p && p.functionResponse),
      );
      const round = (body.contents || []).filter((c) => c.role === 'model').length + 1;
      console.log(`[mock] generateContent #${genCalls} round=${round} hasFnResponse=${hasFnResponse} scenario=${scenario}`);

      if (scenario === 'http-error') return json(res, 500, { error: { message: 'mock injected 500' } });

      const fnCall = (name, args) => ({
        candidates: [
          {
            content: { role: 'model', parts: [{ functionCall: { name, args } }] },
            finishReason: 'STOP',
          },
        ],
      });
      const finalText = (text) => ({
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      });

      // always-tool 场景：无论回灌什么，永远再要一次工具（用于压测 ≤5 轮上限）
      if (scenario === 'always-tool') {
        return json(res, 200, fnCall('search_knowledge', { query: '模组 功耗' }));
      }

      // badargs 场景专用：第 1 轮缺必填参数；收到 error 回灌后第 2 轮补全；再收到成功结果才收尾
      if (scenario === 'badargs' && hasFnResponse) {
        const fnParts = (body.contents || []).flatMap((c) => c.parts || []).filter((p) => p && p.functionResponse);
        const last = fnParts[fnParts.length - 1];
        const wasError = last && last.functionResponse.response && last.functionResponse.response.error;
        if (wasError) return json(res, 200, fnCall('search_knowledge', { query: '模组 功耗 待机' }));
        return json(res, 200, finalText('根据知识库：Cat.1 模组典型功耗 1.5W，待机电流低于 5mA，可开启 PSM 省电模式优化。'));
      }

      // 已拿到工具结果 → 收尾文本
      if (hasFnResponse) {
        return json(res, 200, finalText('根据知识库：Cat.1 模组典型功耗 1.5W，待机电流低于 5mA，可开启 PSM 省电模式优化。'));
      }

      switch (scenario) {
        case 'ticket':
          return json(res, 200, fnCall('create_ticket', {
            intent: 'complaint',
            summary: '用户对产品稳定性不满，要求跟进',
            reason: 'AGENT_TOOL mock',
          }));
        case 'handoff':
          // 仅发回 HANDOFF_TOKEN 文本、不调用工具：驱动 channels 的 detectAgentSignal → openIngestTicket 分支
          // （D4 验收：渠道级建单必须经 persistTicket 落 Firestore）。
          return json(res, 200, finalText('[[HANDOFF]] 该问题需人工专员跟进。'));
        case 'badargs':
          // 第 1 轮缺必填参数（校验失败→自修复路径由上方 hasFnResponse 分支接管）
          return json(res, 200, fnCall('search_knowledge', {}));
        case 'unknown':
          return round === 1
            ? json(res, 200, fnCall('delete_database', { confirm: true }))
            : json(res, 200, finalText('抱歉，该操作不在我的能力范围内。'));
        case 'always-tool':
          return json(res, 200, fnCall('search_knowledge', { query: '模组 功耗' }));
        case 'search':
        default:
          return json(res, 200, fnCall('search_knowledge', { query: '模组 耗电 太大', intent: 'tech_support' }));
      }
    }

    if (url.pathname.endsWith(':search')) {
      searchCalls++;
      console.log(`[mock] discoveryEngine search #${searchCalls} scenario=${scenario} query="${String(body.query || '').slice(0, 40)}"`);
      if (scenario === 'search-error') return json(res, 503, { error: { message: 'mock injected search 503' } });
      // DOCS 非空时检索灌入的产品库（INCREMENTAL 语义），空则回退 CANNED_DOCS（D2 冒烟兼容）
      const corpus = DOCS.length ? DOCS : CANNED_DOCS;
      const query = String(body.query || '');
      const ranked = corpus
        .map((d) => ({ d, s: scoreDoc(query, d) }))
        .filter((x) => x.s >= 0.05)
        .sort((a, b) => b.s - a.s)
        .slice(0, Number(body.pageSize) || 10);
      return json(res, 200, { results: ranked.map((x) => ({ document: x.d })) });
    }

    json(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Vertex AI mock listening on http://127.0.0.1:${PORT} (scenario=${scenario})`);
});
