#!/usr/bin/env node
/**
 * Mock OpenAI 兼容 / Anthropic 服务器（verify_llm_providers 验收用，不依赖真实凭证）
 *
 * 同一端口服务两种协议：
 *   - GET  /v1/models            OpenAI 模型列表（含 embedding/tts 等非对话模型，供过滤断言）
 *   - POST /v1/chat/completions  OpenAI 兼容对话（含 function calling 循环）
 *   - POST /v1/messages          Anthropic Messages（含 tool_use 循环）
 *
 * 场景（POST /__control { scenario } 切换）：
 *   plain              正常文本回复（带 usage）
 *   reject_temperature 首请求带 temperature → 400（模拟 o1/gpt-5 类推理模型），剥离后放行
 *   reject_max_tokens  首请求带 max_tokens → 400，剥离后放行
 *   reject_tools       首请求带 tools/tool_choice → 400，剥离后放行
 *   tools              第一轮回 tool_calls/tool_use（search_knowledge），第二轮回文本
 *   notoolid           同 tools 但不回 id；第二轮回严格校验 tool_call_id/tool_use_id 必须存在
 *   always500          永远 500（验证 fetchWithRetry 重试耗尽后抛错）
 *   unauth             非 Bearer mock-key → 401
 *
 * 运行：MOCK_PORT=4631 node scripts/mock-openai.mjs
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4631);
const API_KEY = 'mock-key';

const state = {
  scenario: 'plain',
  openaiCalls: 0,
  anthropicCalls: 0,
  lastOpenaiBody: null,
  lastAnthropicBody: null,
  /** 第二轮回收到的 tool_call_id / tool_use_id（验证合成 id 兜底） */
  toolIdsSeen: [],
};

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function openaiError(res, status, message) {
  json(res, status, { error: { message, type: 'invalid_request_error', code: null } });
}

function anthropicError(res, status, message) {
  json(res, status, { type: 'error', error: { type: 'invalid_request_error', message } });
}

/** OpenAI 兼容：按场景响应（body 为解析后的请求体） */
function handleOpenAiChat(body) {
  state.openaiCalls += 1;
  state.lastOpenaiBody = body;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasToolResults = messages.some((m) => m?.role === 'tool');
  if (hasToolResults) {
    for (const m of messages) {
      if (m?.role === 'tool' && (!m.tool_call_id || !String(m.tool_call_id).trim())) {
        return { status: 400, payload: { error: { message: "messages with role 'tool' must be a response to a preceding message with 'tool_calls'.", type: 'invalid_request_error' } } };
      }
      if (m?.role === 'tool') state.toolIdsSeen.push(String(m.tool_call_id));
    }
  }

  switch (state.scenario) {
    case 'reject_temperature':
      if (body?.temperature !== undefined) {
        return { status: 400, payload: { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model. Supported values are '1' or omitted.", type: 'invalid_request_error' } } };
      }
      break;
    case 'reject_max_tokens':
      if (body?.max_tokens !== undefined) {
        return { status: 400, payload: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } } };
      }
      break;
    case 'reject_tools':
      if (body?.tools !== undefined) {
        return { status: 400, payload: { error: { message: 'Unrecognized request argument supplied: tools', type: 'invalid_request_error' } } };
      }
      break;
    case 'always500':
      return { status: 500, payload: { error: { message: 'internal mock failure', type: 'server_error' } } };
    case 'unauth':
      return { status: 401, payload: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } } };
    default:
      break;
  }

  // 工具循环场景：无工具结果 → 回 tool_calls；有工具结果 → 收尾文本
  if ((state.scenario === 'tools' || state.scenario === 'notoolid') && !hasToolResults) {
    const call = {
      type: 'function',
      function: { name: 'search_knowledge', arguments: JSON.stringify({ query: '待机功耗' }) },
    };
    if (state.scenario === 'tools') call.id = 'call_mock_1';
    return {
      status: 200,
      payload: {
        id: 'chatcmpl-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      },
    };
  }

  return {
    status: 200,
    payload: {
      id: 'chatcmpl-mock',
      choices: [{ index: 0, message: { role: 'assistant', content: '这是模拟 OpenAI 端点的回复。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    },
  };
}

/** Anthropic Messages：按场景响应 */
function handleAnthropicMessages(body) {
  state.anthropicCalls += 1;
  state.lastAnthropicBody = body;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasToolResults = messages.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result'));
  if (hasToolResults) {
    for (const m of messages) {
      for (const b of Array.isArray(m?.content) ? m.content : []) {
        if (b?.type === 'tool_result' && (!b.tool_use_id || !String(b.tool_use_id).trim())) {
          return { status: 400, payload: { type: 'error', error: { type: 'invalid_request_error', message: 'tool_result blocks must have tool_use_id' } } };
        }
        if (b?.type === 'tool_result') state.toolIdsSeen.push(String(b.tool_use_id));
      }
    }
  }

  switch (state.scenario) {
    case 'reject_tools':
      if (body?.tools !== undefined) {
        return { status: 400, payload: { type: 'error', error: { type: 'invalid_request_error', message: 'tools: Extra inputs are not permitted' } } };
      }
      break;
    case 'always500':
      return { status: 500, payload: { type: 'error', error: { type: 'api_error', message: 'internal mock failure' } } };
    case 'unauth':
      return { status: 401, payload: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    default:
      break;
  }

  if ((state.scenario === 'tools' || state.scenario === 'notoolid') && !hasToolResults) {
    const block = { type: 'tool_use', name: 'search_knowledge', input: { query: '待机功耗' } };
    if (state.scenario === 'tools') block.id = 'toolu_mock_1';
    return {
      status: 200,
      payload: {
        id: 'msg_mock',
        content: [block],
        stop_reason: 'tool_use',
        usage: { input_tokens: 9, output_tokens: 5 },
      },
    };
  }

  return {
    status: 200,
    payload: {
      id: 'msg_mock',
      content: [{ type: 'text', text: '这是模拟 Anthropic 端点的回复。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 5 },
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/__control') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const b = JSON.parse(raw || '{}');
        if (b.scenario) state.scenario = String(b.scenario);
      } catch { /* 忽略非法 body */ }
      json(res, 200, { ok: true, scenario: state.scenario });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__stats') {
    json(res, 200, {
      scenario: state.scenario,
      openaiCalls: state.openaiCalls,
      anthropicCalls: state.anthropicCalls,
      toolIdsSeen: state.toolIdsSeen,
      lastOpenaiBody: state.lastOpenaiBody,
      lastAnthropicBody: state.lastAnthropicBody,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    json(res, 200, {
      data: [
        { id: 'mock-gpt', object: 'model' },
        { id: 'mock-gpt-mini', object: 'model' },
        { id: 'text-embedding-3-small', object: 'model' },
        { id: 'tts-1', object: 'model' },
        { id: 'whisper-1', object: 'model' },
      ],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      if (state.scenario === 'unauth' && req.headers.authorization !== `Bearer ${API_KEY}`) {
        openaiError(res, 401, 'Incorrect API key provided.');
        return;
      }
      const r = handleOpenAiChat(body);
      json(res, r.status, r.payload);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      if (state.scenario === 'unauth' && req.headers['x-api-key'] !== API_KEY) {
        anthropicError(res, 401, 'invalid x-api-key');
        return;
      }
      const r = handleAnthropicMessages(body);
      json(res, r.status, r.payload);
    });
    return;
  }

  json(res, 404, { error: { message: `mock 未实现：${req.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] 监听 http://127.0.0.1:${PORT}（OpenAI 兼容 + Anthropic）`);
});
