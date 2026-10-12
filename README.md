# 智能客服 Agent（Smart Service Agent）

基于 **CodeBuddy Agent SDK** 构建的多轮对话智能客服 Web 应用。支持意图识别、FAQ 知识库检索、自动转人工、对话持久化与管理后台。

---

## 功能与需求对应

| 需求 | 实现 |
| --- | --- |
| 多轮对话 | SSE 流式回复 + 会话上下文持久化（SQLite），支持中途打断（停止生成） |
| FAQ 知识库检索 | 规则混合打分检索（关键词命中率 + 问题/答案 Dice 相似度 + 类目匹配），注入 LLM 上下文 |
| 自动识别用户意图 | 规则式意图引擎（退款 / 订单查询 / 技术支持 / 投诉 / 转人工 / 寒暄 / 其它），<1ms、可解释 |
| 无法解决时自动转人工 | 6 条优先级短路规则（显式要求 / 法务风险 / 投诉 / 知识库连续未命中 / 长未解决 / Agent 自主判定），自动生成工单 |
| 对话历史持久化 | better-sqlite3（WAL 模式），会话 / 消息 / 意图流水 / 工单 / 满意度全量落库 |
| 管理后台 | 对话记录列表（可筛选/展开）、满意度统计（评分分布/趋势/NPS）、意图分布、工单管理、FAQ 管理 |

---

## 技术栈

- **后端**：Express 4 + better-sqlite3 + CodeBuddy Agent SDK（`@tencent-ai/agent-sdk`）
- **前端**：React 18 + TypeScript + Vite 5 + Tailwind CSS + lucide-react + react-router-dom v7
- **降级策略**：`AGENT_MODE = auto | sdk | local`
  - SDK 不可用（鉴权失败 / 模型名不支持 / 超时）时自动降级为「知识库直答」，对话不中断
  - 模型兜底链：`请求模型 → DEFAULT_MODEL → auto → glm-5.2 → hy3 → deepseek-v4-flash`；单次超时继续尝试下一候选，整链受总预算约束
  - 鉴权类错误会令进程内永久禁用 SDK，避免每轮重复挂起与错误刷屏

---

## 设计系统（UI 体验规范）

前端采用「DESIGN.md 作为设计令牌单一事实来源」的工作流：所有颜色、字体层级、圆角、间距与组件令牌定义在根目录 `DESIGN.md`，通过 `designmd`（Google 官方 `@google/design.md` v0.3.0）做 `lint` 校验并 `export --format json-tailwind` 导出为 Tailwind `theme.extend`。

- **校验命令**：`designmd lint DESIGN.md`（当前 0 error；登录主按钮白字/蓝底 3.68:1 对比度 warning 为设计权衡，保留）
- **令牌桥接**：语义色经 `src/index.css` 的 CSS 变量桥接浅/深色（`--color-destructive` / `--color-success` / `--color-warning` / `--color-info` 及其 `foreground` / `light` 变体），`tailwind.config.js` 仅引用变量，保证跨组件统一且零新增运行时依赖。

**核心令牌**

| 类别 | 令牌 | 说明 |
| --- | --- | --- |
| 语义状态色 | `destructive` / `success` / `warning` / `info` | 错误红、成功绿、警示黄、信息蓝；均含 DEFAULT / foreground / light（浅底）三态，统一用于错误提示、空态、徽标 |
| 品牌色 | `accent` | `rgb(var(--td-brand-color-rgb) / <alpha-value>)`，支持 `ring-accent/40`、`bg-accent/10` 等透明度修饰，用于焦点环、主按钮、链接 |
| 字体层级 | headline-display / headline-lg / section / body-md / body-sm / label-sm | 统一标题与正文层级，避免页面字号发散 |
| 圆角 | sm / md / lg / xl(16px) / 2xl(20px) / full | 卡片、输入框、按钮圆角规范 |
| 过渡 | `transition-base` | 统一 `color/bg/border/opacity/box-shadow/transform` 过渡，组件交互一致 |
| 动效 | `animate-fade-in` / `fade-in-up` / `slide-in-right` / `pop-in` / `shimmer` | 路由切换淡入、列表渐入、骨架屏微光 |

**复用型 UI 原子组件**（均零依赖自实现，`src/components/ui/`）

- `Spinner`：加载指示（`Loader2` + `animate-spin text-accent`）
- `Skeleton` / `SkeletonText`：骨架屏占位（`.skeleton` + shimmer 微光，管理后台首屏 `AdminSkeleton`）
- `EmptyState`：统一空状态（图标 + 标题 + 描述 + 可选操作，用于 FAQ 空库、无工单、无对话记录、空表格）
- `cn`：类名合并工具（`src/lib/cn.ts`，过滤 falsy、展平数组）

**可访问性与移动端**

- 全局 `:focus-visible` 焦点环（`outline: 2px solid var(--td-brand-color)`），输入框/按钮额外加 `focus-visible:ring-2 ring-accent/40`
- 触控目标 ≥ 44px（`min-h-[44px]` / `min-w-[44px]`），按钮 `active:scale` 即时反馈
- `@media (hover:none) and (pointer:coarse)` 触控优化；`-webkit-tap-highlight-color: transparent`
- `prefers-reduced-motion` 下自动降级关闭动效；`overscroll-behavior: none` 防止链式滚动

---

## 数据存储与运维

数据持久化基于 better-sqlite3（WAL 模式 + 外键约束），零额外依赖。除 6 张业务表（sessions / messages / faqs / tickets / satisfaction / intent_logs）外，提供以下可商用能力：

- **Schema 版本化迁移**：基于 `PRAGMA user_version` 的幂等迁移框架（`server/db.ts` 的 `migrations` 数组），每次启动按版本顺序应用未执行迁移并落盘版本号；新增列/索引只需追加迁移项，保证演进可追溯、可重放、向后兼容旧库（当前最新 **v7**：v6 为跨渠道续接索引 `sessions(customer_id, channel)` 复合索引，v7 为邮件网关幂等表 `processed_emails`（message_id 主键，跨重启去重避免 IMAP 重复回复））。
- **写入健壮性**：`busy_timeout=5000`（避免并发「database is locked」）、`synchronous=NORMAL`（WAL 下崩溃一致且写入更快）、`cache_size=-16000` 与 `temp_store=MEMORY`（提升聚合查询吞吐）。
- **事务原子性**：`clearAllData` 与「消息落库 + 会话时间戳更新」均包裹在事务中，杜绝半写入。
- **管理后台数据管理面板**（需管理员鉴权）：
  - **备份数据库** `GET /api/admin/db/backup`：先 `wal_checkpoint(TRUNCATE)` 刷盘再流式下载一致性快照（.db，含 -wal/-shm），下载后自动清理临时文件。
  - **完整性自检** `GET /api/admin/db/integrity`：执行 `integrity_check` + `foreign_key_check`，返回结构健康度与各表行数。
  - **空间回收** `POST /api/admin/db/vacuum`：重建库文件回收空闲空间，返回回收字节数。
  - **元信息** `GET /api/admin/db/meta`：返回库体积、schema 版本、日志模式、页大小。
- 上述数据管理端点均经 `requireAuth` 守卫，未鉴权返回 401。

## 运行指标与可观测性

面向「可商用部署 + 演示大屏」的轻量可观测性，零额外依赖、不引入外部监控组件：

- **进程内指标层**（`server/metrics.ts`）：累计请求数、状态码分桶（2xx/3xx/4xx/5xx）、错误数（仅 5xx 计入）、平均时延与 p50/p95/p99 分位、进程 uptime。计数器均为 O(1)，不阻塞主链路；时延分位用定长环形缓冲（200 样本）近似排序。指标存活于内存、重启归零，与落盘访问日志互补（日志追明细、指标看趋势）。
- **访问审计中间件**已接入指标采集：每个请求在 `res` 「finish」事件中同时写访问日志（`logger.access`）与 `recordRequest(status, durationMs)`，链路追踪由 `reqId` 串联。
- **健康探针** `GET /api/health`（公开）：返回 `status / mode / sdkAvailable / db(ping) / brand / metrics / timestamp`，以及 `writeQueue`（含 `mode` 恒为 `inline` 与吞吐计数）、`emailGateway`（含 `enabled / connected / reason / processedTotal / errorTotal / simulatedTotal`，未配置时 `enabled=false` 并给出缺失项）与 `kbCache`（KB 检索 LRU 缓存观测：`lruSize / lruMax / hits / misses / hitRate(百分比,1位小数)`，便于线上直观判断缓存收益）。DB 不可用时返回 503，可供负载均衡/容器编排探活；已用 `asyncHandler` 包裹，异常不致进程崩溃。
- **运行指标端点** `GET /api/admin/metrics`（需 `requireAuth`）：返回完整指标快照，供管理后台「运行概览」卡片与运维看板使用。
- **Prometheus 导出端点** `GET /api/admin/metrics/prometheus`（需 `requireAuth`）：以标准 Prometheus text exposition 格式（`Content-Type: text/plain; version=0.0.4`）输出指标，可直接被 Prometheus 抓取。指标命名统一 `csa_` 前缀，类型含 `counter`（请求总数、分桶计数、5xx 错误数）与 `gauge`（时延分位 avg/p50/p95/p99、uptime、会话/消息/满意度/工单/知识库命中率等业务指标）。进程内存指标每次抓取即当前快照，业务指标实时读库。
  - **KB 缓存命中率指标（新增）**：知识库检索 LRU 缓存的收益独立暴露，与「FAQ 答案命中率」（`csa_knowledge_base_hit_rate`，衡量检索结果质量）语义不同——本组衡量「检索被缓存直接返回、跳过整轮打分」的缓存效率：
    - `csa_kb_cache_hit_rate`（gauge）：LRU 缓存命中率（百分比）。
    - `csa_kb_cache_hits_total`（counter）：缓存命中次数（直接返回、跳过打分）。
    - `csa_kb_cache_misses_total`（counter）：缓存未命中次数（触发重新打分）。
    - `csa_kb_cache_size`（gauge）：当前 LRU 缓存条目数（上限 5000）。
    计数器累计自进程启动（含知识库种子/演示数据预热），重启归零，与缓存本身生命周期一致。
  - **Prometheus 抓取配置示例**：
    ```yaml
    scrape_configs:
      - job_name: 'smart-service-agent'
        metrics_path: /api/admin/metrics/prometheus
        authorization:
          type: Bearer
          credentials: "<管理后台登录后获得的 token>"
        static_configs:
          - targets: ['localhost:3000']
    ```
  - **管理后台「运行概览」卡片**：新增「Prometheus 导出」按钮（`useAdmin.exportPrometheus`），一键下载当前指标快照为 `.prom` 文本，便于离线分析或粘贴至 Grafana/Prometheus 调试。
- **管理后台「运行概览」卡片**：上排 6 个实时指标瓦片（运行时长 / 累计请求 / 错误率 / 平均时延 / P95 / P99），下排新增「知识库检索缓存」4 瓦片（缓存命中率 / 缓存命中数 / 缓存未命中 / 缓存条目 `size/lruMax`），数据来自 `/api/admin/metrics` 的 `kbCache` 段，每 15s 自动轮询、支持手动刷新；错误率>0 显红、P99>3000ms 显橙，缓存命中率用主题色强调，与既有设计令牌一致。**语义区分**：此「缓存命中率」=`kbCache.hitRate`（LRU 命中、跳过整轮打分），不同于「FAQ 答案命中率」（`csa_knowledge_base_hit_rate` / 运营看板，衡量检索是否找到好答案）。
- **核心链路可靠性加固**：
  - **SSE 整体看门狗**：`/api/chat` 设 `CHAT_WATCHDOG_MS`（默认 90000）整体超时，超时强制断流（未发头则 504 JSON，已发头则 SSE error 事件），杜绝连接永久悬挂；正常完成或异常时经 `res` finish/close 清理定时器。
  - **订单上下文超时包裹** `withTimeout`（`server/orders.ts`，默认 `ORDER_CTX_TIMEOUT_MS=3000`）：为「未来远程订单中心 HTTP/gRPC 调用」提前兜底，查询超时即降级为未命中，不拖垮主对话链路。

---

## 安全与运维模型（可商用基础）

| 能力 | 实现 |
| --- | --- |
| **管理后台鉴权** | 管理员登录 `/api/admin/login` 获取 HMAC 签名无状态令牌（类 JWT，零依赖），所有管理/数据写接口（`/api/admin/*`、会话读写、工单读写、FAQ 写、满意度读取）均需 `Authorization: Bearer <token>`；客户对话与满意度提交保持公开 |
| **默认安全凭据** | 未设置 `ADMIN_PASSWORD` 时服务端随机生成强密码并打印于启动日志；未设置 `ADMIN_TOKEN_SECRET` 时生成临时密钥（重启失效）并告警——杜绝默认弱口令被公开访问 |
| **接口限流** | `/api/chat` 按客户端 IP 滑动窗口限流（`RATE_LIMIT_*`），防刷量 |
| **输入校验** | 消息长度上限 2000 字符、客户名 64 字符、会话 ID 强制 UUID 规范化，防注入与畸形请求 |
| **CORS 白名单** | 仅放行 `ALLOWED_ORIGINS` 配置来源；生产可收紧为自有域名 |
| **访问审计** | 所有请求记录方法/路径/状态码/耗时/客户端 IP（`LOG_FILE` 可落盘）；登录失败写入审计日志 |
| **数据导出** | 管理后台支持按筛选条件导出对话记录为 CSV（含 BOM，Excel 中文兼容） |
| **优雅退出** | 收到 SIGINT/SIGTERM 时关闭 HTTP 服务与 SQLite 连接，避免数据损坏 |
| **健康探活** | `/api/health` 返回数据库连通状态，便于容器探针与负载均衡 |
| **集中错误处理** | 新增 `server/middleware.ts`：所有异步路由经 `asyncHandler` 包裹，未决异常可靠转发至统一错误中间件；按 400/404/413/5xx 分流，记录 `reqId`，且不向客户端泄露堆栈 |
| **未知接口 404** | 未匹配的 `/api/*` 路由返回结构化 `404` JSON（非 `/api` 路径仍交由 SPA 回退） |
| **安全响应头** | 零依赖注入 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Cross-Origin-Opener-Policy` 与严格 CSP（同源脚本/样式，`connect-src 'self'`），对标 helmet 核心子集 |
| **请求体约束** | JSON 体积上限收紧至 `1mb`；畸形 JSON 统一返回 `400`，超限返回 `413`，避免大报文占用内存 |
| **SSE 断连安全网** | 聊天流式接口监听 `req.on('close')` / `res.on('error')`，客户端中途关闭时停止推送并优雅断流；顶层 `try/catch` 保证异常不悬挂连接、不拖垮进程 |
| **订单查询容错** | `orders.ts` 的 `resolveOrderContext` 为 async 且吞掉异常，订单查询失败不影响主对话；订单号自动规范化（去空格/转大写）；查不到时向 Agent 注入「未命中引导文案」而非静默无反馈 |

> ⚠️ 客户对话与满意度评价接口保持匿名公开（客服机器人面向终端用户）。管理员令牌是访问全部客户 PII、会话记录与工单的唯一凭证，请妥善保管并通过环境变量固化密码与签名密钥。

---

## 生产部署

```bash
# 1. 构建前端
npm run build            # 产物输出到 dist/

# 2. 配置生产环境变量（建议写入 .env）
#    ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_TOKEN_SECRET（必配）
#    INGEST_SECRET（必配，若启用邮件/IM 等多渠道接入；缺失则 /api/ingest/* 返回 503）
#    ALLOWED_ORIGINS=https://your-domain.com
#    TRUST_PROXY=1（置于反向代理后）
#    NODE_ENV=production（由 Express 直接托管 dist/）
#    LOG_FILE=logs/server.log（开启审计日志）

# 3. 启动（单进程同时提供 API 与前端静态资源）
npm run start           # 等价于 tsx server/index.ts
```

反向代理（Nginx）示例要点：`proxy_pass http://127.0.0.1:3000;`、`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`、`proxy_set_header Host $host;`，并配置 `client_max_body_size` 与 SSE 长连接超时。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动（同时拉起后端 :3000 与前台 :5173）
npm run dev

# 3. 浏览器打开
#    客服工作台:  http://localhost:5173/
#    管理后台:    http://localhost:5173/admin
```

其他脚本：

```bash
npm run server        # 仅启动后端
npm run dev:client    # 仅启动前端（Vite，代理 /api -> :3000）
npm run build         # 前端类型检查 + 生产构建（dist/）
npm run start         # 生产启动：托管 dist/ 并对外提供 API（NODE_ENV=production）
npm run preview       # 预览生产构建
```

> 前端通过 Vite 代理将 `/api/*` 转发到后端 `:3000`，无需额外配置 CORS。

---

## 环境变量

复制 `.env.example` 为 `.env`（可选，均有默认值）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端端口 |
| `DEFAULT_MODEL` | `auto` | 默认大模型，**必须是本账号支持列表中的值**（不支持 `claude-sonnet-4` 等）；账号不支持时自动回落候选模型 |
| `AGENT_MODE` | `auto` | `auto`：优先 SDK 失败降级；`sdk`：强制 SDK；`local`：纯知识库 |
| `AGENT_TIMEOUT_MS` | `20000` | 单次模型尝试的首 token 等待上限，超时则尝试下一个候选模型 |
| `AGENT_CHAIN_BUDGET_MS` | `45000` | 整条模型兜底链的总等待预算，避免多模型依次超时叠加成超长挂起 |
| `BRAND_NAME` | `云智科技` | 品牌名（用于系统提示词与界面标题） |
| `SEED_DEMO` | `1` | 启动时是否写入演示数据（9 条历史会话） |
| `ADMIN_USERNAME` | `admin` | 管理后台登录用户名 |
| `ADMIN_PASSWORD` | 随机生成 | 管理后台登录密码（**生产务必显式设置**强密码） |
| `ADMIN_TOKEN_SECRET` | 临时生成 | 令牌签名密钥（**生产务必设置固定强随机值**，否则重启后登录态失效） |
| `ADMIN_TOKEN_TTL_SEC` | `604800` | 管理员令牌有效期（秒，默认 7 天） |
| `INGEST_SECRET` | 未设置 | **外部渠道接入密钥**（邮件/IM 网关调用 `/api/ingest/*` 时必传，缺失则端点返回 503 拒绝服务）。请求体 `secret` 字段或 `x-ingest-secret` 头，须等于本变量。生产务必设置高强度值 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 聊天接口限流窗口（毫秒） |
| `RATE_LIMIT_MAX` | `20` | 限流窗口内单 IP 最大请求数 |
| `ALLOWED_ORIGINS` | `localhost:5173,3000` | CORS 允许来源（逗号分隔） |
| `TRUST_PROXY` | `0` | 反向代理信任（置于 Nginx/网关后设为 `1`） |
| `LOG_FILE` | 空（仅控制台） | 访问/错误日志落盘路径（如 `logs/server.log`） |
| `NODE_ENV` | `development` | 设为 `production` 时由 Express 托管 `dist/` |
| `EMAIL_ENABLED` | 未设置 | **真实邮件网关开关**：设为 `true` 且 IMAP/SMTP 凭证齐全时启动 IMAP 收件轮询 + SMTP 回执；否则网关自动禁用（服务照常运行，可走 `/api/ingest/email` webhook 或 `simulateInboundEmail` 本地验证） |
| `EMAIL_IMAP_HOST` / `EMAIL_IMAP_PORT` | 空 / `993` | IMAP 服务器地址与端口（SSL/TLS） |
| `EMAIL_IMAP_USER` / `EMAIL_IMAP_PASS` | 空 | IMAP 登录账号与密码 |
| `EMAIL_IMAP_MAILBOX` | `INBOX` | 轮询邮箱文件夹 |
| `EMAIL_SMTP_HOST` / `EMAIL_SMTP_PORT` | 空 / `465` | SMTP 发件服务器地址与端口 |
| `EMAIL_SMTP_USER` / `EMAIL_SMTP_PASS` | 空 | SMTP 发件账号与密码 |
| `EMAIL_SMTP_SECURE` | `true` | SMTP 是否启用隐式 TLS（465 通常为 true；587 提交用 false + STARTTLS 时设为 `false`） |
| `EMAIL_FROM` | 空（回退 `EMAIL_SMTP_USER`） | 回执发件人地址 |
| `EMAIL_POLL_INTERVAL_MS` | `30000` | IMAP 轮询间隔（毫秒） |
| `EMAIL_BATCH_SIZE` | `20` | 单轮最多处理未读邮件数（上限 100） |
| `CSA_PUBLIC_BASE_URL` | 空（回退相对路径） | **CSAT 问卷公开链接前缀**（如 `https://kf.example.com`）：邮件/IM 场景生成绝对链接 `https://kf.example.com/survey/:token`；未设则回退前端相对路径 `/survey/:token` |
| `EMAIL_SMTP_MAX_RETRIES` | `3` | 单次投递最多重试次数（仅对瞬时可恢复错误：超时 / 4xx 临时 / 连接抖动） |
| `EMAIL_SMTP_RETRY_DELAY_MS` | `800` | 两次重试之间的退避延迟（毫秒） |
| `EMAIL_SMTP_TIMEOUT_MS` | `10000` | 连接 / 握手 / 套接字超时（毫秒），超时计一次失败并重试 |
| `PROMETHEUS_TOKEN` | 空 | **监控抓取静态令牌**：设置后 Prometheus/Grafana 可用 `Bearer <PROMETHEUS_TOKEN>` 直连 `/api/admin/metrics/prometheus`；未设置则回退管理员 JWT |
| `ALERT_EMAIL` | 空 | **告警邮件收件人**（逗号分隔多人，如 `oncall@x.com,ops@x.com`）；配合 `EMAIL_SMTP_*` 让 `alert-relay` 把告警发到邮件；为空则跳过邮件渠道 |
| `ALERT_RELAY_PORT` | `9099` | 告警中继服务 `alert-relay` 端口（`/webhook` 收 Alertmanager 回调，`/health` 探活） |
| `QIDIAN_WEBHOOK_URL` | 空 | **腾讯企点群机器人 webhook 地址**；配齐后 `alert-relay` 把告警推到企点群；为空则跳过企点渠道 |
| `QIDIAN_MSG_TYPE` | `markdown` | 企点消息类型：`markdown` 或 `text` |
| `QIDIAN_MENTION` | 空 | 企点消息可选 @ 成员，如 `@all` 或 `@张三`（拼进正文） |

> **SMTP 发件与 IMAP 轮询解耦**：`EMAIL_ENABLED=true` 下，仅配置 `EMAIL_SMTP_*` + `EMAIL_FROM` 即可发件（CSAT 问卷 / 回执），无需 IMAP；完整网关（收+发）才需额外 `EMAIL_IMAP_*`。运维看板 `emailGateway.smtpEnabled` 可确认发件是否就绪。

---

## 目录结构

```
smart-service-agent/
├── server/                # 后端
│   ├── index.ts           # 入口：SSE 对话管线 + 全部 REST 路由 + 鉴权/限流/静态托管
│   ├── db.ts              # SQLite 数据层（7 张表 + 统计聚合 + 分页/导出 + v5 迁移）
│   ├── auth.ts            # 管理员鉴权（HMAC 令牌 + scrypt 密码校验）
│   ├── ratelimit.ts       # 滑动窗口限流
│   ├── middleware.ts       # 集中错误处理 / 404 / 安全响应头（零依赖）
│   ├── logger.ts          # 结构化日志与访问审计
│   ├── intent.ts          # 意图识别引擎（extractIntents / isSmallTalk）
│   ├── knowledge.ts       # FAQ 检索 + 种子知识 + recommendFaqs
│   ├── nlp.ts             # 中文轻量分词 / Dice 相似度
│   ├── orders.ts          # 订单模拟数据（生产替换为真实 API）
│   ├── handoff.ts         # 转人工规则引擎（evaluateHandoff / buildHandoffMessage）
│   ├── profile.ts         # 客户画像（tier 推导 / 滚动情绪 / enrichProfile）
│   ├── tickets.ts         # 工单优先级 / 分配 / SLA 引擎（computePriority / computeSlaDue / assignTicket）
│   ├── channels.ts        # 多渠道统一接入（email/im 收敛 + 跨渠道画像聚合 + 业务意图自动建单）
│   ├── emailGateway.ts    # 真实邮件网关（IMAP 收件轮询 + SMTP 发件回执，配置化启用，缺省自动禁用）
│   ├── validate.ts        # 统一请求参数校验（asString / asIntInRange / asOneOf / asTagString / asBool）
│   ├── express-augment.d.ts # req.user / req.adminUser 类型声明
│   └── seed.ts            # 演示数据
├── src/                   # 前端（React + TS + Tailwind）
│   ├── App.tsx            # 双路由 + 顶栏
│   ├── pages/             # CustomerPage / AdminPage
│   ├── components/        # 工作台与后台组件（含 IntentChart 看板图、ConversationTable 渠道筛选）
│   └── hooks/             # useChat / useApi / useAdmin / useTheme
└── data/chat.db           # SQLite 数据库（运行时生成）
```

---

## 主要接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/chat` | 公开 | 核心对话（SSE：`init` → `analysis`（含 `intents` 多意图）→ `recommend`（无命中时）→ `handoff` → `text`* → `notice` → `done`） |
| POST | `/api/embed/chat` | 公开 | 嵌入站点对话（同源管线，独立限流） |
| GET | `/api/meta` | 公开 | 引擎元信息（SDK 可用性、模型、意图列表） |
| POST | `/api/admin/login` | 公开 | 管理员登录，返回 Bearer 令牌 |
| GET | `/api/sessions` `/api/sessions/:id` | **管理** | 会话与历史（含客户 PII，需鉴权） |
| GET | `/api/faqs` | 公开 | 知识库检索（读） |
| POST | `/api/faqs/recommend` | 公开 | 知识库推荐（低阈值 0.12 召回，驱动「猜你想问」） |
| POST/PATCH/DELETE | `/api/faqs` | **管理** | 知识库写入管理 |
| POST | `/api/satisfaction` | 公开 | 满意度评价（客户提交） |
| GET | `/api/satisfaction` | **管理** | 满意度读取（含明细，需鉴权） |
| GET | `/api/csat/survey/:token` | 公开 | CSAT 匿名问卷元信息（仅返回状态，不泄露 PII） |
| POST | `/api/csat/submit` | 公开 | CSAT 匿名提交满意度问卷（凭 `survey_token`，rating 1–5） |
| GET | `/api/admin/csat` | **管理** | CSAT 聚合统计（派发/回收/回收率/平均分/分布/分渠道/近期） |
| POST | `/api/admin/csat/dispatch` | **管理**（admin/manager） | CSAT 手动补派问卷 |
| POST | `/api/admin/tickets/:id/resolve` | **管理** | 解决工单并自动派发 CSAT 问卷 |
| GET/PATCH | `/api/tickets` `/api/tickets/:id` | **管理** | 工单查询与更新（含 `priority`/`assignee`/`sla_due_at`/`channel`） |
| GET | `/api/customers/:customerId/profile` | **管理** | 读取客户画像（tier / 滚动情绪 / 标签 / 历史摘要） |
| PUT | `/api/customers/:customerId/profile` | **管理** | 更新/创建客户画像（upsert） |
| POST | `/api/ingest/email` | **密钥** | 邮件渠道统一接入（body `secret` 或头 `x-ingest-secret` 须等于 `INGEST_SECRET`） |
| POST | `/api/ingest/im` | **密钥** | 即时通讯渠道统一接入（同上） |
| GET | `/api/admin/stats` | **管理** | 管理后台统计聚合（含渠道/客户等级分布、SLA、首响时延） |
| GET | `/api/admin/conversations` | **管理** | 对话记录（支持 status/intent/keyword/**channel** 筛选 + page/pageSize 分页） |
| GET | `/api/admin/conversations/export` | **管理** | 对话记录 CSV 导出（含 BOM，四渠道通用） |
| POST | `/api/admin/reset-demo` | **管理** | 重置为演示数据 |

---

## 增强模块详解（多渠道 / 画像 / 推荐 / 优先级引擎 / 看板）

本节说明在「意图识别 → FAQ 检索 → 自动转人工」基座之上新增的七大能力，覆盖**运行、运维、扩展**三视角。

### 1. 多渠道统一接入（`server/channels.ts`）

网页（web）、嵌入（embed）、邮件（email）、即时通讯（im）四类渠道统一收敛进 `sessions` 表，以 `channel` 字段区分；同一客户跨渠道以稳定客户标识打通画像：

```
跨渠道客户标识 = `ext_${channel}:${from.toLowerCase()}`   // 例：ext_email:customer@corp.com
```

- **接入端点**（需 `INGEST_SECRET` 鉴权，见环境变量表）：
  - `POST /api/ingest/email` —— 邮件网关调用，body 带 `subject` 字段；
  - `POST /api/ingest/im` —— 即时通讯网关调用。
  - 鉴权：`body.secret` 或请求头 `x-ingest-secret`，等于 `INGEST_SECRET`；未配置 `INGEST_SECRET` 时端点返回 `503` 拒绝服务。
- **请求体（IngestInput）**：`{ channel, externalId, from, message, subject?, siteId?, customerName?, preferredAgentId? }`。`from`/`externalId` 缺失或 `message` 为空会直接返回 `{ error }`。
- **线程连续性**：同一客户在本渠道 24h 内的未结会话会被复用，保证邮件/IM 多轮上下文不丢。
- **决策与实时聊天同源**：走同一套 `classifyIntent → retrieveFaqs → evaluateHandoff` 逻辑；异步渠道**不使用 LLM**，仅用知识库直答 + 引导话术（`composeExternalReply`），因此沙箱/无头环境也能稳定服务。
- **写入后队列（高吞吐）**：ingest 同步完成意图/KB/转人工/建单**决策并返回**，所有 DB 写入（会话/双消息/意图流水/工单/画像）作为可序列化作业投入 `server/writeQueue.ts`，由**主线程异步批量落库**（内存缓冲按 `FLUSH_MS=15ms` 周期或 `MAX_BATCH=150` 超量触发 `execBatch` 事务批量写，写入被批处理摊销）。主线程每请求仅做一次廉价内存 push，写延迟被分摊，吞吐由 ~84 req/s 提升至 ~490 req/s（详见 `PERF_REPORT.md` 第 8 节）。会话续接靠 `server/sessionRegistry.ts` 内存索引同步维护，写后延迟落库期间不重复建单。`/api/health` 的 `writeQueue.mode` 恒为 `inline`（主线程写后批处理，非独立线程）。
  - **KB 检索零冗余 + LRU**（`server/knowledge.ts`）：FAQ 语料（关键词/问题/答案/标签）在源缓存刷新时一次性 `normalize` + `tokenizeSet` 预计算并缓存，热路径不再逐请求重复切分；每条 `retrieveFaqs` 仅对 query 做一次切分；检索结果按「归一化 query + intent + topK」做 LRU（容量 5000），真实流量中的重复/相似问题（如「怎么退款」「NB-IoT 和 Cat.1 怎么选」）命中后跳过整轮打分，重复查询路径吞吐约 **2×**、p95 约半（详见 `PERF_REPORT.md` 第 9 节）。
  - ⚠️ **架构修正（重要）**：早期版本曾尝试将写入 offload 到独立 worker 线程（`server/writeWorker.ts`），但在本工具链（tsx + Node `worker_threads`）下，worker 线程内对相对 `.js` 扩展名 → `.ts` 源的解析不生效，worker 依赖链（writeExec→db→logger）全部报 `Cannot find module`，worker 实际从未加载；此前所谓「worker 模式」吞吐提升实为批处理机制本身。现改为主线程 write-behind 批处理：逻辑更简单、零兼容坑，且保留同等吞吐收益。
- **建单规则**（关闭漏单隐患）：
  - 业务意图 `complaint / refund / tech_support / order_query` 入站 → **默认建单跟踪**（priority 由优先级引擎计算）；
  - `greeting / other` → 仅知识库直答，不建单；
  - `evaluateHandoff` 触发升级 → 标记 `handoff=true` 并升级优先级；
  - 会话维度防重：已有未结工单则不再重复建单。

### 2. 客户画像与情绪（`server/profile.ts`）

- 数据落 `customer_profiles` 表：`tier`（new/regular/vip）、`last_intent`、`sentiment_score`（滚动情绪）、`last_contact_at`、以及人工维护的 `company/industry/tags/notes/preferences/history_summary`。
- **tier 推导**（`deriveTier`）：会话 ≥10 次 → vip；B2B（有公司/行业）且 ≥5 次 → vip；≥3 次 → regular；否则 new。
- **滚动情绪**（`enrichProfile`）：`sentiment = prev*0.8 + delta*0.2`，本地负面词表命中 `delta=-1`；整段容错包裹（`catch → logger.warn`），异常不影响主链路。
- **读写接口**：`GET/PUT /api/customers/:customerId/profile`（需管理员鉴权），`PUT` 为 upsert，字段经 `validate.ts` 统一校验。

### 3. 知识库推荐（猜你想问）

- `POST /api/faqs/recommend`：低准入阈值（0.12）召回相关 FAQ，body 支持 `query / intent? / topK? / excludeIds?`，用于「客户没问到点子上」时的主动推荐。
- 实时聊天中，当标准答案无命中（`hitIds` 为空）且非闲聊（`isSmallTalk` 为假）时，SSE 管线会下发 `recommend` 事件（payload `faqs: [{id,question,category,score}]`），前端 `CustomerPage` 渲染「猜你想问」可点击卡片，点击即追问。

### 4. 工单优先级 / 分配 / SLA 引擎（`server/tickets.ts`）

与 `handoff.ts` 职责分工：**handoff 决定「要不要转」，本引擎决定「多急、给谁」**，全部可解释、可复现。

- **意图权重** `INTENT_PRIORITY_WEIGHT`：complaint 8 / refund 6 / tech_support 5 / order_query 3 / other 2 / greeting 1 / human_service 0。
- **客户等级权重** `TIER_WEIGHT`：vip 2 / regular 1 / new 0。
- **优先级档位**（按综合分）：`score ≥ 12 → urgent` / `≥ 8 → high` / `≥ 4 → medium` / 否则 `low`。
- **SLA 时限** `SLA_MINUTES`：urgent 30 / high 120 / medium 480 / low 1440（分钟），`computeSlaDue` 输出 ISO 时间写入 `tickets.sla_due_at`。
- **分配策略** `assignTicket`：
  - 指定 `preferredAgentId`（技能匹配）→ 优先派给该坐席；
  - 否则**负载均衡**：在在职（active）的 agent/manager 中选「未结工单最少」者，同负载时 manager 优先，再按 id 稳定排序；
  - 无在职坐席 → 返回 `assignee=null`（工单进入公共队列，后台可手动指派）。
- **存量补算** `backfillSlaDue()`：为无 `sla_due_at` 的历史工单幂等补算，迁移/升级后调用一次即可。

### 5. 增强后台看板（前端 `IntentChart` + `AdminPage`）

`GET /api/admin/stats` 在原有意图/评分/趋势基础上新增以下聚合（均经类型校验，缺失自动降级为空结构）：

| 字段 | 含义 | 前端呈现 |
| --- | --- | --- |
| `channelDistribution` | 各渠道会话数（web/embed/email/im） | 渠道分布环形图 `ChannelDonut` |
| `customerTierDistribution` | 客户等级分布（new/regular/vip） | 客户等级分布环形图 `TierDonut` |
| `ticketSla` | `{ open, breached, withinSla }` | 工单 SLA 面板（含超时率条）`SlaPanel` |
| `responseTimes` | `{ avg, median, p95, sampleSize }` 首次响应时延 | 首响时延面板 `ResponsePanel` |
| `unresolvedByPriority` | 按优先级分组的未结工单数 | 与既有工单统计并排 |

- **对话列表渠道筛选**：`ConversationTable` 新增「来源」下拉（网页/嵌入/邮件/即时通讯），来源列按四渠道配色区分；筛选经 `getConversationList(filters.channel)` 全链路下推到 SQLite（v5 已建 `idx_tickets_channel` / `idx_sessions_channel` 类索引），互不串渠道。
- **看板可观测性**：运营看板 4 列网格（渠道分布 / 客户等级 / 工单 SLA / 首响时延）与「运行概览」指标卡片并列，刷新策略与既有一致。

### 6. 扩展指引：如何新增一个接入渠道

以「新增微信客服渠道」为例，仅三处改动、不动核心逻辑：

1. **类型**：在 `server/channels.ts` 的 `ChannelType` 联合类型加 `'wechat'`；
2. **路由**：在 `server/index.ts` 加一行 `app.post('/api/ingest/wechat', handleIngest('wechat'));`（`handleIngest` 工厂已复用 `ingestExternalMessage`）；
3. **网关映射**：在你的微信网关回调里，把微信消息映射为 `IngestInput`（`from`=openid、`externalId`=msgid、`message`=文本内容、`subject?`=标题），并以 `secret: process.env.INGEST_SECRET` 调用即可。

> 接入层与决策层解耦：任何新渠道只需把外部消息「翻译」成 `IngestInput`，意图识别、知识库、转人工、建单、画像全部自动复用，无需改写管线。

### 7. 客户满意度评价（CSAT）（`server/csat.ts` + 迁移 v8 `csat_surveys`）

在工单解决 / 会话关闭后，向客户派发满意度问卷，客户凭匿名 token 提交 1–5 星评分与留言，系统回收并聚合。完整规格见 **`CSAT_MODULE.md`**，此处为要点速览。

- **触发（两路）**：
  - **自动（核心）**：`POST /api/admin/tickets/:id/resolve` 将工单置 `resolved` 时自动派发；邮件渠道用会话 `customer_id` 作收件人。
  - **手动（辅助）**：`POST /api/admin/csat/dispatch`（admin/manager）对任意会话补派。
- **幂等与防打扰**：同会话已有 `pending` 问卷则复用（`getOpenCsatSurveyForSession`），不重复推送。
- **匿名提交安全**：`survey_token` 一次性 UNIQUE；7 天 TTL **惰性过期**（超时提交返回 410）；重复提交返回 409；`rating` 必须为 1–5 整数，否则 400。`/api/csat/survey/:token` 仅返回状态，**不泄露 PII**。
- **数据闭环**：提交成功同步写 `satisfaction` 表（`resolved = rating>=4`），复用运营看板与评分分布；聚合看板 `GET /api/admin/csat` 返回派发/回收/回收率/平均分/NPS 近似/分布/分渠道/近期。
- **邮件集成**：复用 `emailGateway.sendMail`；未启用 SMTP 时模拟发送不阻断。
- **可观测性**：Prometheus 新增 `csa_csat_surveys_total` / `csa_csat_responses_total` / `csa_csat_response_rate` / `csa_csat_avg_rating` 四条指标。
- **前端**：公开问卷页 `SurveyPage`（路由 `/survey/:token`，星级 + 快捷标签 + 留言，无需登录）；管理后台「客户满意度（CSAT）」卡片区（6 指标瓦片 + 评分分布 + 分渠道 + 近期评价，独立轮询）。

### 8. 邮件投递与监控（重试 / 指标 / Grafana）

CSAT 问卷邮件与入站回执统一经 `server/emailGateway.ts` 的 `sendWithRetry` 投递，内置**重试 + 超时 + 错误分类 + 指标**。完整设计、真实对接、Mock 联调、Prometheus/Grafana 接入与告警处置见 **`EMAIL_MONITORING.md`**，要点：

- **重试与错误分类**：仅对瞬时可恢复错误（超时 / `421/450/451` / 连接抖动）重试，最多 `EMAIL_SMTP_MAX_RETRIES`（默认 3）次；鉴权 / 收件人 / 配置类永久错误立即放弃，不空转重试。超时由 `EMAIL_SMTP_TIMEOUT_MS`（默认 10s）控制。
- **SMTP 与 IMAP 解耦**：仅配 `EMAIL_SMTP_*` 即可发件（CSAT 问卷），无需 IMAP；看板 `emailGateway.smtpEnabled` 反映发件就绪状态。
- **投递指标**：`getEmailDeliveryStats()` 累计发送量（按 `type`/`status`）、成功率、错误率、重试数、延迟（最近/累计/平均），由 `/api/admin/metrics/prometheus` 导出为 `csa_email_*` 系列：
  - `csa_email_send_total`（counter，标签 `type`/`status`）、`csa_email_send_retries_total`、`csa_email_send_latency_sum_seconds`、`csa_email_send_latency_last_seconds`、`csa_email_send_latency_avg_seconds`、`csa_email_send_success_rate`、`csa_email_send_error_rate`。
- **Grafana 一键接入**：`monitoring/` 提供 Prometheus 抓取配置、告警规则、Grafana 数据源与**仪表盘 JSON（10 面板：邮件发送量 / 成功率 / 错误率 / 延迟 / 重试率 / CSAT 派发回收 / 回收率 / 平均分 / 工单分布 / 可用性）**。设置 `PROMETHEUS_TOKEN` 静态令牌后 `docker compose up -d` 即可。
- **告警通知渠道（邮件 + 腾讯企点）**：告警经 `prometheus.yml` 顶层 `alerting:` 块推给 **Alertmanager（9093）**，由其聚合/抑制/路由后回调独立中继服务 **`alert-relay`（9099）**，再分流投递到 **SMTP 邮件**（`ALERT_EMAIL` 收件人，复用 `EMAIL_SMTP_*` 凭证）与 **腾讯企点群机器人 webhook**（`QIDIAN_WEBHOOK_URL`）。两渠道各自独立容错，`send_resolved: true` 恢复也通知。配置/验证/Runbook 见 **`EMAIL_MONITORING.md` §7**。本地免 Docker 验证：`node scripts/verify_alert_notify.mjs`（18/18 通过）。
- **端到端联调（免外网）**：`scripts/mock-smtp-server.mjs` + `scripts/verify_email_delivery.ts` 用本地真实 SMTP 协议验证「发送→接收→瞬时重试→永久错误→超时」，已通过 13/13 断言。

---

## 真实邮件网关（IMAP 轮询 + SMTP 回执）

`server/emailGateway.ts` 在「多渠道统一接入」基础上补齐了**真实邮箱收发闭环**：周期性从 IMAP 收件箱拉取未读邮件，经 `ingestExternalMessage`（与 web/embed/im 同源决策逻辑）生成自动回执，再通过 SMTP 发回客户。

**设计要点**

- **配置化启用、缺省零副作用**：仅当 `EMAIL_ENABLED=true` 且 IMAP/SMTP 凭证齐全时才启动轮询；否则 `startEmailGateway()` 仅打印告警并置 `disabled`，服务照常运行。非常适合「先上线、后接邮箱」的渐进部署。
- **业务同源**：邮件的意图识别 / FAQ / 转人工 / 建单全部复用 `channels.ts`，规则不分裂；异步渠道不使用 LLM（知识库直答 + 引导话术），无头环境也能稳定服务。
- **幂等与去重**：以邮件 `Message-ID` 为键落库 `processed_emails`（v7 迁移，跨重启持久化）；处理成功后才标记 `\Seen` 并尝试移入 `Processed` 归档目录（目录不存在静默忽略），双重保险避免重复回复。
- **回执先行于去重**：仅当 SMTP 发送成功后才记录 `processed_emails`；发送失败则保留邮件于未读、下轮重试，杜绝「客户没收到回执却已标记已处理」。
- **依赖按需加载**：`imapflow` / `mailparser` / `nodemailer` 以动态 `import` 加载，编译期不要求安装；**仅当真实启用网关时才解析**，缺失时 `sendReply` 捕获异常返回 `false`（邮件保留重试），不污染服务启动。

**本地验证（无需真实邮箱）**

`simulateInboundEmail({ from, subject?, message })` 直接走完整「收信 → 处理 → 回执 → 落库去重」管线，未配置 SMTP 时打印 `[SIM]` 回执并置 `sent=true`。配套验证脚本：

```bash
CSA_DB_PATH=data/test_email.db ./node_modules/.bin/tsx verify_email_gateway.ts
```

覆盖四类意图（订单查询 / 技术支持 / 寒暄 / 投诉）、去重记录、以及「同客户二次来邮复用会话」的线程连续性，全部断言通过即表示邮件渠道闭环可用。

**生产启用步骤**

1. 安装运行期依赖（真实收发才需要）：`npm install imapflow mailparser nodemailer`（或等价包管理）。
2. 在 `.env` 配置 `EMAIL_ENABLED=true` 及上述 IMAP/SMTP 全部变量（详见环境变量表）。
3. 启动后查看 `GET /api/health` 的 `emailGateway` 块：`enabled=true / connected=true` 表示已连箱并开始轮询；`reason` 会精确列出任何缺失配置项。

> 注：邮件网关与既有的 `POST /api/ingest/email` webhook 是两条互补接入路径——前者适合「自托管邮箱、由本服务主动拉取」，后者适合「已有邮件系统（如 Exchange/Postfix 过滤器）主动推送到本服务」。两者底层都收敛到 `ingestExternalMessage`，业务规则完全一致。

---

## 说明

- 演示数据：`SEED_DEMO=1` 时，启动写入 9 条**端侧 AI / IoT 模组解决方案**场景历史会话（客户为企业研发/采购/项目经理，覆盖模组选型、端侧 NPU 推理、功耗续航、认证入网、SDK/OTA、量产采购、FAE 转人工、批量交付客诉、商务开票），以及 18 条 IoT 模组知识库 FAQ（7 大分类：模组选型/端侧AI推理/功耗续航/认证入网/开发工具链/量产采购/商务支持），管理后台零使用即有真实业务数据。
- 订单数据当前为内存模拟（`server/orders.ts`），接入生产时替换为真实订单 API 即可。
- 真实大模型（LLM 生成回复）取决于 CodeBuddy 账号**交互式登录鉴权**：在本机终端执行 `npx @tencent-ai/agent-sdk login`（或对应 CLI）完成登录后，服务端首轮真实对话即可启用大模型；**未登录 / 沙箱无头环境会自动降级为「知识库直答」**，意图识别、FAQ 检索、转人工、历史持久化与管理后台均不受影响。
- 知识库直答引擎在标准答案直引、相关推荐、订单上下文优先、意图感知兜底等方面已做准生产级打磨，即使不启用 LLM 也能提供高质量自助服务。
