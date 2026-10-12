/**
 * FAQ 知识库检索引擎
 *
 * 检索策略（混合打分）：
 *   score = 0.45 × 关键词命中率
 *         + 0.35 × 问题文本 Dice 相似度
 *         + 0.12 × 答案文本 Dice 相似度
 *         + 0.08 × 意图类目匹配加成
 *
 * 采用混合打分而非纯向量检索的原因：客服 FAQ 条目规模有限（百级），
 * 关键词精确匹配的可控性优于稠密向量，且无需模型推理开销与外部依赖。
 */
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { normalize, tokenizeSet, keywordHitNorm, diceSet } from './nlp.js';
import type { IntentId } from './intent.js';

export interface FaqHit {
  id: string;
  category: string;
  question: string;
  answer: string;
  score: number;
  matchedKeywords: string[];
}

/** 命中阈值：低于该分数视为知识库未覆盖 */
export const HIT_THRESHOLD = 0.3;
/** 高置信直答阈值：达到该分数可直接引用标准答案 */
export const DIRECT_ANSWER_THRESHOLD = 0.62;

// FAQ 源数据内存缓存：知识库变更频率低，TTL 30s 即可显著降低每条请求的整表读取开销
let faqSourceCache: { at: number; rows: ReturnType<typeof db.getAllFaqs> } | null = null;
// 与源数据同步刷新的「预计算语料」：每个 FAQ 的关键词/问题/答案/标签均已在刷新时归一化 + 切分为 Set。
// 热路径直接复用，避免原先对「同一 query 重复 normalize ~72 次、tokenize ~36 次 / 请求」的纯浪费。
interface FaqCorpusItem {
  kwNorms: string[];
  qTokens: Set<string>;
  aTokens: Set<string>;
  tagNorms: string[];
}
let faqCorpusCache: { at: number; corpus: FaqCorpusItem[] } | null = null;
const FAQ_CACHE_TTL_MS = 30_000;

function getFaqSource(): ReturnType<typeof db.getAllFaqs> {
  const now = Date.now();
  if (faqSourceCache && now - faqSourceCache.at < FAQ_CACHE_TTL_MS) return faqSourceCache.rows;
  const rows = db.getAllFaqs(true);
  faqSourceCache = { at: now, rows };
  // 同步重建预计算语料（与源同 TTL，FAQ 变更 30s 内自然生效）
  faqCorpusCache = {
    at: now,
    corpus: rows.map((faq) => ({
      kwNorms: faq.keywords
        .split(',')
        .map((k) => normalize(k.trim()))
        .filter(Boolean),
      qTokens: tokenizeSet(faq.question),
      aTokens: tokenizeSet(faq.answer.slice(0, 120)),
      tagNorms: (faq.tags || '')
        .split(',')
        .map((t) => normalize(t.trim()))
        .filter(Boolean),
    })),
  };
  return rows;
}

// 检索结果 LRU：键 = 归一化 query + intent + topK。真实流量中大量重复 / 相似问题
// （如「怎么退款」「NB-IoT 和 Cat.1 怎么选」）命中后直接返回，跳过整轮打分，显著降低高并发 CPU。
const RETRIEVE_LRU_MAX = 5000;
const retrieveLru = new Map<string, FaqHit[]>();
function lruGet(key: string): FaqHit[] | undefined {
  const v = retrieveLru.get(key);
  if (v !== undefined) {
    retrieveLru.delete(key);
    retrieveLru.set(key, v); // 访问即置最新（Map 保持插入序）
  }
  return v;
}
function lruSet(key: string, val: FaqHit[]): void {
  if (retrieveLru.size >= RETRIEVE_LRU_MAX) {
    const oldest = retrieveLru.keys().next().value; // 淘汰最旧
    if (oldest !== undefined) retrieveLru.delete(oldest);
  }
  retrieveLru.set(key, val);
}

// LRU 缓存命中计数（供 /api/health 与 Prometheus 观测缓存收益）。计数器为 O(1) 自增，
// 不阻塞检索主链路；重启归零（缓存本身也随进程重启清空，语义一致）。
let kbLruHits = 0;
let kbLruMisses = 0;

/** 缓存观测快照：大小、累计命中/未命中、命中率（百分比，1 位小数） */
export function getKbCacheStats(): {
  lruSize: number;
  lruMax: number;
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = kbLruHits + kbLruMisses;
  return {
    lruSize: retrieveLru.size,
    lruMax: RETRIEVE_LRU_MAX,
    hits: kbLruHits,
    misses: kbLruMisses,
    hitRate: total ? Math.round((kbLruHits / total) * 1000) / 10 : 0,
  };
}

export function retrieveFaqs(query: string, intent?: IntentId | null, topK = 3): FaqHit[] {
  const lruKey = normalize(query) + ' ' + (intent || '') + ' ' + topK;
  const cached = lruGet(lruKey);
  if (cached) {
    kbLruHits++; // 缓存命中：直接返回，跳过整轮打分
    return cached;
  }
  kbLruMisses++; // 缓存未命中：需重新打分并回填

  const faqs = getFaqSource();
  if (!faqs.length) return [];
  const corpus = faqCorpusCache!.corpus;

  const qNorm = normalize(query); // 整条请求只归一化一次 query
  const qSet = tokenizeSet(query); // 整条请求只切分一次 query

  const scored = faqs.map((faq, i) => {
    const c = corpus[i];
    const [kwRate, matched] = keywordHitNorm(qNorm, c.kwNorms);
    const qSim = diceSet(qSet, c.qTokens);
    const aSim = diceSet(qSet, c.aTokens);
    const categoryBoost = intent && faq.category === intent ? 1 : 0;
    const [tagRate, tagMatched] = keywordHitNorm(qNorm, c.tagNorms);

    const score =
      0.45 * kwRate + 0.35 * qSim + 0.12 * aSim + 0.08 * categoryBoost + 0.06 * tagRate;

    return {
      id: faq.id,
      category: faq.category,
      question: faq.question,
      answer: faq.answer,
      score: Math.round(score * 1000) / 1000,
      matchedKeywords: matched.concat(tagMatched),
    };
  });

  const result = scored
    .filter((s) => s.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  lruSet(lruKey, result);
  return result;
}

/** 将检索结果拼装为注入 LLM 的上下文片段 */
export function buildKnowledgeContext(hits: FaqHit[]): string {
  if (!hits.length) return '（本次检索未命中知识库条目）';
  return hits
    .map(
      (h, i) =>
        `【知识条目 ${i + 1}｜相关度 ${(h.score * 100).toFixed(0)}%｜类目 ${h.category}】\nQ: ${h.question}\nA: ${h.answer}`
    )
    .join('\n\n');
}

/**
 * 「猜你想问」推荐：在用户问题未命中标准答案（或命中较弱）时，给出低阈值的相关 FAQ 候选。
 * 与 retrieveFaqs 的区别：使用更低的准入阈值（0.12），允许返回「相关但非精确」的条目，
 * 并排除已命中的 FAQ（excludeIds），避免与直答重复。前端在对话流中作为可点击的建议卡片展示。
 */
export function recommendFaqs(
  query: string,
  intent?: IntentId | null,
  topK = 3,
  excludeIds: string[] = [],
): FaqHit[] {
  const hits = retrieveFaqs(query, intent, topK + excludeIds.length);
  return hits
    .filter((h) => h.score >= 0.12 && !excludeIds.includes(h.id))
    .slice(0, topK);
}

/* ============================ 种子数据 ============================ */

interface SeedFaq {
  category: string;
  question: string;
  answer: string;
  keywords: string;
}

const SEED_FAQS: SeedFaq[] = [
  /* ---------- 模组选型 ---------- */
  {
    category: '模组选型',
    question: 'NB-IoT 和 Cat.1 怎么选？',
    answer:
      '看业务节拍与速率：① NB-IoT 适合低频上报、电池供电、深覆盖场景（智能表计、烟感、资产追踪），待机功耗低至微安级、资费按连接数计费；② Cat.1 bis 适合中速率、需 VoLTE 或偶发大文件（OTA 整包、POS、共享设备），成本比 Cat.4 低。两者都基于 LTE，覆盖好。选型时先算「上报频率 × 单包大小 × 功耗预算」。',
    keywords: 'NB-IoT,Cat.1,模组选型,怎么选,低功耗,广覆盖',
  },
  {
    category: '模组选型',
    question: '你们主推哪些蜂窝模组系列？',
    answer:
      '覆盖全制式：NB-IoT（BC95/BC35 系列）、Cat.1 bis（EC600/EC200 系列）、Cat.4（EC20/EC25 系列）、5G（RG/AG 系列）、以及带 NPU 的边缘 AI 模组（SG 系列）。Wi-Fi/蓝牙/BLE 也有对应模组。需要我按您的应用场景（速率/功耗/定位/AI）给一份选型矩阵吗？',
    keywords: '模组系列,产品系列,蜂窝模组,5G,Cat.4,选型矩阵',
  },
  {
    category: '模组选型',
    question: '模组支持 OpenCPU 二次开发吗？',
    answer:
      '部分模组支持 OpenCPU：可在模组内部 MCU 上直接跑轻量应用，省掉外部主控，降低 BOM 与功耗（适合简单数传/透传设备）。复杂逻辑仍建议外接 MCU。具体是否支持 OpenCPU 及可用 RAM/Flash 空间，取决于型号，选型时我可帮您确认。',
    keywords: 'OpenCPU,二次开发,内置,省主控,透传',
  },

  /* ---------- 端侧 AI 推理 ---------- */
  {
    category: '端侧AI推理',
    question: '哪款模组带 NPU，算力多少？',
    answer:
      '边缘 AI 模组 SG 系列带独立 NPU：SG885G 约 8 TOPS，SG200X 系列最高 26 TOPS，可本地跑检测/分类/OCR/语音。若只需轻量推理（如简单分类），也可在普通模组的 MCU 上用 CMSIS-NN 跑微型模型。需要多大算力取决于模型与帧率要求，我帮您估算。',
    keywords: 'NPU,算力,TOPS,边缘AI,AI模组,端侧推理',
  },
  {
    category: '端侧AI推理',
    question: '支持哪些模型框架和量化方式？',
    answer:
      '支持 PyTorch / TensorFlow / ONNX 导出的模型，经我们的转换工具做 INT8/INT4 量化后部署到 NPU；配套量化工具链（calibration + timeline）精度损失通常 < 1%。提供 detection / classification / OCR / 人脸识别等参考工程，可直接微调。',
    keywords: '量化,INT8,INT4,PyTorch,TensorFlow,模型部署,框架',
  },
  {
    category: '端侧AI推理',
    question: '端侧能跑多大的模型，典型帧率多少？',
    answer:
      '建议模型控制在 20MB 以内以适配片上内存（超出走外部 DDR，延迟略升）。典型参考：YOLOv8n INT8 在 8 TOPS NPU 上 30+ FPS；ResNet 类分类可达数百 FPS。具体帧率与输入分辨率强相关，给我模型名称和分辨率我可给实测参考。',
    keywords: '模型大小,帧率,FPS,YOLO,模型上限,性能',
  },

  /* ---------- 功耗续航 ---------- */
  {
    category: '功耗续航',
    question: '如何降低模组待机功耗？',
    answer:
      '三板斧：① 开启 PSM（省电模式），TAU 周期设长（如 12h）、Active Timer 设 0，待机可降到微安级；② 用 eDRX 在不连续接收时休眠；③ MCU 用低功耗核调度、主核深度睡眠，外设用事件唤醒。配合「采集→连网上报→立即休眠」节拍而非常连，续航可提升数倍。',
    keywords: '功耗,待机,PSM,eDRX,省电,待机电流',
  },
  {
    category: '功耗续航',
    question: '一节电池大概能用多久？',
    answer:
      '取决于业务节拍与电池容量：NB-IoT 表计类（8500mAh，每天上报 1-2 次）典型 5-10 年；Cat.1 追踪器（1000mAh，定位+上报 1 次/小时）约 30-45 天；常连数传场景按功耗预算反推。给我上报频率和电池容量，我帮您算理论续航。',
    keywords: '电池续航,能用多久,电池寿命,续航计算,低功耗',
  },

  /* ---------- 认证入网 ---------- */
  {
    category: '认证入网',
    question: '模组有哪些认证，整机出口要补什么？',
    answer:
      '模组已自带 CE / FCC / SRRC / CCC 等预认证报告。整机出口需补充：欧盟 CE-RED（RF/EMC/SAR）、北美 FCC（Part 15/22/24）、加拿大 ISED；国内销售需 SRRC 型号核准 + CCC。整机可沿用模组报告大幅缩短周期，只需补整机级测试项。',
    keywords: '认证,CE,FCC,SRRC,CCC,入网,出口,型号核准',
  },
  {
    category: '认证入网',
    question: '无线认证周期大概多久？',
    answer:
      '周期参考：CE-RED 约 3-4 周、FCC 约 2-3 周、SRRC 约 4-6 周（含样机测试与整改）。模组报告齐备时整机补测可压缩。建议量产前 2-3 个月启动认证，避免卡交期。我们可推荐合作实验室走加急通道。',
    keywords: '认证周期,多久,测试周期,认证时间,加急',
  },

  /* ---------- 开发工具链 ---------- */
  {
    category: '开发工具链',
    question: '编译/开发环境怎么搭建？',
    answer:
      '提供 Ubuntu 20.04 一键配置脚本和 Docker 镜像，避免宿主机依赖冲突，建议直接用容器开发。SDK 含交叉编译工具链、例程、AT 指令手册与调试工具。Windows 用户也能通过 WSL 或 Docker 跑通。需要我把环境镜像和 Quick Start 发您吗？',
    keywords: '编译环境,开发环境,Docker,SDK,工具链,搭建',
  },
  {
    category: '开发工具链',
    question: '固件 OTA 升级失败怎么排查？',
    answer:
      '常见三类：① 空间不足——保证 ≥1.5 倍新固件大小的 scratch 分区；② 中断——建议 A/B 双区 + 断点续传，避免断电断网；③ 签名校验失败——确认用我们发布的公钥。升级失败应自动回滚，不会变砖。把串口日志和版本号发 FAE 可快速定位。',
    keywords: 'OTA,升级失败,固件升级,差分,签名,A/B分区',
  },
  {
    category: '开发工具链',
    question: 'AT 指令集和示例在哪查？',
    answer:
      '每款模组都有配套 AT 指令手册（PDF）+ 示例集，涵盖网络注册、TCP/IP、MQTT、低功耗、GNSS 等。手册与 SDK 一同提供，也可在开发者社区按型号检索。需要哪款的 AT 手册，告诉我型号我直接发。',
    keywords: 'AT指令,指令集,示例,手册,AT命令',
  },

  /* ---------- 量产采购 ---------- */
  {
    category: '量产采购',
    question: '最小起订量和标准交期？',
    answer:
      '蜂窝模组 MOQ 通常 3000 片起，标准交期 6-8 周；常青型号有安全库存可缩短至 2-3 周。大客户可谈 VMI（供应商管理库存）平滑交付。具体交期以商务报价单为准，建议量产前锁定排产。',
    keywords: '起订量,MOQ,交期,最小订货,量产,排产',
  },
  {
    category: '量产采购',
    question: '含税单价大概多少？',
    answer:
      '随制式与封装不同：NB-IoT 约 15-30 元/片，Cat.1 bis 约 30-50 元/片，Cat.4 约 45-70 元/片，5G 与带 NPU 的 AI 模组更高。5000 片以上量级可下探，年度框架协议价更优。给我型号与数量我让商务出正式报价单。',
    keywords: '价格,单价,报价,多少钱,含税,批量价',
  },
  {
    category: '量产采购',
    question: '是否支持客制化与白标？',
    answer:
      '支持客制化（天线布局、固件预置、ATE 测试）、白标（丝印/外壳）与行业固件（如电表协议、车载协议）。客制化需评估 NRE 与起订量，量产阶段可免费烧录您的出厂配置。具体需求告诉我，商务+FAE 一起评估。',
    keywords: '客制化,白标,定制,丝印,行业固件,NRE',
  },

  /* ---------- 商务支持 ---------- */
  {
    category: '商务支持',
    question: '怎么开增值税专用发票？',
    answer:
      '提供开票资料（单位名称、税号、地址电话、开户行及账号），订单付款后财务 3 个工作日内开票寄出（运费到付）。5000 片以上建议签年度框架协议锁定价格与交期。需要我转商务对接或发协议模板吗？',
    keywords: '发票,专票,增值税,开票,报销,合同',
  },
  {
    category: '商务支持',
    question: '在线人工和 FAE 服务时间？',
    answer:
      '在线商务/客服：每日 09:00–21:00（含节假日）。FAE 技术专家：工作日 09:30–18:30，紧急客诉可升级加急响应。非服务时段可留言，工作日开工后 2 小时内回电。重大客户有专属客户经理与 7×24 应急通道。',
    keywords: '服务时间,FAE,人工,客服时间,支持,应急',
  },
];

/** 首次启动时写入种子知识库 */
export function seedKnowledgeBase(): number {
  if (db.faqCount() > 0) return 0;
  const now = new Date().toISOString();
  SEED_FAQS.forEach((f) => {
    db.upsertFaq({
      id: uuidv4(),
      category: f.category,
      question: f.question,
      answer: f.answer,
      keywords: f.keywords,
      enabled: 1,
      hit_count: 0,
      created_at: now,
      updated_at: now,
    });
  });
  return SEED_FAQS.length;
}
