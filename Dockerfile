# EmbedDesk · Cloud Run 部署镜像
# 构建方式（无需本地 Docker）：gcloud builds submit --tag gcr.io/PROJECT_ID/embeddesk
# 或一键部署：gcloud run deploy embeddesk --source . --region asia-east1 --allow-unauthenticated

FROM node:22-slim

# better-sqlite3 原生模块：优先使用预编译包；若下载失败则回退源码构建，需以下工具链
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖层单独拷贝（利用分层缓存）。保留 devDependencies：tsx 为服务端运行时所必需
COPY package.json package-lock.json ./
RUN npm ci

# 源码与构建配置
COPY tsconfig.json tsconfig.node.json tsconfig.server.json ./
COPY vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY seed ./seed

# 构建：tsc 类型检查 + vite 产物（dist/ 由 Express 直接托管，含 embed.js）
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# 健康检查端点 /api/health 由应用提供
CMD ["npm", "start"]
