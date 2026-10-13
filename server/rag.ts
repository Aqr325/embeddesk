/**
 * RAG 检索增强层（Retrieval-Augmented Generation）
 *
 * 在既有 lexical FAQ 检索（knowledge.retrieveFaqs）之上叠加三层增强：
 *   ① 同义词/口语扩展（IoT 领域词典）——提升召回（"耗电大"→"功耗/待机/电池"）；
 *   ② 可选语义向量检索（OpenAI 兼容 /embeddings）——与 lexical 走 RRF 倒数排名融合；
 *   ③ 轻量重排（同义词命中加成 + 精确问题命中加成）。
 *
 * 设计要点：
 *   - 默认纯 lexical+synonym（沙箱无外部 embedding 也可跑，零新依赖）；
 *   - 配置 RAG_EMBEDDING_URL + RAG_EMBEDDING_KEY 后自动启用语义检索，无需改业务代码；
 *   - 对外返回与 knowledge.FaqHit 完全兼容的结构，既有 buildKnowledgeContext /
 *     search_knowledge / 直答兜底全部无缝复用；
 *   - buildRagContext 产出带 [N] 引用标记的上下文块，注入 LLM 提示词即"增强生成"。
 */
import * as db from './db.js';
import { normalize } from './nlp.js';
import { retrieveFaqs, type FaqHit } from './knowledge.js';
import { retrieveVertex, vertexConfigured } from './vertexSearch.js';
import { logger } from './logger.js';

/* ============================ ① 同义词 / 口语扩展 ============================ */

// key（归一化后的口语/别名）→ 追加的标准术语。命中即把 targets 并入检索 query。
const SYNONYM_MAP: Record<string, string[]> = {
  耗电: ['功耗', '待机', '电池', '续航'],
  费电: ['功耗', '待机', '电池', '续航'],
  省电: ['功耗', 'psm', 'edrx', '待机'],
  电量: ['电池', '续航', '功耗'],
  连不上: ['连接失败', '网络', '注册', '掉线'],
  连不上网: ['连接失败', '网络', '注册', '掉线'],
  没网络: ['连接失败', '网络', '注册'],
  无网络: ['连接失败', '网络', '注册'],
  断线: ['掉线', '连接失败', '重连'],
  掉线: ['断线', '连接失败', '重连'],
  卡死: ['无响应', '宕机', '死机', '卡顿'],
  卡顿: ['无响应', '卡死', '性能'],
  开不了机: ['无法开机', '启动失败', 'boot'],
  开不了: ['无法开机', '启动失败'],
  资费: ['价格', '单价', '报价', '费用'],
  多少钱: ['价格', '单价', '报价'],
  报价: ['价格', '单价'],
  价位: ['价格', '单价', '报价'],
  选型: ['怎么选', '推荐', '系列', '对比'],
  怎么挑: ['怎么选', '推荐', '选型'],
  帧率: ['fps', '性能', '每秒帧数'],
  发热: ['温度', '散热', '过热'],
  认证: ['ce', 'fcc', 'srrc', 'ccc', '入网', '型号核准'],
  开票: ['发票', '专票', '增值税'],
  交期: ['货期', '到货', '排产', '交付'],
  起订: ['moq', '最小订货', '批量'],
  固件: ['firmware', 'ota', '升级'],
  开发环境: ['编译', 'sdk', 'docker', '工具链'],
  客制化: ['定制', '白标', '丝印', 'nre'],
};

export interface ExpandedQuery {
  /** 扩展后的检索 query（原 query + 追加同义词术语） */
  expanded: string;
  /** 本次扩展实际追加的术语 */
  added: string[];
  /** 是否发生了扩展 */
  changed: boolean;
}

export function expandQuery(query: string): ExpandedQuery {
  const nq = normalize(query);
  const added = new Set<string>();
  for (const [alias, targets] of Object.entries(SYNONYM_MAP)) {
    if (nq.includes(alias)) targets.forEach((t) => added.add(t));
  }
  const addedArr = [...added];
  const expanded = addedArr.length ? `${query} ${addedArr.join(' ')}` : query;
  return { expanded, added: addedArr, changed: addedArr.length > 0 };
}

/* ============================ ② 可选语义向量检索 ============================ */

interface FaqVec {
  id: string;
  vec: number[];
}

let faqEmbeddings: FaqVec[] | null = null;
let embeddingsPrimed = false;

/** 是否配置了语义 embedding 提供方（OpenAI 兼容 /embeddings 接口） */
export function embeddingConfigured(): boolean {
  return Boolean(process.env.RAG_EMBEDDING_URL && process.env.RAG_EMBEDDING_KEY);
}

async function embed(text: string): Promise<number[] | null> {
  const url = process.env.RAG_EMBEDDING_URL;
  const key = process.env.RAG_EMBEDDING_KEY;
  const model = process.env.RAG_EMBEDDING_MODEL || 'text-embedding-3-small';
  if (!url || !key) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: text, model }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const data = j?.data?.[0]?.embedding;
    return Array.isArray(data) ? (data as number[]) : null;
  } catch {
    return null;
  }
}

/** 惰性预计算 FAQ 向量（仅在配置 embedding 时触发，且只算一次） */
async function ensureFaqEmbeddings(): Promise<void> {
  if (!embeddingConfigured() || embeddingsPrimed) return;
  embeddingsPrimed = true; // 防重入；失败也不重试以免阻塞主链路
  try {
    const faqs = db.getAllFaqs(true);
    const vecs: FaqVec[] = [];
    for (const f of faqs) {
      const v = await embed(`${f.question} ${f.answer}`);
      if (v) vecs.push({ id: f.id, vec: v });
    }
    faqEmbeddings = vecs;
  } catch {
    faqEmbeddings = [];
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ============================ 可观测性 ============================ */

let ragRetrievals = 0;
let ragExpanded = 0;
let ragSemantic = 0;

export function getRagStats(): {
  enabled: boolean;
  provider: string;
  semantic: boolean;
  retrievals: number;
  expanded: number;
  semanticUsed: number;
} {
  return {
    enabled: true,
    provider: vertexConfigured() ? 'vertex' : 'lexical',
    semantic: embeddingConfigured(),
    retrievals: ragRetrievals,
    expanded: ragExpanded,
    semanticUsed: ragSemantic,
  };
}

/* ============================ ③ 主入口：混合检索 ============================ */

/**
 * RAG 检索：扩展 query → lexical 召回 →（可选）语义 RRF 融合 → 重排。
 * 返回与 knowledge.FaqHit 兼容的结构，可直接喂给 buildKnowledgeContext / buildRagContext。
 */
export async function retrieveRag(
  query: string,
  intent?: string | null,
  topK = 3,
  opts: { expand?: boolean } = {},
): Promise<FaqHit[]> {
  ragRetrievals++;
  const useExpand = opts.expand !== false;
  const { expanded, added, changed } = useExpand ? expandQuery(query) : { expanded: query, added: [], changed: false };
  if (changed) ragExpanded++;

  // Hack2skill（改装方案 §3/§10）：KNOWLEDGE_PROVIDER=vertex 时优先 Vertex AI Search；
  // 调用失败自动回退下方 lexical 通路（同签名降级，一行开关可整体切回）。
  if (vertexConfigured()) {
    try {
      const vertexHits = await retrieveVertex(expanded, (intent as any) || null, topK);
      return vertexHits; // vertex 为空视为权威「无匹配」，不叠加 lexical 噪声
    } catch {
      /* 已由 vertexSearch 记日志与错误计数，此处静默回退 lexical */
    }
  }

  // lexical 召回（用扩展后的 query，多取候选供融合/重排）
  const lexical = retrieveFaqs(expanded, (intent as any) || null, topK * 2);

  // 语义召回（可选）
  let semanticScores: { id: string; score: number }[] = [];
  if (embeddingConfigured()) {
    await ensureFaqEmbeddings();
    const qv = await embed(query);
    if (qv && faqEmbeddings && faqEmbeddings.length) {
      ragSemantic++;
      semanticScores = faqEmbeddings
        .map((f) => ({ id: f.id, score: cosine(qv, f.vec) }))
        .filter((s) => s.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 2);
    }
  }

  if (!semanticScores.length) {
    // 纯 lexical：对"同义词命中"的条目做轻微加成，提升召回相关性
    const synonymBoost = new Set(added.map(normalize));
    return lexical
      .map((h) => {
        const boost = synonymBoost.size && h.matchedKeywords.some((k) => synonymBoost.has(normalize(k))) ? 0.03 : 0;
        return { ...h, score: Math.round((h.score + boost) * 1000) / 1000 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // RRF（倒数排名融合）融合 lexical 与语义
  const RRF_K = 60;
  const map = new Map<string, { hit: FaqHit; s: number }>();
  const bump = (id: string, hit: FaqHit, s: number) => {
    const e = map.get(id) || { hit, s: 0 };
    e.s += s;
    map.set(id, e);
  };
  lexical.forEach((h, i) => bump(h.id, h, 1 / (RRF_K + i + 1)));
  const byId = new Map(db.getAllFaqs(true).map((f) => [f.id, f]));
  semanticScores.forEach((s, i) => {
    const f = byId.get(s.id);
    if (!f) return;
    const hit: FaqHit = {
      id: f.id,
      category: f.category,
      question: f.question,
      answer: f.answer,
      score: Math.round(s.score * 1000) / 1000,
      matchedKeywords: [],
    };
    bump(s.id, hit, 1 / (RRF_K + i + 1));
  });

  return [...map.values()]
    .sort((a, b) => b.s - a.s)
    .slice(0, topK)
    .map((e) => ({ ...e.hit, score: Math.round(e.s * 1000) / 1000 }));
}

/* ============================ 增强生成：引用上下文 ============================ */

/**
 * 将检索结果拼装为带 [N] 引用标记的上下文块，注入 LLM 提示词。
 * 相比 buildKnowledgeContext，增加了编号引用 + 关键词透出，便于模型在回答中标注出处。
 */
export function buildRagContext(hits: FaqHit[]): string {
  if (!hits.length) return '（本次检索未命中知识库条目）';
  return hits
    .map((h, i) => {
      const kw = h.matchedKeywords?.length ? `｜命中词 ${h.matchedKeywords.slice(0, 5).join('/')}` : '';
      return `【引用 ${i + 1}｜相关度 ${(h.score * 100).toFixed(0)}%｜类目 ${h.category}${kw}】\nQ: ${h.question}\nA: ${h.answer}`;
    })
    .join('\n\n');
}
