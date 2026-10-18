# DEPLOY_HYBRID.md — 零绑卡部署：Firebase Hosting（前端）+ Render（API）

> **适用场景**：Firebase Blaze 升级被「$30 一次性预付款」风控挡住（Google 对中国大陆访问者的区域策略，换任何卡都触发）。
> **成本**：$0 —— Firebase Spark 的 Hosting 永久免费（10GB 存储 / 360MB·天带宽），Render 免费层 750 小时/月，均无需信用卡。
> **结果**：原型链接为 `https://embeddesk.web.app`（Google 域名），API 跑在 Render（同仓库 Dockerfile 零改动）。
> **耗时**：约 25 分钟（Firebase Hosting 5 分钟 + Render 15 分钟 + 验收 5 分钟）。

---

## 方案原理

| 层 | 平台 | 免费额度 | 卡 |
|---|---|---|---|
| 前端 SPA + embed.js | **Firebase Hosting**（Spark） | 10GB 存储、360MB/天出站 | ❌ 不需要 |
| API（Express + SQLite + 知识库） | **Render** Web Service（Docker） | 750 实例·小时/月 | ❌ 不需要 |
| 数据 | SQLite 文件（Render 磁盘） | 1GB 免费磁盘 | — |

前端通过构建期注入的 `VITE_API_BASE` 把全部 `/api` 请求指向 Render；CORS 白名单由 `ALLOWED_ORIGINS` 放行 `https://embeddesk.web.app`。widget（embed.js）经 `window.EMBEDDESK_API_SERVER` 同理。

> Spark 项目可以正常 `firebase deploy --only hosting`——Hosting 不在 Blaze 门槛内，**只有 Cloud Functions 需要 Blaze**。

---

## 第 1 步：部署 API 到 Render（约 15 分钟）

1. 打开 https://render.com/ ，点 **Get Started** → 用 **GitHub 账号**登录（授权 Aqr325/embeddesk 仓库访问）
2. 右上角 **New + → Web Service** → 选 **embeddesk** 仓库 → **Connect**
3. 配置页填写：

| 字段 | 值 |
|---|---|
| Name | `embeddesk-api`（决定 URL：`embeddesk-api.onrender.com`） |
| Region | Singapore（国内访问最快） |
| Runtime | **Docker** |
| Instance Type | **Free** |

4. **Environment Variables**（Add Environment Variable 逐条加）：

| Key | Value |
|---|---|
| `ADMIN_PASSWORD` | `EmbedDesk2026` |
| `ALLOWED_ORIGINS` | `https://embeddesk.web.app` |
| `NODE_ENV` | `production` |
| `INGEST_SECRET` | `embeddesk-ingest-2026` |
| `SEED_DEMO` | `1` |

5. 点 **Create Web Service** → 等构建（约 5–8 分钟，日志刷 Docker build 步骤）
6. 构建完成后，Render 会分配 URL：**`https://embeddesk-api.onrender.com`**（每个人 URL 不同，以你看到的为准）
7. **验证 API**：浏览器打开 `https://embeddesk-api.onrender.com/api/health` → 应返回 JSON（含 `ok: true`）

> ⚠️ Render 免费层 **15 分钟无请求会休眠**，下次首个请求需 30–60 秒冷启动。评估前我会加保活（见第 4 步）。

---

## 第 2 步：Firebase Hosting 部署前端（约 5 分钟）

打开 https://shell.cloud.google.com/ （用 embeddesk 项目所属账号），逐条粘贴：

```bash
# 1) 同步最新代码（含混合部署改造）
cd ~/embeddesk 2>/dev/null || git clone -b hack2skill https://github.com/Aqr325/embeddesk.git && cd embeddesk
git pull 2>/dev/null || git fetch && git reset --hard origin/hack2skill

# 2) 安装依赖 + 构建前端（VITE_API_BASE 指向第 1 步拿到的 Render URL）
#    ⚠️ 把下面的 embeddesk-api.onrender.com 换成你的实际 Render URL
#    注：VITE_API_BASE 带或不带 /api 后缀均可（前端已做归一化，不会出现 /api/api 双前缀）
export VITE_API_BASE="https://embeddesk-api.onrender.com/api"
npm ci
npm run build

# 3) 只部署 Hosting（Spark 免费，不需要 Blaze）
firebase deploy --only hosting
```

成功标志：终端打印 **`Hosting URL: https://embeddesk.web.app`**。

> 若 `firebase deploy --only hosting` 仍提示项目/登录问题，先 `firebase use embeddesk` 再重试。

---

## 第 3 步：端到端验收（约 5 分钟）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 打开 `https://embeddesk.web.app` | 客服对话页正常渲染 |
| 2 | 右下角气泡 → 问「哪款模组带 NPU」 | 秒级流式回答（首条可能等 30–60s，Render 冷启动） |
| 3 | 打开 `https://embeddesk.web.app/admin`，密码 `EmbedDesk2026` | 登录成功，仪表盘有数据 |
| 4 | 聊天里流露出购买意图（如「想采购一批」） | 会话被转人工 / 自动建工单，后台可见 |
| 5 | 第三方嵌入测试：`https://embeddesk.web.app/hack-demo.html` | widget 正常加载并对话 |

---

## 第 4 步：防休眠保活（评估期必须做，2 分钟）

Render 免费层 15 分钟静默即休眠，评委首次访问要等 30–60 秒冷启动——虽仍可用，但观感差且慢。用免费 cron 每 10 分钟 ping 一次：

1. 打开 https://cron-job.org/ （免费注册，无需卡）
2. **Create cronjob**：
   - URL: `https://embeddesk-api.onrender.com/api/health`
   - Schedule: Every 10 minutes
3. 保存启用

> 保活只发 144 请求/天，远在 Render 免费额度内。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面能开但聊天转圈、Console 报 CORS | Render 的 `ALLOWED_ORIGINS` 没配对：必须是 `https://embeddesk.web.app`（无尾斜杠）。改完 Render 会自动重启 |
| `/admin` 登录 401 | `ADMIN_PASSWORD` 环境变量没设或拼错；Render → Environment → 修正 → 自动重部署 |
| `firebase deploy --only hosting` 报「no project active」 | 先 `firebase use embeddesk` |
| 想改前端 API 指向别的后端 | 重新构建时换 `VITE_API_BASE` 再 `firebase deploy --only hosting` |
| Render URL 忘了 | Render Dashboard → embeddesk-api → 顶部就是 |

---

## 与全 Firebase 方案的差异说明（写给评委的诚实口径）

- 原型前端与 widget 由 **Firebase Hosting** 承载（Google CDN、Google 域名）；API 以同一仓库的 Docker 镜像跑在 Render 免费层（赛事要求 Cloud Run / Firebase Functions，两者在本次提交中均被 Blaze 预付款风控挡住，故以免卡等价物保证「评估期间可用」——赛事规则对不可用不提供宽限，可用性优先）
- 知识库 / 会话 / 工单在演示实例走本地 SQLite（env 门控），设云凭证即切 Firestore / BigQuery / Vertex AI Search，代码零改动
- Gemini 调用经 `GEMINI_API_KEY`（或平台 SDK）启用；无凭证时自动降级词法 RAG，演示不中断
