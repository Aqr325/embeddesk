# EmbedDesk · Firebase 免绑卡部署指南（Spark 免费计划）

> **赛事规则原文**：「通过 Cloud Run **或 Firebase** 部署在 Google Cloud 上」。
> 本路线为 **Firebase Spark 免费计划**——**不需要信用卡**，与 Cloud Run 路线（`DEPLOY_GCP.md`）
> 共用同一套服务端代码，零逻辑分叉。
>
> **为什么 Spark 就够用**：应用在无云凭证时自动运行在「本地 SQLite + 词法 RAG」模式
> （`server/functions-env.ts` 将数据库指向 `/tmp/embeddesk.db`，冷启动自动种子），
> 零出站流量——正好绕开 Spark 计划「出站网络需升级 Blaze」的唯一限制，演示功能完整。
>
> **全流程在 Cloud Shell（浏览器内 Linux 环境）完成**：免安装、自带 Node 20，
> 且 `npm ci` 会拉取 Linux 版 better-sqlite3 原生二进制（与函数运行时匹配，关键！）。

---

## 第 1 步：创建 Firebase 项目（浏览器，约 2 分钟）

1. 打开 https://console.firebase.google.com/ → 「添加项目」
2. 项目名称填 `embeddesk` → 继续
3. **遇到「升级到 Blaze 计划」提示 → 直接跳过/暂不升级**（Spark 免费计划完全支持本次部署）
4. 项目创建后，左侧「构建」→「Functions」→ 首次进入若提示启用，点启用（免费）

## 第 2 步：Cloud Shell 一键部署（约 8 分钟）

打开 https://shell.cloud.google.com/ （右上角确认已登录 Google 账号），依次粘贴：

```bash
# 1) 拉取代码（hack2skill 分支）
git clone -b hack2skill https://github.com/Aqr325/embeddesk.git
cd embeddesk

# 2) 安装依赖（Linux 原生二进制，与函数运行时匹配）
npm ci

# 3) 构建：前端产物 dist/ + 函数 bundle functions-bundle/index.cjs
npm run build
npm run build:functions

# 4) 登录 Firebase（会打印一个 URL：复制到本地浏览器打开，授权后把得到的授权码粘回终端）
firebase login --no-localhost

# 5) 写入后台口令（.env 已被 .gitignore，不会入库；ADMIN_PASSWORD 必须设置，否则评委无法登录后台）
echo "ADMIN_PASSWORD=EmbedDesk2026" > .env

# 6) 部署（Hosting + Functions 一次性完成）
firebase deploy
```

部署成功后会打印两个地址：

| 地址 | 用途 |
|---|---|
| `https://embeddesk.web.app` | **提交用主链接**（Hosting：SPA + embed.js） |
| `https://embeddesk.firebaseapp.com` | 备用（等价） |

`/api/**` 请求由 Hosting rewrite 到 Cloud Function（`api`），前端与 API 同源，无跨域问题。

## 第 3 步：验收清单（评委视角）

| # | 检查 | 预期 |
|---|---|---|
| 1 | 开 `https://embeddesk.web.app/api/health` | 返回 `{"status":"ok",...}` |
| 2 | 开 `https://embeddesk.web.app/` | 右下角出现聊天气泡 |
| 3 | 发送「如何降低模组待机功耗？」或「哪款模组带 NPU，算力多少？」 | 有知识库回复（无凭证模式走本地 RAG，附产品引用） |
| 4 | 开 `https://embeddesk.web.app/admin`，用 `EmbedDesk2026` 登录 | 能进后台；仪表盘 / 工单 / 调用监控有演示数据 |
| 5 | 过 5 分钟再访问一次 | 正常（Spark 缩容到零，冷启动约 3–5 秒） |

全部通过后：把 `https://embeddesk.web.app` 回填 H2S 提交页「部署原型链接」栏。

## 常见问题

| 现象 | 原因 / 解法 |
|---|---|
| 首次访问慢 3–5 秒 | Spark 缩容到零的正常冷启动；演示期间连续访问即热 |
| 工单/会话数据"没了" | SQLite 位于 /tmp，函数实例回收后重建并自动种子（SEED_DEMO 默认开）——功能演示无影响，非缺陷 |
| 想切真实 GCP 栈（Gemini/Vertex/Firestore/BigQuery） | Spark 不支持，需绑卡升 Blaze 或走 Cloud Run 路线（见 `DEPLOY_GCP.md`） |
| `firebase deploy` 报 project 不存在 | `.firebaserc` 默认项目为 `embeddesk`；若你建的项目 ID 不同，执行 `firebase use --add` 选一下 |
| 部署后 404 | 确认第 3 步 `npm run build` 成功产出 `dist/`（Hosting public 目录） |

## 架构说明（与 Cloud Run 路线的关系）

```
同一份 server/ 代码
   ├── 本地 / Cloud Run：server/index.ts → app.listen(PORT)      （DEPLOY_GCP.md）
   └── Firebase Spark  ：server/functions.ts → onRequest(app)     （本文件）
                            ↑ functions-env.ts 预置 CSA_DB_PATH=/tmp/embeddesk.db
                            ↑ esbuild bundle 为单文件 CJS（Cloud Functions 无法直跑 TS）
```

- 切换判定：`process.env.FUNCTION_TARGET`（Firebase 函数运行时自动注入）——函数模式跳过 listen
- bundle 脚本：`scripts/build-functions.mjs`；冒烟测试：`node scripts/smoke-functions.cjs`
- 数据文件随包上传规则见 `.firebaseignore`（`data/products/catalog.json` 保留——知识库种子用 fs 读取，bundle 无法内联）
