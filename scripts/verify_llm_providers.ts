/**
 * 多协议直连接入层验收（llmProviders.ts + agentCore 编排，本地 mock，不依赖真实凭证）
 *
 * 前置：本脚本自行拉起 mock 服务（scripts/mock-openai.mjs，MOCK_PORT 默认 4631），
 *   并以独立库运行（CSA_DB_PATH 须为 verify_*，由 npm run verify 统一注入）。
 *
 * 断言矩阵：
 *   U0  openaiChatUrl 三态归一化（完整 URL / 版本层级 / 根地址）
 *   U1  discoverModels 探测并过滤非对话模型（embedding/tts/whisper）
 *   U2  OpenAI plain 生成（usedModel 前缀 + usage 提取）
 *   U3  端点 400 拒绝 temperature → 自动剥离重试成功（不消耗工具轮次）
 *   U4  端点 400 拒绝 max_tokens → 自动剥离重试成功
 *   U5  端点 400 拒绝 tools → 连带剥离 tool_choice 重试成功
 *   U6  OpenAI 工具循环（search_knowledge 两轮闭环 + captured）
 *   U7  工具结果缺 tool_call_id → 合成幂等 id 被端点接受
 *   U8  HTTP 500 重试耗尽 → 抛错（fallbackToKb=false 交上层编排）
 *   U9  401 鉴权失败 → 抛错且错误信息含状态码
 *   U10 Anthropic plain 生成（usedModel + usage）
 *   U11 Anthropic 400 拒绝 tools → 自动剥离重试成功
 *   U12 Anthropic 工具循环（tool_use + captured）
 *   U13 Anthropic 缺 tool_use_id → 合成 id 兜底
 *   U14 agentCore 显式协议 ok 埋点（provider/status/tokens/channel 落库）
 *   U15 agentCore 显式协议失败 → 回退链耗尽 → 知识库命中降级（degraded 埋点）
 *   U16 agentCore 显式协议失败且知识库无命中 → 抛错（error 埋点）
 *   U17 testProviderConnection 保存前连通性测试
 */
import { spawn } from 'node:child_process';

const MOCK_PORT = Number(process.env.MOCK_PORT || 4631);
const MOCK = process.env.MOCK_URL || `http://127.0.0.1:${MOCK_PORT}`;

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + msg);
  } else {
    failed += 1;
    console.error('  ✗ ' + msg);
    throw new Error('断言失败: ' + msg);
  }
}

async function control(scenario: string): Promise<void> {
  await fetch(MOCK + '/__control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
}

async function stats(): Promise<{
  scenario: string;
  openaiCalls: number;
  anthropicCalls: number;
  toolIdsSeen: string[];
  lastOpenaiBody: any;
  lastAnthropicBody: any;
}> {
  const r = await fetch(MOCK + '/__stats');
  return (await r.json()) as any;
}

/** 等待 mock 就绪（轮询 /__stats，最多 5s） */
async function waitMockReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(MOCK + '/__stats');
      if (r.ok) return;
    } catch { /* 未起 */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('mock 服务 5s 内未就绪');
}

async function main(): Promise<void> {
  /* ---------- 安全护栏：必须跑在 verify 专用库上，防止污染开发库配置 ---------- */
  const dbPath = process.env.CSA_DB_PATH || '';
  if (!/verify/i.test(dbPath)) {
    console.error('[verify_llm_providers] 安全拦截：须经 npm run verify 运行（CSA_DB_PATH 须为 verify_* 库）');
    process.exit(1);
  }

  /* ---------- 拉起 mock ---------- */
  const mock = spawn(process.execPath, ['scripts/mock-openai.mjs'], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit',
  });
  try {
    await waitMockReady();

    // 动态导入：确保护栏在 server/db.ts（导入即按 CSA_DB_PATH 开库）之前生效
    const { callOpenAiCompatible, callAnthropic, discoverModels, testProviderConnection, openaiChatUrl } =
      await import('../server/llmProviders.js');
    const { callAgent } = await import('../server/agentCore.js');
    const db = await import('../server/db.js');
    const { seedKnowledgeBase } = await import('../server/knowledge.js');

    const seeded = seedKnowledgeBase();
    if (seeded) console.log(`[seed] 已写入 ${seeded} 条 FAQ 知识`);

    const newSession = (tag: string): string => {
      const id = `vl-${tag}-${Date.now()}`;
      db.createSession({ id, title: 'LLM 直连冒烟 ' + tag, model: 'mock-gpt', channel: 'web', customer_name: '冒烟客户' });
      return id;
    };
    const baseOpts = { systemPrompt: '你是测试助手', model: 'mock-gpt', timeoutMs: 20000 };
    const setCfg = (patch: Record<string, unknown>): void => { db.saveLlmConfig(patch as any); };

    /* ---------- U0: 端点归一化（纯函数） ---------- */
    console.log('\n[U0] openaiChatUrl 三态归一化');
    assert(openaiChatUrl('https://api.example.com/v1/chat/completions') === 'https://api.example.com/v1/chat/completions', 'U0 完整 URL 原样返回');
    assert(openaiChatUrl('https://api.example.com/v1') === 'https://api.example.com/v1/chat/completions', 'U0 版本层级补 /chat/completions');
    assert(openaiChatUrl('https://api.example.com') === 'https://api.example.com/v1/chat/completions', 'U0 根地址补 /v1/chat/completions');
    assert(openaiChatUrl('https://api.example.com/v1/') === 'https://api.example.com/v1/chat/completions', 'U0 尾斜杠容忍');

    /* ---------- U1: 探测可用模型 ---------- */
    console.log('\n[U1] discoverModels 探测 + 非对话模型过滤');
    setCfg({ provider: 'openai', endpoint: `${MOCK}/v1`, apiKey: 'mock-key', model: 'mock-gpt', maxOutputTokens: 1024 });
    const d1 = await discoverModels('openai', `${MOCK}/v1`, 'mock-key');
    const ids = (d1.models || []).map((m) => m.modelId);
    assert(d1.ok, 'U1 探测成功');
    assert(ids.includes('mock-gpt') && ids.includes('mock-gpt-mini'), 'U1 对话模型全部保留');
    assert(!ids.some((id) => /embedding|tts|whisper/i.test(id)), 'U1 embedding/tts/whisper 被过滤');

    /* ---------- U2: OpenAI plain ---------- */
    console.log('\n[U2] OpenAI plain 生成');
    await control('plain');
    const s2 = newSession('u2');
    const r2 = await callOpenAiCompatible({ ...baseOpts, prompt: '你好', session: { id: s2, sdk_session_id: null } });
    assert(r2.text.includes('模拟 OpenAI'), 'U2 返回 mock 文本');
    assert(r2.usedModel === 'openai:mock-gpt', 'U2 usedModel=openai:mock-gpt');
    assert(r2.usage?.promptTokens === 11 && r2.usage?.completionTokens === 7, 'U2 usage 提取 11/7');

    /* ---------- U3: 400 拒绝 temperature ---------- */
    console.log('\n[U3] 400 参数自修复：temperature');
    await control('reject_temperature');
    const before3 = await stats();
    const r3 = await callOpenAiCompatible({ ...baseOpts, prompt: '你好', session: { id: newSession('u3'), sdk_session_id: null } });
    const st3 = await stats();
    assert(r3.text.includes('模拟 OpenAI'), 'U3 剥离 temperature 后生成成功');
    assert(st3.openaiCalls - before3.openaiCalls === 2, 'U3 共 2 次请求（被拒 + 剥离重试）');
    assert(st3.lastOpenaiBody?.temperature === undefined, 'U3 重试请求已不含 temperature');

    /* ---------- U4: 400 拒绝 max_tokens ---------- */
    console.log('\n[U4] 400 参数自修复：max_tokens');
    await control('reject_max_tokens');
    const r4 = await callOpenAiCompatible({ ...baseOpts, prompt: '你好', session: { id: newSession('u4'), sdk_session_id: null } });
    const st4 = await stats();
    assert(r4.text.includes('模拟 OpenAI'), 'U4 剥离 max_tokens 后生成成功');
    assert(st4.lastOpenaiBody?.max_tokens === undefined, 'U4 重试请求已不含 max_tokens');

    /* ---------- U5: 400 拒绝 tools ---------- */
    console.log('\n[U5] 400 参数自修复：tools（连带 tool_choice）');
    await control('reject_tools');
    const r5 = await callOpenAiCompatible({
      ...baseOpts,
      prompt: '你好',
      session: { id: newSession('u5'), sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: 'x', customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
    });
    const st5 = await stats();
    assert(r5.text.includes('模拟 OpenAI'), 'U5 剥离 tools 后生成成功');
    assert(st5.lastOpenaiBody?.tools === undefined && st5.lastOpenaiBody?.tool_choice === undefined, 'U5 tools 与 tool_choice 均已剥离');

    /* ---------- U6: OpenAI 工具循环 ---------- */
    console.log('\n[U6] OpenAI 工具循环（search_knowledge）');
    await control('tools');
    const before6 = await stats();
    const s6 = newSession('u6');
    const r6 = await callOpenAiCompatible({
      ...baseOpts,
      prompt: '如何降低模组待机功耗？',
      session: { id: s6, sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: s6, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
    });
    const st6 = await stats();
    assert(r6.text.includes('模拟 OpenAI'), 'U6 工具循环后收尾');
    assert(st6.openaiCalls - before6.openaiCalls === 2, 'U6 两轮请求（工具轮 + 收尾轮）');
    assert((r6.captured?.toolCalls || []).includes('search_knowledge'), 'U6 captured.toolCalls 含 search_knowledge');
    assert(!(r6.captured?.tickets || []).length, 'U6 web 渠道未建单');

    /* ---------- U7: 缺 tool_call_id 合成兜底 ---------- */
    console.log('\n[U7] 缺 tool_call_id → 合成幂等 id');
    await control('notoolid');
    const r7 = await callOpenAiCompatible({
      ...baseOpts,
      prompt: '如何降低模组待机功耗？',
      session: { id: newSession('u7'), sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: 'x', customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
    });
    const st7 = await stats();
    assert(r7.text.includes('模拟 OpenAI'), 'U7 合成 id 后闭环成功');
    assert(st7.toolIdsSeen.includes('call_1_0'), 'U7 端点收到合成 id call_1_0');

    /* ---------- U8: 500 重试耗尽抛错 ---------- */
    console.log('\n[U8] HTTP 500 重试耗尽 → 抛错');
    await control('always500');
    let err8: any = null;
    try {
      await callOpenAiCompatible({ ...baseOpts, prompt: '你好', session: { id: newSession('u8'), sdk_session_id: null } }, false);
    } catch (e) { err8 = e; }
    assert(err8 && String(err8.message).includes('OPENAI_HTTP_500'), 'U8 抛出 OPENAI_HTTP_500（fallbackToKb=false 交上层）');

    /* ---------- U9: 401 鉴权失败 ---------- */
    console.log('\n[U9] 401 鉴权失败');
    await control('unauth');
    setCfg({ apiKey: 'wrong-key' });
    let err9: any = null;
    try {
      await callOpenAiCompatible({ ...baseOpts, prompt: '你好', session: { id: newSession('u9'), sdk_session_id: null } }, false);
    } catch (e) { err9 = e; }
    setCfg({ apiKey: 'mock-key' });
    assert(err9 && String(err9.message).includes('OPENAI_HTTP_401'), 'U9 抛出 OPENAI_HTTP_401');

    /* ---------- U10: Anthropic plain ---------- */
    console.log('\n[U10] Anthropic plain 生成');
    setCfg({ provider: 'anthropic', endpoint: `${MOCK}/v1`, apiKey: 'mock-key', model: 'mock-claude' });
    await control('plain');
    const s10 = newSession('u10');
    const r10 = await callAnthropic({ ...baseOpts, model: 'mock-claude', prompt: '你好', session: { id: s10, sdk_session_id: null } });
    assert(r10.text.includes('模拟 Anthropic'), 'U10 返回 mock 文本');
    assert(r10.usedModel === 'anthropic:mock-claude', 'U10 usedModel=anthropic:mock-claude');
    assert(r10.usage?.promptTokens === 9 && r10.usage?.completionTokens === 5, 'U10 usage 提取 9/5');

    /* ---------- U11: Anthropic 400 拒绝 tools ---------- */
    console.log('\n[U11] Anthropic 400 参数自修复：tools');
    await control('reject_tools');
    const before11 = await stats();
    const r11 = await callAnthropic({
      ...baseOpts,
      model: 'mock-claude',
      prompt: '你好',
      session: { id: newSession('u11'), sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: 'x', customerId: null, customerName: '冒冒客户', allowCreateTicket: false },
    });
    const st11 = await stats();
    assert(r11.text.includes('模拟 Anthropic'), 'U11 剥离 tools 后生成成功');
    assert(st11.anthropicCalls - before11.anthropicCalls === 2, 'U11 共 2 次请求（被拒 + 剥离重试）');
    assert(st11.lastAnthropicBody?.tools === undefined, 'U11 重试请求已不含 tools');

    /* ---------- U12: Anthropic 工具循环 ---------- */
    console.log('\n[U12] Anthropic 工具循环（search_knowledge）');
    await control('tools');
    const s12 = newSession('u12');
    const r12 = await callAnthropic({
      ...baseOpts,
      model: 'mock-claude',
      prompt: '如何降低模组待机功耗？',
      session: { id: s12, sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: s12, customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
    });
    assert(r12.text.includes('模拟 Anthropic'), 'U12 工具循环后收尾');
    assert((r12.captured?.toolCalls || []).includes('search_knowledge'), 'U12 captured.toolCalls 含 search_knowledge');

    /* ---------- U13: Anthropic 缺 tool_use_id 合成兜底 ---------- */
    console.log('\n[U13] Anthropic 缺 tool_use_id → 合成幂等 id');
    await control('notoolid');
    const r13 = await callAnthropic({
      ...baseOpts,
      model: 'mock-claude',
      prompt: '如何降低模组待机功耗？',
      session: { id: newSession('u13'), sdk_session_id: null },
      toolCtx: { channel: 'web', sessionId: 'x', customerId: null, customerName: '冒烟客户', allowCreateTicket: false },
    });
    const st13 = await stats();
    assert(r13.text.includes('模拟 Anthropic'), 'U13 合成 id 后闭环成功');
    assert(st13.toolIdsSeen.includes('toolu_1_0'), 'U13 端点收到合成 id toolu_1_0');

    /* ---------- U14: agentCore 显式协议 + ok 埋点 ---------- */
    console.log('\n[U14] agentCore 显式协议路由 + ok 埋点');
    setCfg({ provider: 'openai', endpoint: `${MOCK}/v1`, apiKey: 'mock-key', model: 'mock-gpt', maxOutputTokens: 1024 });
    await control('plain');
    const s14 = newSession('u14');
    const r14 = await callAgent({
      ...baseOpts,
      prompt: '你好',
      session: { id: s14, sdk_session_id: null },
      channel: 'verify',
    });
    assert(r14.usedModel === 'openai:mock-gpt', 'U14 callAgent 路由到 openai 直连');
    const logs14 = db.queryRecentLlmCallLogs(5) as any[];
    const top14 = logs14[0];
    assert(top14?.provider === 'openai' && top14?.status === 'ok', 'U14 埋点 provider=openai status=ok');
    assert(top14?.channel === 'verify', 'U14 埋点 channel=verify');
    assert(top14?.prompt_tokens === 11 && top14?.completion_tokens === 7, 'U14 埋点 tokens 11/7 落库');

    /* ---------- U15: 显式协议失败 → 回退链耗尽 → 知识库命中降级 ---------- */
    console.log('\n[U15] 回退链耗尽 → 知识库命中（degraded）');
    await control('always500');
    const s15 = newSession('u15');
    const r15 = await callAgent({
      ...baseOpts,
      prompt: '如何降低模组待机功耗？', // 种子 FAQ 原句，确保知识库命中
      session: { id: s15, sdk_session_id: null },
      channel: 'verify',
    });
    assert(r15.usedModel === 'knowledge_base', 'U15 降级知识库直答');
    assert(r15.text.length > 0, 'U15 返回知识库答案');
    const logs15 = db.queryRecentLlmCallLogs(5) as any[];
    assert(logs15[0]?.status === 'degraded', 'U15 埋点 status=degraded');

    /* ---------- U16: 显式协议失败且知识库无命中 → 抛错（error 埋点） ---------- */
    console.log('\n[U16] 回退链耗尽且知识库无命中 → 抛错');
    let err16: any = null;
    try {
      await callAgent({
        ...baseOpts,
        prompt: 'zzqqxxww 不存在的气象问题 987654',
        session: { id: newSession('u16'), sdk_session_id: null },
        channel: 'verify',
      });
    } catch (e) { err16 = e; }
    assert(err16 !== null, 'U16 callAgent 抛错');
    const logs16 = db.queryRecentLlmCallLogs(5) as any[];
    assert(logs16[0]?.status === 'error', 'U16 埋点 status=error');

    /* ---------- U17: testProviderConnection ---------- */
    console.log('\n[U17] testProviderConnection 保存前测试');
    await control('plain');
    const t17 = await testProviderConnection({ provider: 'openai', endpoint: `${MOCK}/v1`, apiKey: 'mock-key', model: 'mock-gpt' });
    assert(t17.ok, 'U17 连接测试通过');
    assert(t17.usedModel === 'openai:mock-gpt', 'U17 usedModel=openai:mock-gpt');
    assert((t17.reply || '').length > 0 && t17.latencyMs >= 0, 'U17 返回回复与延迟');

    console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 ===`);
    if (failed > 0) process.exit(1);
  } finally {
    mock.kill();
  }
}

main().catch((e) => {
  console.error('[verify_llm_providers] 运行异常:', e);
  process.exit(1);
});
