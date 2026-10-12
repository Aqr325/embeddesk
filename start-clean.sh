#!/usr/bin/env bash
# 干净预览实例：全新端口 + 全新库名（遵循"干净测试铁律"，绝不复用历史端口/库）
set -e
cd "D:/workbuddy workspace/2026-08-01-19-43-13/smart-service-agent"
export PORT=3197
export API_TARGET_PORT=3197
export ADMIN_PASSWORD=preview123
export SEED_DEMO=1
export NODE_ENV=development
export CSA_DB_PATH="$PWD/data/preview_clean.db"
export ALLOWED_ORIGINS="http://localhost:5191,http://localhost:3197"
echo "[clean] backend :3197 (admin/preview123) + vite :5191  db=$CSA_DB_PATH"
exec npx concurrently -k -n SRV,CLI \
  "npx tsx server/index.ts" \
  "npx vite --port 5191 --host 0.0.0.0"
