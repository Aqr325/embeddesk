# 客户满意度评价（CSAT）模块功能规格

> 适用项目：智能客服 Agent（Smart Service Agent）
> 模块定位：在工单解决 / 会话关闭后，自动向客户派发满意度问卷，客户通过匿名 token 链接提交 1–5 星评分与留言，系统回收并聚合，为服务质量运营提供量化依据。
> 状态：已落地（后端 `server/csat.ts` + 迁移 v8 `csat_surveys` 表；前端 `src/pages/SurveyPage.tsx` + 管理后台「客户满意度（CSAT）」看板）。

---

## 1. 功能用途（What & Why）

| 维度 | 说明 |
| --- | --- |
| 直接用途 | 向刚结束服务的客户收集**满意度评分**（1–5 星）与**定性反馈**（快捷标签 + 自由留言），衡量单次服务的质量。 |
| 业务价值 | ① 量化客服团队的持续改进效果；② 识别低分会话做服务补救（差评预警）；③ 为坐席考核、知识库质量、SLA 达标提供闭环数据。 |
| 数据闭环 | 问卷提交成功后回写既有 `satisfaction` 表（`rating` 1–5，`resolved = rating>=4`），**复用运营看板与评分分布**，不另起炉灶。 |
| 与 NPS 的关系 | 本模块是 **CSAT（满意度）**，非全量 NPS（净推荐值）。指标里 `npsLike` 仅为「好评率 − 差评率」的近似，便于横向对标。 |

---

## 2. 触发条件（When）

| 触发方式 | 入口 | 说明 |
| --- | --- | --- |
| **自动（核心）** | `POST /api/admin/tickets/:id/resolve` | 工单被置为 `resolved` 时，**自动派发**问卷。邮件渠道用会话 `customer_id`（邮件场景下即邮箱）作收件人；其他渠道仅生成 token + 链接，由坐席/前端安排派发（如会话结束页、IM 卡片）。 |
| **手动（辅助）** | `POST /api/admin/csat/dispatch` | 管理员/经理可对任意会话补派问卷（如补发漏派、对历史会话追评）。 |
| **免触发** | 定时任务 | 不支持。问卷有效期靠**惰性过期**（提交/查元信息时校验 `survey_sent_at + 7d`），不依赖后台定时器。 |

**派发静默约束（防打扰）：**
- 同一会话若已有 `pending` 问卷，自动/手动派发均**幂等复用**，不重复推送（见 4.1）。
- 邮件渠道未启用 SMTP（`EMAIL_ENABLED=false`）时，`sendMail` 走**模拟发送**（仅记日志不报错），派发流程不阻断。

---

## 3. 核心业务流程（How）

### 3.1 状态机

```
          dispatchSurvey()
   [无记录] ───────────────► [pending]  ←── 幂等复用（getOpenCsatSurveyForSession）
                                │
           提交成功 submitSurvey() │   rating 1–5 合法
                                ▼
                          [completed]  ──► 同步写 satisfaction 表
                                │
           超时提交（惰性校验）  │   now - survey_sent_at > 7d
                                ▼
                          [expired]   （拒绝提交，返回 410）
```

`survey_status` 三态：`pending` / `completed` / `expired`。

### 3.2 自动派发 + 回收时序

```
坐席解决工单 ─► POST /tickets/:id/resolve（requireAuth）
                  │
                  ├─ 置 ticket.status = 'resolved'
                  ├─ 解析 channel（ticket.channel || session.channel || 'web'）
                  ├─ 邮件渠道: toAddress = session.customer_id
                  └─ dispatchSurvey({sessionId, ticketId, channel, toAddress, customerName})
                        │
                        ├─ 已有 pending → 复用，dispatched=false
                        ├─ 新建 → 写 csat_surveys(pending) + 生成 token
                        │         └─ 邮件渠道: sendMail(邀请链接)  [失败仅记日志]
                        └─ 返回 { surveyToken, surveyUrl, dispatched, channel }

客户点击链接 ─► GET  /survey/:token  (前端 SPA 公开路由，匿名)
                  │
                  └─ GET /api/csat/survey/:token → { status: 'pending'|... , rating }

客户提交评分 ─► POST /api/csat/submit（匿名，凭 token）
                  │
                  ├─ 校验 token 存在 / 非 completed / 非 expired
                  ├─ 惰性过期: 超 7d → 标记 expired → 410
                  ├─ rating 非 1–5 整数 → 400
                  ├─ 重复提交(已完成) → 409
                  └─ 成功 → completeCsatSurvey() + createSatisfaction() → 200 {ok:true}
```

### 3.3 管理侧聚合

- `GET /api/admin/csat`（requireAuth）→ `db.getCsatStats()`：派发总数 / 已回收 / 待回收 / 已过期 / 回收率 / 平均分 / NPS 近似 / 评分分布 / 分渠道回收 / 近期评价。
- 前端 `AdminPage` 挂载即拉取并渲染「客户满意度（CSAT）」卡片区，含刷新按钮，与运营看板聚合解耦（独立轮询，不加重 `stats` 负担）。
- Prometheus 暴露 4 条指标（见 6.3）。

---

## 4. 数据字段

### 4.1 存储表 `csat_surveys`（迁移 v8）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 问卷主键（UUID） |
| `session_id` | TEXT FK→sessions | 所属会话（ON DELETE CASCADE） |
| `ticket_id` | TEXT NULL | 关联工单（resolve 触发时写入） |
| `channel` | TEXT | 派发渠道：web / embed / email / im，默认 web |
| `survey_token` | TEXT UNIQUE | 匿名访问令牌（32 hex，一次性） |
| `customer_name` | TEXT NULL | 客户称呼（仅用于邮件正文，不向问卷页泄露 PII） |
| `to_address` | TEXT NULL | 邮件渠道收件人 |
| `survey_status` | TEXT | `pending` / `completed` / `expired` |
| `survey_sent_at` | TEXT(ISO) | 派发时间（TTL 起点） |
| `responded_at` | TEXT NULL | 回收时间 |
| `rating` | INT NULL | 1–5 |
| `comment` | TEXT NULL | 留言（最长 1000 字符） |
| `tags` | TEXT NULL | 快捷标签（逗号分隔，最长 200 字符） |
| `created_at` | TEXT(ISO) | 创建时间 |

索引：`idx_csat_token(survey_token)`、`idx_csat_session(session_id)`、`idx_csat_status(survey_status)`。

### 4.2 回写表 `satisfaction`（既有，复用）

提交成功时写入：`{ id, session_id, rating, comment, tags, resolved(1 if rating>=4), created_at }`。
> 注：现有 `satisfaction` 表另有 `message_id` 列（CSAT 写入时该列为 NULL，按既有 schema 兼容）。

### 4.3 聚合结构 `CsatStats`（API 返回 / 前端 `CsatStats`）

```
total, responded, pending, expired
responseRate      // 回收率 % = responded/total*100
avgRating         // 平均分 1–5（无数据则 0）
ratingCount       // 有效评分数
npsLike           // (好评数 - 差评数) / 有效数 * 100，好评=rating>=4，差评=rating<=2
ratingDistribution[]  // { rating, count }  评分分布
byChannel[]          // { channel, total, responded }  分渠道回收
recent[]             // 近期评价（completed，responded_at DESC，最多 20）：{token, channel, rating, comment, responded_at, created_at}
```

---

## 5. 交互界面元素

### 5.1 公开问卷页 `SurveyPage`（路由 `/survey/:token`，匿名）

| 元素 | 行为 |
| --- | --- |
| 加载态 | `Loader2` 转圈，拉取 `/api/csat/survey/:token` |
| 星级选择 | 5 颗 `Star`（amber-400 填充），hover 预览，文案映射：1 很不满意 → 5 非常满意 |
| 快捷标签 | 6 个可多选胶囊：`响应及时 / 解答专业 / 态度友好 / 问题解决 / 流程繁琐 / 等待较久` |
| 留言框 | `textarea`，`maxLength=1000`，可选 |
| 提交按钮 | 未打分时禁用（文案「请先打分」），提交中转圈，成功/失败态切换 |
| 结果态 notfound | 「问卷不存在或已失效」提示卡 |
| 结果态 expired | 「问卷已过期（>7 天）」提示卡（warning 色） |
| 结果态 completed | 「评价已提交 / 感谢反馈」成功卡（含 409 重复提交兜底） |

### 5.2 管理后台「客户满意度（CSAT）」卡片区（AdminPage）

- 标题行：`<Smile>` 图标 + 「客户满意度（CSAT）」+ 刷新按钮（`RefreshCw`，轮询中旋转）。
- 6 个指标瓦片：`平均评分 (avgRating/5)`、`回收率 (responseRate%)`、`NPS 近似 (npsLike%)`、`已回收 (responded/total)`、`待回收 (pending)`、`已过期 (expired)`。
- 评分分布条形图：5★→1★ 各一行，长度按 `count/max` 比例。
- 分渠道回收：列出各 `channel` 的 total / responded。
- 近期评价列表：最多 8 条，展示星级 + 渠道 + 留言（脱敏，不显示 token 明文）。

---

## 6. 与现有系统的集成方式

### 6.1 触发集成（工单引擎）
`server/index.ts` 的 `POST /api/admin/tickets/:id/resolve` 内联调用 `dispatchSurvey`，复用 `db.getTicket` / `db.getSession` 解析 channel 与收件人。工单状态与问卷派发在**同一请求内原子完成**（无跨服务调用）。

### 6.2 邮件集成（复用 emailGateway）
`dispatchSurvey` 调 `sendMail(to, subject, body)`（来自 `server/emailGateway.ts`，已导出）：
- SMTP 启用 → 真实投递邀请邮件（含 `/survey/:token` 链接）；
- 未启用 → 模拟发送（返回 `true`，记日志），不阻断派发。
- 邮件正文由 `buildEmailBody(name, url)` 生成（纯文本，含 7 天有效期提示）。
- 链接 base URL 优先级：`dispatch` 入参 `baseUrl` → `CSA_PUBLIC_BASE_URL` 环境变量 → 回退相对路径 `/survey/:token`（前端 SPA 内可用）。

### 6.3 可观测性集成（Prometheus）
`/api/health` 的 Prometheus 段新增 4 条 CSAT 指标（均经 `db.getCsatStats()`）：
| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `csa_csat_surveys_total` | counter | 累计派发数 |
| `csa_csat_responses_total` | counter | 累计回收数（completed） |
| `csa_csat_response_rate` | gauge | 回收率 % |
| `csa_csat_avg_rating` | gauge | 平均分 1–5 |

### 6.4 路由与鉴权中间件（复用既有）
- 匿名路由：`/api/csat/survey/:token`、`/api/csat/submit` —— **无鉴权**，凭 token 访问。
- 管理路由：`requireAuth`（`/api/admin/csat`）+ `requireRole('admin','manager')`（`/api/admin/csat/dispatch`，手动派发受控）。
- 公开前端路由：`/survey/:token` 在 `App.tsx` 中置于 `/admin` 之后、`*` 兜底之前，无需登录即可访问。

---

## 7. 权限控制要求

| 操作 | 所需权限 | 实现 |
| --- | --- | --- |
| 查看/提交问卷（客户侧） | 匿名（仅需有效 token） | 公开路由，token 即凭证；token 一次性 UNIQUE，无法枚举 |
| 查看 CSAT 聚合看板 | `requireAuth`（登录管理员） | `GET /api/admin/csat`，JWT 鉴权 |
| 手动补派问卷 | `requireAuth` + `requireRole('admin','manager')` | `POST /api/admin/csat/dispatch` |
| 解决工单触发自动派发 | `requireAuth` | `POST /api/admin/tickets/:id/resolve`（所有登录管理员可解决，从而触发） |

**PII 隔离：**
- `/api/csat/survey/:token` 仅返回 `{ status, rating }`，**不返回** `customer_name` / `to_address` / `comment` 等 PII。
- 管理后台「近期评价」展示 `comment` 但不展示 `survey_token` 明文，避免 token 泄露后被冒用（尽管已 completed 的 token 再利用无效）。
- `customer_name` 仅用于邮件正文拼接，不入问卷页。

---

## 8. 边界条件处理

| 场景 | 处理 | HTTP |
| --- | --- | --- |
| token 不存在 | `getSurveyMeta` 返回 `notfound`；提交返回 `notfound` | 404 |
| token 已 `completed` | 重复提交返回 `already`（前端兜底为成功提示） | 409 |
| token 已 `expired` | 查询/提交均拒绝 | 410 |
| 超过 7 天 TTL（惰性过期） | 提交/查元信息时校验 `now - survey_sent_at > SURVEY_TTL_MS`，标记 `expired` 后拒绝 | 410 |
| `rating` 缺失 | 路由层 `rating == null` 拦截 | 400 |
| `rating` 非 1–5 整数 | `submitSurvey` 抛错 → 路由 `catch` 转 400（如 `rating=9`、`rating=2.5`、`rating=0`） | 400 |
| `comment` 超长 | 前端 `maxLength=1000`，后端 `String(comment).slice(0,1000)` 截断 | 200 |
| `tags` 超长 | 后端 `String(tags).slice(0,200)` 截断 | 200 |
| 同会话已有 pending | `dispatchSurvey` 幂等复用，不新建、不重发 | 返回 `dispatched:false` |
| 邮件发送失败 | `sendMail().catch()` 吞掉，仅记日志，派发成功继续 | 200（派发成功） |
| 提交成功回写 satisfaction 失败 | 先 `completeCsatSurvey` 再 `createSatisfaction`，同属主线程同步事务语义；二者顺序保证问卷状态先落地 | 200 |
| 并发重复提交同一 token | `survey_token` UNIQUE + 状态机检查，第二次命中 `already` | 409 |

---

## 9. 预期行为说明（端到端）

1. 工单解决 → 系统自动生成一份 `pending` 问卷，邮件渠道收到含链接的邀请信；非邮件渠道拿到 token 链接由坐席派发。
2. 客户打开链接 → 看到星级 + 标签 + 留言的轻量问卷页，无需登录。
3. 客户提交 5 星 + 标签「响应及时」+ 留言 → 返回成功；`csat_surveys` 该记录变 `completed`，`satisfaction` 新增一条 `rating=5, resolved=1`。
4. 管理后台「客户满意度（CSAT）」卡片：`avgRating=5`、`responseRate` 上升、`byChannel` 对应渠道 `responded+1`、近期评价列表出现该条。
5. 7 天内未提交 → 链接点击时显示「问卷已过期」，状态置 `expired`，计入 `expired` 与分母（回收率分母含过期，符合 CSAT 口径）。
6. 重复提交已完成问卷 → 显示「您已评价过，感谢支持」。
7. 非法评分（如 9）→ 前端禁用提交；即便绕过，后端返回 400，不改变状态。
8. Prometheus 中 `csa_csat_*` 四条指标随数据实时变化，可被 Grafana 抓取看板。

---

## 10. 配置项

| 环境变量 | 作用 | 缺省 |
| --- | --- | --- |
| `CSA_PUBLIC_BASE_URL` | 问卷公开链接前缀（如 `https://kf.example.com`），用于邮件/IM 场景生成绝对链接 | 空（回退相对路径 `/survey/:token`） |
| `EMAIL_ENABLED` / `SMTP_*` | 控制真实邮件投递；未启用时问卷邮件模拟发送 | 关 |

---

## 11. 文件清单（实现落点）

| 文件 | 角色 |
| --- | --- |
| `server/db.ts` | 迁移 v8 `csat_surveys` 表；`createCsatSurvey` / `getCsatSurveyByToken` / `getOpenCsatSurveyForSession` / `completeCsatSurvey` / `expireCsatSurvey` / `getCsatStats` |
| `server/csat.ts` | 业务模块：`dispatchSurvey` / `submitSurvey` / `getSurveyMeta` / `generateSurveyToken` / `buildSurveyUrl` / `SURVEY_TTL_MS` |
| `server/emailGateway.ts` | 导出 `sendMail(to, subject, body)`，CSAT 邮件复用 |
| `server/index.ts` | 公开路由 `/api/csat/*` + 管理路由 `/api/admin/csat*` + `/tickets/:id/resolve` 自动派发 + Prometheus 4 指标 |
| `src/hooks/useApi.ts` | `CsatStats` 接口 + `api.getCsat()` |
| `src/pages/SurveyPage.tsx` | 匿名问卷页 |
| `src/App.tsx` | 路由 `/survey/:token` |
| `src/pages/AdminPage.tsx` | 「客户满意度（CSAT）」看板卡片区 |
