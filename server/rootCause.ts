/**
 * 工单根因聚类与洞察（Ticket Root-Cause Mining）
 *
 * 把散落的工单文本聚成「反复出现的根因」，直接回答管理层三个问题：
 *   ① 客户到底在为什么反复来找我们？（Top 根因排序）
 *   ② 是产品问题、说明不清，还是个别批次故障？（根因类型判定）
 *   ③ 该补知识库、该改产品说明，还是该排查批次？（可执行建议）
 *
 * 设计要点：
 *   - 纯确定性文本统计（不依赖 LLM）：同样的工单必然得到同样的根因排序，可现场复现；
 *   - 中文按 2-3 字滑窗取词 + 停用词过滤，避免依赖分词器（零新依赖）；
 *   - 根因分类用「信号词表」判定（温度/信号/电池 → 硬件批次；不会用/怎么/如何 → 说明缺失；
 *     退款/投诉/赔偿 → 服务流程），保证建议可执行；
 *   - 异常降级 source='empty'，看板类接口绝不因单点异常 500。
 */
import * as db from './db.js';

export type RootCauseKind = 'hardware_batch' | 'doc_gap' | 'service_flow' | 'other';

export interface RootCauseCluster {
  /** 根因关键词（如「干扰距离」「温度过高」） */
  keyword: string;
  /** 命中工单数 */
  count: number;
  /** 占已结工单比例（0-100） */
  ratio: number;
  kind: RootCauseKind;
  kindLabel: string;
  /** 命中的意图分布（Top 3） */
  intents: Array<{ intent: string; count: number }>;
  /** 样本文单（最多 3 条，含 id 与摘要，便于后台跳转核查） */
  samples: Array<{ id: string; summary: string; createdAt: string }>;
  /** 可执行建议 */
  suggestion: string;
  /** 是否已出现在知识盲区清单（= 已知未解决问题，优先级更高） */
  inGapList: boolean;
}

export interface RootCauseData {
  source: 'db' | 'empty';
  windowDays: number;
  totalTickets: number;
  resolvedTickets: number;
  clusters: RootCauseCluster[];
  /** 关键词共现对（如「干扰距离 + 使用方法」同时高频出现） */
  coOccurrences: Array<{ pair: [string, string]; count: number }>;
  summary: string;
  generatedAt: string;
}

/**
 * 领域词典（无人机反制 / IoT / 客服域）：优先整体命中并掩码，
 * 避免 2-3 字滑窗把「干扰距离」切碎成「干扰」「距离」之类无语义片段。
 * 这是确定性分词的最小实现——不引分词器，但比裸滑窗精度高一个量级。
 */
const DOMAIN_TERMS = [
  // 产品 / 技术
  '侦打一体', '干扰距离', '干扰范围', '反制系统', '反无人机', '无人机', '屏蔽器', '图传',
  '频段', '天线', '馈线', '电池', '电压', '温度过高', '温度', '充电', '续航', '链路',
  '离线', '固件', '校准', '调试', '参数设置', '安装部署', '验收', '培训',
  // 商务 / 服务
  '说明书', '质保', '售后', '退款', '退货', '投诉', '赔偿', '物流', '发货', '发票',
  '报价', '询价', '选型', '竞品对比', '授权', '资质', '投标', '解决方案', '使用方法',
  '不会用', '怎么用', '无法开机', '信号弱', '设备故障',
];
/** 按长度降序，保证最长匹配优先 */
const DOMAIN_TERMS_SORTED = [...DOMAIN_TERMS].sort((a, b) => b.length - a.length);

/**
 * 建单模板句：系统写入的固定话术（非客户原声），挖掘前先剔除。
 * 否则「端侧遥测异常自动建单」这类常量会成为最高频"根因"，完全误导结论。
 */
const BOILERPLATE = [
  '端侧遥测异常自动建单',
  '智能升级触发',
  '工作流规则命中',
  '客服转接人工',
  'Agent 工具建单',
];

/**
 * 中文停用词 / 通用套话（无区分度，剔除）。
 * 除常见客服用语外，还剔除「自动 / 建单 / 工单 / 遥测 / 异常」等流程性词汇——
 * 它们描述的是「系统做了什么」而非「客户遇到了什么」，作为根因关键词不具备可执行性。
 */
const STOPWORDS = new Set([
  '客户', '用户', '问题', '咨询', '询问', '反馈', '收到', '谢谢', '感谢', '您好', '你好',
  '设备', '产品', '进行', '相关', '一下', '这个', '那个', '我们', '他们', '可以', '需要',
  '什么', '怎么', '为什么', '是否', '能否', '情况', '影响', '使用', '购买', '咨询一下',
  // 流程/系统词汇（非客户视角根因）
  '自动', '建单', '工单', '系统', '平台', '生成', '处理', '提交', '记录', '消息', '回复',
  '内容', '服务', '客服', '数据', '信息', '异常', '遥测', '端侧', '触发', '规则', '智能',
  '升级', '通知', '创建', '新建', '更新', '状态', '时间', '当前', '已经', '没有', '一个',
]);

/** 根因信号词表：关键词命中即归类，决定后续建议走向 */
const KIND_SIGNALS: Array<{ kind: RootCauseKind; label: string; words: string[]; suggestion: string }> = [
  {
    kind: 'hardware_batch',
    label: '硬件/批次故障',
    words: ['温度', '电压', '信号', '离线', '故障', '损坏', '无法开机', '失灵', '电池', '天线', '馈线', '散熱', '散热'],
    suggestion: '疑似批次性硬件问题：汇总命中工单的设备序列号，比对生产批次并安排备件/返修',
  },
  {
    kind: 'doc_gap',
    label: '说明/知识缺失',
    words: ['不会用', '怎么用', '如何', '设置', '操作', '教程', '说明书', '校准', '调试', '参数'],
    suggestion: '客户看不懂现有说明：把该主题补成图文/视频知识库条目，并在产品手册加索引',
  },
  {
    kind: 'service_flow',
    label: '服务流程',
    words: ['退款', '退货', '投诉', '赔偿', '发票', '物流', '发货', '售后', '客服', '态度'],
    suggestion: '流程类诉求集中：检查售后响应时效与退换货政策宣导，必要时前置到下单页',
  },
];

/**
 * 从一段文本提取关键词候选（词典优先 + 滑窗补充）。
 * 词典命中的词会从原文中等长掩码，滑窗因此不会再把它们切碎。
 */
function extractKeywords(text: string): string[] {
  const found = new Set<string>();

  // ① 剔除建单模板句（固定话术不是根因）
  let masked = text;
  for (const bp of BOILERPLATE) masked = masked.split(bp).join('');

  // ② 领域词典最长匹配 + 等长掩码
  for (const term of DOMAIN_TERMS_SORTED) {
    if (!masked.includes(term)) continue;
    found.add(term);
    masked = masked.split(term).join('\u0000'.repeat(term.length));
  }

  // ③ 剩余文本滑窗取 2-3 字候选
  const cleaned = masked.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
  for (const seg of cleaned.split(/\s+/)) {
    if (!seg) continue;
    if (/^[A-Za-z0-9]+$/.test(seg)) {
      if (seg.length >= 2) found.add(seg.toUpperCase());
      continue;
    }
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const w = seg.slice(i, i + n);
        if (STOPWORDS.has(w)) continue;
        if (/^(.)\1+$/.test(w)) continue;
        found.add(w);
      }
    }
  }
  return [...found];
}

/**
 * 语料级子串去重：若候选 A 是另一候选 B 的子串、且 B 的频次不低于 A，则丢弃 A。
 * 例：「侧遥」（3 次）是「端侧遥测」（3 次）的子串 → 只保留更长、更有语义的后者。
 */
function dropSubsumed(counts: Map<string, number>): Map<string, number> {
  const keys = [...counts.keys()].sort((a, b) => b.length - a.length);
  const keep = new Map<string, number>();
  for (const k of keys) {
    const c = counts.get(k) ?? 0;
    let subsumed = false;
    for (const longer of keep.keys()) {
      if (longer.includes(k) && (keep.get(longer) ?? 0) >= c) {
        subsumed = true;
        break;
      }
    }
    if (!subsumed) keep.set(k, c);
  }
  return keep;
}

function classifyKind(keyword: string, allText: string): { kind: RootCauseKind; label: string; suggestion: string } {
  for (const sig of KIND_SIGNALS) {
    if (sig.words.some((w) => keyword.includes(w) || allText.includes(w))) {
      return { kind: sig.kind, label: sig.label, suggestion: sig.suggestion };
    }
  }
  return { kind: 'other', label: '其他/待归类', suggestion: '样本量不足或主题分散：先补充知识库覆盖，再观察是否形成趋势' };
}

/**
 * 工单根因挖掘：默认看全部工单，按窗口天数可收窄。
 */
export function getRootCauses(windowDays = 30, minCount = 2, topN = 8): RootCauseData {
  const generatedAt = new Date().toISOString();
  const empty: RootCauseData = {
    source: 'empty',
    windowDays,
    totalTickets: 0,
    resolvedTickets: 0,
    clusters: [],
    coOccurrences: [],
    summary: '暂无工单数据，无法挖掘根因',
    generatedAt,
  };
  try {
    const all = db.getTickets();
    const cutoff = Date.now() - windowDays * 86400000;
    const inWindow = all.filter((t) => {
      const ts = Date.parse(t.created_at || '');
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
    if (!inWindow.length) return empty;

    const resolved = inWindow.filter((t) => t.status === 'resolved' || t.status === 'closed');
    const base = resolved.length ? resolved : inWindow;

    // 关键词 → 命中工单
    const kwToTickets = new Map<string, Array<{ id: string; summary: string; createdAt: string; intent: string | null; text: string }>>();
    for (const t of base) {
      const text = `${t.reason || ''} ${t.summary || ''} ${t.note || ''}`;
      const kws = extractKeywords(text);
      for (const kw of kws) {
        const arr = kwToTickets.get(kw) || [];
        arr.push({ id: t.id, summary: t.reason || t.summary || '', createdAt: t.created_at, intent: t.intent, text });
        kwToTickets.set(kw, arr);
      }
    }

    // 关键词共现（同一张工单里共同出现的关键词对）
    const pairCount = new Map<string, number>();
    for (const t of base) {
      const kws = extractKeywords(`${t.reason || ''} ${t.summary || ''}`);
      const uniq = [...new Set(kws)].slice(0, 12); // 限制组合爆炸
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const key = [uniq[i], uniq[j]].sort().join('|');
          pairCount.set(key, (pairCount.get(key) || 0) + 1);
        }
      }
    }

    // 知识盲区关键词集合（用于标注「已知未解决」）
    let gapWords = new Set<string>();
    try {
      for (const g of db.getKnowledgeGaps('pending', 200)) {
        for (const w of extractKeywords(g.query)) gapWords.add(w);
      }
    } catch {
      /* 盲区表不存在时忽略 */
    }

    // 语料级子串去重：把「侧遥」这类被切碎的片段让位给更长、更有语义的「端侧遥测」
    const corpusCounts = new Map<string, number>();
    for (const [kw, hits] of kwToTickets) corpusCounts.set(kw, hits.length);
    const deduped = dropSubsumed(corpusCounts);

    const clusters: RootCauseCluster[] = [];
    for (const [keyword, hits] of kwToTickets) {
      if (hits.length < minCount) continue;
      // 被更长候选吸收的片段直接跳过（其频次已由更长词代表）
      if (!deduped.has(keyword)) continue;
      const intentCount = new Map<string, number>();
      for (const h of hits) {
        const k = h.intent || 'unknown';
        intentCount.set(k, (intentCount.get(k) || 0) + 1);
      }
      const { kind, label, suggestion } = classifyKind(keyword, hits.map((h) => h.text).join(' '));
      clusters.push({
        keyword,
        count: hits.length,
        ratio: Math.round((hits.length / base.length) * 1000) / 10,
        kind,
        kindLabel: label,
        intents: [...intentCount.entries()]
          .map(([intent, count]) => ({ intent, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3),
        samples: hits
          .slice()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, 3)
          .map((h) => ({ id: h.id, summary: h.summary.slice(0, 80), createdAt: h.createdAt })),
        suggestion,
        inGapList: gapWords.has(keyword),
      });
    }
    clusters.sort((a, b) => b.count - a.count || b.ratio - a.ratio);

    const coOccurrences = [...pairCount.entries()]
      .filter(([, c]) => c >= 2)
      .map(([key, count]) => ({ pair: key.split('|') as [string, string], count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const top = clusters.slice(0, topN);
    const summary = top.length
      ? `近 ${windowDays} 天 ${base.length} 张工单中，最高频根因是「${top[0].keyword}」（${top[0].count} 次，占 ${top[0].ratio}%），类型判定为${top[0].kindLabel}。`
      : `近 ${windowDays} 天 ${base.length} 张工单未形成重复性根因（最高频关键词不足 ${minCount} 次）。`;

    return {
      source: 'db',
      windowDays,
      totalTickets: inWindow.length,
      resolvedTickets: resolved.length,
      clusters: top,
      coOccurrences,
      summary,
      generatedAt,
    };
  } catch {
    return empty;
  }
}
