/**
 * 演示事件种子（Hack2skill 改装方案 §7 · D5 灌 2–3 周模拟基线）
 *
 * 生成 21 天模拟客服事件（question / search_hit / latency / ticket_created），
 * 写入本地 JSONL（EVENTS_JSONL_PATH，默认 data/analytics-events.jsonl）。
 * 管理后台「洞察」页据此展示 TOP 知识点 / 渠道分布 / 工单趋势等演示数据。
 *
 * 口径（与 §7 一致）：运营数据为演示数据，材料与页面均标注「演示数据」，绝不声称真实运营。
 * 真实部署时事件由线上流量经 events.ts 实时写入 BigQuery，无需本脚本。
 *
 * 运行：
 *   EVENTS_JSONL_PATH=data/analytics-events.jsonl npx tsx scripts/seed-demo-events.ts
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.EVENTS_JSONL_PATH || 'data/analytics-events.jsonl';
const DAYS = Number(process.env.SEED_DAYS || 21);
const PER_DAY = Number(process.env.SEED_PER_DAY || 18);

// 模拟产品咨询语料（与 data/products/catalog.json 真实产品对齐）
const QUERIES: Array<{ query: string; docId: string; channel: string }> = [
  { query: 'DT900 侦测打击一体机是什么产品', docId: 'qa-dt900-intro', channel: 'web' },
  { query: 'DJ9341 干扰枪的有效干扰距离是多少', docId: 'qa-dj9341-range', channel: 'embed' },
  { query: 'DJ9341 支持几个频段可以选配', docId: 'qa-dj9341-bands', channel: 'embed' },
  { query: 'DJ500 基站款反制设备有什么特点', docId: 'qa-dj500-base', channel: 'web' },
  { query: 'DJ600 反制盾适合什么场景用', docId: 'qa-dj600-shield', channel: 'im' },
  { query: 'SDJ800 查打一体设备的工作原理是什么', docId: 'qa-sdj800-principle', channel: 'web' },
  { query: '有没有手持式无人机探测器', docId: 'qa-bt2-detector', channel: 'embed' },
  { query: '有没有超大功率的反制枪', docId: 'qa-dj102-power', channel: 'email' },
  { query: 'DT900 有用户手册吗', docId: 'qa-dt900-manual', channel: 'web' },
  { query: '有没有射频干扰模块或者 PCBA 方案', docId: 'qa-pcba-modules', channel: 'im' },
  { query: '你们的反制设备用了什么专利技术', docId: 'qa-patents', channel: 'web' },
  { query: '机场监狱变电站这类场景用什么设备', docId: 'qa-scenario-selection', channel: 'embed' },
  { query: '考场手机信号屏蔽器有吗', docId: 'qa-exam-shield', channel: 'email' },
];
const CHANNELS = ['web', 'embed', 'im', 'email'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function isoOnDay(base: Date, dayIdx: number, hour: number, min: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() - (DAYS - 1 - dayIdx));
  d.setHours(hour, min, Math.floor(Math.random() * 60), 0);
  return d.toISOString();
}

function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const base = new Date();
  let total = 0;

  for (let day = 0; day < DAYS; day++) {
    const count = Math.round(PER_DAY * (0.6 + Math.random() * 0.8)); // 工作日波动
    for (let i = 0; i < count; i++) {
      const seed = pick(QUERIES);
      const channel = Math.random() < 0.5 ? seed.channel : pick(CHANNELS);
      const hh = 9 + Math.floor(Math.random() * 9); // 9:00–18:00
      const ts = isoOnDay(base, day, hh, Math.floor(Math.random() * 60));

      // 提问
      append('question', ts, {
        sessionId: `s-${day}-${i}`,
        channel,
        query: seed.query,
      });
      // 检索命中（绝大多数命中，少数未命中）
      const hit = Math.random() < 0.82;
      append('search_hit', ts, {
        query: seed.query,
        docId: seed.docId,
        score: hit ? 0.6 + Math.random() * 0.39 : 0.2 + Math.random() * 0.3,
        provider: 'vertex',
        hit,
      });
      // 时延样本
      append('latency', ts, {
        stage: 'agent-first-token',
        ms: 280 + Math.floor(Math.random() * 900),
        sessionId: `s-${day}-${i}`,
      });
      // 约 18% 转为建单
      if (Math.random() < 0.18) {
        append('ticket_created', ts, {
          ticketId: `t-${day}-${i}-${Math.floor(Math.random() * 9999)}`,
          priority: pick(PRIORITIES),
          escalated: Math.random() < 0.25,
          channel,
        });
      }
      total++;
    }
  }

  console.log(`✅ 已生成 ${total} 次会话事件（${DAYS} 天）→ ${OUT}`);
  console.log('   后续可在管理后台「洞察」页查看 TOP 知识点 / 渠道分布 / 工单趋势（标注：演示数据）。');
}

function append(type: string, ts: string, payload: Record<string, unknown>) {
  appendFileSync(OUT, JSON.stringify({ type, ts, ...payload }) + '\n', 'utf8');
}

main();
