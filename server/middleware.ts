/**
 * 通用中间件集合：集中错误处理、异步路由安全、基础安全响应头、/api 404。
 *
 * 设计约束（与项目既有风格一致）：
 *  - 零额外依赖，仅基于 Node 内置能力与 Express 现有类型实现；
 *  - 所有日志统一走 logger，禁止裸 console；
 *  - 错误响应不向客户端泄露内部实现细节（堆栈 / 绝对路径 / 依赖名）。
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from './logger.js';

/** 携带 HTTP 语义的受控异常：业务层可直接抛出，由 errorHandler 统一转换 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, message: string, code = 'ERR') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 包装异步路由处理器，将其 reject 可靠转发给 Express 错误中间件。
 * Express 4 默认不会捕获 async 处理器中的未决异常，缺失本封装会导致请求挂起或进程崩溃。
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * 基础安全响应头（零依赖实现，对标 helmet 核心子集）。
 * 不引入 CDN / 内联脚本，故可直接启用严格 CSP。
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // 生产构建为同源打包脚本 + Tailwind 提取样式；如后续接入外部 CDN，需放宽 script-src / style-src
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  );
  next();
}

/** 未知 /api/* 路由统一 404（非 /api 路径交由 SPA 回退处理，不受影响） */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api')) {
    next(new HttpError(404, '接口不存在或已移除'));
  } else {
    next();
  }
}

/**
 * 集中错误处理器（必须保留 4 个参数，Express 才将其识别为错误处理中间件）。
 * 仅当 next(err) 被调用时触发；对 400/404/413 等客户端错误给出友好文案，
 * 对 5xx 记录完整堆栈但仅向客户端返回中性提示。
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const reqId = (req as any).reqId || '-';
  const e = err as any;

  // 由错误类型推导最终状态码
  const statusCode: number = e instanceof HttpError
    ? e.statusCode
    : e?.statusCode ||
      (e?.type === 'entity.too.large'
        ? 413
        : e instanceof SyntaxError && (e as { body?: unknown }).body !== undefined
          ? 400
          : 500);

  const isServerError = statusCode >= 500;
  const message =
    statusCode === 400
      ? '请求体格式错误'
      : statusCode === 404
        ? '资源不存在'
        : statusCode === 413
          ? '请求体过大'
          : isServerError
            ? '服务内部错误，请稍后重试'
            : e?.message || '请求处理失败';

  if (isServerError) {
    logger.error(`[${statusCode}] ${req.method} ${req.originalUrl} id=${reqId} :: ${e?.stack || e?.message || err}`);
  } else {
    logger.warn(`[${statusCode}] ${req.method} ${req.originalUrl} id=${reqId} :: ${e?.message}`);
  }

  // 流式响应已开始（如 SSE）时无法再改写状态码，仅记录，由调用方自行断流
  if (res.headersSent) return;

  res.status(statusCode).json({ error: message, code: e?.code || 'ERR', reqId });
}
