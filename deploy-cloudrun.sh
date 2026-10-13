#!/usr/bin/env bash
# EmbedDesk · 一键部署到 Cloud Run（方案 §8 D3/D4 部署收口）
#
# 前置：
#   1) gcloud auth login
#   2) gcloud config set project <GCP_PROJECT>
#   3) 将 .env.example 复制为 .env 并填好 GCP 凭证相关变量（.env 已被 .gitignore 忽略，不会入库）
#
# 设计原则（与代码一致）：本地 mock 验证闭环，凭证就绪零改动切真。
#   - 代码按真实 GCP REST 契约写死；以下环境变量即「切真开关」。
#   - Cloud Run 使用默认服务账号身份调用 Gemini / Vertex / Firestore / BigQuery，
#     因此无需在镜像里打包 SA JSON（生产更安全的做法）。
#
# 用法：
#   bash deploy-cloudrun.sh            # 读 .env 部署
#   GCP_REGION=us-central1 bash deploy-cloudrun.sh

set -euo pipefail

# ---------- 读取 .env（若存在，被 .gitignore 忽略） ----------
if [[ -f .env ]]; then
  # 仅加载非注释、含 = 的行，且跳过可能含空格的值的复杂解析
  while IFS='=' read -r key value; do
    [[ -z "${key:-}" || "${key}" =~ ^[[:space:]]*# ]] && continue
    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"
    [[ -n "$key" ]] && export "$key=$value"
  done < .env
fi

PROJECT_ID="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE="${SERVICE_NAME:-embeddesk}"
IMAGE_REPO="${IMAGE_REPO:-${REGION}-docker.pkg.dev/${PROJECT_ID}/embeddesk/embeddesk}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "✗ 未设置 GCP_PROJECT，请先 gcloud config set project <ID> 或在 .env 中填写" >&2
  exit 1
fi

echo "▶ 项目：${PROJECT_ID}  区域：${REGION}  服务：${SERVICE}"

# ---------- 1) 构建并推送镜像 ----------
echo "▶ 构建镜像 ${IMAGE_REPO} ..."
gcloud builds submit --tag "${IMAGE_REPO}" .

# ---------- 2) 组装运行期环境变量（切真开关） ----------
# 说明：KNOWLEDGE_PROVIDER=vertex 启用 Vertex AI Search；DATA_PROVIDER=firestore 启用 Firestore 双写。
ENV_VARS="NODE_ENV=production"
ENV_VARS="${ENV_VARS},GCP_PROJECT=${PROJECT_ID}"
[[ -n "${GEMINI_MODEL:-}" ]]          && ENV_VARS="${ENV_VARS},GEMINI_MODEL=${GEMINI_MODEL}"
[[ -n "${GEMINI_TEMPERATURE:-}" ]]    && ENV_VARS="${ENV_VARS},GEMINI_TEMPERATURE=${GEMINI_TEMPERATURE}"
[[ -n "${GEMINI_LOCATION:-}" ]]       && ENV_VARS="${ENV_VARS},GEMINI_LOCATION=${GEMINI_LOCATION}"
[[ -n "${VERTEX_SEARCH_ENGINE_ID:-}" ]] && ENV_VARS="${ENV_VARS},VERTEX_SEARCH_ENGINE_ID=${VERTEX_SEARCH_ENGINE_ID},KNOWLEDGE_PROVIDER=vertex"
[[ -n "${VERTEX_SEARCH_LOCATION:-}" ]] && ENV_VARS="${ENV_VARS},VERTEX_SEARCH_LOCATION=${VERTEX_SEARCH_LOCATION}"
[[ -n "${DATA_PROVIDER:-}" ]]         && ENV_VARS="${ENV_VARS},DATA_PROVIDER=${DATA_PROVIDER}"
[[ -n "${FIRESTORE_PROJECT:-}" ]]     && ENV_VARS="${ENV_VARS},FIRESTORE_PROJECT=${FIRESTORE_PROJECT}"
[[ -n "${BIGQUERY_PROJECT:-}" ]]      && ENV_VARS="${ENV_VARS},BIGQUERY_PROJECT=${BIGQUERY_PROJECT}"
[[ -n "${BIGQUERY_DATASET:-}" ]]      && ENV_VARS="${ENV_VARS},BIGQUERY_DATASET=${BIGQUERY_DATASET}"
[[ -n "${BIGQUERY_TABLE:-}" ]]        && ENV_VARS="${ENV_VARS},BIGQUERY_TABLE=${BIGQUERY_TABLE}"
[[ -n "${BRAND_NAME:-}" ]]            && ENV_VARS="${ENV_VARS},BRAND_NAME=${BRAND_NAME}"

# ---------- 3) 部署到 Cloud Run ----------
echo "▶ 部署到 Cloud Run ..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE_REPO}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --port 8080 \
  --set-env-vars "${ENV_VARS}"

echo "✅ 部署完成："
gcloud run services describe "${SERVICE}" --region "${REGION}" --format 'value(status.url)'
