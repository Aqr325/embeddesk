#!/usr/bin/env bash
# 预览专用后端启动脚本（可提交版，不含任何明文密码）
#
# 安全约定：
#   - 本脚本零明文密钥。ADMIN_PASSWORD 按以下优先级解析：
#       1) 命令行参数  --admin-password <pw>
#       2) 环境变量    ADMIN_PASSWORD=... bash start-preview-backend.sh
#       3) .env.local（gitignore，优先）/ .env（gitignore）
#       4) 以上皆空 → 自动生成 12 位随机密码并写入 .env.local（便于登录，不打印明文）
#   - 项目根目录从脚本自身位置推导，无论仓库 clone 到何处均可直接运行。
#   - 本地模式：无 GCP 凭证，Agent 内核与检索自动降级（知识库直答 / 本地词法检索）。
#
# 用法示例：
#   ADMIN_PASSWORD=yourpw bash start-preview-backend.sh
#   bash start-preview-backend.sh --admin-password yourpw --port 4321

set -uo pipefail

# 项目根目录：取脚本自身所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 解析命令行参数
PORT="${PORT:-4321}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port)            PORT="$2"; shift 2;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2;;
    --ingest-secret)   INGEST_SECRET="$2"; shift 2;;
    *) shift;;
  esac
done

# 无显式密码时，从本地密钥文件读取（.env.local / .env 均在 .gitignore，不会入库）
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
fi

# 仍为空 → 生成随机密码并落地 .env.local（幂等，不打印明文值）
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$(tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 12)"
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> .env.local
  echo "[preview] 未提供 ADMIN_PASSWORD，已生成随机密码并写入 .env.local（gitignore），请查阅该文件获取登录密码。"
fi

# === 基础服务配置（路径从脚本位置推导，兼容任意 clone 目录）===
export ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
export CSA_DB_PATH="${CSA_DB_PATH:-$SCRIPT_DIR/data/preview.db}"
export PORT="$PORT"
export ADMIN_PASSWORD="$ADMIN_PASSWORD"
export SEED_DEMO="${SEED_DEMO:-1}"
export INGEST_SECRET="${INGEST_SECRET:-sc}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:4521,http://127.0.0.1:4521}"
export NODE_ENV="${NODE_ENV:-development}"

exec npx tsx server/index.ts
