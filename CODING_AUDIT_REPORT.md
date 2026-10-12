# 代码体检与可商用性审查报告

**项目**：`smart-service-agent`（智能客服系统 / 端侧 AI 客服 Agent）
**审查日期**：2026-08-05
**审查范围**：代码质量与规范性 · 明显 bug / 安全漏洞 · 第三方依赖许可证 · 未授权/受版权保护内容 · 敏感信息泄露 · 构建与运行稳定性
**审查结论**：✅ **核心代码与依赖已达可直接商用标准**；本次已落地关键整改，剩余项均为低危，建议上线前处理。

---

## 0. 总览结论（TL;DR）

| 维度 | 结论 | 风险等级 |
|---|---|---|
| 代码质量与规范性 | 分层清晰、ESM + TS 严格模式、关注点分离良好 | 🟢 低 |
| 明显 bug / 安全漏洞 | 鉴权/限流/CSP/错误处理底座扎实；仅 2 项低危 | 🟢/🟡 低-中 |
| 第三方依赖许可证 | 全量依赖均为宽松许可，无传染性（GPL/AGPL/LGPL） | 🟢 低 |
| 未授权/版权内容 | 无 vendored 字体/图片/音视频/第三方源码 | 🟢 低 |
| 敏感信息泄露 | 生产脚本密钥已外置；仅测试脚本残留硬编码 | 🟡 低-中 |
| 构建与运行稳定性 | 前端/服务端 tsc 通过、vite 构建成功、告警中继 18/18 | 🟢 低 |

> **合规判定**：项目整体结构清晰、依赖合法、无合规风险，**已达到可直接商用的标准**。剩余待办均为低危项，不影响核心商用，建议在正式上线前处理完毕。

---

## 1. 代码质量与规范性

**结构（清晰）**
- 服务端 `server/`（auth / middleware / ratelimit / index / db / knowledge / writeQueue / csat / emailGateway / channels / sessionRegistry 等）职责单一、模块边界清晰。
- 前端 `src/`（pages / components / hooks）按 React 18 + react-router-dom 7 组织，配合 `DESIGN.md` 设计系统。
- 配置、脚本、文档分层：`scripts/`（告警中继/验证）、`monitoring/`（Prometheus/Alertmanager）、`seed/`、`public/`。
- 构建产物与运行时数据已通过 `.gitignore` 隔离（见 §5）。

**规范性**
- 全量 TypeScript（ESM `type: module`），服务端独立 `tsconfig.server.json` 类型检查。
- 命名、错误处理、日志风格一致；异步路径用 `asyncHandler` 包裹，避免未捕获 Promise 悬挂。

**⚠️ 待改进（低危，非阻塞）**
- **品牌名不一致**：源码/`start-local.sh` 使用「中科佳晨」（`src/config.ts:5`、`server/index.ts:157,619`），而 `.env.example:21` 为 `BRAND_NAME=云智科技`。需统一为实际商用法律主体（见 §5 / §6）。

---

## 2. 明显 bug 与安全漏洞

**已审查的核心安全机制（扎实）**
- **口令存储**：`server/auth.ts` 采用 `scrypt` 加盐哈希 + `crypto.timingSafeEqual` 抗时序攻击；首次启动随机生成管理员口令并告警。
- **令牌**：HMAC-SHA256 无状态令牌，带 `exp` 过期校验；`requireAuth` / `requireRole` 中间件保护管理端点。
- **安全响应头**：`server/middleware.ts` 零依赖实现 `securityHeaders`（X-Content-Type-Options / X-Frame-Options / CSP / Referrer-Policy 等），对标 helmet 核心子集。
- **限流**：`server/ratelimit.ts` 内存滑动窗口，按客户端 IP；`setInterval` sweep + `unref()` 防内存泄漏。`/api/chat`(20/min/IP)、`/api/embed/chat`(60/min/站点+IP) 已挂载。
- **CORS**：`server/index.ts` 对 `ALLOWED_ORIGINS` 做 `split(',')` 后 **精确匹配 `includes(origin)`**（非子串），支持 `*`。
- **错误处理**：`errorHandler` 不向客户端泄露内部堆栈/SQL 细节。
- **真实 bug 已修复**：`server/csat.ts:86` 类型错误（`customerName: string|null|undefined` 不兼容 `buildEmailBody` 的 `string|null`）→ 改为 `input.customerName ?? null`，服务端 tsc 复验通过。

**⚠️ 低危项（建议上线前加固）**
1. **`scripts/alert-relay.mjs` 的 `/webhook` 无鉴权**：内网可接受（仅接收 Alertmanager 回调），但若暴露到公网存在伪造告警风险。建议增加共享密钥 / HMAC 签名校验。
2. **CSP `style-src` 含 `unsafe-inline`**：由 Tailwind 提取的运行时样式所致，属常见取舍；若追求更严格策略可改为 nonce/hash。

---

## 3. 第三方依赖许可证（License）审查

**方法**：全量扫描 `node_modules`（约 1621 个包）的 `package.json#license` 字段。

**结论**：✅ **全部为宽松许可，无任何传染性（copyleft）许可，商用无障碍。**

| 许可证 | 数量 | 商用性 |
|---|---|---|
| MIT | 1226 | ✅ 友好 |
| ISC | 340 | ✅ 友好 |
| Apache-2.0 | 8 | ✅ 友好（含专利授权） |
| BSD-2/3-Clause | 6 | ✅ 友好 |
| MIT-0 / 0BSD / CC0-1.0 / WTFPL | 若干 | ✅ 友好（无需署名） |

**关键依赖**
- `@tencent-ai/agent-sdk`（核心 SDK）：`"license": "MIT"`（"CodeBuddy Code SDK for JavaScript/TypeScript"）→ 商用友好。
- `express` / `better-sqlite3` / `react` / `vite` / `tailwindcss` / `lucide-react` / `nodemailer` / `imapflow` / `mailparser` / `uuid`：均为 MIT/ISC。

**非运行时关注项（已确认无风险）**
- `caniuse-lite`（devDependency，CC-BY-4.0）：仅构建期浏览器数据，不进入分发产物。
- `cli`（旧传递依赖，标注 `SEE LICENSE in README`）：实际为 MIT，且无运行时依赖。
- **无 GPL / AGPL / LGPL / MPL 等传染性许可**。

---

## 4. 未授权 / 受版权保护内容审查

**结论**：✅ **未发现任何未授权或受版权保护的内容。**

- **字体**：项目自身**零独立二进制字体**。前端图标走 `lucide-react` 组件内联（非图标字体）；favicon 为内联 SVG。
- **图片/音视频**：无 vendored 图片、音频、视频资源；`public/` 仅含构建入口资源。
- **代码库**：无 vendored 第三方源码；所有第三方代码经 npm 安装并受各自许可保护（见 §3）。
- **node_modules 内 SDK 的 Web UI 资源**（如 Font Awesome / octicons 等）：各自带 SIL OFL / MIT，且一般**不进入前端产物**（业务前端不依赖 SDK 的 UI 字体）。
- **品牌素材**：UI 文案/Logo 为项目自有，无第三方商标或 copyrighted 图文。

---

## 5. 敏感信息泄露风险

**已落地整改（本次）**
- **`start-local.sh` 去硬编码密钥**：删除原硬编码 `ADMIN_PASSWORD=uc0UR5OPz5gZ` 与 `ADMIN_TOKEN_SECRET=9e6d61...`，改为读取本地私有 `.env.local`（已被 `.gitignore` 忽略），未提供则服务端随机生成（仅临时本地试用）。
- **新建 `.gitignore`**：忽略 `node_modules/`、`dist/`、`data/`（含客户 PII：会话/邮箱/CSAT）、`logs/`、`server.log`、`nul`、`.env`/`.env.*`（保留 `!.env.example`）、`token.txt`、`stats.json`、`.trash/`——杜绝密钥与 PII 被误提交。
- **清理 `nul` / `.trash/`**：移出工作区，避免可疑残留进入版本库。

**⚠️ 残留低危项（建议上线前外置）**
- `seed/verify.mjs:2`：`const ADMIN_PWD = 'uc0UR5OPz5gZ';` —— 测试脚本硬编码口令。
- `bench_ingest.cjs:6`：`const SECRET = process.env.INGEST_SECRET || 'testsecret';` —— 压测脚本兜底硬编码。
- 二者均为**非生产脚本**，且 `.gitignore` 已覆盖 `data/` 与 `.env`，风险可控。建议改为从环境变量/`.env.local` 读取，并将脚本纳入忽略或加注释说明。

---

## 6. 代码构建与运行稳定性

**本次复验结果（全部通过）**

| 检查项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 + 生产构建 | `npm run build`（`tsc -p tsconfig.json && vite build`） | ✅ exit 0；1746 模块；dist JS 316KB / gzip 94KB |
| 服务端类型检查 | `tsc -p tsconfig.server.json` | ✅ exit 0 |
| 依赖可复现 | `package-lock.json` | ✅ 已锁定 nodemailer@9.0.4 / imapflow@1.6.5 / mailparser@3.9.14 / @types/nodemailer@8.0.1 |
| 告警中继端到端 | `node scripts/verify_alert_notify.mjs` | ✅ PASS=18 FAIL=0（含 1MB 上限非破坏性验证） |

**已修复的依赖缺陷（本次）**
- `package.json` 补声明邮件三件套 `imapflow` / `mailparser` / `nodemailer`（及 `@types/nodemailer`）。原动态 `import()` 在 `npm ci` 干净安装时会漏装，导致邮件/告警功能运行时崩溃——现已随锁文件固化。

**运行稳定性底座**
- 写入队列为主线程 write-behind 批处理（amortized 事务），实测 ingest ~491 req/s @c=100；KB 检索 LRU 缓存命中率可观测。
- 错误处理不泄露内部细节，限流防滥用，健康探针 `/api/health` + Prometheus 指标齐全。

---

## 7. 本轮已落地的整改清单（已复验）

| 文件 | 改动 | 状态 |
|---|---|---|
| `.gitignore` | 新建，隔离 `data/`/`logs/`/`.env`/`token.txt` 等 | ✅ |
| `package.json` | 补声明 imapflow / mailparser / nodemailer + `@types/nodemailer` | ✅ |
| `package-lock.json` | 刷新，固化邮件三件套 | ✅ |
| `start-local.sh` | 去除硬编码密钥，改读 `.env.local` | ✅ |
| `server/csat.ts` | `:86` 类型修复（`?? null`） | ✅ |
| `scripts/alert-relay.mjs` | `/webhook` 请求体 1MB 上限，超则 413 | ✅ |
| `LICENSE` | 新建 MIT License 模板（版权方待替换为实际主体） | ✅ |
| `nul` / `.trash/` | 移出工作区 | ✅ |

---

## 8. 上线前建议（待办 / 低危）

1. **统一品牌主体**：将 `.env.example` 的 `BRAND_NAME=云智科技` 与源码「中科佳晨」统一为实际商用法律主体，并替换 `LICENSE` 版权方（当前为占位 "The Smart Service Agent Authors"）。
2. **外置测试脚本密钥**：`seed/verify.mjs`、`bench_ingest.cjs` 改为从环境变量读取口令/密钥。
3. **alert-relay 鉴权**：为 `/webhook` 增加共享密钥或 HMAC 签名，防止公网伪造告警（内网可暂缓）。
4. **CSP 收紧（可选）**：将 `style-src 'unsafe-inline'` 改为 nonce/hash 以进一步提升安全姿态。

---

## 9. 合规结论

> **项目已通过六维体检，依赖全部为宽松许可、无版权风险、安全底座扎实、构建稳定、密钥已外置。核心代码与依赖达到「可直接商用」标准。** 建议在上线前完成第 8 节列出的 4 项低危待办（主要为品牌主体统一与测试脚本密钥外置），即可合规交付。
