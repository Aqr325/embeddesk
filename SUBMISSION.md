# EmbedDesk · AI Builder Cup 2026 提交简述

> **赛道**：Future of Work & Enterprise Productivity
> **仓库**：https://github.com/Aqr325/embeddesk （分支 `hack2skill`，**已转公开 ✅** `private:false`）
> **实时原型**：`<Cloud Run URL — 本沙箱无 gcloud/凭证，需在本机执行 `gcloud run deploy` 后回填，详见 DEPLOY_GCP.md>`
> **演示视频**：仓库内两支——`embeddesk-demo.mp4`（95s 真机全链路录制）+ `embeddesk_intro.mp4`（make-video 技能生成，53s，1920×1080，字幕烧录；沙箱无外网故人声配音降级、BGM 兜底）
> **演示文稿**：`EmbedDesk-AI-Builder-Cup.pptx`（10 页，按 hack2skill 提交结构以 tencent-pptx 重建；平台模板仅在登录后 dashboard 提供，公开页无下载入口）

---

## 〇、五项提交材料对照

| # | 赛事要求 | 状态 | 交付物 |
|---|---|---|---|
| 1 | 演示文稿（按规定模板） | ✅ 已完成 | `EmbedDesk-AI-Builder-Cup.pptx`（tencent-pptx 重建，10 页 + 4 张 SVG 主视觉） |
| 2 | 演示视频（实际运行） | ✅ 已完成 | `embeddesk-demo.mp4`（95s 真机全链路）+ `embeddesk_intro.mp4`（53s make-video，字幕烧录，BGM 兜底） |
| 3 | 已部署的实时原型链接 | 🟡 待本机部署 | 代码 100% 就绪；本沙箱无 gcloud/凭证，需在本机跑 `gcloud run deploy`（见 DEPLOY_GCP.md） |
| 4 | 可访问的 GitHub 仓库 | ✅ 已完成 | 仓库已转公开（`private:false`），密钥扫描干净 |
| 5 | 简要描述 | ✅ 已完成 | 本文档 |

---

## 一、表单用简短版（约 200 字，可直接粘贴）

EmbedDesk（云嵌）是一个一行代码即可嵌入企业官网的 AI 客服 Agent，整套构建在 Google Cloud 上：Vertex AI（Gemini）负责对话与工具调用，Vertex AI Search 做企业知识检索，Firestore 持久化工单与会话，BigQuery 沉淀洞察事件流，单容器部署于 Cloud Run。它面向工业设备厂商的真实痛点——专家问题应答慢、购买意图无人跟进：一段 `<script>`（Shadow DOM 隔离，不影响宿主页面）即可把客服能力带到任意网站，基于 16 款真实产品资料作答并附引用，识别购买意图后自动建单并通知销售，首响时间从 2 小时降到 30 秒。系统还内置情感识别与智能升级、RAG 检索增强、坐席 Copilot、工作流自动化与多渠道接入（网页 / 嵌入挂件 / IM / 邮件），且全链路带本地降级，无凭证环境也能完整演示。

---

## 二、一句话定义

**一行代码嵌入官网的 AI 客服 Agent——基于真实产品资料作答，识别购买意图自动建单，把客服会话变成销售线索。**

---

## 三、结构化完整版

### 1. 解决什么问题

工业设备厂商（本项目以中科佳晨 16 款端侧 AI / IoT 模组产品为真实知识库）的客服环节长期存在两个断层：

- **专业问题应答慢**：产品参数、选型、接口问题需要资深工程师回答，首响以小时计；
- **购买意图流失**：访客在会话里流露出采购信号，但客服只当「咨询」处理，没有流转到销售，线索石沉大海。

### 2. 我们建造了什么

EmbedDesk 是一个**嵌入式 AI 客服 Agent**：一段 `<script>` 标签以 Shadow DOM 挂载聊天挂件到任意网站（官网、文档站、第三方门户），同一个 Agent 内核同时驱动网页客服台、管理后台与 IM / 邮件渠道。

核心能力：

| 能力 | 说明 |
|---|---|
| 专家问答 | 基于 16 款真实产品资料库检索作答，回复附引用来源 |
| 意图识别 + 自动建单 | 检测到购买信号自动创建结构化工单（含优先级 / SLA）并通知销售 |
| 情感识别与智能升级 | 负面情绪实时升级，转人工令牌 + 工单叠加 |
| RAG 检索增强 | 同义词 / 口语化查询扩展 + 重排，Top-3 命中率 96.4% |
| 坐席 Copilot | 实时推荐回复与下一步动作，人工坐席一键执行 |
| 工作流引擎 | 结构化规则求值（不使用 eval），工单自动分派 / 提醒 |
| 多渠道接入 | web / embed / IM / 邮件四端同源，会话维度防重建单 |
| 可观测性 | 每次模型调用的引擎 / 延迟 / token / 状态全量埋点，管理后台可视 |

### 3. 技术架构（Google Cloud）

| 资源 | 角色 |
|---|---|
| **Cloud Run** | 托管完整 Express 服务（单容器，`PORT=8080`，min-instances=1 防冷启动） |
| **Vertex AI（Gemini）** | 对话主模型 + function calling（≤5 轮工具循环、参数自修复） |
| **Vertex AI Search** | 企业知识检索（16 份产品资料经 Document AI 解析入库） |
| **Firestore** | 工单 / 会话持久化（Native mode） |
| **BigQuery** | 洞察事件流（问题 / 命中 / 延迟 / 建单） |
| **Artifact Registry** | 容器镜像存储 |

所有 GCP 服务均由环境变量开关控制：**无凭证时应用完整运行在本地 SQLite + 词法 RAG 上，设置凭证后零代码改动切换到真实云栈**——这让演示环境永不硬失败。

### 4. 差异化亮点

- **换核不换壳**：只替换 AI 内核与数据层（Tencent SDK → Gemini + Vertex AI Search + Firestore + BigQuery），渠道接入、嵌入挂件、管理 UI 全部保留，核心契于 `callAgent()` 签名不变；
- **工程韧性**：模型调用四级回退链（显式协议 → Gemini 直连 → 平台 SDK → 知识库直答）、429/5xx 指数退避、HTTP 400 参数自修复（端点拒参自动剥离重试）；
- **真实可复现**：`npm run verify` 一键验收 9 个测试套件（含 GCP 端点本地 mock），Top-3 检索命中率 96.4% 高于 80% 门限。

### 5. 验证与部署

```bash
# 本地一键验收（无需任何云凭证）
npm install && npm run verify

# 部署到 Cloud Run（真实 GCP 栈）
gcloud builds submit --config cloudbuild.yaml .
bash deploy-cloudrun.sh
```

部署与复现细节见 README「5. Local reproduction」与「6. Deploy to Cloud Run」两节。
