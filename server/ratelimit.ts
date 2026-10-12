/**
 * 内存滑动窗口限流器（零依赖）
 *
 * 用于保护高成本接口（如 /api/chat 的大模型调用），防止单 IP 刷量。
 * 按 key（默认客户端 IP）统计窗口内请求数，超限返回 429 + Retry-After。
 * 周期性清理过期计数，避免长期运行内存泄漏。
 */
interface LimiterOptions {
  windowMs: number;
  max: number;
  key?: (req: any) => string;
}

export function clientIp(req: any): string {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit(opts: LimiterOptions) {
  const { windowMs, max } = opts;
  const hits = new Map<string, number[]>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length === 0) hits.delete(k);
      else hits.set(k, fresh);
    }
  }, Math.max(10000, Math.floor(windowMs / 2)));
  if (sweep.unref) sweep.unref();

  return (req: any, res: any, next: any) => {
    const key = opts.key ? opts.key(req) : clientIp(req);
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      return;
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
