/**
 * Google Cloud 鉴权共享层（Hack2skill 赛用）
 *
 * 被 server/geminiAgent.ts（Vertex AI Gemini）与 server/vertexSearch.ts（Vertex AI Search）共用。
 * 零依赖：原生 fetch + node:crypto 自签服务账号 JWT，不引入 @google-cloud/*。
 *
 * 三档鉴权（按优先级）：
 *   ① GEMINI_API_KEY —— API Key 模式（x-goog-api-key 头，本地/冒烟最省事）；
 *   ② GOOGLE_APPLICATION_CREDENTIALS —— 服务账号 JSON，自签 JWT 换 access token；
 *   ③ metadata server —— Cloud Run 默认服务账号（AGENT_PROVIDER=gemini 显式启用时尝试）。
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from './logger.js';

export type GoogleAuthMode = 'api-key' | 'sa' | 'metadata' | 'none';

export function googleAuthMode(): GoogleAuthMode {
  if (process.env.GEMINI_API_KEY) return 'api-key';
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && loadServiceAccount()) return 'sa';
  if (process.env.AGENT_PROVIDER === 'gemini') return 'metadata';
  return 'none';
}

/* ============================ 服务账号 JWT ============================ */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

let saCache: ServiceAccount | null | undefined;

function loadServiceAccount(): ServiceAccount | null {
  if (saCache !== undefined) return saCache;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) {
    saCache = null;
    return null;
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    saCache = j.client_email && j.private_key ? (j as ServiceAccount) : null;
  } catch (e: any) {
    logger.warn('[googleAuth] 读取服务账号密钥失败：', String(e?.message || e).slice(0, 120));
    saCache = null;
  }
  return saCache;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as any).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchSaToken(sa: ServiceAccount): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`SA token exchange failed: HTTP ${r.status}`);
  const j = (await r.json()) as any;
  if (!j.access_token) throw new Error('SA token exchange: no access_token');
  return j.access_token as string;
}

let tokenCache: { token: string; exp: number } | null = null;

/**
 * 取请求头（带缓存，提前 60s 刷新）。
 * none 档位直接抛错——调用方（geminiAgent / vertexSearch）负责降级。
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const mode = googleAuthMode();
  if (mode === 'api-key') return { 'x-goog-api-key': process.env.GEMINI_API_KEY as string };
  if (mode === 'none') throw new Error('GOOGLE_AUTH_NOT_CONFIGURED');
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 60000) return { Authorization: `Bearer ${tokenCache.token}` };
  let token: string;
  if (mode === 'sa') {
    token = await fetchSaToken(loadServiceAccount() as ServiceAccount);
  } else {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) throw new Error(`metadata token failed: HTTP ${r.status}`);
    const j = (await r.json()) as any;
    token = j.access_token;
  }
  tokenCache = { token, exp: now + 3300 * 1000 };
  return { Authorization: `Bearer ${token}` };
}
