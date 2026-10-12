#!/usr/bin/env bash
set -e
cd "D:/workbuddy workspace/2026-08-01-19-43-13/smart-service-agent"
# 全部 env 在脚本内 export，规避后台子进程剥离环境变量的问题
export PORT=3000
export ADMIN_PASSWORD=preview123
export SEED_DEMO=1
export NODE_ENV=development
export CSA_DB_PATH="$PWD/data/preview.db"
export ALLOWED_ORIGINS="http://localhost:5180,http://localhost:3000,http://localhost:5173"
echo "[preview] backend :3000 (admin/preview123) + vite :5180"
exec npx concurrently -k -n SRV,CLI \
  "npx tsx server/index.ts" \
  "npx vite --port 5180 --host 0.0.0.0"
