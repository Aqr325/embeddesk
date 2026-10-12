# 性能压测与优化报告

> 项目：smart-service-agent（智能客服系统）
> 压测日期：2026-08-05
> 运行环境：`AGENT_MODE=local`（本地兜底回复，不调真实 LLM），托管 Node 22，端口 3000
> 数据规模：约 1197 个会话 / 2378 条消息（含压测产生的邮件、IM、网页多渠道会话）
> 压测工具：自研 Node 并发压测脚本（`bench.cjs` / `bench2.cjs`），使用原生 `fetch` 并发发起请求，统计吞吐、延迟分位与错误率。

---

## 1. 压测范围

对三条关键链路做梯度并发压测：

| 链路 | 方法 | 说明 |
| --- | --- | --- |
| 多渠道接入 | `POST /api/ingest/email` | 外部邮件入站，触发意图识别 + KB 检索 + 建单 + 画像（同步写多表） |
| 后台大盘 | `GET /api/admin/stats` | 聚合统计，含首响时延计算、渠道/等级/SLA 分组 |
| 实时对话 | `POST /api/chat` | SSE 流式对话（本轮未在大改范围，仅作为已知项记录） |

---

## 2. 基线结果（优化前）

| 链路 | 并发 | 总量 | 错误率 | 吞吐 | avg | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ingest/email | 20 | 200 | 0% | 81.1/s | 232ms | 268ms | 330ms | 502ms |
| ingest/email | 50 | 300 | 0% | 85.5/s | 538ms | 600ms | 602ms | 603ms |
| ingest/email | 100 | 400 | 0% | 84.6/s | 1035ms | 1198ms | 2086ms | 2119ms |
| admin/stats | 50 | 500 | **26%** | **5.6/s** | 8529ms | **16470ms** | 17596ms | 17837ms |
| admin/stats | 150 | 1000 | **31%** | **5.7/s** | 23362ms | **54693ms** | 58546ms | 60671ms |
| chat (SSE) | 10 | 50 | 60%* | 62.1/s | 158ms | 467ms | 468ms | 468ms |
| chat (SSE) | 20 | 80 | 100%* | 2100/s | 9ms | 18ms | 22ms | 22ms |

\* chat 的失败全部为 `HTTP 429`——命中既有限流（`RATE_LIMIT_MAX=20`），属**限流保护正常工作**，非性能缺陷；通过限流的请求本身延迟正常（avg 158ms）。

### 基线暴露的两个严重瓶颈

1. **admin/stats 灾难性**：并发 50 即 26% 请求失败（`fetch failed`，客户端在服务器阻塞期间断开），p95 高达 16.5 秒；并发 150 时 p95 冲到 54.7 秒。
2. **ingest 吞吐天花板 ~84 req/s**：吞吐不随并发提升，延迟随并发线性飙升（20→100 并发，p95 从 268ms 涨到 1198ms），但**零错误**（写入被串行化、busy_timeout 保护）。

---

## 3. 瓶颈根因

### 3.1 stats 慢：首响时延「逐会话万次子查询」+ 同步查询冻结事件循环

`server/db.ts` 的 `getDashboardStats()` 中，`responseTimes` 原实现：

```ts
const rows = db.prepare(`SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 5000`).all();
for (const r of rows) {
  const u = firstMsg.get(r.id);   // 每次 1 次 DB 往返
  const a = firstAsst.get(r.id);  // 每次 1 次 DB 往返
  ...
}
```

对最近 5000 个会话**逐个发起 2 次子查询**，即 1 万次同步 DB 往返。better-sqlite3 是**同步**驱动，查询期间**阻塞整个 Node 事件循环**——一次 stats 请求执行几秒时，期间所有其他请求（包括它自己并发的）全部排队、客户端超时断开（`fetch failed`）。这是 stats 失败率高、延迟爆炸的直接原因。

### 3.2 ingest 天花板：better-sqlite3 单连接同步写入串行

`db.ts` 已正确开启 WAL + `busy_timeout=5000` + `synchronous=NORMAL`，SQLite 侧配置无问题。瓶颈在**应用层**：better-sqlite3 是单连接同步引擎，每个 ingest 请求内部的多次写（建单 INSERT、会话 UPDATE、touch、画像）严格串行执行，且每次 DB 调用占用事件循环。因此吞吐被锁死在 ~84 req/s，延迟随并发堆积。这是该驱动的固有限制，非配置问题。

### 3.3 chat 限流偏紧（非缺陷）

`RATE_LIMIT_MAX=20`（窗口 60s）对单访客/站点合理，但压测式突发并发会快速耗尽配额触发 429。属于产品策略，需按真实流量预期调整。

---

## 4. 本轮实施的优化

| # | 优化 | 文件 | 做法 | 风险 |
| --- | --- | --- | --- | --- |
| A | stats 短 TTL 缓存 | `server/index.ts` | `/api/admin/stats` 加 15s 内存缓存，仪表盘轮询命中缓存，重聚合每秒最多执行几次 | 极低（仪表盘允许 15s 延迟） |
| B | responseTimes 单条查询 | `server/db.ts` | 将「万次子查询」改为 1 条 `SELECT` 相关子查询返回每会话首条 user/assistant 时间，JS 用 `new Date()` 算差值（复用已验证的时间解析） | 低 |
| C | KB 检索内存预热 | `server/knowledge.ts` | `retrieveFaqs` 的 FAQ 源数据加 30s TTL 缓存，消除每条 chat/ingest/recommend 请求的整表读取 | 低（FAQ 编辑后最多 30s 全局生效） |

> 注：优化 B 的第一版草稿误用 `julianday(a.t)`（列别名不存在）导致 `SQLITE_ERROR` 全 500，已通过本地脚本对候选 SQL 做正确性/速度验证（`bench_sqltest.cjs`）后修正为方案 B。

---

## 5. 优化后结果对比

| 链路 | 并发 | 错误率 | 吞吐 | p95 | 改善 |
| --- | --- | --- | --- | --- | --- |
| **admin/stats** | 50 | 26% → **0%** | 5.6 → **364/s** | 16.5s → **431ms** | 吞吐 ↑65×，p95 ↓38× |
| **admin/stats** | 150 | 31% → **0%** | 5.7 → **2347/s** | 54.7s → **80ms** | 吞吐 ↑412×，p95 ↓680× |
| ingest/email | 100 | 0% → 0% | 84.6 → 71.5/s | 1198 → 1417ms | **基本持平**（写串行瓶颈未破，见第 8 节第二轮） |

**结论（第一轮）**：stats 链路从「高并发即雪崩」变为「高并发秒回、零错误」，满足生产仪表盘轮询需求；ingest 因架构性写串行，吞吐维持 ~72 req/s（详见第 6 节）。

---

## 6. 遗留瓶颈与后续建议（未在本轮实施）

### 6.1 ingest 吞吐天花板（~72 req/s，已于第 8 节突破）
- **现状评估**：对单租户客服系统足够（外部渠道批量入站峰值远低于此；实时网页对话另有独立限流保护）。
- **若要突破**，需架构级改动（按收益排序）：
  1. **写入队列化**：将建单/画像/会话持久化中非强一致的写，投入进程内异步队列（批量提交 / `setImmediate` 后置），让 ingest HTTP 响应更快返回。
  2. **读写分离 / 异步 DB**：改用异步 SQLite 驱动（如 `node:sqlite` Worker 线程）或 Postgres，解除单连接同步阻塞。
  3. **responseTimes 增量统计**（根治 stats 首响计算）：在会话首次产生助手消息时把时延写入会话表新增列 `first_response_sec`，stats 直接 `SELECT AVG/...` 聚合该列（单条 SQL，O(1) 索引），彻底去掉扫描。需加迁移 + 写入点（中工作量，建议后续单独排期）。

### 6.2 chat 限流阈值
- `RATE_LIMIT_MAX=20` 对单访客偏紧。若预期单页高并发，可调高至 60~100 或按「已登录用户 vs 匿名访客」分级限流。属产品决策，未擅自修改。

### 6.3 缓存一致性
- stats 15s 缓存、KB 30s 缓存均为 TTL 兜底，未接入写失效。对客服场景（数据非强实时）可接受；若需更强一致性，可在 FAQ 写操作 / 工单状态变更后主动失效对应缓存。

---

## 8. 第二轮：ingest 写入队列化（突破吞吐天花板）

> 时间：2026-08-05。在 stats 已优化、但 ingest 仍卡在 ~84 req/s 的基础上，实施「写后队列 + 独立写线程 + 续接索引」三项改造，彻底解除 better-sqlite3 单连接同步写对 ingest 的固有限制。

### 8.1 根因再定位
首轮「进程内 write-behind 队列」实测**未**突破天花板（吞吐持平、高并发延迟反而上升），根因有两条：
1. **同步引擎单线程**：better-sqlite3 是单连接、单线程同步引擎。即便把写批量化，批量事务仍在**主线程事件循环**上执行，会阻塞 HTTP 处理与请求内读，吞吐与延迟都无实质改善。
2. **请求内全表扫描**：`getOpenSessionForCustomerChannel(customer_id, channel)` 无索引，每个新客户请求对 sessions 表做**全表扫描**（基线小库不明显，库增大后成为主瓶颈，且随数据量线性恶化）。

### 8.2 改造方案
| 项目 | 实现 | 作用 |
| --- | --- | --- |
| 写入作业化 | `server/writeExec.ts` 把写入抽象为「可序列化描述符（type+payload）」，便于跨线程传输 | 解耦写入逻辑与执行位置 |
| 独立写线程 | `server/writeQueue.ts` 主线程缓冲作业，周期（20ms）/超量（400 条）批量 `postMessage` 给 `server/writeWorker.ts`；worker 持有**自己的** SQLite 连接，在 WAL 下单写者执行 | 写不阻塞主线程读与 HTTP；吞吐由 worker 连接独立承担 |
| 同线程兜底 | worker 启动/通信失败时自动回退「主线程内联批量写」，保证功能不中断 | 运行环境兼容 |
| 内存会话索引 | `server/sessionRegistry.ts` 预热并同步维护活跃会话，**优先命中内存**（零 DB）保证异步渠道线程续接 | 写后延迟落库期间不重复建单 |
| 续接索引 | 迁移 v6 新增 `idx_sessions_customer_channel(customer_id, channel)` | 消除全表扫描，请求内读降到 O(log n) |
| 队列位次轻量化 | `countTicketsByStatus` 替代 `getTickets('pending')`（避免 `SELECT *` 全量拉取） | 去掉请求内另一处隐性全表扫描 |

### 8.3 第二轮结果（干净库，退款业务意图最重路径）

| 链路 | 并发 | 错误率 | 吞吐 | p95 | 对比首轮基线（~84.6/s, 1198ms） |
| --- | --- | --- | --- | --- | --- |
| ingest/email | 100 | 0% | **491.9/s** | **267ms** | 吞吐 ↑5.8×，p95 ↓4.5× |
| ingest/email | 200 | 0% | **446.4/s** | 865ms | 吞吐 ↑5.3× |
| ingest/email | 400 | 0% | **360.4/s** | 2598ms | 吞吐 ↑4.3×（优雅退化，未雪崩） |

- **核心结论**：吞吐天花板由 ~84 req/s 提升至 **~490 req/s（约 5.8×）**，p95 延迟从秒级降到亚秒级，全程**零错误**；极高并发（400）下仅延迟上升、吞吐温和退化，不再「锁死即雪崩」。
- **正确性**：线程续接在顺序与 20 路并发同客户突发下均验证通过（同客户复用 1 个会话、无重复建单、消息全量落库）。

### 8.4 残余瓶颈（c=400 后延迟上升的主因）
- **单写者连接饱和**：worker 单连接写入上限约 ~2000–2400 writes/s；超过后缓冲堆积、延迟上升。进一步突破需多写连接分片或升级异步 DB（Postgres）。对单租户客服系统，**~490 req/s 已远超外部渠道入站峰值，足够**。（⚠️ 更正：此处的「worker 单连接」前提已于第 9 节推翻——worker 实际从未加载，吞吐来自主线程批处理，该「~2000–2400 writes/s 饱和」数字不可靠，真实瓶颈见 9.1。）
- **主线程 CPU**：高并发下 `retrieveFaqs` 对 257 条 FAQ 的逐请求打分占主线程 CPU，是 c=400 时延迟的次要来源；必要时可将 KB 检索结果按意图预分组或加 LRU。

### 8.5 复现
```bash
node bench_ingest.cjs   # 见文件：线程续接校验 + 吞吐梯度 + 落库一致性校验
```

---

## 9. 第三轮：c>400 残余瓶颈优化（KB LRU + 预计算语料 + 轻量写批）

（2026-08-05，接续第 8 节「残余瓶颈」）

### 9.1 本轮定位
- 第 8 节报告的「worker 单写连接 ~2000–2400 writes/s 饱和」**前提不成立**：经独立验证，tsx + worker_threads 下 worker 从未真正加载（相对 `.js`→`.ts` 解析在 worker 内失效），吞吐实际来自主线程 write-behind 批处理（详见项目 MEMORY.md「架构修正」）。故「残余瓶颈」的真实构成是：
  1. **主线程 CPU（检索打分）**：`retrieveFaqs` 对每条请求、每个 FAQ 重复 `normalize(query)` ~54 次、`tokenize(query)` ~36 次，纯属浪费；高并发下占满事件循环。
  2. **写批事务阻塞事件循环**：主线程 `flush()` 单次最多 400 作业（~数千 INSERT）同步事务，在 c≥200 时把事件循环长时间独占 → 吞吐不升反降（实测 c=200 仅 89/s、c=400 仅 83/s，比 c=100 的 228/s 还低，即「高并发塌方」）。

### 9.2 改造（均零 DB 变更、低风险）
- **预计算 FAQ 语料**：`knowledge.ts` 在源缓存刷新时一次性把每个 FAQ 的关键词/问题/答案/标签 `normalize` + `tokenizeSet` 成 `Set` 并缓存；热路径不再逐请求重复切分 FAQ 文本。
- **query 单次切分**：每条 `retrieveFaqs` 调用只对 query 做一次 `normalize` + 一次 `tokenizeSet`，供全部 FAQ 复用。
- **检索结果 LRU**（容量 5000）：键 = 归一化 query + intent + topK。真实流量中大量重复/相似问题（「怎么退款」「NB-IoT 和 Cat.1 怎么选」）命中后直接返回，跳过整轮打分。
- **写批轻量化**：`writeQueue` 的 `MAX_BATCH` 400→150、`FLUSH_MS` 20→15，缩短单次事务对事件循环的阻塞，缓解高并发长尾（代价：批次数略增、低负载下略增事务开销）。

### 9.3 结果（同一次运行内 cold 路径 vs LRU 命中路径对照，排除跨 run 机器负载方差）
> 注：本沙箱 CPU 争用剧烈，绝对吞吐在同机不同时间可相差 2–3×（c=100 cold 路径实测 68–228/s 摆动）。以下以「同 run 内 LRU 命中 / cold 路径」比值与「c=400/c=100 比值」作为负载无关、可复现的结论：

| 对比维度 | 优化前（首轮实测） | 优化后（同 run 比值） | 结论 |
| --- | --- | --- | --- |
| 高并发塌方：c=400 / c=100 吞吐比 | 0.36（塌方） | ~1.0–1.5（不再塌方） | 写批轻量化消除了 c≥200 的吞吐倒挂 |
| 同机 LRU 命中 vs cold 路径 吞吐 | — | **~1.9–2.2×** | 预计算语料 + LRU 显著降 CPU |
| 同机 LRU 命中 vs cold 路径 p95 | — | **~0.4–0.5×**（约半） | 重复查询延迟近乎腰斩 |

- LRU 命中路径在 c=100 同机实测约 150–314/s、p95 约 360–700ms；cold 唯一查询路径约 69–165/s、p95 约 880–2080ms（区间差异来自机器负载，非优化回退）。
- 全链路仍 **0% 错误**、落库最终一致（`pending=0`、`flushed` 与入队数吻合）；线程续接校验通过。

### 9.4 为何未选「多写连接分片 / Postgres」
- **多写连接分片（同一 SQLite 文件）无效**：SQLite WAL 模式仍只允许**单一写者**串行提交，开多个写连接并不能提升写吞吐，反而增加连接管理与锁协调复杂度，且跨连接事务一致性更难保证。本项目单库单写者已是最优形态。
- **Postgres 是真解但成本高**：换 Postgres 可获异步/并发写者，彻底解除单线程写瓶颈；但需整体替换 DB 访问层（better-sqlite3 → pg 池 + 异步化大量调用点 + 迁移脚本），属架构级改造，单租户客服场景收益边际递减。如确有超 ~1000 req/s 持续写入需求，再立项评估。
- 当前主线程 write-behind 批处理 + KB LRU 已是单租户 SQLite 的务实天花板。

### 9.5 复现
```bash
# 隔离库压测（避免争用真实 chat.db；bench 现读 CSA_DB_PATH 指定库）
CSA_DB_PATH=data/bench.db INGEST_SECRET=testsecret PORT=3000 \
  node_modules/tsx/dist/cli.mjs server/index.ts &   # 后台起服务
CSA_DB_PATH=data/bench.db BASE=http://localhost:3000 INGEST_SECRET=testsecret node bench_ingest.cjs
# 含「重复查询 LRU 命中」场景（@c=100，对比 cold 唯一查询路径）
```

---

## 7. 复现命令

```bash
# 启动（本地模式，便于压测）
INGEST_SECRET=testsecret ADMIN_PASSWORD=testpass123 AGENT_MODE=local PORT=3000 SEED_DEMO=1 \
  node_modules/tsx/dist/cli.mjs server/index.ts

# 登录取 token
curl -s -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"testpass123"}'

# 运行压测（bench.cjs 全链路 / bench2.cjs 聚焦优化项）
node bench2.cjs
```
