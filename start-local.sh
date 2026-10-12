#!/usr/bin/env bash
# 本地开发启动脚本
#
# ⚠️ 安全须知：本脚本「不再硬编码任何密钥」。请将管理员凭据写入本目录的
#    .env.local（已被 .gitignore 忽略，不会进入版本库）：
#       ADMIN_PASSWORD=你的强密码
#       ADMIN_TOKEN_SECRET=$(openssl rand -hex 32)   # 32+ 位强随机串，令牌签名密钥
#       ADMIN_USERNAME=admin                         # 可选，默认 admin
# 若未提供，服务端会随机生成（重启后登录态失效），仅适合临时本地试用。
#
# 用法：bash start-local.sh   （在项目根目录执行）
cd "$(dirname "$0")"

# 读取本地私有环境变量（若存在且未被 git 跟踪）
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

export AGENT_MODE=local            # 跳过 SDK 鉴权探测，沙箱/本地可稳定运行
export BRAND_NAME=中科佳晨
export PORT=3000

exec npx tsx server/index.ts
