# EmbedDesk · 云嵌 — Embedded AI Customer Service Agent

> **AI Builder Cup 2026 · Track: Future of Work & Enterprise Productivity**
> One-line embeddable AI agent for industrial-equipment vendors: answers expert product questions from a real knowledge base, detects purchase intent, and auto-creates tickets that turn support chats into sales leads.
>
> 一句话：**一行代码嵌入官网的 AI 客服 Agent**——基于真实产品资料作答，识别购买意图自动建单，把客服会话变成销售线索。

---

## 1. What it is (product definition)

EmbedDesk is an **embedded AI customer-service agent** for industrial-equipment companies. A single `<script>` tag drops a Shadow-DOM chat widget onto any website; the same agent runs on the web console and the admin back-office.

- **Answers expert questions** — retrieves from a real product knowledge base (16 products from szjammer.com's product center: 11 devices + exam shield + 4 PCBA modules) and replies with citations.
- **Detects purchase intent** — when a visitor shows buying signals, the agent auto-creates a ticket (with structured fields) and notifies sales.
- **Turns support into revenue** — the business story: first-response from 2 hours → 30 seconds, and no lead is lost.
- **Cloud-native & resilient** — Gemini on Vertex AI for reasoning, Vertex AI Search for retrieval, Firestore for tickets/sessions, BigQuery for insight events; all with local fallbacks so the demo never hard-fails.

**Core strategy — "swap the core, keep the shell" (换核不换壳):** only the AI kernel and data layer were replaced (Tencent SDK → Gemini + Vertex AI Search + Firestore + BigQuery). The Express service shell, channel integrations, embed widget, and admin UI are all preserved and unchanged.

---

## 2. Architecture

```
Channels (zero-change)        Cloud Run · Express shell        AI Kernel (replaced)        Data layer (replaced/added)
┌──────────┐ ┌──────────┐ ┌──────────┐   ┌──────────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│embed widget│ │web console│ │admin UI  │ → │ Shared chat pipeline      │→ │ Gemini Agent Loop    │→ │ Vertex AI Search   │
│Shadow DOM │ │CustomerPg│ │TicketList│   │ callAgent() single swap   │  │ function calling ≤5  │  │ enterprise KB       │
└──────────┘ └──────────┘ └──────────┘   └──────────────────────────┘  └──────────────────────┘  └────────────────────┘
                                               ↘ fallback: lexical RAG     │                      ├─ Firestore (tickets/sessions)
                                                 (rag.ts preserved)       │                      └─ BigQuery (events/insights)
                                                                 Document AI ──↑ (16 product docs → JSON)
```

**Key contracts (guarantee `index.ts` / `channels.ts` zero-change):**

1. `callAgent(opts)` signature & `{ text, usedModel, captured }` return shape — unchanged; internals now call `geminiAgent.ts`.
2. `retrieveRag(query, intent, k) → FaqHit[]` signature — unchanged; `KNOWLEDGE_PROVIDER=vertex|lexical` switches the backend.
3. `create_ticket` → `captured.tickets` return path — unchanged (front-end "ticket created" card depends on it).
4. SSE streaming protocol — unchanged (`embed.js` depends on it).

---

## 3. Google Cloud stack

| Resource | Role |
|---|---|
| **Cloud Run** | Hosts the full Express service (single container, `PORT=8080`) |
| **Vertex AI (Gemini)** | Dialogue + function calling (`gemini-2.5-flash` by default) |
| **Vertex AI Search (Discovery Engine)** | Enterprise knowledge retrieval |
| **Document AI** | Parses product PDFs / brochures (16 catalog entries) → structured JSON → Vertex data store |
| **Firestore** | Ticket / session persistence (Native mode) |
| **BigQuery** | Insight event stream (question / hit / latency / ticket_created) |
| **Artifact Registry** | Container image storage for Cloud Build |

> All GCP services are wired behind **environment-variable switches**. Without credentials the app runs fully on local SQLite + lexical RAG (mock-verified closed loop), and flips to the real stack the moment credentials are set — **zero code change**.

---

## 4. Resilience (D5)

- `fetchWithRetry()` in `geminiAgent.ts`: exponential backoff on HTTP 429 / ≥500, independent 20s timeout per attempt, 3 attempts, then falls back to knowledge-base direct-answer (`knowledgeFallback`).
- Insight aggregation (`insights.ts`): BigQuery `jobs.query` prioritized; on missing config or failure it falls back to a local JSONL event log (`EVENTS_JSONL_PATH`); on any error it returns an empty structure (`source:'empty'`). Best-effort, never throws.

---

## 5. Local reproduction (no GCP credentials needed)

The whole pipeline is mock-verifiable with zero cloud setup.

```bash
# 1. Install dependencies
npm install

# 2. Seed demo analytics events (2–3 weeks of baseline, labeled "demo data")
#    -> writes to data/analytics-events.jsonl, consumed by the insights panel
npx tsx scripts/seed-demo-events.ts

# 3. Start (backend :3000 + frontend :5173)
npm run dev

# 4. Open
#    Customer widget:  http://localhost:5173/
#    Admin back-office: http://localhost:5173/admin   (login: admin / ADMIN_PASSWORD)
```

- Knowledge retrieval runs on the built-in **lexical RAG** (`KNOWLEDGE_PROVIDER=lexical`, the default) — no Vertex setup required.
- The **Insights** tab in the admin back-office reads from the seeded JSONL (BigQuery fallback path) and renders TOP products, intent distribution, and ticket trends.
- **One-click verification** (starts a local mock of all GCP endpoints, then runs 6 suites):

```bash
npm run verify
# → insights aggregation (12 assertions) · agent tools · Gemini kernel T1–T9
#   · Firestore+SQLite · BigQuery+JSONL · retrieval Top-3 hit rate 96.4% (≥80% gate)
```

---

## 6. Deploy to Cloud Run (real GCP stack)

```bash
# Prereqs: gcloud auth login && gcloud config set project <GCP_PROJECT>
# Copy and fill credentials:
cp .env.example .env        # set GEMINI_MODEL, VERTEX_SEARCH_ENGINE_ID, BIGQUERY_*, etc.

# Build & push image (Cloud Build, no local Docker needed)
gcloud builds submit --config cloudbuild.yaml .

# One-shot deploy (reads .env, flips switch flags, min-instances=1 to avoid cold start)
bash deploy-cloudrun.sh
# -> prints the Cloud Run URL; open /api/health to confirm
```

Switch flags set by `deploy-cloudrun.sh` from `.env`:
`KNOWLEDGE_PROVIDER=vertex`, `DATA_PROVIDER=firestore`, `GEMINI_*`, `VERTEX_SEARCH_*`, `BIGQUERY_*`.

---

## 7. Data honesty (important for judges)

Per the project data policy, the system is **explicit and honest about data provenance**:

- **Product knowledge = real asset** — 16 catalog entries from szjammer.com's product center (11 counter-drone devices + SJ-10C exam shield + 4 PCBA modules), with specs transcribed from official product pages (frequency bands, power, range, battery).
- **FAQ cold-start = derived from real materials** — 30–50 structured Q&A authored from the actual product docs.
- **Operational data = demo data** — conversations, tickets, and BigQuery insight events are generated for the demo and **clearly labeled "演示数据 / demo data"** in the UI and this repo. We do **not** claim real production telemetry.

This is surfaced consistently across the README, the demo, and the admin insights panel.

---

## 8. Feature map

| Capability | Implementation |
|---|---|
| Multi-channel (web / embed / admin) | `server/index.ts` shared SSE pipeline; `public/embed.js` Shadow-DOM widget (zero-change) |
| AI dialogue + function calling | `server/geminiAgent.ts` (Gemini loop, ≤5 turns, knowledge-base fallback) |
| Knowledge retrieval | `server/vertexSearch.ts` (Vertex AI Search) with `server/rag.ts` lexical fallback |
| 4 domain tools | `search_knowledge` / `query_order` / `get_customer` / `create_ticket` (`server/agentTools.ts`) |
| Intent → ticket | `create_ticket` → Firestore (cloud) / SQLite (local); sales email notify via `emailGateway` |
| Insight dashboard | `server/insights.ts` (BigQuery → local JSONL fallback) + `src/components/InsightsPanel.tsx` |
| Admin back-office | `src/pages/AdminPage.tsx` (tickets, stats, CSAT, **Insights** tab) |
| Edge-telemetry reservation | `create_ticket` optional `device` param → `tickets.device_snapshot` (DB v12) — reserved for on-device modules; once field devices connect, telemetry snapshots attach to tickets for direct after-sales handoff ("device self-report → AI triage → human resolution") |

---

## 9. Project structure (hack2skill branch highlights)

```
smart-service-agent/
├── server/
│   ├── index.ts            # entry: SSE chat pipeline + REST routes + auth/rate-limit/static
│   ├── geminiAgent.ts      # [NEW] Gemini function-calling loop (replaces Tencent SDK core)
│   ├── vertexSearch.ts     # [NEW] Vertex AI Search retrieval (same retrieveRag signature)
│   ├── store.ts            # [NEW] Firestore persistence (tickets/sessions), SQLite fallback
│   ├── insights.ts         # [NEW] BigQuery insight aggregation + local JSONL fallback
│   ├── events.ts           # analytics event emission (BigQuery or JSONL)
│   ├── agentTools.ts       # 4 in-process MCP-style tools (incl. create_ticket)
│   ├── rag.ts / knowledge.ts # lexical RAG fallback + KB cache
│   ├── channels.ts         # multi-channel ingest (email/im/web/embed)
│   └── ...                 # auth, tickets, sentiment, escalation, csat, email gateway
├── src/
│   ├── pages/AdminPage.tsx       # back-office (added Insights tab)
│   ├── components/InsightsPanel.tsx  # [NEW] TOP products / intent / ticket trends
│   └── hooks/useApi.ts, useAdmin.ts
├── public/embed.js         # Shadow-DOM embed widget (zero-change)
├── scripts/
│   ├── seed-demo-events.ts # [NEW] seed 2–3 weeks of demo insight events
│   ├── verify-all.mjs      # [NEW] one-click verification (mock GCP + 6 suites)
│   ├── verify_insights.ts  # [NEW] insight aggregation assertions
│   └── ingest-products.mjs # Document AI → Vertex AI Search ingest
├── cloudbuild.yaml         # [NEW] Artifact Registry build
├── deploy-cloudrun.sh      # [NEW] one-shot Cloud Run deploy (reads .env switches)
├── Dockerfile              # node:22-slim, builds dist/, PORT 8080
└── .env.example            # GCP / Gemini / Vertex / BigQuery config block
```

---

## 10. Submission checklist

- [x] Public repo on `hack2skill` branch + this README (architecture, GCP list, repro steps, `.env.example`)
- [x] BigQuery insight page (TOP products / intent distribution / ticket trends) with demo-data labeling
- [x] Gemini resilience (retry + knowledge-base fallback)
- [x] Cloud Run deployment config (`cloudbuild.yaml` + `deploy-cloudrun.sh`, `PORT=8080`, `min-instances=1`)
- [x] One-click verification (`npm run verify`): 6 suites all green, retrieval Top-3 96.4%
- [ ] 3-minute demo video
- [ ] Live demo: Cloud Run URL + embedded widget on test page
- [ ] hack2skill team page completed (≥2 members)

---

## 11. Quick env reference (`cp .env.example .env`)

| Variable | Meaning |
|---|---|
| `GCP_PROJECT` | GCP project id (Cloud Run uses default service account) |
| `GEMINI_MODEL` / `GEMINI_TEMPERATURE` | Gemini model & sampling |
| `VERTEX_SEARCH_ENGINE_ID` / `KNOWLEDGE_PROVIDER` | set `vertex` to enable Vertex AI Search |
| `DATA_PROVIDER` | `firestore` (cloud) or `sqlite` (local default) |
| `BIGQUERY_DATASET` / `BIGQUERY_TABLE` | insight event store |
| `EVENTS_JSONL_PATH` | local fallback event log when BigQuery is unconfigured |
| `ADMIN_PASSWORD` / `ADMIN_TOKEN_SECRET` | admin auth (set strong values in production) |

> Leave the GCP block empty for fully local mock runs. Fill it to flip the entire stack to real Google Cloud — no code change required.

---

## 10. Submission artifacts (AI Builder Cup 2026)

| Requirement | Artifact |
|---|---|
| Presentation (per template) | see `SUBMISSION.md` |
| Demo video (actual run) | `embeddesk-demo.mp4` (95s, 1920×1080) |
| Deployed live prototype | `DEPLOY_GCP.md` — Cloud Run one-command deploy |
| Accessible GitHub repo | this repository (branch `hack2skill`) |
| Brief description | `SUBMISSION.md` |

The demo video is a real screen recording of the running system (web console + admin back-office + LLM call monitoring), produced by `scripts/record-demo-video.mjs` (Puppeteer + CDP screencast) and `scripts/encode-demo-video.mjs` (VFR-accurate ffmpeg encode). The model endpoint in the video is swappable: any OpenAI-compatible endpoint / Gemini / Vertex AI works via the admin "模型配置" page.
