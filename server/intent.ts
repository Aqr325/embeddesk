/**
 * 意图识别引擎
 *
 * 采用「加权关键词 + 正则模式 + 上下文继承」的规则式分类器。
 * 相比纯 LLM 分类，规则式方案的优势：延迟 < 1ms、结果可解释、零调用成本；
 * 对于客服这类意图空间封闭（枚举可穷尽）的场景，准确率足够高。
 * LLM 在下游负责「答案生成」，而非「意图判定」，形成职责分离。
 */
import { normalize, containsAny, extractOrderNo } from './nlp.js';

export type IntentId =
  | 'refund'        // 退款 / 退货 / 退换
  | 'order_query'   // 查询订单 / 物流
  | 'tech_support'  // 技术支持 / 故障排查
  | 'complaint'     // 投诉 / 强烈不满
  | 'human_service' // 显式要求人工
  | 'greeting'      // 寒暄
  | 'other';        // 其它 / 兜底

export interface IntentMeta {
  id: IntentId;
  label: string;
  color: string;
  /** 是否为核心业务意图（管理后台重点统计） */
  core: boolean;
  description: string;
}

export const INTENT_META: Record<IntentId, IntentMeta> = {
  refund: { id: 'refund', label: '退款退货', color: '#e37318', core: true, description: '退款、退货、退换货、取消订单' },
  order_query: { id: 'order_query', label: '订单查询', color: '#0052d9', core: true, description: '订单状态、物流进度、发货时间' },
  tech_support: { id: 'tech_support', label: '技术支持', color: '#00a870', core: true, description: '产品故障、无法使用、报错排查' },
  complaint: { id: 'complaint', label: '投诉抱怨', color: '#d54941', core: false, description: '强烈不满、投诉、差评倾向' },
  human_service: { id: 'human_service', label: '转人工', color: '#8e56dd', core: false, description: '明确要求人工客服介入' },
  greeting: { id: 'greeting', label: '寒暄问候', color: '#8b8b8b', core: false, description: '打招呼、致谢、告别' },
  other: { id: 'other', label: '其它咨询', color: '#606060', core: false, description: '未匹配到明确业务意图' },
};

/** 关键词按权重分层：strong 为强特征，weak 为弱特征 */
interface IntentRule {
  strong: string[];
  weak: string[];
  patterns?: RegExp[];
}

const RULES: Record<Exclude<IntentId, 'other'>, IntentRule> = {
  refund: {
    strong: ['退款', '退货', '退钱', '退单', '退换', '申请退', '不想要了', '要求退', '七天无理由', '7天无理由', '仅退款'],
    weak: ['取消订单', '返回', '换货', '退', '钱没到账', '退回', '售后'],
    patterns: [/怎么(才能)?退/, /能不能退/, /可以退(款|货)?吗/, /多久(能)?到账/],
  },
  order_query: {
    strong: ['查订单', '查询订单', '订单状态', '物流', '快递', '发货', '什么时候到', '到哪了', '运单', '签收', '几天到'],
    weak: ['订单', '包裹', '单号', '配送', '派送', '发出', '寄出'],
    patterns: [/订单.*(在哪|到哪|状态|进度)/, /(我的)?(货|东西|包裹).*(到|发)/, /物流.*(信息|进度)/],
  },
  tech_support: {
    strong: ['用不了', '打不开', '连不上', '报错', '闪退', '故障', '死机', '无法使用', '不能用', '黑屏', '卡住', '崩溃', '激活失败', '登录不了', '登不上'],
    weak: ['怎么用', '设置', '配置', '安装', '升级', '固件', '驱动', '异常', 'bug', '问题', '教程', '说明书'],
    patterns: [/(为什么|为啥).*(不|无法)/, /(怎么|如何).*(设置|配置|连接|安装)/, /提示.*错误/],
  },
  complaint: {
    strong: ['投诉', '差评', '太差了', '垃圾', '骗人', '欺骗', '曝光', '消协', '315', '起诉', '维权', '气死', '很失望', '态度恶劣'],
    weak: ['不满意', '有问题吧', '搞什么', '离谱', '过分', '无语', '第几次了'],
    patterns: [/(已经|都).*(第\s*[二三四五六七八九十\d]+\s*次)/, /(什么|啥)(破|垃圾)/],
  },
  human_service: {
    strong: ['转人工', '人工客服', '人工服务', '找人工', '真人', '客服电话', '要人工', '接人工', '人工处理'],
    weak: ['有人吗', '在吗人工', '机器人听不懂', '找个人'],
    patterns: [/(转|接|要|叫).{0,3}(人工|真人|客服专员)/],
  },
  greeting: {
    strong: ['你好', '您好', '在吗', '谢谢', '感谢', '再见', '拜拜', '辛苦了', '哈喽', 'hello', 'hi'],
    weak: ['早上好', '晚上好', '打扰了', '麻烦了'],
  },
};

export interface IntentResult {
  intent: IntentId;
  label: string;
  confidence: number;
  matchedKeywords: string[];
  /** 次优意图，用于歧义提示 */
  runnerUp: { intent: IntentId; confidence: number } | null;
  orderNo: string | null;
  /** 全部意图得分，便于调试与后台展示 */
  scores: Array<{ intent: IntentId; score: number }>;
}

const STRONG_W = 3.0;
const WEAK_W = 1.0;
const PATTERN_W = 2.5;
const ORDER_NO_BONUS = 2.0;

/**
 * 识别用户意图
 * @param text 用户输入
 * @param previousIntent 上一轮意图（用于短回复的上下文继承，如「是的」「那个订单呢」）
 */
export function classifyIntent(text: string, previousIntent?: IntentId | null): IntentResult {
  const norm = normalize(text);
  const orderNo = extractOrderNo(text);
  const raw: Array<{ intent: IntentId; score: number; hits: string[] }> = [];

  (Object.keys(RULES) as Array<Exclude<IntentId, 'other'>>).forEach((intent) => {
    const rule = RULES[intent];
    const strongHits = containsAny(text, rule.strong);
    const weakHits = containsAny(text, rule.weak);
    let score = strongHits.length * STRONG_W + weakHits.length * WEAK_W;

    const patternHits: string[] = [];
    (rule.patterns ?? []).forEach((re) => {
      if (re.test(norm)) {
        score += PATTERN_W;
        patternHits.push(re.source);
      }
    });

    if (intent === 'order_query' && orderNo) score += ORDER_NO_BONUS;
    // 极短寒暄（≤6 字）额外加权，避免被业务词误吞
    if (intent === 'greeting' && norm.length <= 6 && strongHits.length) score += 1.5;

    raw.push({ intent, score, hits: [...strongHits, ...weakHits, ...patternHits] });
  });

  // 上下文继承：本轮无明显特征 + 输入很短 → 沿用上一轮意图（衰减）
  const maxScore = Math.max(...raw.map((r) => r.score));
  if (maxScore < 1.0 && previousIntent && previousIntent !== 'other' && norm.length <= 12) {
    const target = raw.find((r) => r.intent === previousIntent);
    if (target) target.score += 1.6;
  }

  raw.sort((a, b) => b.score - a.score);
  const top = raw[0];
  const second = raw[1];
  const total = raw.reduce((s, r) => s + r.score, 0);

  if (!top || top.score <= 0) {
    return {
      intent: 'other',
      label: INTENT_META.other.label,
      confidence: 0.2,
      matchedKeywords: [],
      runnerUp: null,
      orderNo,
      scores: raw.map((r) => ({ intent: r.intent, score: 0 })),
    };
  }

  // 置信度 = 占比 × 绝对强度饱和因子，抑制「弱命中却高置信」的假阳性
  const share = total > 0 ? top.score / total : 0;
  const saturation = Math.min(1, top.score / 5);
  const confidence = Math.round(Math.min(0.98, 0.35 * share + 0.65 * saturation * (0.5 + 0.5 * share)) * 100) / 100;

  return {
    intent: top.intent,
    label: INTENT_META[top.intent].label,
    confidence,
    matchedKeywords: Array.from(new Set(top.hits)).slice(0, 8),
    runnerUp:
      second && second.score > 0
        ? { intent: second.intent, confidence: Math.round((second.score / (total || 1)) * 100) / 100 }
        : null,
    orderNo,
    scores: raw.map((r) => ({ intent: r.intent, score: Math.round(r.score * 100) / 100 })),
  };
}

/** 判断是否为负面情绪表达（用于转人工升级判定） */
export function isNegativeSentiment(text: string): boolean {
  const negative = [
    '生气', '愤怒', '恶心', '烦', '差劲', '失望', '欺骗', '骗子', '垃圾', '投诉',
    '太慢', '没人管', '推诿', '踢皮球', '不解决', '再不', '警告', '曝光',
  ];
  return containsAny(text, negative).length > 0;
}

/**
 * 多意图提取：返回得分 > 0 的意图（按得分降序），最多 topN 条。
 * 用于：① 后台展示「一句话命中多个业务意图」；② 前端实时分析区展示次意图；
 * ③ 知识库推荐时作为意图补充信号。复用 classifyIntent 的打分结果，零额外成本。
 */
export function extractIntents(
  text: string,
  topN = 3,
  previousIntent?: IntentId | null,
): Array<{ intent: IntentId; score: number; label: string }> {
  const res = classifyIntent(text, previousIntent);
  return res.scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => ({ intent: s.intent, score: s.score, label: INTENT_META[s.intent].label }));
}

/**
 * 判断是否为闲聊 / 寒暄（非业务意图）。
 * 用于决定是否下发「猜你想问」推荐——对纯问候不应打扰用户。
 * 判定：意图为 greeting 且文本较短（≤12 字）、无业务强特征。
 */
export function isSmallTalk(text: string): boolean {
  const norm = normalize(text);
  const r = classifyIntent(text);
  if (r.intent !== 'greeting') return false;
  // 短寒暄才算闲聊；若夹杂业务关键词（如「你好，我要退款」）则视作业务咨询
  const businessHits = containsAny(text, [
    '退款', '退货', '订单', '物流', '快递', '发票', '模组', '配置', '故障', '报错', '投诉', '人工',
  ]);
  return norm.length <= 12 && !businessHits;
}
