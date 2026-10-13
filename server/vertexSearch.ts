/**
 * Vertex AI Search 检索层（Discovery Engine · Hack2skill 赛用）
 *
 * 背景（AI-Builder-Cup 改装方案 §3/§4 契约2）：知识检索从 SQLite lexical RAG 升级为
 * Vertex AI Search（企业知识语义检索），但对外保持 retrieveRag 同签名
 * `retrieveVertex(query, intent, topK) → FaqHit[]`，由 rag.ts 按
 * KNOWLEDGE_PROVIDER=vertex|lexical 路由；vertex 失败自动回退 lexical（方案 §10）。
 *
 * 数据形态：结构化 JSON 文档直灌 data store（scripts/ingest-products.mjs 负责入库），
 * 每篇文档 structData 至少含 { id, category, question, answer, keywords }。
 * 零依赖：原生 fetch + googleAuth 三档鉴权。
 */
import { logger } from './logger.js';
import type { FaqHit } from './knowledge.js';
import { authHeaders } from './googleAuth.js';

/** 检索开关：KNOWLEDGE_PROVIDER=vertex 且配置了 engine id 才启用 */
export function vertexConfigured(): boolean {
  return (
    (process.env.KNOWLEDGE_PROVIDER || 'lexical').toLowerCase() === 'vertex' &&
    Boolean((process.env.VERTEX_SEARCH_ENGINE_ID || '').trim())
  );
}

function searchUrl(): string {
  const override = process.env.VERTEX_SEARCH_BASE_URL;
  if (override) return `${override.replace(/\/+$/, '')}/projects/${process.env.GCP_PROJECT || 'local'}/locations/${process.env.VERTEX_SEARCH_LOCATION || 'global'}/collections/default_collection/engines/${process.env.VERTEX_SEARCH_ENGINE_ID}/servingConfigs/default:search`;
  const project = process.env.GCP_PROJECT;
  const loc = process.env.VERTEX_SEARCH_LOCATION || 'global';
  const engine = process.env.VERTEX_SEARCH_ENGINE_ID;
  return `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/${loc}/collections/default_collection/engines/${engine}/servingConfigs/default:search`;
}

/* ============================ 可观测性 ============================ */

let vertexCalls = 0;
let vertexErrors = 0;

export function getVertexStats(): { configured: boolean; calls: number; errors: number } {
  return { configured: vertexConfigured(), calls: vertexCalls, errors: vertexErrors };
}

/* ============================ 主入口 ============================ */

/**
 * Vertex AI Search 检索（与 retrieveRag 同签名）。
 * query 应为已扩展的检索式（同义词扩展由 rag.ts 负责，避免双重扩展）。
 * 结果按召回序合成 score（Discovery Engine 不暴露逐条相关度，取 1 - rank*0.05），
 * 保证下游 HIT_THRESHOLD / 重排逻辑行为一致。
 */
export async function retrieveVertex(query: string, intent?: string | null, topK = 3): Promise<FaqHit[]> {
  if (!vertexConfigured()) return [];
  vertexCalls++;
  try {
    const headers = await authHeaders();
    const resp = await fetch(searchUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        query,
        pageSize: Math.max(topK * 3, 10),
        spellCorrectionSpec: { mode: 'AUTO' },
        contentSearchSpec: { snippetSpec: { returnSnippet: true } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      vertexErrors++;
      throw new Error(`VERTEX_HTTP_${resp.status}`);
    }
    const j = (await resp.json()) as any;
    const results: any[] = Array.isArray(j?.results) ? j.results : [];
    const hits: FaqHit[] = [];
    results.forEach((r, i) => {
      const s = r?.document?.structData || r?.document?.derivedStructData || {};
      const question = String(s.question ?? s.title ?? s.query ?? '').trim();
      const answer = String(s.answer ?? s.content ?? s.snippet ?? '').trim();
      if (!question || !answer) return;
      hits.push({
        id: String(s.id ?? r?.document?.id ?? `vertex-${i}`),
        category: String(s.category ?? s.intent ?? intent ?? 'product'),
        question,
        answer,
        score: Math.round(Math.max(0.05, 1 - i * 0.05) * 1000) / 1000,
        matchedKeywords: Array.isArray(s.keywords)
          ? s.keywords.map(String)
          : typeof s.keywords === 'string'
            ? s.keywords.split(/[,，;；\s]+/).filter(Boolean)
            : [],
      });
    });
    logger.info(`[vertexSearch] query="${query.slice(0, 40)}" → ${hits.length} 条（topK=${topK}）`);
    return hits.slice(0, topK);
  } catch (e: any) {
    vertexErrors++;
    logger.warn('[vertexSearch] 检索失败（将由 rag.ts 回退 lexical）：', String(e?.message || e).slice(0, 140));
    throw e;
  }
}
