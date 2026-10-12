/**
 * 鉴权模块（零依赖，基于 Node crypto）
 *
 * 多用户/角色体系：管理员(admin)、主管(manager)、坐席(agent) 各自账号与口令，
 * 密码以 scrypt 加盐哈希存储于 users 表（格式 `<saltHex>$<scryptHex>`）。
 * 令牌：无状态 HMAC(SHA-256) 三段式（类 JWT），payload 携带 sub 与 role。
 * 首次启动若 users 表为空，使用 ADMIN_PASSWORD 环境变量（或随机口令）创建初始 admin。
 */
import crypto from 'crypto';
import { getUserByUsername, countUsers, createUser, type UserRole } from './db.js';

const DEFAULT_TTL = Number(process.env.ADMIN_TOKEN_TTL_SEC || 7 * 24 * 3600);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

function resolveSecret(): string {
  const fromEnv = process.env.ADMIN_TOKEN_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const ephemeral = crypto.randomBytes(32).toString('base64url');
  console.warn(
    '\n[Auth] 未设置 ADMIN_TOKEN_SECRET（或长度不足 16），已生成临时密钥。\n' +
      '        生产环境请通过环境变量设置固定强随机密钥（建议 32+ 位），否则服务重启后登录态将全部失效。\n',
  );
  return ephemeral;
}

export const SECRET = resolveSecret();

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 生成密码哈希（加盐 scrypt）。返回 `<saltHex>$<scryptHex>` */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 校验明文口令与存储哈希是否一致（抗时序） */
export function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf('$');
  if (sep <= 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  const attempt = crypto.scryptSync(password, salt, 64);
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

export function issueToken(username: string, role: UserRole): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: username, role, iat: now, exp: now + DEFAULT_TTL }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token?: string): { sub: string; role: UserRole } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return { sub: payload.sub, role: (payload.role as UserRole) ?? 'agent' };
  } catch {
    return null;
  }
}

function ensureSeedAdmin(): void {
  if (countUsers() > 0) return;
  const envPwd = process.env.ADMIN_PASSWORD;
  const useEnv = !!(envPwd && envPwd.length >= 6);
  const password = useEnv
    ? envPwd
    : crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  createUser({ username: ADMIN_USERNAME, display_name: '系统管理员', role: 'admin', password_hash: hashPassword(password) });
  if (!useEnv) {
    console.warn(
      '\n[Auth] 未设置 ADMIN_PASSWORD，已为初始管理员创建随机密码（请尽快登录后修改或固化环境变量）。\n' +
        `        用户名: ${ADMIN_USERNAME}\n        密码:   ${password}\n`,
    );
  }
}

export function verifyCredentials(username: string, password: string): boolean {
  const user = getUserByUsername(username);
  if (!user || user.status !== 'active') return false;
  return verifyPassword(password, user.password_hash);
}

/** Express 中间件：校验 Bearer 令牌，注入 req.user={sub,role}；保留 req.adminUser 兼容旧调用 */
export function requireAuth(req: any, res: any, next: any): void {
  const auth = req.headers.authorization;
  const token = auth && typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: '未授权，请先登录' });
    return;
  }
  req.user = user;
  req.adminUser = user.sub;
  next();
}

/** 角色校验中间件：仅允许指定角色访问，否则 403 */
export function requireRole(...roles: UserRole[]) {
  return (req: any, res: any, next: any): void => {
    const u = req.user as { sub: string; role: UserRole } | undefined;
    if (!u || !roles.includes(u.role)) {
      res.status(403).json({ error: '权限不足' });
      return;
    }
    next();
  };
}

// 启动时确保至少存在一个 admin 账户（幂等）
ensureSeedAdmin();
