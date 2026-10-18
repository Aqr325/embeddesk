/** 管理员鉴权状态管理 —— 基于 React Context 的单例，避免多个组件各自持有独立 state 导致登录态不同步。
 *  令牌存于 localStorage，自动处理过期与角色解析。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_BASE } from '../lib/apiBase';

const TOKEN_KEY = 'csa_admin_token';

interface TokenPayload {
  sub: string;
  role?: string;
  exp?: number;
  iat?: number;
}

function parseToken(token: string | null): TokenPayload | null {
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1])) as TokenPayload;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) return null;
    const p = parseToken(t);
    if (p?.exp && p.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

const KNOWN_ROLES = ['admin', 'manager', 'agent'];

/** 初始加载：返回可用 token。若 token 存在但缺少合法 role 字段（旧版残留），
 *  判定为无效并自动清除，强制用户重新登录以获取带角色的新令牌。 */
function loadInitialToken(): string | null {
  const t = readToken();
  if (!t) return null;
  const p = parseToken(t);
  if (!p || !p.role || !KNOWN_ROLES.includes(p.role)) {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
  return t;
}

interface AuthContextValue {
  token: string | null;
  role: string | null;
  username: string | null;
  isAuthed: boolean;
  hasRole: (...allowed: string[]) => boolean;
  login: (username: string, password: string) => Promise<{ token: string; role: string; expiresIn: number }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => loadInitialToken());
  const [role, setRole] = useState<string | null>(() => parseToken(loadInitialToken())?.role ?? null);
  const [username, setUsername] = useState<string | null>(() => parseToken(loadInitialToken())?.sub ?? null);

  const login = useCallback(async (usernameInput: string, password: string) => {
    const res = await fetch(API_BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password }),
    });
    if (!res.ok) {
      let msg = '用户名或密码错误';
      try {
        const e = await res.json();
        if (e?.error) msg = e.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    localStorage.setItem(TOKEN_KEY, data.token);
    setToken(data.token);
    setRole(data.role ?? 'agent');
    setUsername(parseToken(data.token)?.sub ?? null);
    return data;
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
    setRole(null);
    setUsername(null);
  }, []);

  // 监听 localStorage 变化（多标签页 / 其它入口改动了登录态），保证单例一致
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY) {
        const t = readToken();
        setToken(t);
        setRole(parseToken(t)?.role ?? null);
        setUsername(parseToken(t)?.sub ?? null);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const hasRole = useCallback((...allowed: string[]) => !!role && allowed.includes(role), [role]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, role, username, isAuthed: !!token, hasRole, login, logout }),
    [token, role, username, hasRole, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
