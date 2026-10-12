/**
 * 客户画像增强模块
 *
 * 职责边界：
 *  - deriveTier：根据历史接触频次与企业信息推导客户等级（new / regular / vip），
 *    供工单优先级加权与坐席差异化服务使用。
 *  - enrichProfile：将会话过程中的意图 / 情绪 / 知识库命中信号，滚动写入长期画像，
 *    保持「每次会话都为下次会话积累上下文」的闭环，且不破坏既有 upsert 的字段合并语义。
 *
 * 设计约束：本模块只依赖 db 与 intent，不触碰 LLM / 流式链路，因此可被实时管线与
 * 异步渠道（邮件 / IM）复用，且失败不影响主回复链路（调用方已做容错包裹）。
 */
import * as db from './db.js';
import { logger } from './logger.js';
import type { IntentId } from './intent.js';

export type CustomerTier = 'new' | 'regular' | 'vip';

export interface TierInput {
  sessionCount: number;
  /** 已登记企业名称 */
  hasCompany?: boolean;
  /** 已登记行业 */
  hasIndustry?: boolean;
}

/**
 * 推导客户等级。规则保持单调：接触越多、B 端属性越强，等级越高。
 *  - vip：深度接触（≥10 次）或「已登记企业/行业且接触 ≥5 次」的重点客户
 *  - regular：有一定接触（≥3 次）的普通客户
 *  - new：首次或浅接触客户
 */
export function deriveTier(input: TierInput): CustomerTier {
  const { sessionCount, hasCompany, hasIndustry } = input;
  const b2b = Boolean(hasCompany || hasIndustry);
  if (sessionCount >= 10) return 'vip';
  if (b2b && sessionCount >= 5) return 'vip';
  if (sessionCount >= 3) return 'regular';
  return 'new';
}

/**
 * 由文本推断情绪极性：
 *  -1 负面（命中负面词，如投诉/生气）
 *   0 中性
 *  （本客服场景暂不单独建模正面，中性已足够驱动滚动均值回归）
 */
export function sentimentDeltaOf(text: string): number {
  // isNegativeSentiment 已在 intent 模块定义，这里复用其语义，避免重复词表
  // 为避免循环依赖，直接本地判断（词表与 intent 保持一致）
  const negative = [
    '生气', '愤怒', '恶心', '烦', '差劲', '失望', '欺骗', '骗子', '垃圾', '投诉',
    '太慢', '没人管', '推诿', '踢皮球', '不解决', '再不', '警告', '曝光',
  ];
  const hit = negative.some((w) => text.includes(w));
  return hit ? -1 : 0;
}

export interface EnrichInput {
  customerId: string;
  intent?: IntentId | null;
  /** 本轮用户消息文本（用于情绪滚动） */
  message?: string;
  /** 本轮是否命中知识库（用于画像的「自助解决倾向」标记，可选） */
  kbHit?: boolean;
}

/**
 * 将会话信号写入长期画像：
 *  - last_intent / last_contact_at：最近意图与接触时间（坐席一眼看到客户在聊什么）
 *  - sentiment_score：以 0 为中心的滚动均值（历史权重 0.8、本轮 0.2），范围约 [-1, 1]
 *  - tier：依据最新 session_count 与企业信息重新推导（等级只升不降由调用方/业务决定，
 *    这里每次取实时推导值，保证与历史接触同步）
 * 失败（如 customerId 非法）时静默返回，绝不向上抛出，保证主链路稳定。
 */
export function enrichProfile(input: EnrichInput): void {
  try {
    if (!input.customerId) return;
    const existing = db.getCustomerProfile(input.customerId);
    const sessionCount = existing?.session_count ?? 0;
    const hasCompany = Boolean(existing?.company);
    const hasIndustry = Boolean(existing?.industry);

    const prev = existing?.sentiment_score ?? 0;
    const delta = sentimentDeltaOf(input.message ?? '');
    const sentiment = Math.max(-1, Math.min(1, prev * 0.8 + delta * 0.2));

    const tier = deriveTier({ sessionCount, hasCompany, hasIndustry });

    db.upsertCustomerProfile({
      customer_id: input.customerId,
      last_intent: input.intent ?? null,
      sentiment_score: Math.round(sentiment * 100) / 100,
      last_contact_at: new Date().toISOString(),
      tier,
    });
  } catch (e) {
    // 画像增强是「锦上添花」，任何异常都不应影响对话主链路
    logger.warn(`[profile] enrichProfile 失败: ${(e as Error)?.message || e}`);
  }
}
