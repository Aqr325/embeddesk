/**
 * Express 请求对象类型增强。
 *
 * requireAuth 中间件会向 req 注入 user / adminUser 字段（见 auth.ts）。
 * 由于中间件形参使用 `any`，TypeScript 默认 Request 上不存在这两个字段，
 * 故在此做全局声明增强，使各路由处理器可直接以类型安全方式访问 req.user。
 */
import type { UserRole } from './db.js';

declare global {
  namespace Express {
    interface Request {
      user?: { sub: string; role: UserRole };
      adminUser?: string;
      reqId?: string;
    }
  }
}

export {};
