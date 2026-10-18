/**
 * 构建 Firebase Cloud Functions 部署包（esbuild 单文件 bundle）。
 *
 * 背景：服务端无独立编译产物（tsconfig.server.json 为 noEmit，生产靠 tsx 直跑 TS），
 * 而 Cloud Functions 运行时无法执行 TS——故用 esbuild 打单文件 CJS bundle。
 *
 * 产物：functions-bundle/index.cjs（package.json 的 main 指向它，firebase-tools 据此识别入口）
 *
 * 关键点：
 * 1. external 外置原生/运行时依赖（better-sqlite3 二进制、firebase-functions）——从 node_modules require
 * 2. define 把 import.meta.url 降维到 CJS（db.ts / index.ts / knowledge.ts 基于它推导 __dirname，
 *    推导结果 = functions-bundle/ 目录，故 ../data/products/catalog.json 与 ../dist 必须随包上传，
 *    见 .firebaseignore 的排除规则）
 * 3. server/functions-env.ts 无 import，bundle 后其副作用语句位于 require 链最前——
 *    CSA_DB_PATH=/tmp/embeddesk.db 在 db.ts 模块加载前生效（导入顺序铁律，勿调换）
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['server/functions.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'functions-bundle/index.cjs',
  external: ['better-sqlite3', 'firebase-functions', 'firebase-admin'],
  // CJS 无 import.meta：banner 在 bundle 顶部定义 __import_meta_url__（基于 __filename），
  // define 把所有 import.meta.url 替换为该标识符（db.ts/index.ts/knowledge.ts 据此推导 __dirname）
  banner: {
    js: 'const __import_meta_url__ = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__import_meta_url__',
  },
  logLevel: 'info',
  metafile: true,
});

if (result.errors.length > 0) {
  console.error('bundle 失败：', result.errors);
  process.exit(1);
}
console.log('✅ functions-bundle/index.cjs 构建完成（CJS，Node 20 运行时）');
