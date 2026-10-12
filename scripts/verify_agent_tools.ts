/**
 * Agent 领域工具层直接验证（不依赖在线 LLM）。
 * 直接调用 createCsaAgentTools 产出的 handler，断言：
 *   - search_knowledge：能检索到标准 FAQ 文本；
 *   - query_order：能安全返回订单上下文字符串（命中或未命中均不崩溃）；
 *   - create_ticket：能建单并返回工单号，captured.tickets 同步记录（会话维度防重生效）。
 * 使用隔离库（CSA_DB_PATH 由调用方传入），避免污染主库。
 */
import { createCsaAgentTools } from '../server/agentTools.js';
import { seedKnowledgeBase } from '../server/knowledge.js';
import * as db from '../server/db.js';

async function main() {
  // 隔离库无种子数据，先灌入 FAQ 知识库，使检索可命中
  const seeded = seedKnowledgeBase();
  if (seeded) console.log(`[seed] 已写入 ${seeded} 条 FAQ 知识`);

  const sessionId = `verify-${Date.now()}`;
  // 真实运行路径中 ingestExternalMessage 已先 registerSession 落库；
  // 验证脚本直接调 handler，需先插入一条合法会话，否则 create_ticket 会触发 session_id 外键约束失败。
  db.createSession({ id: sessionId, title: '工具层验证会话', model: 'verify', channel: 'im', customer_name: '验证客户' });

  const bundle = createCsaAgentTools({
    channel: 'im',
    sessionId,
    customerId: null,
    customerName: '验证客户',
    allowCreateTicket: true,
  });

  const sk = bundle.tools.find((t) => t.name === 'search_knowledge');
  const qo = bundle.tools.find((t) => t.name === 'query_order');
  const ct = bundle.tools.find((t) => t.name === 'create_ticket');
  if (!sk || !qo || !ct) throw new Error('工具未全部注册');

  // 站内语料查询（中科佳晨为端侧 AI / IoT 模组方案商），确保命中标准 FAQ
  const r1: any = await sk.handler({ query: 'Cat.1 模组适合什么场景', intent: 'order_query' });
  const skText = r1.content?.[0]?.text ?? '';
  console.log('[search_knowledge]', skText.slice(0, 80).replace(/\n/g, ' '), '...');
  if (!skText.includes('Cat.1') && !skText.includes('NB-IoT')) throw new Error('search_knowledge 未返回相关 FAQ');

  const r2: any = await qo.handler({ orderNo: 'SO20260001' });
  const qoText = r2.content?.[0]?.text ?? '';
  console.log('[query_order]', qoText.slice(0, 80).replace(/\n/g, ' '), '...');
  if (typeof qoText !== 'string') throw new Error('query_order 返回异常');

  // 第一次建单
  const r3: any = await ct.handler({ intent: 'complaint', summary: '用户投诉物流延迟', reason: 'AGENT_TOOL verify' });
  const ctText = r3.content?.[0]?.text ?? '';
  console.log('[create_ticket #1]', ctText.slice(0, 80).replace(/\n/g, ' '), '...');
  if (bundle.captured.tickets.length !== 1) throw new Error('create_ticket 未捕获工单');
  const firstId = bundle.captured.tickets[0].ticketId;

  // 二次建单：会话维度防重，应返回既有工单而非新建
  const r4: any = await ct.handler({ intent: 'complaint', summary: '再次投诉', reason: 'AGENT_TOOL verify 2' });
  const ctText2 = r4.content?.[0]?.text ?? '';
  console.log('[create_ticket #2]', ctText2.slice(0, 80).replace(/\n/g, ' '), '...');
  if (bundle.captured.tickets.length !== 1) throw new Error('create_ticket 防重失效，重复建单');
  if (bundle.captured.tickets[0].ticketId !== firstId) throw new Error('create_ticket 防重返回工单不一致');

  console.log('\n✅ Agent 工具层验证通过（search_knowledge / query_order / create_ticket 防重正常）');
}

main().catch((e) => {
  console.error('❌ 验证失败:', e?.stack || e);
  process.exit(1);
});
