#!/usr/bin/env bash
# 全栈预览后端启动脚本（可提交版，不含任何明文密码）
#
# 安全约定：
#   - 本脚本零明文密钥。ADMIN_PASSWORD 按以下优先级解析：
#       1) 命令行参数  --admin-password <pw>
#       2) 环境变量    ADMIN_PASSWORD=... bash start-preview-fullstack.sh
#       3) .env.local（gitignore，优先）/ .env（gitignore）
#       4) 以上皆空 → 自动生成 12 位随机密码并写入 .env.local（便于登录，不打印明文）
#   - 项目根目录从脚本自身位置推导，无论仓库 clone 到何处均可直接运行。
#   - 真实 GCP 部署：删掉脚本里的 mock *_BASE_URL，设 AGENT_PROVIDER=gemini + 真实凭证即零改码点亮。
#
# 用法示例：
#   ADMIN_PASSWORD=yourpw bash start-preview-fullstack.sh
#   bash start-preview-fullstack.sh --admin-password yourpw --port 4321 --mock-port 4609
#   前置：先启动 mock GCP → MOCK_PORT=4609 node scripts/mock-vertex.mjs

set -uo pipefail

# 项目根目录：取脚本自身所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 解析命令行参数
PORT="${PORT:-4321}"
MOCK_PORT="${MOCK_PORT:-4609}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port)            PORT="$2"; shift 2;;
    --mock-port)       MOCK_PORT="$2"; shift 2;;
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

# === 全栈 mock GCP（本地预览：证明 Vertex / Firestore / BigQuery / DocAI 全亮）===
# 真实部署时删除下列 *_BASE_URL 并配置真实凭证即可零改码切换。
export AGENT_PROVIDER=tencent
export KNOWLEDGE_PROVIDER=vertex
export VERTEX_SEARCH_ENGINE_ID=local-engine
export VERTEX_SEARCH_LOCATION=global
export GCP_PROJECT=local
export VERTEX_SEARCH_BASE_URL="http://127.0.0.1:${MOCK_PORT}"
export DATA_PROVIDER=firestore
export FIRESTORE_PROJECT=local
export FIRESTORE_BASE_URL="http://127.0.0.1:${MOCK_PORT}"
export BIGQUERY_PROJECT=local
export BIGQUERY_DATASET=analytics
export BIGQUERY_TABLE=events
export BIGQUERY_BASE_URL="http://127.0.0.1:${MOCK_PORT}"
export DOCAI_BASE_URL="http://127.0.0.1:${MOCK_PORT}"

exec npx tsx server/index.ts
