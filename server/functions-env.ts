/**
 * Firebase Cloud Functions 环境预置（副作用模块）。
 *
 * ⚠️ 本模块**严禁 import 任何东西**：db.ts 在模块加载时即读取 CSA_DB_PATH，
 * 必须保证本模块在 bundle 后的 require 链中最先执行（esbuild 按 import 顺序求值，
 * server/functions.ts 中本模块的 import 语句排在第一位）。
 *
 * 背景：函数容器文件系统只读（仅 /tmp 可写），本地默认的 data/chat.db 路径不可用；
 * Spark 免费计划冷启动会重建数据库并自动种子（SEED_DEMO 默认开），演示无感知。
 */
if (!process.env.CSA_DB_PATH) {
  process.env.CSA_DB_PATH = '/tmp/embeddesk.db';
}
if (!process.env.SEED_DEMO) {
  process.env.SEED_DEMO = '1';
}
