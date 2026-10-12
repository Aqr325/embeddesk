/**
 * 轻量中文文本处理工具
 *
 * 不引入分词依赖，采用「字符二元组（bigram）+ 英文数字词」的混合切分策略。
 * 该方案对客服短文本的召回表现稳定，且零依赖、可离线运行。
 */

/** 全角转半角 + 去标点 + 小写化 */
export function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》…—~`!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 切分为检索单元：
 *  - 连续中文串 → 单字 + 相邻二元组
 *  - 英文/数字串 → 整词
 */
export function tokenize(text: string): string[] {
  const norm = normalize(text);
  const tokens: string[] = [];
  let cjkBuf = '';
  let latinBuf = '';

  const flushCjk = () => {
    if (!cjkBuf) return;
    for (let i = 0; i < cjkBuf.length; i++) {
      tokens.push(cjkBuf[i]);
      if (i < cjkBuf.length - 1) tokens.push(cjkBuf.slice(i, i + 2));
    }
    cjkBuf = '';
  };
  const flushLatin = () => {
    if (!latinBuf) return;
    tokens.push(latinBuf);
    latinBuf = '';
  };

  for (const ch of norm) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkBuf += ch;
    } else if (/[a-z0-9]/.test(ch)) {
      flushCjk();
      latinBuf += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return tokens;
}

/** Dice 系数相似度，取值 0~1 */
export function diceSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  setA.forEach((t) => {
    if (setB.has(t)) inter += 1;
  });
  return (2 * inter) / (setA.size + setB.size);
}

/** 关键词命中率：返回 [命中数 / 关键词总数, 命中的关键词列表] */
export function keywordHit(text: string, keywords: string[]): [number, string[]] {
  const norm = normalize(text);
  const hits = keywords.filter((k) => k && norm.includes(normalize(k)));
  return [keywords.length ? hits.length / keywords.length : 0, hits];
}

/** 是否包含任一关键词 */
export function containsAny(text: string, keywords: string[]): string[] {
  const norm = normalize(text);
  return keywords.filter((k) => norm.includes(normalize(k)));
}

/**
 * 将文本切分为检索单元集合（去重）。用于 FAQ 语料预计算：每个 FAQ 的
 * 问题/答案/关键词只需 tokenize 一次，热路径直接复用 Set，避免逐请求重复切分。
 */
export function tokenizeSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * 关键词命中率（基于已归一化字符串）：返回 [命中数 / 关键词总数, 命中关键词列表]。
 * 与 keywordHit 等价，但入参已是 normalize 后的字符串，供预计算语料热路径零重复归一化。
 */
export function keywordHitNorm(queryNorm: string, keywordNorms: string[]): [number, string[]] {
  if (!keywordNorms.length) return [0, []];
  const hits = keywordNorms.filter((k) => k && queryNorm.includes(k));
  return [hits.length / keywordNorms.length, hits];
}

/** Dice 系数相似度（基于已切分好的两个集合），取值 0~1。 */
export function diceSet(setA: Set<string>, setB: Set<string>): number {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  setA.forEach((t) => {
    if (setB.has(t)) inter += 1;
  });
  return (2 * inter) / (setA.size + setB.size);
}

/** 提取订单号：支持 SO/ORD 前缀或 8~20 位纯数字 */
export function extractOrderNo(text: string): string | null {
  const m =
    text.match(/\b(?:SO|ORD|DD|NO)[-_]?\d{6,18}\b/i) ||
    text.match(/\b\d{8,20}\b/);
  return m ? m[0].toUpperCase() : null;
}

/** 截断文本，保留可读性 */
export function truncate(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + '…' : text;
}
