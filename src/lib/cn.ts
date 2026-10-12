/**
 * cn —— 零依赖的 className 合并工具。
 * 过滤 falsy 值并展平数组，便于条件类名组合，避免引入 clsx 依赖。
 */
export type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
  };
  inputs.forEach(walk);
  return out.join(' ');
}
