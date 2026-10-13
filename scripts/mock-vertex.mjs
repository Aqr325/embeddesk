/**
 * 本地 mock Vertex AI 服务（Hack2skill D2 冒烟用，不进生产）
 *
 * 模拟两个 GCP 端点，使无凭证环境也能端到端验证 geminiAgent / vertexSearch 的逻辑闭环：
 *   ① POST /models/{model}:generateContent —— Gemini function calling
 *      （按 /__control 切换场景：search / ticket / badargs / unknown / always-tool / http-error）
 *   ② POST .../servingConfigs/default:search —— Discovery Engine 检索
 *      （按 /__control 切换场景：normal / search-error）
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
let lastGenBody = null;

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
      return json(res, 200, { scenario, genCalls, searchCalls });
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
      console.log(`[mock] discoveryEngine search #${searchCalls} scenario=${scenario}`);
      if (scenario === 'search-error') return json(res, 503, { error: { message: 'mock injected search 503' } });
      return json(res, 200, { results: CANNED_DOCS.map((d) => ({ document: d })) });
    }

    json(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Vertex AI mock listening on http://127.0.0.1:${PORT} (scenario=${scenario})`);
});
