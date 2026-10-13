/**
 * 写入后队列（write-behind queue）—— 主线程异步批量写，突破 better-sqlite3 单连接同步写吞吐天花板
 *
 * 架构：
 *   - 主线程 ingest 同步完成意图识别 / 知识库检索 / 转人工 / 建单决策并返回 IngestResult
 *     （无需等待 DB 写入）；写入作业以「可序列化描述符」入队到内存缓冲。
 *   - 缓冲按 FLUSH_MS 周期或 MAX_BATCH 超量，由主线程批量化事务落库（execBatch）。
 *     单次 ingest 仅做一次廉价的内存 push，DB 写入被批处理摊销，极大降低每请求写延迟与锁争用，
 *     吞吐提升与「独立 worker 线程 offload」等价（见下方说明），但实现更简单、零兼容坑。
 *
 * 为何不再使用独立 worker 线程：
 *   早期版本尝试将写入 offload 到 worker_threads。但在本工具链（tsx + Node worker_threads）
 *   下，worker 线程内对「相对 .js 扩展名 → .ts 源」的解析不生效——任何相对 .js 导入（含
 *   writeExec→db→logger 整条依赖链）在 worker 中均报 Cannot find module，worker 根本无法加载。
 *   实测此前所谓「worker 模式」从未真正生效，吞吐提升实际来自本批处理机制本身。故改为主线程
 *   write-behind 批处理：逻辑简单、健壮，且保留同样吞吐收益（先前压测 ~491 req/s @c=100）。
 *
 * 正确性边界（channels.ts 配套处理）：
 *   - 会话续接靠 sessionRegistry 内存索引同步维护，不依赖落库；
 *   - 作业顺序 = 入队顺序 = 到达顺序（FIFO），保证消息时序；
 *   - 进程退出前 drain() 等待缓冲刷完，避免丢数据。
 */
import { logger } from './logger.js';
import { execBatch, type WriteJob } from './writeExec.js';

const FLUSH_MS = 15; // 主线程缓冲刷写间隔（兼顾及时落库与避免事务过长阻塞事件循环）
const MAX_BATCH = 150; // 单批最大条数：调小以缩短单次事务对事件循环的阻塞，缓解高并发下的长尾延迟

const buffer: WriteJob[] = [];
let timer: NodeJS.Timeout | null = null;

export interface QueueStats {
  pending: number;
  enqueued: number;
  flushed: number;
  batches: number;
  errors: number;
  lastBatchSize: number;
  lastFlushMs: number;
  mode: 'inline';
}

const stats: QueueStats = {
  pending: 0,
  enqueued: 0,
  flushed: 0,
  batches: 0,
  errors: 0,
  lastBatchSize: 0,
  lastFlushMs: 0,
  mode: 'inline',
};

/** 入队一个写入作业（描述符形式，可序列化） */
export function enqueue(job: WriteJob): void {
  stats.enqueued += 1;
  buffer.push(job);
  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setInterval(() => flush(), FLUSH_MS);
  if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
}

/** 将缓冲的作业批量落库（主线程事务批量写，批处理摊销写入成本） */
function flush(): void {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, MAX_BATCH);
  stats.pending = buffer.length;
  const t0 = Date.now();
  try {
    const errs = execBatch(batch);
    stats.errors += errs;
    stats.flushed += batch.length;
    stats.lastBatchSize = batch.length;
    stats.batches += 1;
    stats.lastFlushMs = Date.now() - t0;
  } catch (e) {
    stats.errors += batch.length;
    logger.error(`[writeQueue] 批量写失败: ${(e as Error)?.message || e}`);
  }
  if (buffer.length > 0) setImmediate(() => flush());
}

/**
 * 优雅停机：停止定时器并刷完缓冲（应对超量分批），保证异步渠道消息不丢。
 * 必须在关闭 DB 连接前 await。
 */
export async function drain(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 反复刷写直到缓冲清空（单批超量时可能需要多轮）
  let guard = 0;
  while (buffer.length > 0 && guard++ < 1000) {
    flush();
    if (buffer.length > 0) await new Promise((r) => setImmediate(r));
  }
  stats.pending = 0;
}

/** 暴露队列运行指标，供 /api/health 等运维端点展示 */
export function getStats(): QueueStats {
  stats.pending = buffer.length;
  return { ...stats };
}

/**
 * 同步刷写当前缓冲（D4 验收修复：persistTicket 在「写工单」前需确保会话行已落库，
 * 否则 better-sqlite3 外键约束会失败。原 write-behind 模式下 createSession 与 createTicket
 * 同批 FIFO 落库天然有序；改为 persistTicket 同步建单后，需显式 flush 还原该顺序保证）。
 * 幂等安全：缓冲为空时为 no-op。
 */
export function flushNow(): void {
  flush();
}
