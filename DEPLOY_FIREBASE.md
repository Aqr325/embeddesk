# EmbedDesk · Firebase 部署指南（Hosting + Cloud Functions）

> **赛事规则原文**：「通过 Cloud Run **或 Firebase** 部署在 Google Cloud 上」。
> 本路线为 **Firebase**——与 Cloud Run 路线（`DEPLOY_GCP.md`）共用同一套服务端代码，零逻辑分叉。
>
> **全流程在 Cloud Shell（浏览器内 Linux 环境）完成**：免安装、自带 Node 20，
> 且 `npm ci` 会拉取 Linux 版 better-sqlite3 原生二进制（与函数运行时匹配，关键！）。

---

## ⚠️ 第 0 步（必读）：关于「绑卡」的真相

**Firebase Spark（免费）计划不能部署 Cloud Functions**——这是 Google 2026 年的硬性规则，
`firebase deploy` 到函数步骤会直接弹「需要升级 Blaze 计划」并中断。

**Blaze ≠ 收费**：升 Blaze 只是绑定一个谷歌云计费账户做身份验证，**演示用量远在免费额度内，实际 $0**：

| 项 | 免费额度（Blaze） | 本次演示预计用量 |
|---|---|---|
| 函数调用 | 200 万次/月 | < 1,000 次 |
| 函数计算 | 400,000 GB·秒/月 | < 60 GB·秒 |
| 出站流量 | 5 GB/月（Google 侧） | ≈ 0（无凭证模式零出站） |

> 本应用在无云凭证时自动运行「本地 SQLite + 词法 RAG」模式（`server/functions-env.ts` 把数据库指向
> `/tmp/embeddesk.db`，冷启动自动种子），**不调用任何外部 API**，不可能产生费用。

### 绑卡三条路（按推荐顺序，任选其一）

**路线 A：用自己的卡试一下（约 2 分钟就知道行不行）**
项目已在你账号下 → 直接 https://console.firebase.google.com/project/embeddesk/usage/details → 左下角「Spark」旁「升级」→ 选 Blaze →「创建计费账户」→ 填卡。国内很多**双币储蓄卡（Visa/Mastercard 借记卡）**可以直接过；纯银联卡可能被拒。被拒就删掉计费信息，项目仍在、零费用，直接走路线 B。
> ⚠️ **若升级时弹出「One-time prepayment required / 需要一次性预付 $30」**：说明该卡被 Google 风控标记（典型为虚拟卡、预付卡、或账单姓名与 Google 账号本人不一致的卡）——**正常个人信用卡不会触发此要求**。$30 是「预存」不是手续费：计入账户余额可消费、关闭计费账户可退；但姓名不一致的卡在评估期有被暂停计费 → 函数被停 → 原型链接失效的连锁风险。追求零成本+低风险就走路线 B（队友实名卡）。

**路线 B：有卡的队友建计费账户，你关联升级（队长无卡的标准解法；项目无需重建）**
1. ANKIT 打开 https://console.cloud.google.com/billing →「创建账户」→ 起名 `EmbedDesk-Billing` → 填他的卡（被拒就换一张双币卡）
2. ANKIT 在该计费账户页 →「账户管理 / Account Management」→「添加成员」→ 填 `xinghuiwan1@gmail.com` → 角色选 **Billing Account User** → 保存
3. 你打开 https://console.firebase.google.com/project/embeddesk/usage/details → 左下角「升级」→ 选 Blaze → 计费账户列表里选中 ANKIT 的 `EmbedDesk-Billing`（你已是其 User）→ 确认
4. 回 Cloud Shell 原样重跑 `firebase deploy`（项目 ID 不变、代码不动、数据不动）

**路线 B-2（变体）：让队友全程部署，你只收 URL**
1. 你在 https://console.firebase.google.com/project/embeddesk/settings/iam →「添加成员」→ 填 ANKIT 的 Gmail → 角色 **Owner** → 保存
2. ANKIT 用他的 Gmail 登录 Firebase 控制台 → 对 embeddesk 项目左下角升级 Blaze（他的卡）
3. ANKIT 打开 https://shell.cloud.google.com/ → 执行第 2 步的完整部署命令（全新 clone）
4. ANKIT 把 `https://embeddesk.web.app` 发给你 → 你回填表单（队长署名仍是你）

**路线 C：全程无卡（保底，非 Google 栈）**
仓库已带 `Dockerfile`，可部署到 Render 免费层（无需绑卡，5 分钟，功能完整）。
代价：不满足「Cloud Run 或 Firebase」的赛事字面要求——**只在 A/B 都失败时使用**，并可在提交简述中说明原因。

---

## 第 1 步：创建 Firebase 项目（浏览器，约 3 分钟）

1. 打开 https://console.firebase.google.com/ → 「添加项目」
2. 项目名称填 `embeddesk` → 继续（记住生成的**项目 ID**，全局唯一；若 `embeddesk` 已被占用，用 `embeddesk-xxxxx` 形式）
3. **遇到「升级到 Blaze 计划」提示 → 现在就升**（按上面第 0 步的路线 A 或 B 操作；免费额度内 $0）
   - 建议顺手设预算保险：https://console.cloud.google.com/billing → 「预算和提醒」→ 建 $1/月的预算，超额仅发邮件不会自动扣费
4. 项目创建后，左侧「构建」→「Functions」→ 首次进入若提示启用 API，点启用

## 第 2 步：Cloud Shell 部署（约 8 分钟）

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

# 6) 若你的项目 ID 不是 embeddesk，先关联：
#    firebase use --add   （列表里选中你的项目，别名 default）
# 7) 部署（Hosting + Functions 一次性完成）
firebase deploy
```

部署成功后会打印两个地址：

| 地址 | 用途 |
|---|---|
| `https://<项目ID>.web.app` | **提交用主链接**（Hosting：SPA + embed.js） |
| `https://<项目ID>.firebaseapp.com` | 备用（等价） |

`/api/**` 请求由 Hosting rewrite 到 Cloud Function（`api`），前端与 API 同源，无跨域问题。

## 第 3 步：验收清单（评委视角）

| # | 检查 | 预期 |
|---|---|---|
| 1 | 开 `https://<项目ID>.web.app/api/health` | 返回 `{"status":"ok",...}` |
| 2 | 开 `https://<项目ID>.web.app/` | 右下角出现聊天气泡 |
| 3 | 发送「如何降低模组待机功耗？」或「哪款模组带 NPU，算力多少？」 | 有知识库回复（无凭证模式走本地 RAG，附产品引用） |
| 4 | 开 `https://<项目ID>.web.app/admin`，用 `EmbedDesk2026` 登录 | 能进后台；仪表盘 / 工单 / 调用监控有演示数据 |
| 5 | 过 5 分钟再访问一次 | 正常（函数缩容到零，冷启动约 3–5 秒） |

全部通过后：把主链接回填 H2S 提交页「部署原型链接」栏。

## 常见问题

| 现象 | 原因 / 解法 |
|---|---|
| `firebase deploy` 提示需要 Blaze/绑卡 | 见第 0 步——Spark 不能部署 Functions，这是 Google 规则不是本项目问题 |
| `npm ci` 报 `EALLOWREMOTE` / `Refusing to fetch ...@https://registry.npmmirror.com/...` | lockfile 曾混入淘宝镜像地址，Cloud Shell 的 npm 11 拒绝抓取非官方源 tarball——已于 2026-10-18 将全部 595 个 resolved 改写为 `registry.npmjs.org`；若再现，先 `git pull` 再重试 |
| `sh: 1: tsc: command not found` | 同上——`npm ci` 失败导致 devDependencies（typescript）未安装，修好 lockfile 后重跑即恢复 |
| 升级时要求「$30 one-time prepayment」才能激活 | 该支付方式被 Google 风控标记（虚拟卡/预付卡/账单姓名非本人）——正常个人信用卡无此要求。预付款可退（关闭计费账户），但非本人卡有评估期被停风险；零成本正路是路线 B 用队友实名信用卡 |
| 绑卡被拒（卡不支持） | 删掉计费信息（项目无损、零费用）→ 走路线 B（ANKIT 建计费账户加你为 Billing Account User）或 B-2（加 ANKIT 为 Owner 让他部署）；都不可行才用路线 C（Render） |
| 首次访问慢 3–5 秒 | 函数缩容到零的正常冷启动；演示期间连续访问即热 |
| 工单/会话数据"没了" | SQLite 位于 /tmp，函数实例回收后重建并自动种子（SEED_DEMO 默认开）——功能演示无影响，非缺陷 |
| 想切真实 GCP 栈（Gemini/Vertex/Firestore/BigQuery） | 在 Blaze 上直接可用，配好环境变量即可，无需改码 |
| `firebase deploy` 报 project 不存在 | `.firebaserc` 默认项目为 `embeddesk`；项目 ID 不同则执行 `firebase use --add` 选一下 |
| 部署后 404 | 确认第 3 步 `npm run build` 成功产出 `dist/`（Hosting public 目录） |

## 架构说明（与 Cloud Run 路线的关系）

```
同一份 server/ 代码
   ├── 本地 / Cloud Run：server/index.ts → app.listen(PORT)      （DEPLOY_GCP.md）
   └── Firebase         ：server/functions.ts → onRequest(app)     （本文件）
                            ↑ functions-env.ts 预置 CSA_DB_PATH=/tmp/embeddesk.db
                            ↑ esbuild bundle 为单文件 CJS（Cloud Functions 无法直跑 TS）
```

- 切换判定：`process.env.FUNCTION_TARGET`（Firebase 函数运行时自动注入）——函数模式跳过 listen
- bundle 脚本：`scripts/build-functions.mjs`；冒烟测试：`node scripts/smoke-functions.cjs`
- 数据文件随包上传规则见 `.firebaseignore`（`data/products/catalog.json` 保留——知识库种子用 fs 读取，bundle 无法内联）
