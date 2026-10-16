#!/usr/bin/env node
/**
 * Mock 演示 LLM 端点（record-demo-video.mjs 录制专用，不依赖真实凭证）
 *
 * 与 scripts/mock-openai.mjs（验收用、场景式全局状态）不同，本服务是**内容感知**的：
 * 读取对话里最后一条用户消息，按关键词编排真实的工具调用（function calling），
 * 使录制视频能够完整走通「提问 → search_knowledge 检索 → 基于真实知识库回答 →
 * 采购意向 → [[HANDOFF]] 转人工 → 真实建单（优先级/SLA/坐席）」全链路。
 *
 * 回答内容全部来源于工具回传的真实结果（知识库 FAQ 原文），不虚构产品参数。
 *
 * 运行：MOCK_PORT=4799 node scripts/mock-demo-llm.mjs
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4799);
const API_KEY = 'mock-key';

/** 模拟模型“思考”时延，让录制更自然 */
const think = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content || '');
  }
  return '';
}

/** 工具结果文本（role=tool 的消息 content） */
function toolResultText(messages) {
  return messages
    .filter((m) => m?.role === 'tool')
    .map((m) => String(m?.content || ''))
    .join('\n')
    .trim();
}

/** 从工具结果中提炼回答：取前若干字符，保持知识库原文口径 */
function composeAnswer(toolText, intent) {
  const body = toolText.replace(/\s+/g, ' ').slice(0, 420);
  if (intent === 'purchase') {
    return (
      '感谢您的信任！采购与招标事宜需要商务专员对接，我可以为您说明流程并安排报价方案。' +
      '我已记录您的采购意向，现在为您转接人工专员跟进。[[HANDOFF]]'
    );
  }
  if (intent === 'tech') {
    return `关于您咨询的问题，知识库中的说明如下：\n\n${body}\n\n如需更详细的选型建议，我可以为您转接技术工程师。`;
  }
  return `为您查到以下资料：\n\n${body}`;
}

function pickIntent(text) {
  if (/采购|招标|报价|购买|500|批量|代理|经销/.test(text)) return 'purchase';
  if (/功耗|待机|休眠|低功耗/.test(text)) return 'tech';
  return 'general';
}

/** 会话摘要请求的规则式兜底回复（不调工具、不带令牌） */
function composeSummary(messages) {
  const userLines = messages.filter((m) => m?.role === 'user').map((m) => String(m?.content || '').trim()).filter(Boolean);
  const topics = [];
  if (userLines.some((t) => /功耗|待机/.test(t))) topics.push('模组待机功耗咨询（已基于知识库作答）');
  if (userLines.some((t) => /采购|招标/.test(t))) topics.push('500 套模组采购意向与招标流程咨询（需商务专员跟进）');
  if (!topics.length) topics.push('客户产品咨询');
  return `客户本次会话涉及：${topics.join('；')}。历史消息 ${userLines.length} 条，问题尚未闭环，建议人工跟进。`;
}

function pickQuery(text) {
  if (/功耗|待机|休眠|低功耗/.test(text)) return '模组待机功耗 降低';
  if (/采购|招标|报价|购买|批量|代理|经销/.test(text)) return '采购流程 招标 批量报价';
  return String(text).slice(0, 40);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 模型列表（供前端「探测可用模型」演示）
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const body = JSON.stringify({
      data: [
        { id: 'demo-gpt-pro', object: 'model' },
        { id: 'demo-gpt-air', object: 'model' },
        { id: 'text-embedding-3-small', object: 'model' },
      ],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = null;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* 忽略 */
      }
      await think(500 + Math.random() * 500);

      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const userText = lastUserText(messages);
      const hasToolResults = messages.some((m) => m?.role === 'tool');

      const json = (status, payload) => {
        const s = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
        res.end(s);
      };

      // 会话摘要请求（summarize.ts 的兜底 prompt）：直接给规则式文本摘要，
      // 既不发起工具调用，也不带 [[HANDOFF]] 令牌（避免污染工单摘要）
      if (/^请总结以下对话/.test(userText.trim())) {
        await think(300);
        return json(200, {
          id: 'chatcmpl-demo',
          choices: [{ index: 0, message: { role: 'assistant', content: composeSummary(messages) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 210, completion_tokens: 46 },
        });
      }

      if (!hasToolResults) {
        // 第一轮：发起真实工具调用（function calling）
        const call = {
          id: `call_demo_${Date.now()}`,
          type: 'function',
          function: { name: 'search_knowledge', arguments: JSON.stringify({ query: pickQuery(userText) }) },
        };
        return json(200, {
          id: 'chatcmpl-demo',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 128, completion_tokens: 12 },
        });
      }

      // 第二轮：基于真实工具结果组织回答；采购意向走 [[HANDOFF]] 转人工
      const intent = pickIntent(userText);
      const answer = composeAnswer(toolResultText(messages), intent);
      return json(200, {
        id: 'chatcmpl-demo',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 356, completion_tokens: 168 },
      });
    });
    return;
  }

  const s = JSON.stringify({ error: { message: `mock-demo-llm 未实现：${req.method} ${url.pathname}` } });
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(s);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-demo-llm] 监听 http://127.0.0.1:${PORT}/v1（内容感知演示端点）`);
});
