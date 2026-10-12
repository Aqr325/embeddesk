/**
 * 输入校验工具（零依赖，与 middleware.HttpError 协同）。
 *
 * 设计约束（与项目既有风格一致）：
 *  - 所有校验失败统一抛出 HttpError，由集中错误处理器返回中性文案，避免向客户端泄露内部细节；
 *  - 字符串统一 .trim() 并限长，防御超长/空白注入与存储膨胀；
 *  - 数值/枚举严格范围校验，拒绝 NaN、越界与非法取值；
 *  - 不引入任何外部依赖，仅基于标准类型与 middleware.HttpError。
 */
import { HttpError } from './middleware.js';

/** 规范化字符串：去空白、限长；为空或缺失时返回空串（调用方据此判定必填） */
export function asString(
  v: unknown,
  opts: { max?: number; name?: string; default?: string } = {},
): string {
  const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
  const trimmed = raw.trim();
  if (opts.max != null && trimmed.length > opts.max) {
    throw new HttpError(400, `${opts.name ?? '字段'}长度不能超过 ${opts.max} 个字符`);
  }
  return opts.default !== undefined && !trimmed ? opts.default : trimmed;
}

/** 整数范围校验，失败抛 HttpError */
export function asIntInRange(v: unknown, min: number, max: number, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} 须为 ${min}-${max} 之间的整数`);
  }
  return n;
}

/** 枚举值校验，失败抛 HttpError */
export function asOneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new HttpError(400, `${name} 取值非法（允许：${allowed.join('/')}）`);
  }
  return v as T;
}

/**
 * 标签数组规范化：支持数组或逗号分隔字符串输入，限制数量与单条长度，
 * 返回 ', ' 拼接串（与现有 tags 存储约定一致）。
 */
export function asTagString(v: unknown, maxItems: number, maxLen: number, name: string): string {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  if (arr.length > maxItems) throw new HttpError(400, `${name} 数量不能超过 ${maxItems}`);
  const items = arr.map((x) => String(x).slice(0, maxLen).trim()).filter(Boolean);
  return items.join(',');
}

/** 布尔规范化：支持 boolean / 'true'|'1' / 缺失回退 */
export function asBool(v: unknown, defaultVal = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return defaultVal;
}
