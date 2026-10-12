/**
 * 邮件渠道闭环验证脚本（沙箱用，无需真实邮箱）。
 * 驱动 simulateInboundEmail 走完整「ingest → 生成回执 → 落库去重」管线，
 * 并断言会话 / 消息 / 去重记录均已落库。运行：tsx verify_email_gateway.ts
 */
import { simulateInboundEmail } from './server/emailGateway.js';
import { drain } from './server/writeQueue.js';
import * as db from './server/db.js';

async function main() {
  const cases = [
    { from: 'refund@customer.com', subject: '我要退款', message: '我买的模组想退款，订单号 SO2026001，还没发货' },
    { from: 'tech@customer.com', subject: '设备连不上网', message: '我的设备指示灯红色，连不上网，型号 SG-200' },
    { from: 'hi@customer.com', subject: '你好', message: '你好，在吗' },
    { from: 'angry@customer.com', subject: '投诉', message: '你们服务太差了，我要投诉，必须给个说法' },
  ];

  const results: Array<{ from: string; r: any; session: any; msgs: number; processed: boolean }> = [];
  for (const c of cases) {
    const r = await simulateInboundEmail(c);
    results.push({ from: c.from, r, session: null, msgs: 0, processed: false });
  }

  // 等写入队列刷盘（worker 或内联回退异步落库），再读 DB 断言。
  // 以超时兜底，避免 broken worker 时 drain() 永久挂起。
  await Promise.race([drain(), new Promise((res) => setTimeout(res, 2500))]);
  await new Promise((res) => setTimeout(res, 300));

  let allOk = true;
  for (const item of results) {
    const sess = db.getSession(item.r.sessionId);
    const msgs = db.getMessagesBySession(item.r.sessionId).length;
    const processed = db.isEmailProcessed(item.r.messageId);
    item.session = sess;
    item.msgs = msgs;
    item.processed = processed;
    const ok =
      !!sess &&
      sess.channel === 'email' &&
      msgs >= 2 && // 至少一条 user + 一条 assistant
      processed &&
      item.r.reply.length > 0 &&
      item.r.sent === true;
    if (!ok) allOk = false;
    console.log(
      `[${ok ? 'OK ' : 'FAIL'}] from=${item.from} intent=${sess?.primary_intent ?? '?'} ` +
        `channel=${sess?.channel ?? '?'} msgs=${msgs} ticket=${item.r.ticketId ? item.r.ticketId.slice(0, 8) : '无'} ` +
        `processed=${processed} sent=${item.r.sent}`,
    );
    console.log('       REPLY:', item.r.reply.replace(/\n/g, ' ').slice(0, 90));
  }

  // 幂等二次校验：对同一 from 再发一封，应续接到同一会话（同一客户 24h 内复用），不新建会话
  const second = await simulateInboundEmail({
    from: 'refund@customer.com',
    subject: '补充一下',
    message: '刚才那个退款，我补充一下物流单号',
  });
  await drain();
  await new Promise((res) => setTimeout(res, 200));
  const reusedSession = db.getSession(second.sessionId);
  const firstSession = db.getSession(results[0].r.sessionId);
  const threadContinued = reusedSession && firstSession && reusedSession.id === firstSession.id;
  console.log(`[${threadContinued ? 'OK ' : 'FAIL'}] 线程续接: 同客户二次来邮复用会话=${threadContinued}`);

  console.log('\n==== 邮件网关验证', allOk && threadContinued ? '全部通过 ✅' : '存在失败 ❌', '====');
  if (!(allOk && threadContinued)) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('验证脚本异常:', e);
    process.exit(1);
  });
