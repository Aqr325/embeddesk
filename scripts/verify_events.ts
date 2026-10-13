/**
 * D4 events.ts 冒烟：BigQuery Streaming Insert 优先 + 本地 JSONL 兜底（mock 模式）
 *
 * 运行：
 *   BIGQUERY_BASE_URL=http://127.0.0.1:4599 BIGQUERY_PROJECT=mock BIGQUERY_DATASET=analytics \
 *   BIGQUERY_TABLE=events EVENTS_JSONL_PATH=data/events-verify.jsonl \
 *   npx tsx scripts/verify_events.ts
 */
import { trackEvent, getEventsStats } from '../server/events.js';
import { readFileSync, existsSync, rmSync } from 'node:fs';

const MOCK = process.env.BIGQUERY_BASE_URL || 'http://127.0.0.1:4599';
const JSONL = process.env.EVENTS_JSONL_PATH || 'data/events-verify.jsonl';

async function bqStats() {
  try {
    return (await (await fetch(`${MOCK}/__stats`)).json()) as any;
  } catch {
    return null;
  }
}

async function main() {
  let failures = 0;
  const assert = (c: boolean, m: string) => {
    console.log(`${c ? '✅' : '❌'} ${m}`);
    if (!c) failures++;
  };

  // 清空本地 JSONL 以便断言增量
  if (existsSync(JSONL)) rmSync(JSONL);

  // ---------- T1：BigQuery 优先（mock 存活） ----------
  console.log('\n[T1] BigQuery Streaming Insert 优先路径');
  const before = await bqStats();
  trackEvent('question', { sessionId: 's1', channel: 'web', query: '模组功耗' });
  trackEvent('search_hit', { query: '模组功耗', docId: 'faq-1', score: 0.8, provider: 'vertex', hit: true });
  trackEvent('ticket_created', { ticketId: 't1', priority: 'urgent', escalated: true, channel: 'im' });
  await new Promise((r) => setTimeout(r, 300)); // 等待 fire-and-forget 异步投递
  const after = await bqStats();
  assert(after.bqInserts >= before.bqInserts + 1, `BigQuery insertAll 被调用（${before.bqInserts}→${after.bqInserts}）`);

  // ---------- T2：未配置 BigQuery → 落本地 JSONL ----------
  console.log('\n[T2] 未配置 BigQuery → 本地 JSONL 兜底');
  delete process.env.BIGQUERY_PROJECT;
  const jsonlBefore = existsSync(JSONL) ? readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).length : 0;
  trackEvent('latency', { stage: 'agent-first-token', ms: 420 });
  trackEvent('question', { sessionId: 's2', channel: 'embed', query: '干扰距离' });
  const jsonlAfter = existsSync(JSONL) ? readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).length : 0;
  assert(jsonlAfter > jsonlBefore, `本地 JSONL 新增 ${jsonlAfter - jsonlBefore} 行兜底事件`);
  // 校验写入内容是合法 JSON 且 type 正确
  const last = existsSync(JSONL) ? (readFileSync(JSONL, 'utf8').trim().split('\n').pop() || '') : '';
  let parsed: any = null;
  try {
    parsed = JSON.parse(last);
  } catch {}
  assert(parsed?.type === 'question', 'JSONL 末行是合法 question 事件');

  console.log('\n[stats]', JSON.stringify(getEventsStats()));
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
  process.exit(failures ? 2 : 0);
}

main().catch((e) => {
  console.error('[verify_events] 异常：', e);
  process.exit(1);
});
