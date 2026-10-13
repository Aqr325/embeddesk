/**
 * D5 洞察聚合验收（server/insights.ts，纯本地 JSONL 验证，无需凭证/服务）
 *
 * 构造一份已知结构的事件 JSONL → 设 EVENTS_JSONL_PATH → 调 getInsights() → 断言聚合正确。
 * 验证点：检索命中率、TOP 知识点、渠道分布、工单趋势、热门查询。
 *
 * 运行：npx tsx scripts/verify_insights.ts
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getInsights } from '../server/insights.js';

function buildSample(): string {
  const lines: string[] = [];
  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
  // 渠道分布：web 多、embed 中、im 少、email 极少
  const ch = ['web', 'web', 'embed', 'im', 'email'];
  // 检索命中：dt900 命中 5 次、dj9341 命中 3 次（其中 1 次未命中）
  const docs = [
    'qa-dt900-intro', 'qa-dt900-intro', 'qa-dt900-intro', 'qa-dt900-intro', 'qa-dt900-intro',
    'qa-dj9341-range', 'qa-dj9341-range', 'qa-dj9341-range',
    'qa-dj600-shield',
  ];
  const hitsTotal = docs.length;
  const hitsOk = hitsTotal - 1; // 最后一个 dj9341 设未命中
  docs.forEach((d, i) => {
    const ts = `${day(10 + (i % 5))}T10:0${i % 6}:00.000Z`;
    const channel = ch[i % ch.length];
    const query = `查询 ${d} 相关参数`;
    lines.push(JSON.stringify({ type: 'question', ts, channel, query }));
    lines.push(
      JSON.stringify({
        type: 'search_hit',
        ts,
        query,
        docId: d,
        score: 0.8,
        provider: 'vertex',
        hit: i !== docs.length - 1, // 末条未命中
      }),
    );
    lines.push(JSON.stringify({ type: 'latency', ts, stage: 'agent-first-token', ms: 500, sessionId: `s${i}` }));
  });
  // 3 张工单：10-10 / 10-12 / 10-14 各 1
  [10, 12, 14].forEach((n, i) => {
    lines.push(
      JSON.stringify({
        type: 'ticket_created',
        ts: `${day(n)}T11:00:00.000Z`,
        ticketId: `t-${i}`,
        priority: 'high',
        escalated: false,
        channel: 'web',
      }),
    );
  });
  return lines.join('\n') + '\n';
}

async function main() {
  let failures = 0;
  const assert = (c: boolean, m: string) => {
    console.log(`${c ? '✅' : '❌'} ${m}`);
    if (!c) failures++;
  };

  const dir = mkdtempSync(join(tmpdir(), 'insights-'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, buildSample(), 'utf8');
  process.env.EVENTS_JSONL_PATH = file;
  // 确保不命中 BigQuery 路径
  delete process.env.BIGQUERY_PROJECT;

  const r = await getInsights();

  assert(r.source === 'local', `来源为本地 JSONL（实际 ${r.source}）`);
  assert(r.demo === true, '标注为演示数据');
  assert(r.totals.questions === 9, `提问总数=9（实际 ${r.totals.questions}）`);
  assert(r.totals.searchHits === 9, `检索次数=9（实际 ${r.totals.searchHits}）`);
  assert(r.totals.tickets === 3, `建单数=3（实际 ${r.totals.tickets}）`);
  assert(r.searchHitRate === Math.round(((9 - 1) / 9) * 100), `检索命中率=89%（实际 ${r.searchHitRate}%）`);
  assert(r.topDocs[0]?.docId === 'qa-dt900-intro' && r.topDocs[0]?.count === 5, `TOP1 知识点=DT900(5)（实际 ${JSON.stringify(r.topDocs[0])}）`);
  assert(r.topDocs[0]?.label === 'DT900 侦打一体机', `TOP1 标签中文映射正确（实际 ${r.topDocs[0]?.label}）`);
  const web = r.channelDistribution.find((c) => c.channel === 'web');
  assert(!!web && web.count >= 3, `渠道分布含 web（实际 ${web?.count}）`);
  assert(r.ticketTrend.length === 3, `工单趋势=3 天（实际 ${r.ticketTrend.length}）`);
  assert(r.questionTrend.length >= 5, `提问趋势覆盖多天（实际 ${r.questionTrend.length}）`);
  assert(r.topQueries.length > 0 && r.topQueries[0].count >= 1, '热门查询非空');

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
  process.exit(failures ? 2 : 0);
}

main().catch((e) => {
  console.error('[verify_insights] 异常：', e);
  process.exit(1);
});
