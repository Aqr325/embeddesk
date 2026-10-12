# 邮件投递与监控（Email Delivery & Monitoring）

> 适用范围：CSAT 满意度问卷邮件、入站邮件自动回执（reply）的 SMTP 投递、重试、可观测性、Grafana 监控，**以及告警通知渠道（邮件 + 腾讯企点）**。
> 配套代码：`server/emailGateway.ts`（`sendMail` / `sendReply` / `sendWithRetry` / `getEmailDeliveryStats`）、`server/index.ts`（Prometheus 导出）。
> 配套脚本与配置：`scripts/mock-smtp-server.mjs`、`scripts/verify_email_delivery.ts`、`monitoring/`（含 `alertmanager.yml` / `alert-relay.mjs` / `verify_alert_notify.mjs`）。

---

## 1. 投递链路设计

```
业务触发
  ├─ CSAT 工单 resolved / 手动 dispatch ──► dispatchSurvey() ──► emailGateway.sendMail()   (type=csat)
  └─ 入站邮件处理回执                   ──► processMessage()  ──► emailGateway.sendReply() (type=reply)
                                                    │
                                                    ▼
                                          sendWithRetry(cfg, mail, type)
                                           ├─ 创建 nodemailer transport（含连接/握手/套接字超时）
                                           ├─ 尝试发送（最多 1 + EMAIL_SMTP_MAX_RETRIES 次）
                                           ├─ 失败分类：retry（瞬时可恢复） / fail（永久）
                                           └─ 每次结果计入投递指标（见 §3）
```

### 1.1 重试与超时

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `EMAIL_SMTP_MAX_RETRIES` | `3` | 单次投递的最多重试次数（不含首次尝试） |
| `EMAIL_SMTP_RETRY_DELAY_MS` | `800` | 两次重试之间的退避延迟 |
| `EMAIL_SMTP_TIMEOUT_MS` | `10000` | 连接 / 握手 / 套接字超时（毫秒），超时即算一次失败并重试 |

### 1.2 错误分类（决定「是否重试」）

仅对**瞬时可恢复**错误重试，避免对永久错误空转刷重试：

- **重试（retry）**：网络超时（`ETIMEDOUT`/`ECONNABORTED`）、连接重置（`ECONNRESET`）、临时 DNS（`EAI_AGAIN`）、SMTP 临时响应 `421/450/451`、限流 / 临时不可用。
- **放弃（fail，不重试）**：鉴权失败（`535/534/530 auth`）、收件人被拒（`550/551/552/553/554`）、请求语法（`501/503/504`）、TLS 证书错误、域名解析失败（`ENOTFOUND`）、连接被拒（`ECONNREFUSED`，属配置错误）。

> 兜底策略：未明确匹配的错误保守判为「可重试」（多数网络抖动会在重试中恢复）。

### 1.3 配置解耦：SMTP 发件 ≠ IMAP 轮询

`EMAIL_ENABLED=true` 下：

- **仅 SMTP**（只发问卷、不收信）：只需 `EMAIL_SMTP_*` + `EMAIL_FROM` 即可发件（`smtpEnabled=true`，邮件照常投递并计入指标）。
- **完整网关**（收+发）：还需 `EMAIL_IMAP_*`，`enabled=true` 启动 IMAP 轮询。

运维看板 `/api/admin/metrics` 的 `emailGateway.smtpEnabled` 字段可确认发件是否就绪。

---

## 2. 真实邮件服务对接（联调）

沙箱通常无外网 / 无真实凭证，故提供两种「真·端到端」验证方式：

### 2.1 本地 Mock SMTP（推荐，零依赖）

`scripts/mock-smtp-server.mjs` 用纯 Node 实现最小 SMTP 服务，承接真实 nodemailer SMTP 协议：

```bash
# 终端 1：起一个「正常接收」的 mock
node scripts/mock-smtp-server.mjs --smtp 3201 --http 3211 --mode capture --out /tmp/smtp_recv.jsonl

# 终端 2：跑端到端联调（发送 / 接收 / 瞬时可恢复重试 / 永久错误 / 超时）
node_modules/.bin/tsx scripts/verify_email_delivery.ts
```

`verify_email_delivery.ts` 会起 4 个 mock（capture / fail-transient / fail-permanent / slow），验证：

- CSAT 派发 → 真实 SMTP → mock 收到含 `/survey/` 链接的邮件；
- `451` 瞬时可恢复 → 重试 `MAX_RETRIES` 次后失败；
- `550` 永久错误 → 不重试直接失败；
- `slow`（服务端故意延迟）→ 触发超时 → 重试并记录延迟；
- 投递指标随场景正确变化（发送量 / 成功率 / 重试数 / 延迟）。

> 验证结果：13/13 通过（见提交记录）。

### 2.2 接入真实 SMTP / 邮件发送 API

把以下环境变量指向你的邮件服务商（如腾讯企业邮、阿里云邮件推送、SendGrid、Amazon SES 等），重启服务即可：

```bash
EMAIL_ENABLED=true
EMAIL_SMTP_HOST=smtp.your-provider.com
EMAIL_SMTP_PORT=465            # 或 587（STARTTLS）
EMAIL_SMTP_SECURE=true         # 465 用 true；587 视服务商
EMAIL_SMTP_USER=api@your-domain.com
EMAIL_SMTP_PASS=****            # 注意：部分服务商是「授权码」而非登录密码
EMAIL_FROM=no-reply@your-domain.com
# 可选调优
EMAIL_SMTP_MAX_RETRIES=3
EMAIL_SMTP_RETRY_DELAY_MS=800
EMAIL_SMTP_TIMEOUT_MS=10000
```

- 若使用邮件发送 API（HTTP 形式），需自行封装为 `sendMail` 的另一种实现（当前为 SMTP 直连；SMTP 几乎被所有主流服务商支持）。
- 收件人来自 CSAT 派发时的 `toAddress`（工单 resolved 自动派发取 `sessions.customer_id` 对应邮箱）。

---

## 3. 投递指标（Prometheus / Grafana 数据源）

`emailGateway.getEmailDeliveryStats()` 累计全进程投递指标，由 `/api/admin/metrics/prometheus` 导出：

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `csa_email_send_total` | counter | 邮件发送量，标签 `type=csat\|reply`、`status=success\|failure` |
| `csa_email_send_retries_total` | counter | 重试次数（仅瞬时可恢复错误触发） |
| `csa_email_send_latency_sum_seconds` | counter | 累计投递延迟（秒） |
| `csa_email_send_latency_last_seconds` | gauge | 最近一次投递延迟（秒） |
| `csa_email_send_latency_avg_seconds` | gauge | 平均投递延迟（秒） |
| `csa_email_send_success_rate` | gauge | 投递成功率（0..1） |
| `csa_email_send_error_rate` | gauge | 投递错误率（0..1） |

> 指标只统计**真实 SMTP 投递**；未启用 SMTP 时的「模拟发送」不计入（避免虚高成功率）。

---

## 4. Prometheus + Grafana 接入

### 4.1 服务端暴露抓取端点

服务端 `/api/admin/metrics/prometheus` 需要先鉴权。为便于自动抓取，设置静态令牌：

```bash
PROMETHEUS_TOKEN=<一段强随机串，建议 32+ 位>
```

- 配置了 `PROMETHEUS_TOKEN`：Prometheus 用 `Bearer <PROMETHEUS_TOKEN>` 直接抓取（推荐）；
- 未配置：回退为管理员 JWT（`requireAuth`），不适合自动抓取。

### 4.2 一键拉起监控栈

```bash
cd monitoring
export PROMETHEUS_TOKEN=<与服务端一致>
export GRAFANA_PASSWORD=admin
# ↓↓↓ 告警通知渠道（邮件 + 腾讯企点）所需环境变量（缺失则对应渠道自动跳过）↓↓↓
export ALERT_EMAIL="oncall@corp.com,ops@corp.com"   # 告警邮件收件人（逗号分隔多人）
export EMAIL_SMTP_HOST=smtp.your-provider.com       # 复用邮件网关的 SMTP 发件凭证
export EMAIL_SMTP_PORT=465
export EMAIL_SMTP_SECURE=true
export EMAIL_SMTP_USER=api@your-domain.com
export EMAIL_SMTP_PASS=****
export EMAIL_FROM=alert@your-domain.com
export QIDIAN_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx  # 腾讯企点群机器人 webhook
export QIDIAN_MSG_TYPE=markdown                     # markdown | text
export QIDIAN_MENTION=""                            # 可选：@ 成员，如 "@all" 或 "@张三"
docker compose up -d
```

- Grafana： http://localhost:3001 （admin / 你设的密码）
- Prometheus： http://localhost:9090
- Alertmanager： http://localhost:9093
- 告警中继 `alert-relay`： http://localhost:9099 （`/health` 探活）

启动后 Grafana 会自动通过 provisioning 加载：

- 数据源 `SmartServiceAgent`（uid=`prom`）→ Prometheus；
- 仪表盘 **「智能客服 Agent · 邮件投递与 CSAT 监控」**（10 个面板：邮件发送量、成功率、错误率、延迟、重试率、CSAT 派发/回收、回收率、平均分、工单分布、服务可用性）。

> 抓取目标默认 `smart-service-agent:3000`（Docker 网络内应用容器名）。若应用不在同一 compose，编辑
> `monitoring/prometheus/prometheus.yml` 把 target 改为应用可达地址（如 `host.docker.internal:3000`）。

### 4.3 配置文件清单

```
monitoring/
  docker-compose.yml                  # Prometheus + Alertmanager + alert-relay + Grafana 容器编排
  prometheus/
    prometheus.yml                    # 抓取配置（Bearer 静态令牌 + 目标）+ 顶层 alerting 块指向 alertmanager:9093
    alert.rules.yml                   # 告警规则（错误率/延迟/重试/CSAT回收率/可用性）
  alertmanager/
    alertmanager.yml                  # 告警路由/聚合/抑制 → webhook receiver（alert-relay:9099）
  grafana/provisioning/
    datasources/prometheus.yml        # Grafana 数据源
    dashboards/dashboards.yml         # 仪表盘 provider
    dashboards/smart-service-agent.json  # 监控仪表盘（10 面板）
scripts/
  alert-relay.mjs                     # 独立 Node 进程：接收 Alertmanager webhook，分流到 邮件(SMTP) / 腾讯企点(webhook)
  verify_alert_notify.mjs             # 告警通知端到端验证（mock SMTP + mock 企点 webhook，18/18 断言）
  mock-smtp-server.mjs                # 本地最小 SMTP（已支持 QP/base64 正文解码，存明文）
  verify_email_delivery.ts            # CSAT 邮件投递联调（13/13 断言）
```

---

## 5. 告警说明与处置

| 告警 | 触发 | 级别 | 可能原因 / 处置 |
| --- | --- | --- | --- |
| `EmailErrorRateHigh` | 错误率 > 20% 持续 5m | critical | SMTP 凭证失效 / 服务限流封禁 / 网络问题 → 检查 `EMAIL_SMTP_*` 与投递指标 |
| `EmailLatencyHigh` | 平均延迟 > 5s 持续 5m | warning | SMTP 链路慢 → 检查网络与 `EMAIL_SMTP_TIMEOUT_MS` |
| `EmailRetriesSustained` | 重试率 > 0.1/s 持续 10m | warning | 持续性瞬时可恢复错误 → 排查 SMTP 稳定性与重试参数 |
| `CsatResponseRateLow` | 回收率 < 30% 持续 10m | warning | 问卷邮件未送达 / 链接不可访问 / 派发覆盖不足 → 检查邮件可达性与触发逻辑 |
| `ServiceUnreachable` | `up==0` 持续 2m | critical | 服务宕机或令牌/端口错 → 立即检查进程与 `PROMETHEUS_TOKEN` |

> 告警产出后如何送达现场？见 **§7 告警通知渠道（邮件 + 腾讯企点）**：Prometheus → Alertmanager（聚合/抑制/路由）→ `alert-relay` → 分流投递到 SMTP 邮件 与 腾讯企点群机器人 webhook。`send_resolved: true`，告警恢复也会通知。

---

## 7. 告警通知渠道（邮件 + 腾讯企点）

Prometheus 仅负责**评估**告警规则；真正的「聚合、抑制、路由、送达」由 Alertmanager 完成，再由一个**独立轻量中继服务 `alert-relay`** 把告警分流到两个渠道。业务服务（smart-service-agent）与通知链路完全解耦——即使告警通知组件异常，也不影响主对话/邮件网关。

### 7.1 架构

```
                          ┌─────────────┐   alerting: alertmanager:9093
        csa_* 指标  ──────►│ Prometheus  │──────────────────────────────┐
                          └─────────────┘                               │
                                  │ 评估 alert.rules.yml                │ 触发
                                  ▼                                     ▼
                          ┌─────────────┐  group_by[alertname,severity,team]   send_resolved
                          │ Alertmanager │  group_wait 30s / group_interval 5m / repeat 4h
                          │  (9093)      │  inhibit: critical → warning（同 alertname+team）
                          └──────┬───────┘
                                 │ webhook  POST /webhook   { alerts:[{status,labels,annotations}] }
                                 ▼
                          ┌─────────────┐
                          │ alert-relay │  (独立 Node 进程, 9099; 每渠道独立容错)
                          │  (9099)     │
                          └──────┬───────┘
              ┌──────────────────┴───────────────────────┐
              ▼                                           ▼
   ┌──────────────────────┐                  ┌──────────────────────────┐
   │ ① 邮件 (SMTP)         │                  │ ② 腾讯企点 webhook        │
   │ 复用 EMAIL_SMTP_*     │                  │ QIDIAN_WEBHOOK_URL        │
   │ 收件人 ALERT_EMAIL    │                  │ msgtype: markdown | text  │
   └──────────────────────┘                  └──────────────────────────┘
```

**设计要点**
- **解耦**：`alert-relay` 是独立进程（不依赖业务服务 DB / SDK），仅消费 Alertmanager 标准 webhook，可随 Docker 编排独立伸缩/重启。
- **逐渠道容错**：邮件与企点各自独立发送；仅当**所有启用渠道都失败**时 `alert-relay` 才返回 HTTP 500，触发 Alertmanager 按 `repeat_interval` 重试；任一渠道成功即返回 200（Alertmanager 标记已通知，不重复推送）。
- **复用凭证**：邮件渠道直接复用既有的 `EMAIL_SMTP_*` / `EMAIL_FROM`，零新增依赖（仅 nodemailer，已装）；企点渠道用 `fetch` POST 群机器人 webhook，无第三方 SDK。
- **恢复通知**：Alertmanager `send_resolved: true`，告警从 firing→resolved 时再次回调，邮件/企点均带「✅ 已恢复」标记。

### 7.2 环境变量

`alert-relay` 通过环境变量配置（Docker 编排中以 `environment:` 透传；本地调试直接 `export`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ALERT_RELAY_PORT` | `9099` | 中继服务端口（`/webhook` 收 Alertmanager 回调，`/health` 探活） |
| `ALERT_EMAIL` | 空 | 告警邮件收件人，**逗号分隔多人**（如 `oncall@x.com,ops@x.com`）；为空则跳过邮件渠道 |
| `EMAIL_SMTP_HOST` / `EMAIL_SMTP_PORT` / `EMAIL_SMTP_SECURE` / `EMAIL_SMTP_USER` / `EMAIL_SMTP_PASS` | 空 | 复用邮件网关 SMTP 发件凭证（`smtpEnabled = host&&user&&pass&&from` 齐全才发） |
| `EMAIL_FROM` | 空（回退 `EMAIL_SMTP_USER`） | 告警发件人 |
| `QIDIAN_WEBHOOK_URL` | 空 | 腾讯企点群机器人 webhook 地址；为空则跳过企点渠道 |
| `QIDIAN_MSG_TYPE` | `markdown` | 企点消息类型：`markdown` 或 `text` |
| `QIDIAN_MENTION` | 空 | 可选：@ 成员，如 `@all` 或 `@张三`（拼进消息正文） |

> 若两者都未配置，`alert-relay` 仍正常启动并接收 webhook，但所有告警判定为「无可用渠道」并记入日志（返回 200，不阻塞 Alertmanager）。

### 7.3 接入与验证

**一键拉起（Docker）**：见 §4.2，compose 已含 `alertmanager` 与 `alert-relay` 两个服务，`alertmanager.yml` 的 webhook 指向 `alert-relay:9099`。

**本地免 Docker 验证（推荐）**：`scripts/verify_alert_notify.mjs` 起 mock SMTP（捕获明文）+ 内建 mock 企点 webhook + 真实 `alert-relay` 进程，模拟 firing / resolved 告警，断言两路均收到且含关键信息：

```bash
node scripts/verify_alert_notify.mjs
```

覆盖场景：① firing 双发（邮件 + 企点均命中告警名/级别）② resolved 双发带「已恢复」③ 仅配邮件、未配企点时邮件仍发、企点标记 skipped。结果 **18/18 通过**。

> mock SMTP 已修复：nodemailer 中文正文为 quoted-printable（QP）编码、Subject 为 `=?UTF-8?B?...?=` base64，mock 现正确解码并**存明文**，断言稳定可靠。

### 7.4 Runbook

| 现象 | 排查 |
| --- | --- |
| Prometheus 页面 Silence/Alerts 看不到告警 | 检查 `prometheus.yml` 顶层 `alerting:` 是否指向 `alertmanager:9093`；Alertmanager 容器是否 `Up` |
| Alertmanager 收到告警但不回调 | 看 `alertmanager.yml` 的 `receivers[0].webhook_configs.url` 是否 `http://alert-relay:9099/webhook`；`alert-relay` 容器日志是否报错 |
| 邮件收不到告警 | 检查 `ALERT_EMAIL` 与 `EMAIL_SMTP_*` 是否齐全；`/health` 返回 `smtpEnabled` 状态；用 `verify_alert_notify.mjs` 单测 |
| 企点群无消息 | 检查 `QIDIAN_WEBHOOK_URL` 是否有效（key 是否过期）；企点机器人需群内添加且 webhook 未被禁用 |
| 恢复通知没来 | 确认 `alertmanager.yml` 中 `send_resolved: true`；Alertmanager 需真正收到 resolved 状态（告警条件不再满足） |

---

## 6. 管理端实时看板

除 Grafana 外，`/api/admin/metrics`（需管理员 JWT）JSON 中也包含：

- `emailGateway`：`enabled` / `smtpEnabled` / `connected` / `reason` / 轮询计数；
- `emailDelivery`：上述全部投递指标快照（前端「运行概览」可据此展示邮件投递健康度）。
