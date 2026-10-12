/**
 * 写入作业执行逻辑（主线程 / 写入 worker 线程共用）
 *
 * 设计：写入作业以「可序列化的描述符（type + payload）」传递，而非函数 thunk，
 * 这样才能跨 worker_threads 用 postMessage 传输。本模块根据 type 派发到对应的 db 写函数。
 *
 * 关键：本模块通过 `import db from './db.js'` 拿到的是**当前线程**的数据库连接实例。
 *  - 在主线程（fallback 内联执行）时，使用主连接；
 *  - 在写入 worker 线程时，db.ts 会被重新实例化，得到 worker 自己的独立连接。
 * 二者指向同一 SQLite 文件（WAL 模式），实现「单写者 + 多读者」并发，写不阻塞读。
 */
import DatabaseInstance, * as db from './db.js';
import { enrichProfile } from './profile.js';

export type WriteJob =
  | { type: 'createSession'; payload: Parameters<typeof db.createSession>[0] }
  | { type: 'persistMessage'; payload: Parameters<typeof db.persistMessageNoTx>[0] }
  | { type: 'createIntentLog'; payload: Parameters<typeof db.createIntentLog>[0] }
  | { type: 'updateSession'; payload: { id: string; updates: Record<string, unknown> } }
  | { type: 'createTicket'; payload: Parameters<typeof db.createTicket>[0] }
  | { type: 'enrichProfile'; payload: { customerId: string; intent?: string | null; message?: string; kbHit?: boolean } }
  | { type: 'touchCustomerSession'; payload: { customerId: string; sessionId: string } };

/** 执行单条写入作业（异常由调用方批量循环捕获，不影响同批其他作业） */
export function execJob(job: WriteJob): void {
  switch (job.type) {
    case 'createSession':
      db.createSession(job.payload);
      break;
    case 'persistMessage':
      db.persistMessageNoTx(job.payload);
      break;
    case 'createIntentLog':
      db.createIntentLog(job.payload);
      break;
    case 'updateSession':
      db.updateSession(job.payload.id, job.payload.updates as never);
      break;
    case 'createTicket':
      db.createTicket(job.payload);
      break;
    case 'enrichProfile':
      enrichProfile({ customerId: job.payload.customerId, intent: job.payload.intent as never, message: job.payload.message, kbHit: job.payload.kbHit });
      break;
    case 'touchCustomerSession':
      db.touchCustomerSession(job.payload.customerId, job.payload.sessionId);
      break;
  }
}

/** 在一个事务内批量执行作业（作业已按到达顺序排队，保证消息时序）。返回本批失败条数。 */
export function execBatch(jobs: WriteJob[]): number {
  let errors = 0;
  const tx = DatabaseInstance.transaction((js: WriteJob[]) => {
    for (const j of js) {
      try {
        execJob(j);
      } catch (e) {
        // 单条失败不影响同批其他写入（事务仍正常提交已成功的语句）
        errors += 1;
      }
    }
  });
  tx(jobs);
  return errors;
}
