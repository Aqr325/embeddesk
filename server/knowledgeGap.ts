/**
 * 知识盲区自学习（企业知识助手 · Knowledge Gap）
 *
 * 当客户真实提问在知识库中「完全未命中」时，按归一化 query 聚类计数，沉淀为
 * 「待补充知识清单」，驱动运营侧闭环：
 *   发现盲区（recordGap）→ 后台清单（listGaps）→ 一键补全 FAQ（createFaqFromGap）→ 盲区消解。
 *
 * 设计要点：
 *   - 由 rag.ts 的 retrieveRag 在无命中时调用，客户链路（web/embed/im/email）全覆盖；
 *   - normalize(query) 作为聚合键，同一问题的多次未命中合并计数（miss_count）；
 *   - 过滤噪声：过短、纯寒暄不记录，避免清单被无意义输入污染；
 *   - 同步落库（better-sqlite3），与主链路同库保证一致性；失败仅告警不阻断问答。
 */
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { normalize } from './nlp.js';
import { classifyIntent } from './intent.js';
import { logger } from './logger.js';

/** 对外视图（驼峰命名，供 API 与前端直接消费） */
export interface KnowledgeGapView {
  id: string;
  query: string;
  intent: string | null;
  source: string | null;
  missCount: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  resolvedFaqId: string | null;
  sampleSession: string | null;
}

export interface KnowledgeGapStats {
  pending: number;
  resolved: number;
  dismissed: number;
}

/** 归一化 query 作为聚合键（去空格/标点/大小写），保证同一问题多次命中合并计数 */
function queryKey(query: string): string {
  return normalize(query);
}

/** 是否值得记录：过滤过短、纯寒暄等噪声，避免清单被无意义输入污染 */
function worthRecording(query: string): boolean {
  const key = queryKey(query);
  if (key.length < 2) return false;
  if (classifyIntent(query).intent === 'greeting') return false;
  return true;
}

/**
 * 记录一次知识库未命中（供 retrieveRag 无命中时调用）。同步落库、按 query 聚合计数。
 * @param query 原始用户提问
 * @param intent 已识别意图（可选，便于按业务域归类盲区）
 * @param source 来源渠道（chat/embed/email/im/tool），便于分辨盲区权重
 * @param sessionId 会话标识（可选，便于坐席回溯原始上下文）
 */
export function recordGap(
  query: string,
  intent?: string | null,
  source?: string | null,
  sessionId?: string | null,
): void {
  const q = (query || '').trim();
  if (!q || !worthRecording(q)) return;
  try {
    db.recordKnowledgeGap({
      query: q.slice(0, 300),
      queryKey: queryKey(q).slice(0, 300),
      intent: intent ?? null,
      source: source ?? null,
      sessionId: sessionId ?? null,
    });
  } catch (e) {
    logger.warn(`[knowledgeGap] 记录盲区失败: ${(e as Error).message}`);
  }
}

export function listGaps(status: db.KnowledgeGapStatus = 'pending', limit = 100): KnowledgeGapView[] {
  return db.getKnowledgeGaps(status, limit).map((g) => ({
    id: g.id,
    query: g.query,
    intent: g.intent,
    source: g.source,
    missCount: g.miss_count,
    firstSeen: g.first_seen,
    lastSeen: g.last_seen,
    status: g.status,
    resolvedFaqId: g.resolved_faq_id,
    sampleSession: g.sample_session,
  }));
}

export function gapStats(): KnowledgeGapStats {
  return {
    pending: db.countKnowledgeGaps('pending'),
    resolved: db.countKnowledgeGaps('resolved'),
    dismissed: db.countKnowledgeGaps('dismissed'),
  };
}

/** 标记盲区已解决（可关联到补全的 FAQ） */
export function resolveGap(id: string, faqId?: string | null): boolean {
  return db.resolveKnowledgeGap(id, faqId ?? null);
}

/** 忽略盲区（误报 / 无需补知识） */
export function dismissGap(id: string): boolean {
  return db.dismissKnowledgeGap(id);
}

/**
 * 一键从盲区创建 FAQ：以盲区问题为题目、运营填写答案，补全知识的同时把盲区标记为已解决。
 * 这是「企业知识助手」自进化闭环的终点：未命中问题 → 标准答案 → 下次即可命中。
 */
export function createFaqFromGap(gapId: string, answer: string, category?: string): db.DbFaq {
  const gap = db.getKnowledgeGapById(gapId);
  if (!gap) throw new Error('知识盲区不存在或已处理');
  const faq = db.upsertFaq({
    id: uuidv4(),
    category: category || '知识补全',
    question: gap.query,
    answer,
    keywords: gap.query,
    tags: 'knowledge-gap',
    enabled: 1,
  });
  db.resolveKnowledgeGap(gapId, faq.id);
  logger.info(`[knowledgeGap] 由盲区 ${gapId.slice(0, 8)} 一键补全 FAQ ${faq.id.slice(0, 8)}（问题：${gap.query.slice(0, 30)}）`);
  return faq;
}
