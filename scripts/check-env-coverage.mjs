#!/usr/bin/env node
/**
 * EmbedDesk · .env.example 覆盖率检查（全质量审计验收点⑤）
 *
 * 扫描后端代码中所有 `process.env.XXX` 引用（server/ + scripts/），
 * 对比 .env.example 的声明项，输出未声明变量并决定退出码。
 *   - 退出码 0：覆盖率 100%（无代码引用但未声明的变量）
 *   - 退出码 1：存在未声明变量
 *
 * 运行：node scripts/check-env-coverage.mjs
 * 说明：动态拼接形式的 process.env[`X_${y}`] 无法静态提取，按设计忽略；
 *       Node 运行时内建变量（NODE_ENV/PATH/HOME 等）列入白名单不计入。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BUILTINS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME',
  'SHELL', 'PWD', 'LANG', 'LC_ALL', 'OS', 'PATHEXT', 'COMSPEC', 'WINDIR',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'COMPUTERNAME', 'SESSIONNAME', 'CLIENTNAME',
]);

// 测试 / 内部变量：代码会读取，但属脚本运行参数或测试占位，不应进 .env.example 模板
const INTERNAL = new Set([
  'MOCK_PORT',   // mock-vertex.mjs 运行参数
  'MOCK_URL',    // mock-vertex.mjs 运行参数
  'XXX',         // 代码中的测试占位引用
  'CSA_DB_PATH', // 运行时 DB 路径，由启动脚本/部署注入，不放模板
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    if (e.startsWith('.')) continue; // 跳过 .workbuddy / .git 等隐藏目录
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of ['server', 'scripts']) walk(join(ROOT, d), files);

const refs = new Set();
const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(txt))) refs.add(m[1]);
}

const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const declared = new Set();
for (const line of envExample.split('\n')) {
  // 注释态声明（# KEY=...）视为已文档化的「可选/默认关闭」项，同样计入覆盖
  const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
  if (m) declared.add(m[1]);
}

const missing = [...refs]
  .filter((k) => !declared.has(k) && !BUILTINS.has(k) && !INTERNAL.has(k))
  .sort();

console.log(`扫描文件数: ${files.length}`);
console.log(`代码引用 env 变量: ${refs.size}`);
console.log(`.env.example 声明: ${declared.size}`);

if (missing.length === 0) {
  console.log('✅ 覆盖率 100%（无代码引用但未声明的变量）');
  process.exit(0);
} else {
  console.log('❌ 以下代码引用但未在 .env.example 声明:');
  for (const k of missing) console.log(`  - ${k}`);
  process.exit(1);
}
