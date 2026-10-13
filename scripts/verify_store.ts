/**
 * D4 store.ts 冒烟：Firestore 优先 + SQLite 兜底（mock 模式）
 *
 * 运行：
 *   FIRESTORE_BASE_URL=http://127.0.0.1:4599 FIRESTORE_PROJECT=mock-project \
 *   DATA_PROVIDER=firestore CSA_DB_PATH=data/verify_store.db \
 *   npx tsx scripts/verify_store.ts
 */
import { persistTicket, fetchTicket, getStoreStats } from '../server/store.js';
import * as db from '../server/db.js';

const MOCK = process.env.FIRESTORE_BASE_URL || 'http://127.0.0.1:4599';

async function firestoreStats() {
  try {
    const r = await fetch(`${MOCK}/__stats`);
    return (await r.json()) as any;
  } catch {
    return null;
  }
}

async function main() {
  let failures = 0;
  const assert = (cond: boolean, msg: string) => {
    console.log(`${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failures++;
  };

  // 预建会话（tickets.session_id 外键指向 sessions；id 带运行后缀保证重复执行幂等）
  const RUN = Date.now().toString(36);
  const SESSIONS = { fire: `s-fire-${RUN}`, sqlite: `s-sqlite-${RUN}`, plain: `s-plain-${RUN}` };
  for (const sid of Object.values(SESSIONS)) {
    db.createSession({ id: sid, title: `测试会话 ${sid}`, model: 'gemini:gemini-2.5-flash' });
  }

  // ---------- T1：Firestore 优先（mock 存活） ----------
  console.log('\n[T1] Firestore 优先路径（mock 在 4599 存活）');
  const before = await firestoreStats();
  const t1 = await persistTicket({
    id: `t-fire-${Date.now()}`,
    session_id: SESSIONS.fire,
    customer_name: '万总',
    intent: 'complaint',
    reason: '产品质量投诉',
    trigger_rule: 'AGENT_TOOL',
    priority: 'urgent',
    status: 'pending',
    channel: 'im',
  });
  const after = await firestoreStats();
  assert(t1 && t1.id.startsWith('t-fire-'), 'persistTicket 返回规范化工单对象');
  assert(after.fsWrites > before.fsWrites, `Firestore 写入计数上升（${before.fsWrites}→${after.fsWrites}）`);
  const fetched = await fetchTicket(t1.id);
  assert(fetched?.id === t1.id, 'fetchTicket 能从 Firestore 读回该工单');
  assert(db.getTicket(t1.id)?.id === t1.id, 'SQLite 兜底同样落库（双写）');

  // ---------- T2：Firestore 不可用 → 静默回退 SQLite ----------
  console.log('\n[T2] Firestore 不可达 → 回退 SQLite（指向关闭端口 4598）');
  const prevBase = process.env.FIRESTORE_BASE_URL;
  process.env.FIRESTORE_BASE_URL = 'http://127.0.0.1:4598'; // 无服务监听
  let threw = false;
  let t2;
  try {
    t2 = await persistTicket({
      id: `t-sqlite-${Date.now()}`,
      session_id: SESSIONS.sqlite,
      intent: 'other',
      reason: '回退测试',
      trigger_rule: 'AGENT_TOOL',
      priority: 'medium',
      status: 'pending',
    });
  } catch (e) {
    threw = true;
  }
  process.env.FIRESTORE_BASE_URL = prevBase;
  assert(!threw, 'Firestore 不可达时不抛错（静默回退）');
  assert(!!(t2 && db.getTicket(t2.id)?.id === t2.id), '回退后工单落 SQLite 可读');

  // ---------- T3：sqlite 模式直连 ----------
  console.log('\n[T3] DATA_PROVIDER=sqlite 直连');
  process.env.DATA_PROVIDER = 'sqlite';
  const t3 = await persistTicket({
    id: `t-plain-${Date.now()}`,
    session_id: SESSIONS.plain,
    reason: 'plain 模式',
    trigger_rule: 'AGENT_TOOL',
  });
  assert(!!(t3 && db.getTicket(t3.id)?.id === t3.id), 'sqlite 模式工单落库');

  console.log('\n[stats]', JSON.stringify(getStoreStats()));
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
  process.exit(failures ? 2 : 0);
}

main().catch((e) => {
  console.error('[verify_store] 异常：', e);
  process.exit(1);
});
