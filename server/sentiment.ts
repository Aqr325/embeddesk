/**
 * 情感识别层（词库 + 否定处理，零外部依赖）。
 *
 * 设计目标：在「无大模型」环境下也能稳定产出客户情绪，使情感识别 + 智能升级
 * 在沙箱/降级场景可真实跑通；当 LLM 可用时，调用方可用 summarize 的结构化
 * sentiment 覆盖本层结果（见 escalation.ts 的合并策略）。
 *
 * 输出：sentiment（positive|neutral|negative|angry）、score（-1..1）、命中的
 * signals、以及是否触及法务/舆情/高危 risk 词（供升级引擎触发紧急升级）。
 */
import type { Sentiment } from './summarize.js';

export interface SentimentResult {
  /** 归一化情绪标签 */
  sentiment: Sentiment;
  /** -1（极负面/愤怒）.. +1（极正面） */
  score: number;
  /** 命中的情感/风险词（去重），便于前端展示触发原因 */
  signals: string[];
  /** 是否触及法务/舆情/高危风险词（如 起诉/消协/曝光） */
  risk: boolean;
}

// 愤怒 / 强烈不满：直接归为 angry
const ANGER_WORDS = [
  '气死', '愤怒', '生气', '恶心', '火大', '暴怒', '太差', '极差', '烂', '垃圾',
  '骗子', '欺诈', '虚假', '伪劣', '要投诉', '坑人', '坑爹', '后悔', '受够了',
  '忍无可忍', '垃圾产品', '态度恶劣', '敷衍', '推诿', '踢皮球', '没人管',
];

// 一般负面：归为 negative（与否定词组合可弱化为中性）
const NEGATIVE_WORDS = [
  '差', '慢', '烦', '失望', '不满', '不好', '不行', '没用', '退', '投诉', '贵',
  '难用', '卡', '崩溃', '死机', '坏了', '无法', '不能', '错误', 'bug', '问题',
  '解决不了', '亏', '恶劣',
];

// 正面：归为 positive
const POSITIVE_WORDS = [
  '满意', '感谢', '谢谢', '好', '棒', '不错', '解决', '快', '专业', '赞',
  '及时', '耐心', '贴心', '清晰',
];

// 法务 / 舆情 / 高危风险词：触发紧急升级
const RISK_WORDS = [
  '起诉', '律师', '消协', '12315', '315', '工商局', '媒体', '曝光', '维权',
  '法院', '仲裁', '报警', '监管', '黑猫', '12345', '纪委', '上访',
];

// 否定词：出现在负面/正面词前 2 字内时取反（"不差" -> 非负面；"不满意" -> 负面保留）
const NEGATION = ['不', '没', '没有', '未', '别', '勿', '并非', '不是', '毫无'];

function hitAny(text: string, words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) if (text.includes(w)) out.push(w);
  return out;
}

/** 词库情感分析（纯同步，无 IO，可高频调用） */
export function analyzeSentiment(text: string): SentimentResult {
  const t = (text || '').toString();
  if (!t.trim()) return { sentiment: 'neutral', score: 0, signals: [], risk: false };

  const riskHits = hitAny(t, RISK_WORDS);
  const angerHits = hitAny(t, ANGER_WORDS);

  let neg = 0;
  const negSignals: string[] = [];
  for (const w of NEGATIVE_WORDS) {
    if (t.includes(w)) {
      const idx = t.indexOf(w);
      const before = t.slice(Math.max(0, idx - 2), idx);
      const negated = NEGATION.some((n) => before.includes(n));
      if (!negated) {
        neg += 1;
        negSignals.push(w);
      }
    }
  }

  let pos = 0;
  const posSignals: string[] = [];
  for (const w of POSITIVE_WORDS) {
    if (t.includes(w)) {
      const idx = t.indexOf(w);
      const before = t.slice(Math.max(0, idx - 2), idx);
      const negated = NEGATION.some((n) => before.includes(n));
      if (!negated) {
        pos += 1;
        posSignals.push(w);
      }
    }
  }

  let sentiment: Sentiment = 'neutral';
  let score = 0;
  if (angerHits.length > 0) {
    sentiment = 'angry';
    score = -0.8 - 0.1 * angerHits.length;
  } else if (neg > 0 && neg >= pos) {
    sentiment = 'negative';
    score = -Math.min(1, 0.2 + 0.1 * neg);
  } else if (pos > 0 && pos > neg) {
    sentiment = 'positive';
    score = Math.min(1, 0.2 + 0.1 * pos);
  }

  const signals = [...new Set([...riskHits, ...angerHits, ...negSignals, ...posSignals])];
  return {
    sentiment,
    score: Number(score.toFixed(2)),
    signals,
    risk: riskHits.length > 0,
  };
}
