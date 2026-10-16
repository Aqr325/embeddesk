# EmbedDesk · Google Cloud Run 部署指南（给万总的执行手册）

> 赛事要求：「通过 Cloud Run 或 Firebase 部署在 Google Cloud 上，评估期间链接必须保持可用」。
> 本文件给出**两条路线**，全部命令按 **cmd（命令提示符）** 语法书写，可直接粘贴执行。

---

## 0. 前置条件（一次性）

1. 安装 Google Cloud CLI：https://cloud.google.com/sdk/docs/install
2. 登录并绑定项目（在 cmd 中执行）：

```bat
gcloud auth login
gcloud config set project <你的GCP项目ID>
```

3. 开通 API（一次性，约 1 分钟）：

```bat
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

> 没有 GCP 项目的话，先在 https://console.cloud.google.com/ 新建一个（免费额度足够本应用运行）。

---

## 路线 A：最快出活链接（推荐，一条命令）

源码直部署——Cloud Build 在云端构建，**无需本地 Docker**：

```bat
gcloud run deploy embeddesk --source . --region asia-east1 --allow-unauthenticated --min-instances 1 --set-env-vars ADMIN_PASSWORD=<设置一个强口令>
```

- 首次执行会问「Allow unauthenticated invocations?」→ 选 **y**（评委需要公开访问）。
- 构建约 3–6 分钟，完成后打印服务 URL，形如 `https://embeddesk-xxxxx-uc.a.run.app`。
- `--min-instances 1`：评估期间防冷启动，链接随时可用。

部署后自检：

```bat
curl https://<上一步的URL>/api/health
```

---

## 路线 B：仓库自带套件（读 .env，切真实 GCP 栈）

适合要把 Vertex AI Search / Firestore / BigQuery 全部切真的场景：

1. 准备凭证文件（不会入库，`.env` 已被 .gitignore 忽略）：

```bat
copy .env.example .env
notepad .env
```

按需填写：`GCP_PROJECT`、`GEMINI_MODEL`（默认 gemini-2.5-flash）、`VERTEX_SEARCH_ENGINE_ID`、`FIRESTORE_PROJECT`、`BIGQUERY_*`。**不填也能跑**——应用自动降级到本地 SQLite + 词法 RAG，演示不硬失败。

2. 在 **Git Bash** 中执行（脚本是 bash）：

```bash
bash deploy-cloudrun.sh
```

脚本会自动：Cloud Build 构建推送 → 按 .env 组装环境变量开关 → `gcloud run deploy`（min-instances=1）→ 打印服务 URL。

---

## 环境变量速查（Cloud Run 上按需设置）

| 变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | ✅ | 管理后台登录口令（赛事评委可能查看后台，务必设置） |
| `SEED_DEMO` | 默认开 | 知识库 / 工单 / 洞察演示数据默认种子；仅 `=false` 关闭 |
| `ALLOWED_ORIGINS` | 可选 | 留空则同源访问无限制 |
| `GEMINI_MODEL` | 可选 | 默认 `gemini-2.5-flash`；Cloud Run 默认服务账号自动带 Vertex 鉴权，无需打包 SA JSON |
| `KNOWLEDGE_PROVIDER` | 可选 | `vertex` 切 Vertex AI Search；缺省 `lexical` 本地检索 |
| `DATA_PROVIDER` | 可选 | `firestore` 切 Firestore 双写；缺省 SQLite |

添加 / 修改变量（不重新构建）：

```bat
gcloud run services update embeddesk --region asia-east1 --update-env-vars ADMIN_PASSWORD=<新口令>
```

---

## 部署后验收清单（评委视角）

- [ ] `https://<URL>/` —— 客户聊天挂件正常渲染（右下角气泡）
- [ ] 发一条消息（如「如何降低模组待机功耗？」）—— 有回复即链路通
- [ ] `https://<URL>/admin` —— 管理后台可登录（ADMIN_PASSWORD）
- [ ] 工单列表 / 调用监控 / 洞察看板有数据
- [ ] `/api/health` 返回 ok

全部通过后，把 URL 回填到 `SUBMISSION.md` 头部「实时原型」一行。

---

## 注意事项

- **SQLite 为容器内存储，实例重启会重置**（自动重建并重新种子）——持久化请切 `DATA_PROVIDER=firestore`；纯演示场景无需处理。
- 评估期如遇费用顾虑，可 `gcloud run services update embeddesk --region asia-east1 --min-instances 0` 关闭常驻（首次访问会冷启动数秒）。
- 镜像内含 `tsx` 运行时（devDependencies 刻意保留），`npm start` 即生产启动。
