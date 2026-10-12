/**
 * 结构化日志模块（零依赖，基于 Node 内置能力）
 *
 * - 控制台分级输出：INFO / WARN / ERROR / ACCESS
 * - 可选文件落盘：设置环境变量 LOG_FILE 指向文件路径即可开启（自动创建 logs 目录）
 * - access 用于访问审计：方法 / 路径 / 状态码 / 耗时 / 客户端 IP
 */
import fs from 'fs';
import path from 'path';

const LOG_FILE = process.env.LOG_FILE || '';

function ensureStream(): fs.WriteStream | null {
  if (!LOG_FILE) return null;
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch (e) {
    console.error('[Logger] 文件日志初始化失败，仅使用控制台输出:', (e as Error).message);
    return null;
  }
}

const stream = ensureStream();

function fmt(level: string, msg: string): string {
  return `${new Date().toISOString()} [${level.padEnd(6)}] ${msg}`;
}

function out(level: string, msg: string) {
  const line = fmt(level, msg);
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (stream) stream.write(line + '\n');
}

function join(m: string, rest: unknown[]): string {
  return rest.length ? `${m} ${rest.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}` : m;
}

export const logger = {
  info: (m: string, ...rest: unknown[]) => out('INFO', join(m, rest)),
  warn: (m: string, ...rest: unknown[]) => out('WARN', join(m, rest)),
  error: (m: string, ...rest: unknown[]) => out('ERROR', join(m, rest)),
  access: (m: string, ...rest: unknown[]) => out('ACCESS', join(m, rest)),
};
