/**
 * 智能客服 Agent —— 服务端
 *
 * 请求处理管线（POST /api/chat）：
 *   用户输入
 *     → ① 意图识别（规则引擎，<1ms）
 *     → ② FAQ 知识库检索（混合打分）
 *     → ③ 订单数据挂载（命中订单号时）
 *     → ④ 转人工规则判定（命中即短路，不再调用大模型）
 *     → ⑤ CodeBuddy Agent SDK 生成回复（注入知识库上下文，禁用工具）
 *     → ⑥ 降级兜底（SDK 不可用时由知识库直接组装答案）
 *     → ⑦ 持久化（消息 / 意图流水 / 工单）
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query, unstable_v2_authenticate } from '@tencent-ai/agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { classifyIntent, isNegativeSentiment, INTENT_META, type IntentId, extractIntents, isSmallTalk } from './intent.js';
import { seedKnowledgeBase, DIRECT_ANSWER_THRESHOLD, HIT_THRESHOLD, getKbCacheStats, type FaqHit, recommendFaqs } from './knowledge.js';
import { retrieveRag, buildRagContext, getRagStats } from './rag.js';
import { geminiConfigured } from './geminiAgent.js';
import { getCopilotSuggestions } from './copilot.js';
import { evaluateHandoff, buildHandoffMessage, detectAgentSignal, stripHandoffToken, HANDOFF_TOKEN, type HandoffDecision } from './handoff.js';
import { computePriority, computeSlaDue, assignTicket } from './tickets.js';
import { enrichProfile } from './profile.js';
import {
  getResolvedConfig,
  toPublicConfig,
  clampTemp,
  clampMaxReply,
  TEMP_MIN,
  TEMP_MAX,
  MAX_REPLY_MIN,
  MAX_REPLY_MAX,
} from './llmConfig.js';
import { ingestExternalMessage, type ChannelType } from './channels.js';
import { summarizeConversation } from './summarize.js';
import { escalateFromContext, higherPriority } from './escalation.js';
import { resolveOrderContext, withTimeout, listOrders } from './orders.js';
import { truncate } from './nlp.js';
import { seedDemoData } from './seed.js';
import { issueToken, verifyCredentials, requireAuth, requireRole, hashPassword } from './auth.js';
import { rateLimit, clientIp } from './ratelimit.js';
import { logger } from './logger.js';
import { recordRequest, metrics } from './metrics.js';
import { getInsights } from './insights.js';
import { asyncHandler, securityHeaders, notFoundHandler, errorHandler, HttpError } from './middleware.js';
import { asString, asIntInRange, asOneOf, asTagString, asBool } from './validate.js';
import { preload as preloadSessionRegistry } from './sessionRegistry.js';
import { drain as drainWriteQueue, getStats as getWriteQueueStats } from './writeQueue.js';
import { startEmailGateway, stopEmailGateway, getEmailGatewayStatus, getEmailDeliveryStats } from './emailGateway.js';
// AI 内核共享层（Agent 调用 / 工具注入 / 系统提示词 / SDK 探测），web 与异步渠道共用
import {
  callAgent,
  buildSystemPrompt,
  formatCustomerProfile,
  probeSdk,
  confirmSdk,
  isSdkAvailable,
  isSdkBroken,
  markSdkBroken,
  BRAND,
  AGENT_MODE,
  AUTH_ERROR_PATTERN,
  DEFAULT_MODEL,
  KNOWN_SUPPORTED_MODELS,
  AGENT_CHAIN_BUDGET,
  AGENT_FIRST_TOKEN_TIMEOUT,
  badModels,
  buildHistoryText,
} from './agentCore.js';
import { submitSurvey, getSurveyMeta, dispatchSurvey } from './csat.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// ESM 环境下 __dirname 不可用，需基于 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '1mb' }));
// 基础安全响应头（零依赖实现，对标 helmet 核心子集）
app.use(securityHeaders);

/* ---- 嵌入渠道 CORS（第三方网站跨域调用 /api/embed/*，无凭证、任意来源） ---- */
// 必须注册在通用 CORS 之前：通用中间件对白名单外的 origin 不回写 Allow-Origin，
// 且会在 OPTIONS 阶段直接 204 返回（不带嵌入头），会阻断第三方站点的预检。
app.use((req, res, next) => {
  if (req.path.startsWith('/api/embed/')) {
    const origin = req.headers.origin;
    // 回显来源而非固定 *，兼顾带 Origin 的浏览器请求；无 Origin（如服务端脚本）退回 *
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
  }
  next();
});

/* ---- 安全与可运维中间件 ---- */

// 反向代理信任（部署在 Nginx/网关后时需开启，以便正确提取客户端 IP）
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// CORS 白名单：默认仅允许本地开发来源；生产可经 ALLOWED_ORIGINS 配置跨域来源
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// 请求标识 + 访问审计 + 指标采集
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  (req as any).reqId = reqId;
  const t0 = Date.now();
  res.on('finish', () => {
    const d = Date.now() - t0;
    logger.access(`${req.method} ${req.originalUrl} ${res.statusCode} ${d}ms ip=${clientIp(req)} id=${reqId}`);
    recordRequest(res.statusCode, d);
  });
  next();
});

// 聊天接口限流（按客户端 IP 滑动窗口）
const chatLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: Number(process.env.RATE_LIMIT_MAX) || 20,
  key: (req) => clientIp(req),
});

// 嵌入渠道聊天限流（第三方网站访客，按站点 + IP 维度，放宽额度）
const embedLimiter = rateLimit({
  windowMs: Number(process.env.EMBED_RATE_LIMIT_WINDOW_MS) || 60000,
  max: Number(process.env.EMBED_RATE_LIMIT_MAX) || 60,
  key: (req) => `${asString(req.body?.siteId, { max: 64 })}:${clientIp(req)}`,
});

/** 单条对话请求整体看门狗：即便内部某环节意外挂起，也保证连接不会永久悬挂 */
const CHAT_WATCHDOG_MS = Number(process.env.CHAT_WATCHDOG_MS) || 90000;
/** 订单上下文解析超时上限（为未来远程订单中心调用兜底，避免拖垮主链路） */
const ORDER_CTX_TIMEOUT_MS = Number(process.env.ORDER_CTX_TIMEOUT_MS) || 3000;
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];

/* ============================ 初始化 ============================ */

const seededFaqs = seedKnowledgeBase();
if (seededFaqs) logger.info(`[Init] 已写入 ${seededFaqs} 条 FAQ 种子知识`);
const seededDemo = seedDemoData();
if (seededDemo) logger.info(`[Init] 已生成 ${seededDemo} 条演示会话数据`);

/* ============================ 系统提示词 ============================ */
// buildSystemPrompt / formatCustomerProfile 已迁移至 server/agentCore.ts（web 与异步渠道共用同一 AI 内核）

/**
 * 聊天核心管线（被 /api/chat 与 /api/embed/chat 共用）：
 * 意图识别 → 知识库检索 → 订单挂载 → 转人工判定 → Agent/知识库直答 → 流式输出与落库。
 * ctx.session / ctx.message / ctx.customerName / ctx.startedAt / ctx.now 由调用方在装载会话后传入，
 * visitorId/siteId 仅在嵌入渠道存在，用于把标识回传给前端做持久化。
 */
async function runChatPipeline(
  req: express.Request,
  res: express.Response,
  ctx: {
    session: db.DbSession;
    message: string;
    customerName: string;
    model?: string;
    startedAt: number;
    now: string;
    visitorId?: string;
    siteId?: string;
  },
): Promise<void> {
  const { session, message, customerName, model, startedAt, now, visitorId, siteId } = ctx;

  /* ---- ① 意图识别 ---- */
  const history = db.getMessagesBySession(session.id);
  const lastUserIntent = [...history].reverse().find((m) => m.role === 'user' && m.intent)?.intent as IntentId | undefined;
  const intentResult = classifyIntent(String(message), lastUserIntent ?? null);

  /* ---- ② 知识库检索 ---- */
  const faqHits = await retrieveRag(String(message), intentResult.intent, 3);
  const topScore = faqHits[0]?.score ?? 0;
  const hitIds = faqHits.filter((h) => h.score >= HIT_THRESHOLD).map((h) => h.id);

  /* ---- ②-b 多意图提取（一句话命中多个业务意图，用于前台展示与推荐信号） ---- */
  const intents = extractIntents(String(message), 3, lastUserIntent ?? null);

  /* ---- ③ 订单挂载（异步容错 + 超时包裹，查询失败/超时均不影响主链路） ---- */
  const orderResult = intentResult.orderNo
    ? await withTimeout(resolveOrderContext(intentResult.orderNo), ORDER_CTX_TIMEOUT_MS, 'order-context').catch((e) => {
        logger.warn(`[orders] ${e?.message || e}（降级为未命中）`);
        return null;
      })
    : null;
  const orderContext = orderResult?.context ?? null;

  /* ---- 持久化用户消息 ---- */
  const userMessageId = uuidv4();
  db.createMessage({
    id: userMessageId,
    session_id: session.id,
    role: 'user',
    content: String(message),
    created_at: now,
    intent: intentResult.intent,
    intent_confidence: intentResult.confidence,
    faq_ids: JSON.stringify(hitIds),
    source: 'user',
  });

  db.createIntentLog({
    id: uuidv4(),
    session_id: session.id,
    message_id: userMessageId,
    text: truncate(String(message), 200),
    intent: intentResult.intent,
    confidence: intentResult.confidence,
    matched_keywords: intentResult.matchedKeywords.join(','),
    hit_faq: hitIds.length ? 1 : 0,
  });

  /* ---- 画像增强：有客户标识时，将意图/情绪/接触信号滚动写入长期画像（容错包裹） ---- */
  if (session.customer_id) {
    enrichProfile({
      customerId: session.customer_id,
      intent: intentResult.intent,
      message: String(message),
      kbHit: hitIds.length > 0,
    });
  }

  if (!session.primary_intent || session.primary_intent === 'other') {
    db.updateSession(session.id, { primary_intent: intentResult.intent });
  }
  if (history.length === 0) {
    db.updateSession(session.id, { title: truncate(String(message), 24) });
  }

  /* ---- SSE 头 ---- */
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const assistantMessageId = uuidv4();
  sse(res, {
    type: 'init',
    sessionId: session.id,
    userMessageId,
    assistantMessageId,
    model: model || session.model,
    ...(visitorId ? { visitorId, siteId } : {}),
  });

  sse(res, {
    type: 'analysis',
    intent: intentResult.intent,
    label: intentResult.label,
    confidence: intentResult.confidence,
    matchedKeywords: intentResult.matchedKeywords,
    runnerUp: intentResult.runnerUp,
    orderNo: intentResult.orderNo,
    orderFound: orderResult?.found ?? false,
    faqHits: faqHits.map((h) => ({ id: h.id, question: h.question, category: h.category, score: h.score })),
    scores: intentResult.scores,
    intents: intents.map((i) => ({ intent: i.intent, label: i.label, score: i.score })),
  });

  /* ---- ②-c 知识库推荐（猜你想问）：未命中标准答案且非闲聊时，下发低阈值相关 FAQ ---- */
  if (!hitIds.length && !isSmallTalk(String(message))) {
    const recommended = recommendFaqs(String(message), intentResult.intent, 3, hitIds);
    if (recommended.length) {
      sse(res, {
        type: 'recommend',
        faqs: recommended.map((h) => ({ id: h.id, question: h.question, category: h.category, score: h.score })),
      });
    }
  }

  // 客户端断连 / 写入异常安全网：避免流式输出期间连接关闭导致资源泄漏或进程异常
  let clientGone = false;
  // 注意：必须用 res 的 close 事件判断「客户端断开」。Node 中 req 的 close 在请求体
  // 被 express.json 读取完毕后即触发（并非连接断开），若误用 req 会使 streamText 在
  // 首轮即判定 clientGone=true 而直接 return，导致回复文本完全不流出（仅落库、不推送）。
  res.on('close', () => {
    clientGone = true;
  });
  res.on('error', () => {
    clientGone = true;
  });

  try {
    if (hitIds.length) db.incrementFaqHits(hitIds);

    /* ---- ④ 转人工判定 ---- */
    const negativeCount =
      history.filter((m) => m.role === 'user' && isNegativeSentiment(m.content)).length +
      (isNegativeSentiment(String(message)) ? 1 : 0);

    const decision = evaluateHandoff({
      text: String(message),
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      topFaqScore: topScore,
      missStreak: db.countRecentMisses(session.id, 3),
      userTurns: db.countUserMessages(session.id),
      negativeCount,
    });

    // 综合优先级（handoff 已判定"要转"，此处决定"多急、给谁"）：结合客户等级、知识盲区、长会话、负面情绪
    const tierForTicket = session.customer_id ? (db.getCustomerProfile(session.customer_id)?.tier || 'new') : 'new';
    const computedPriority = computePriority({
      intent: intentResult.intent,
      customerTier: tierForTicket,
      missStreak: db.countRecentMisses(session.id, 3),
      userTurns: db.countUserMessages(session.id),
      negativeCount,
    });

    const finish = (content: string, source: string, extra: Record<string, unknown> = {}) => {
      db.createMessage({
        id: assistantMessageId,
        session_id: session.id,
        role: 'assistant',
        content,
        model: model || session.model,
        created_at: new Date().toISOString(),
        intent: intentResult.intent,
        intent_confidence: intentResult.confidence,
        faq_ids: JSON.stringify(hitIds),
        source,
        latency_ms: Date.now() - startedAt,
      });
      sse(res, { type: 'done', source, latencyMs: Date.now() - startedAt, ...extra });
      if (!res.writableEnded) res.end();
    };

    /** 转人工统一出口：规则判定与 Agent 信号两处共用，消除建单 + 更新会话 + 推送 + 落库的重复逻辑。
     *  textFor 回调在拿到真实 ticketId / queuePosition 后再生成话术，避免提前计算导致的占位不一致。
     *  内部自动完成：综合优先级落地、SLA 时限计算、坐席负载均衡分配、来源渠道标记。 */
    const openHandoff = async (opts: {
      reason: string;
      rule: string;
      priority: db.TicketPriority;
      /** 规则拼装的兜底摘要（LLM 不可用时使用） */
      summaryHint?: string;
      usedModel?: string;
      textFor: (ticketId: string, queuePosition: number) => string;
    }): Promise<void> => {
      const ticketId = uuidv4();
      const queuePosition = db.getTickets('pending').length + 1;
      // 坐席分配：默认负载均衡（未结工单最少者优先），无在职坐席时进入公共队列（assignee=null）
      const assign = assignTicket(intentResult.intent, {});
      // AI 会话摘要（工单自动填充）：基于整段历史 + 当前消息生成结构化摘要；CLI 不可达时回退规则摘要
      const histMsgs = [...history, { role: 'user' as const, content: String(message) }].map((m) => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));
      const sum = await summarizeConversation(histMsgs, { sessionId: session.id, timeoutMs: 15000 });
      const summaryText = (sum?.summary || opts.summaryHint || '').slice(0, 800);
      // 情感识别 + 智能升级：依据当前消息 + 历史对话产出情绪与升级决策，叠加到工单
      const esc = escalateFromContext({
        message: String(message),
        history: histMsgs,
        currentPriority: opts.priority,
        unresolved: true,
      });
      const finalPriority = higherPriority(opts.priority, esc.decision.priority);
      const sentimentForTicket = sum?.sentiment ?? esc.sentiment;
      const slaDue = computeSlaDue(finalPriority, new Date().toISOString());
      db.createTicket({
        id: ticketId,
        session_id: session.id,
        customer_name: session.customer_name,
        intent: intentResult.intent,
        reason: opts.reason,
        trigger_rule: opts.rule,
        summary: summaryText,
        sentiment: sentimentForTicket,
        tags: sum?.tags?.length ? sum.tags.join(',') : null,
        escalated: esc.decision.escalate ? 1 : 0,
        escalation_reason: esc.decision.reason,
        priority: finalPriority,
        status: 'pending',
        assignee: assign.assignee,
        sla_due_at: slaDue,
        channel: session.channel,
      });
      db.updateSession(session.id, { status: 'waiting_human', handoff: 1, handoff_reason: opts.reason });
      sse(res, {
        type: 'handoff',
        ticketId,
        rule: opts.rule,
        reason: opts.reason,
        priority: finalPriority,
        queuePosition,
        assignee: assign.assignee,
      });
      const text = opts.textFor(ticketId, queuePosition);
      await streamText(res, text, 10, 12, () => clientGone);
      finish(text, 'handoff', { handoff: true, ticketId, model: opts.usedModel, priority: finalPriority, assignee: assign.assignee });
    };

    /* ---- 转人工短路：不消耗大模型调用 ---- */
    if (decision.shouldHandoff && !db.hasOpenTicket(session.id)) {
      // 高危场景（法务风险等）由 handoff 显式置 urgent 的不可被综合算法下调；其余采用综合优先级
      const finalPriority: db.TicketPriority = decision.priority === 'urgent' ? 'urgent' : computedPriority.priority;
      decision.priority = finalPriority; // 同步到话术生成，保证展示一致
      const summary = db
        .getMessagesBySession(session.id)
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => m.content)
        .join(' / ');
      await openHandoff({
        reason: decision.reason,
        rule: decision.rule ?? 'AUTO',
        priority: finalPriority,
        summaryHint: summary,
        textFor: (ticketId, queuePosition) => buildHandoffMessage(decision, ticketId, queuePosition),
      });
      return;
    }

    /* ---- ⑤ Agent 生成（带模型兜底） ---- */
    // Hack2skill（方案 §4 契约1）：Gemini 引擎就绪时不受 tencent SDK 可用性约束
    const useSdk = geminiConfigured() || ((await probeSdk()) && !isSdkBroken());
    const knowledgeContext = buildRagContext(faqHits);
    const customerProfileText = session.customer_id ? formatCustomerProfile(db.getCustomerProfile(session.customer_id)) : null;
    const llmCfg = getResolvedConfig();
    // 多轮上下文：取既有历史（排除刚写入的当前用户消息）拼到 prompt 前；新消息本身已是 prompt
    const historyText = buildHistoryText(
      history.slice(0, -1).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    );
    const systemPrompt = buildSystemPrompt(intentResult.intent, knowledgeContext, orderContext, customerProfileText, {
      basePrompt: llmCfg.basePrompt,
      maxReplyLength: llmCfg.maxReplyLength,
    });

    if (useSdk) {
      const requestedModel = model || session.model || llmCfg.model;
      // 尝试顺序：请求模型 → 配置模型 → 已知可用模型；过滤已确认不可用的。
      // Gemini 引擎例外：模型由 getGeminiConfig()（GEMINI_MODEL env 覆盖）决定，单次调用不进 tencent 候选链。
      const MODEL_TRY_ORDER = geminiConfigured()
        ? [process.env.GEMINI_MODEL || 'gemini-2.5-flash']
        : Array.from(new Set([requestedModel, llmCfg.model, ...KNOWN_SUPPORTED_MODELS])).filter((m) => !badModels.has(m));
      let full = '';
      let usedModel = '';
      let agentError: unknown = null;
      let budget = AGENT_CHAIN_BUDGET; // 整链总等待预算，避免多模型依次超时叠加成超长挂起

      for (const tryModel of MODEL_TRY_ORDER) {
        const perTimeout = Math.min(budget, AGENT_FIRST_TOKEN_TIMEOUT);
        if (perTimeout <= 0) break;
        const t0 = Date.now();
        try {
          const agent = await callAgent({
            prompt: String(message),
            systemPrompt,
            model: tryModel,
            session,
            timeoutMs: perTimeout,
            historyText: historyText ?? undefined,
            // web 渠道开放只读工具（知识/订单/画像），建单仍走 HANDOFF_TOKEN 机制
            toolCtx: {
              channel: session.channel,
              sessionId: session.id,
              customerId: session.customer_id,
              customerName: session.customer_name ?? '',
              allowCreateTicket: false,
            },
          });
          full = agent.text;
          usedModel = agent.usedModel;
          break;
        } catch (e: any) {
          const msg = String(e?.message || e);
          // 鉴权失败：SDK 彻底不可用，进程内永久禁用，避免后续每轮重复 9s 挂起与错误刷屏
          if (AUTH_ERROR_PATTERN.test(msg)) {
            markSdkBroken();
            agentError = e;
            break;
          }
          // 模型名不可用（账号不支持）或返回空响应：通常很快返回，换下一个候选模型重试
          if (/model|service info not found|invalid|not found|empty/i.test(msg)) {
            badModels.add(tryModel);
            continue;
          }
          // 超时等其它错误：消耗预算，继续尝试下一个候选模型，而非立即放弃
          budget -= Date.now() - t0;
          agentError = e;
          logger.warn(`[Agent] 模型 ${tryModel} 调用异常（继续尝试下一候选）: ${msg.slice(0, 120)}`);
          continue;
        }
      }

      if (full && full.trim()) {
        /* ---- Agent 自主判定转人工 ---- */
        if (detectAgentSignal(full) && !db.hasOpenTicket(session.id)) {
          const cleaned = stripHandoffToken(full);
          // Agent 信号转人工：投诉类升级 high，其余采用综合优先级
          const agentPriority: db.TicketPriority =
            intentResult.intent === 'complaint' ? 'high' : computedPriority.priority;
          await openHandoff({
            reason: 'Agent 判定超出自助处理范围',
            rule: 'AGENT_SIGNAL',
            priority: agentPriority,
            summaryHint: String(message),
            usedModel,
            textFor: () => cleaned,
          });
          return;
        }

        await streamText(res, full, 8, 14, () => clientGone);
        return finish(full, 'agent', { model: usedModel });
      }

      if (agentError) {
        logger.warn('[Agent] 调用失败，降级至知识库直答:', (agentError as any)?.message || agentError);
        sse(res, { type: 'notice', level: 'warn', message: '大模型服务暂不可用，已切换至知识库直答模式' });
      }
    }

    /* ---- ⑥ 降级：知识库直答 ---- */
    const localAnswer = composeLocalAnswer(faqHits, intentResult.intent, orderContext, orderResult?.found ?? false);
    await streamText(res, localAnswer, 6, 14, () => clientGone);
    return finish(localAnswer, 'knowledge_base', { degraded: true, topScore });
  } catch (err) {
    // 流式已开始后的异常：无法再改写状态码，发送错误事件并优雅断流，避免连接悬挂
    logger.error(`[chat] 流式生成异常 id=${(req as any).reqId}: ${(err as any)?.stack || err}`);
    if (!res.writableEnded) {
      try {
        sse(res, { type: 'error', message: '服务异常，已中断本次回复' });
      } catch {
        /* 连接已断开，忽略写入异常 */
      }
      res.end();
    }
  }
}

/* ============================ 工具函数 ============================ */

function sse(res: express.Response, payload: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 按标点软切分，模拟自然的流式输出节奏；shouldStop 返回 true 时提前结束（客户端断连） */
async function streamText(
  res: express.Response,
  text: string,
  chunkSize = 8,
  delay = 18,
  shouldStop?: () => boolean,
) {
  for (let i = 0; i < text.length; i += chunkSize) {
    if (shouldStop && shouldStop()) return;
    sse(res, { type: 'text', content: text.slice(i, i + chunkSize) });
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

/** 知识库直答（SDK 不可用时的降级路径，也是当前环境实际运行路径，需达到准生产质量） */
function composeLocalAnswer(hits: FaqHit[], intent: IntentId, orderContext: string | null, orderFound = true): string {
  const parts: string[] = [];

  // 1) 订单实时信息最具体，优先呈现（未命中时 orderContext 已为引导文案，不再误报「已查询到」）
  if (orderContext) {
    parts.push(orderFound ? '已为您查询到订单信息：\n\n' + orderContext : orderContext);
  }

  const top = hits[0];
  if (top && top.score >= HIT_THRESHOLD) {
    if (orderContext) parts.push('');
    // 高/中置信均直接引用标准答案（标准答案本身已结构化、可落地）
    parts.push(top.answer);
    // 相关推荐：合并其它命中（score >= 0.18），帮助客户自助延伸
    const related = hits.slice(1).filter((h) => h.score >= 0.18);
    if (related.length) {
      parts.push('\n您可能还想了解：');
      related.forEach((h) => parts.push(`· ${h.question}`));
    }
  } else if (!orderContext) {
    // 无命中：按意图给出建设性引导，而非泛化「没找到答案」
    parts.push(buildNoHitReply(intent));
  }

  return parts.join('\n');
}

/** 无知识库命中时的意图感知兜底话术 */
function buildNoHitReply(intent: IntentId): string {
  const lead = '关于这个问题，为了给您准确的答复';
  switch (intent) {
    case 'refund':
      return `${lead}，麻烦提供下订单号（如 SO2026...），或说明是「未发货取消」还是「已收货退货」？我可立即给出对应办理步骤；也可直接回复「转人工」由专员协助。`;
    case 'order_query':
      return `${lead}，请提供订单号（如 SO2026...），我可为您实时调取物流轨迹与预计送达时间；也可描述想了解发货时间还是配送进度。`;
    case 'tech_support':
      return `${lead}，麻烦说明：设备型号、具体现象（如闪退 / 连不上网 / 指示灯异常）以及您已尝试过的操作。我先给排查步骤，必要时为您转接技术工程师。`;
    case 'complaint':
      return `非常理解您的心情，这类问题建议交由人工专员跟进处理。请回复「转人工」或留下联系方式与诉求，我们会在服务时间（09:00–21:00）内主动回电。`;
    case 'human_service':
      return `好的，正在为您转接人工客服，请稍候～（在线人工服务时间：每日 09:00–21:00，含节假日）`;
    case 'greeting':
      return `您好，我是中科佳晨的智能客服小云，很高兴为您服务。请问有什么可以帮您？`;
    default:
      return `${lead}，可以补充说明具体场景或提供订单号吗？也可回复「转人工」由专员为您处理。`;
  }
}

/* ============================ SDK 探测与 Agent 调用 ============================ */
// probeSdk / confirmSdk / callAgent 已迁移至 server/agentCore.ts（web 与异步渠道共用同一 AI 内核）


/* ============================ 健康检查与元信息 ============================ */

app.get('/api/health', asyncHandler(async (_req, res) => {
  const dbOk = db.ping();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    mode: AGENT_MODE,
    sdkAvailable: isSdkAvailable(),
    sdkBroken: isSdkBroken(),
    db: dbOk,
    brand: BRAND,
    metrics: metrics.snapshot(),
    writeQueue: getWriteQueueStats(),
    emailGateway: getEmailGatewayStatus(),
    emailDelivery: getEmailDeliveryStats(),
    kbCache: getKbCacheStats(),
    rag: getRagStats(),
    timestamp: new Date().toISOString(),
  });
}));

/** 运行指标（需管理员鉴权；供运维看板与演示大屏使用） */
app.get('/api/admin/metrics', requireAuth, asyncHandler(async (_req, res) => {
  // 将进程级指标、KB 检索 LRU 缓存指标、邮件投递指标合并；kbCache/emailDelivery 缺省为 undefined（旧前端兼容）。
  res.json({ ...metrics.snapshot(), kbCache: getKbCacheStats(), rag: getRagStats(), emailDelivery: getEmailDeliveryStats() });
}));

/** 事件流洞察聚合（需管理员鉴权；BigQuery 优先，本地 JSONL 兜底；方案 §8 D5） */
app.get('/api/admin/insights', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await getInsights());
}));

/**
 * Prometheus 指标导出（供 Prometheus / Grafana 抓取）。
 * 鉴权：配置了 PROMETHEUS_TOKEN 时，允许 `Bearer <PROMETHEUS_TOKEN>` 静态令牌直连（供抓取）；
 * 否则沿用管理员 JWT（requireAuth）。静态令牌便于 Prometheus / Grafana 稳定抓取，无需每次登录。
 * 路由层将进程级指标（metrics.prometheus()）与业务指标（db.getDashboardStats()）
 * 拼为符合 Exposition Format 0.0.4 的文本，以 text/plain 返回。
 */
app.get(
  '/api/admin/metrics/prometheus',
  (req, res, next) => {
    const st = process.env.PROMETHEUS_TOKEN;
    if (st && (req.headers.authorization || '') === `Bearer ${st}`) return next();
    return requireAuth(req, res, next);
  },
  asyncHandler(async (_req, res) => {
  interface PromMetric {
    type: 'gauge' | 'counter';
    help: string;
    samples: string[];
  }
  const M = new Map<string, PromMetric>();
  const add = (
    name: string,
    type: 'gauge' | 'counter',
    help: string,
    value: number,
    labels?: Record<string, string | number>,
  ): void => {
    if (!M.has(name)) M.set(name, { type, help, samples: [] });
    const lbl = labels
      ? '{' + Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',') + '}'
      : '';
    M.get(name)!.samples.push(`${name}${lbl} ${value}`);
  };

  const stats = db.getDashboardStats();
  add('csa_sessions_total', 'gauge', 'Total conversation sessions', stats.totalSessions);
  add('csa_sessions_active', 'gauge', 'Currently active sessions', stats.activeSessions);
  add('csa_sessions_handoff_total', 'gauge', 'Sessions escalated to a human agent', stats.handoffSessions);
  add('csa_messages_total', 'gauge', 'Total messages stored', stats.totalMessages);
  add('csa_satisfaction_total', 'gauge', 'Total satisfaction ratings submitted', stats.ratingCount);
  add('csa_satisfaction_avg', 'gauge', 'Average satisfaction rating (1-5)', stats.avgRating);
  add('csa_knowledge_base_hit_rate', 'gauge', 'Knowledge base answer hit rate in percent (share of queries that found a matching FAQ above threshold)', stats.kbHitRate);
  // KB 检索 LRU 缓存命中指标：衡量「检索被缓存直接返回、跳过整轮打分」的收益，
  // 与上面的 answer hit rate 语义不同（后者是检索结果质量，本组是缓存效率）。
  const kbCache = getKbCacheStats();
  add('csa_kb_cache_hit_rate', 'gauge', 'KB retrieve LRU cache hit rate in percent', kbCache.hitRate);
  add('csa_kb_cache_hits_total', 'counter', 'KB retrieve LRU cache hits (served from cache, scoring skipped)', kbCache.hits);
  add('csa_kb_cache_misses_total', 'counter', 'KB retrieve LRU cache misses (triggered re-scoring)', kbCache.misses);
  add('csa_kb_cache_size', 'gauge', 'Current number of entries in the KB retrieve LRU cache', kbCache.lruSize);
  // RAG 检索增强指标：检索调用量 / 同义词扩展命中量 / 语义融合使用量 / 语义开关
  const rag = getRagStats();
  add('csa_rag_retrievals_total', 'counter', 'RAG retrieval calls (hybrid lexical + synonym expansion, optionally + semantic)', rag.retrievals);
  add('csa_rag_expanded_total', 'counter', 'RAG retrievals where synonym/colloquial expansion changed the query (recall lift)', rag.expanded);
  add('csa_rag_semantic_used_total', 'counter', 'RAG retrievals that used vector (semantic) fusion', rag.semanticUsed);
  add('csa_rag_semantic_enabled', 'gauge', 'Whether semantic embedding retrieval is configured (1/0)', rag.semantic ? 1 : 0);
  // CSAT 满意度问卷指标：派发/回收/回收率/平均分
  const csat = db.getCsatStats();
  add('csa_csat_surveys_total', 'counter', 'CSAT surveys dispatched (invitations sent)', csat.total);
  add('csa_csat_responses_total', 'counter', 'CSAT surveys responded (completed)', csat.responded);
  add('csa_csat_response_rate', 'gauge', 'CSAT response rate in percent (responded / dispatched)', csat.responseRate);
  add('csa_csat_avg_rating', 'gauge', 'CSAT average rating (1-5)', csat.avgRating);
  // 邮件投递指标：发送量（成功/失败，按 type 拆分）、重试、延迟、成功率 / 错误率
  const email = getEmailDeliveryStats();
  for (const [type, n] of Object.entries(email.sentByType)) {
    add('csa_email_send_total', 'counter', 'Emails delivered over real SMTP (by type and status)', n, { type, status: 'success' });
  }
  for (const [type, n] of Object.entries(email.failuresByType)) {
    add('csa_email_send_total', 'counter', 'Emails delivered over real SMTP (by type and status)', n, { type, status: 'failure' });
  }
  add('csa_email_send_retries_total', 'counter', 'Email delivery retry attempts (transient failures only)', email.retryTotal);
  add('csa_email_send_latency_sum_seconds', 'counter', 'Cumulative email delivery latency in seconds', email.latencySumSeconds);
  add('csa_email_send_latency_last_seconds', 'gauge', 'Last email delivery latency in seconds', email.latencyLastSeconds);
  add('csa_email_send_latency_avg_seconds', 'gauge', 'Average email delivery latency in seconds', email.latencyAvgSeconds);
  add('csa_email_send_success_rate', 'gauge', 'Email delivery success rate (0..1)', email.successRate);
  add('csa_email_send_error_rate', 'gauge', 'Email delivery error rate (0..1)', email.errorRate);
  for (const t of stats.ticketStats) {
    add('csa_tickets_total', 'gauge', 'Tickets grouped by status', t.count, { status: t.status });
  }

  const blocks: string[] = [metrics.prometheus().replace(/\n$/, '')];
  for (const [name, m] of M) {
    blocks.push(`# HELP ${name} ${m.help}\n# TYPE ${name} ${m.type}\n${m.samples.join('\n')}`);
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(blocks.join('\n') + '\n');
}));

app.get('/api/meta', asyncHandler(async (_req, res) => {
  const available = await probeSdk();
  res.json({
    brand: BRAND,
    mode: AGENT_MODE,
    sdkAvailable: available,
    engine: available ? 'CodeBuddy Agent SDK' : '知识库直答（降级）',
    intents: Object.values(INTENT_META),
    faqCount: db.faqCount(),
  });
}));

app.get('/api/models', async (_req, res) => {
  const cfg = getResolvedConfig();
  res.json({
    models: KNOWN_SUPPORTED_MODELS.map((m) => ({ modelId: m, name: m })),
    defaultModel: cfg.model,
    sdkBroken: isSdkBroken(),
  });
});

/* ============================ 大模型（LLM）配置管理 ============================ */

/** 读取当前 LLM 配置（apiKey 脱敏，仅返回 hasApiKey 布尔） */
app.get('/api/admin/llm-config', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ config: toPublicConfig(getResolvedConfig()) });
}));

/** 保存 LLM 配置（模型 / API 密钥 / 温度 / 最大回复长度 / 系统提示词） */
app.post('/api/admin/llm-config', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};

  if (body.model !== undefined) {
    patch.model = asString(body.model, { max: 64, name: 'model' });
    if (!patch.model) return res.status(400).json({ error: '模型类型不能为空' });
  }
  // apiKey：仅当显式提供非空字符串时才更新；传空字符串表示清除
  if (body.apiKey !== undefined) {
    patch.apiKey = asString(body.apiKey, { max: 512, name: 'apiKey' });
  }
  if (body.endpoint !== undefined) {
    patch.endpoint = asString(body.endpoint, { max: 512, name: 'endpoint' });
  }
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    if (!Number.isFinite(t)) return res.status(400).json({ error: '温度参数必须为数字' });
    patch.temperature = clampTemp(t);
  }
  if (body.maxReplyLength !== undefined) {
    const n = Number(body.maxReplyLength);
    if (!Number.isFinite(n)) return res.status(400).json({ error: '最大回复长度必须为数字' });
    if (n < MAX_REPLY_MIN || n > MAX_REPLY_MAX) {
      return res.status(400).json({ error: `最大回复长度须在 ${MAX_REPLY_MIN}–${MAX_REPLY_MAX} 之间` });
    }
    patch.maxReplyLength = clampMaxReply(n);
  }
  if (body.systemPrompt !== undefined) {
    patch.systemPrompt = asString(body.systemPrompt, { max: 8000, name: 'systemPrompt' });
  }

  const saved = db.saveLlmConfig(patch as any);
  logger.info(`[LLM 配置] 已更新：${Object.keys(patch).join(', ')}`);
  res.json({ config: toPublicConfig({ ...getResolvedConfig(), ...saved } as any) });
}));

/** 测试连接：用当前配置做一次轻量真实调用，返回成败与模型信息 */
app.post('/api/admin/llm-config/test', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (_req, res) => {
  const cfg = getResolvedConfig();
  const probeSession = { id: 'llm-config-test', sdk_session_id: null as string | null };
  const t0 = Date.now();
  try {
    const r = await callAgent({
      prompt: '你好，请只回复「连接正常」四个字。',
      systemPrompt: '你是客服助手。只回复「连接正常」四个字，不要多写。',
      model: cfg.model,
      session: probeSession,
      timeoutMs: 15000,
    });
    if (r.text && r.text.trim()) {
      res.json({ ok: true, usedModel: r.usedModel, latencyMs: Date.now() - t0, reply: r.text.trim().slice(0, 60) });
    } else {
      res.json({ ok: false, error: '模型返回为空', latencyMs: Date.now() - t0 });
    }
  } catch (e: any) {
    res.json({ ok: false, error: String(e?.message || e).slice(0, 200), latencyMs: Date.now() - t0 });
  }
}));

/* ============================ 管理员鉴权 ============================ */

app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const username = asString(req.body?.username, { max: 64, name: 'username' });
  const password = asString(req.body?.password, { max: 128, name: 'password' });
  if (!verifyCredentials(username, password)) {
    logger.warn(`登录失败：用户名=${username} ip=${clientIp(req)}`);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const user = db.getUserByUsername(username);
  const token = issueToken(username, user?.role ?? 'agent');
  logger.info(`登录成功：用户=${username} 角色=${user?.role} ip=${clientIp(req)}`);
  res.json({ token, role: user?.role ?? 'agent', expiresIn: Number(process.env.ADMIN_TOKEN_TTL_SEC) || 7 * 24 * 3600 });
}));

/* ============================ 员工/坐席管理 ============================ */

// 员工列表（管理员/主管可见）
app.get('/api/employees', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (_req, res) => {
  res.json({ employees: db.listUsers() });
}));

// 创建员工（仅管理员）
app.post('/api/employees', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const username = asString(req.body?.username, { max: 32, name: 'username' });
  if (!username) throw new HttpError(400, '用户名不能为空');
  if (db.getUserByUsername(username)) throw new HttpError(409, '用户名已存在');
  const displayName = asString(req.body?.display_name ?? req.body?.displayName, { max: 32, name: 'display_name', default: username });
  const role = asOneOf(req.body?.role, ['admin', 'manager', 'agent'], 'role');
  const password = asString(req.body?.password, { max: 128, name: 'password' });
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位');
  const user = db.createUser({ username, display_name: displayName, role, password_hash: hashPassword(password) });
  logger.info(`创建员工：${username} 角色=${role} 操作人=${(req.user as any)?.sub}`);
  const { password_hash, ...pub } = user;
  res.status(201).json({ employee: pub });
}));

// 更新员工（仅管理员）：角色 / 状态 / 显示名 / 重置密码
app.patch('/api/employees/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const existing = db.getUserById(id);
  if (!existing) throw new HttpError(404, '员工不存在');
  const update: db.UserUpdatable = {};
  if (req.body?.role !== undefined) update.role = asOneOf(req.body.role, ['admin', 'manager', 'agent'], 'role') as db.UserRole;
  if (req.body?.status !== undefined) update.status = asOneOf(req.body.status, ['active', 'disabled'], 'status') as db.UserStatus;
  if (req.body?.display_name !== undefined) update.display_name = asString(req.body.display_name, { max: 32, name: 'display_name' });
  if (req.body?.password !== undefined) {
    const pw = asString(req.body.password, { max: 128, name: 'password' });
    if (pw.length < 6) throw new HttpError(400, '密码至少 6 位');
    update.password_hash = hashPassword(pw);
  }
  // 防降级：禁止把唯一的 admin 改为非 admin
  if (update.role && update.role !== 'admin' && existing.role === 'admin') {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    if (admins.length <= 1) throw new HttpError(400, '至少保留一个管理员账户');
  }
  if (!db.updateUser(id, update)) throw new HttpError(400, '无任何变更');
  logger.info(`更新员工：${existing.username} 操作人=${(req.user as any)?.sub}`);
  const updated = db.getUserById(id)!;
  const { password_hash, ...pub } = updated;
  res.json({ employee: pub });
}));

// 停用员工（仅管理员，软删以避免误删）
app.delete('/api/employees/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const existing = db.getUserById(id);
  if (!existing) throw new HttpError(404, '员工不存在');
  if ((req.user as any)?.sub === existing.username) throw new HttpError(400, '不能停用当前登录账户');
  if (existing.role === 'admin') {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    if (admins.length <= 1) throw new HttpError(400, '至少保留一个管理员账户');
  }
  if (!db.updateUser(id, { status: 'disabled' })) throw new HttpError(400, '操作失败');
  logger.info(`停用员工：${existing.username} 操作人=${(req.user as any)?.sub}`);
  res.json({ ok: true });
}));

/* ============================ 客户长期画像 ============================ */

// 读取客户画像（管理员/主管/坐席可见）
app.get('/api/customers/:customerId/profile', requireAuth, asyncHandler(async (req, res) => {
  const customerId = asString(req.params.customerId, { max: 64, name: 'customerId' });
  if (!customerId) throw new HttpError(400, '客户标识不能为空');
  const profile = db.getCustomerProfile(customerId);
  // 契约一致性：未知客户 → 404（前端 http() 会抛错，调用方已有 catch 兜底显示空画像）
  if (!profile) return res.status(404).json({ error: '客户画像不存在', profile: null });
  res.json({ profile });
}));

// 更新/创建客户画像（upsert）
app.put('/api/customers/:customerId/profile', requireAuth, asyncHandler(async (req, res) => {
  const customerId = asString(req.params.customerId, { max: 64, name: 'customerId' });
  if (!customerId) throw new HttpError(400, '客户标识不能为空');
  const input: db.UpsertCustomerProfileInput = { customer_id: customerId };
  if (req.body?.name !== undefined) input.name = asString(req.body.name, { max: 64, name: 'name' });
  if (req.body?.company !== undefined) input.company = asString(req.body.company, { max: 128, name: 'company' });
  if (req.body?.industry !== undefined) input.industry = asString(req.body.industry, { max: 64, name: 'industry' });
  if (req.body?.contact !== undefined) input.contact = asString(req.body.contact, { max: 64, name: 'contact' });
  if (req.body?.tags !== undefined) input.tags = asTagString(req.body.tags, 20, 32, 'tags');
  if (req.body?.preferences !== undefined) input.preferences = asString(req.body.preferences, { max: 1000, name: 'preferences' });
  if (req.body?.notes !== undefined) input.notes = asString(req.body.notes, { max: 2000, name: 'notes' });
  if (req.body?.history_summary !== undefined) input.history_summary = asString(req.body.history_summary, { max: 2000, name: 'history_summary' });
  const profile = db.upsertCustomerProfile(input);
  logger.info(`更新客户画像：${customerId} 操作人=${(req.user as any)?.sub}`);
  res.json({ profile });
}));

/* ============================ 会话 API ============================ */

app.get('/api/sessions', requireAuth, asyncHandler(async (_req, res) => {
  // 批量统计消息数，避免逐会话查询（N+1）
  const counts = db.getSessionMessageCounts();
  const sessions = db.getAllSessions().map((s) => ({
    ...s,
    messageCount: counts[s.id] || 0,
  }));
  res.json({ sessions });
}));

app.get('/api/sessions/:sessionId', requireAuth, asyncHandler(async (req, res) => {
  const session = db.getSession(req.params.sessionId);
  if (!session) throw new HttpError(404, '会话不存在');
  const messages = db.getMessagesBySession(req.params.sessionId).map((m) => ({
    ...m,
    faq_ids: m.faq_ids ? JSON.parse(m.faq_ids) : null,
    tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
  }));
  res.json({
    session,
    messages,
    tickets: db.getTicketsBySession(session.id),
    satisfaction: db.getSatisfactionBySession(session.id),
  });
}));

app.post('/api/sessions', asyncHandler(async (req, res) => {
  const customerName = asString(req.body?.customerName, { max: 64, name: 'customerName' }) || '访客用户';
  const model = asString(req.body?.model, { max: 32, name: 'model' }) || DEFAULT_MODEL;
  const customerId = asString(req.body?.customerId, { max: 64, name: 'customerId' });
  const session = db.createSession({
    id: uuidv4(),
    title: '新的咨询',
    model,
    customer_name: customerName,
    customer_id: customerId || null,
  });
  if (customerId) db.touchCustomerSession(customerId, session.id);
  res.json({ session });
}));

app.delete('/api/sessions/:sessionId', requireAuth, asyncHandler(async (req, res) => {
  const ok = db.deleteSession(req.params.sessionId);
  if (!ok) throw new HttpError(404, '会话不存在');
  res.json({ success: true });
}));

/** 结束会话 */
app.post('/api/sessions/:sessionId/close', requireAuth, asyncHandler(async (req, res) => {
  const resolved = asBool(req.body?.resolved, true);
  const ok = db.updateSession(req.params.sessionId, { status: 'closed', resolved: resolved ? 1 : 0 });
  if (!ok) throw new HttpError(404, '会话不存在');
  res.json({ success: true });
}));

/* ============================ 核心对话 API ============================ */

app.post('/api/chat', chatLimiter, asyncHandler(async (req, res) => {
  // 整体看门狗：超时强制断流，防止连接因内部某环节意外挂起而永久悬挂
  const chatWatchdog = setTimeout(() => {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.status(504).json({ error: '响应超时，请稍后重试' });
    } else {
      try {
        sse(res, { type: 'error', message: '响应超时，已中断本次回复' });
      } catch {
        /* 连接已断开，忽略写入异常 */
      }
      res.end();
    }
  }, CHAT_WATCHDOG_MS);
  res.once('finish', () => clearTimeout(chatWatchdog));
  res.once('close', () => clearTimeout(chatWatchdog));

  const rawMessage = String(req.body?.message || '');
  const message = rawMessage.length > 2000 ? rawMessage.slice(0, 2000) : rawMessage;
  const { model } = req.body || {};
  const customerName = String(req.body?.customerName || '').slice(0, 64) || '访客用户';
  if (!message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }
  // sessionId 规范化：仅接受合法 UUID v4，否则忽略并新建
  let providedSessionId: string | undefined = req.body?.sessionId;
  if (typeof providedSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providedSessionId)) {
    providedSessionId = undefined;
  }

  const startedAt = Date.now();
  const now = new Date().toISOString();

  /* ---- 会话装载 ---- */
  let session = providedSessionId ? db.getSession(providedSessionId) : null;
  if (!session) {
    const providedCustomerId = asString(req.body?.customerId, { max: 64, name: 'customerId' });
    session = db.createSession({
      id: providedSessionId || uuidv4(),
      title: truncate(String(message), 24),
      model: model || DEFAULT_MODEL,
      customer_name: customerName,
      customer_id: providedCustomerId || null,
    });
    if (providedCustomerId) db.touchCustomerSession(providedCustomerId, session.id);
  } else if (req.body?.customerId) {
    const providedCustomerId = asString(req.body.customerId, { max: 64, name: 'customerId' });
    if (providedCustomerId && !session.customer_id) {
      db.updateSession(session.id, { customer_id: providedCustomerId });
      session.customer_id = providedCustomerId;
      db.touchCustomerSession(providedCustomerId, session.id);
    }
  }

  /* ---- 聊天核心管线（与嵌入渠道共用） ---- */
  await runChatPipeline(req, res, { session, customerName, model, message, startedAt, now });
}));

/* ============================ 嵌入渠道（第三方网站） ============================ */

/**
 * 嵌入渠道聊天端点：第三方网站浮动窗调用。
 * 鉴权方式：请求体携带 siteId + token（嵌入码所含），服务端校验站点存在、启用且 token 匹配。
 * 会话与本站 /api/chat 共用 sessions 表（仅多带 site_id/visitor_id + channel='embed'），
 * 因此所有嵌入对话天然同步进客服后台，坐席可在「对话记录」中按站点筛选、查看与介入。
 */
app.post('/api/embed/chat', embedLimiter, asyncHandler(async (req, res) => {
  const chatWatchdog = setTimeout(() => {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.status(504).json({ error: '响应超时，请稍后重试' });
    } else {
      try {
        sse(res, { type: 'error', message: '响应超时，已中断本次回复' });
      } catch {
        /* 连接已断开，忽略写入异常 */
      }
      res.end();
    }
  }, CHAT_WATCHDOG_MS);
  res.once('finish', () => clearTimeout(chatWatchdog));
  res.once('close', () => clearTimeout(chatWatchdog));

  const siteId = asString(req.body?.siteId, { max: 64, name: 'siteId' });
  const token = asString(req.body?.token, { max: 128, name: 'token' });
  if (!siteId || !token) {
    return res.status(400).json({ error: '缺少 siteId 或 token' });
  }
  const site = db.getSiteBySiteId(siteId);
  if (!site || site.status !== 'active' || site.embed_token !== token) {
    return res.status(403).json({ error: '站点校验失败：siteId 或 token 无效，或站点已停用' });
  }

  const rawMessage = String(req.body?.message || '');
  const message = rawMessage.length > 2000 ? rawMessage.slice(0, 2000) : rawMessage;
  if (!message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  const visitorName = String(req.body?.visitorName || '').slice(0, 64) || '网站访客';
  // 访客标识：优先使用客户端持久化的 visitorId，否则服务端生成并随 init 事件回传
  let visitorId = asString(req.body?.visitorId, { max: 64, name: 'visitorId' });
  let visitor = visitorId ? db.getVisitor(visitorId) : null;
  if (!visitor || visitor.site_id !== siteId) {
    visitor = db.upsertVisitor({ visitor_id: visitorId || uuidv4(), site_id: siteId, name: visitorName });
  }
  visitorId = visitor.visitor_id;

  const startedAt = Date.now();
  const now = new Date().toISOString();

  /* ---- 会话装载：复用该访客在本站点的最近一次会话，实现跨页面刷新续接 ---- */
  let session: db.DbSession | null | undefined = null;
  const providedSessionId = asString(req.body?.sessionId, { max: 64, name: 'sessionId' });
  if (providedSessionId) {
    const cand = db.getSession(providedSessionId);
    if (cand && cand.site_id === siteId && cand.visitor_id === visitorId) session = cand;
  }
  if (!session) session = db.getLatestSessionForVisitor(siteId, visitorId);
  if (!session) {
    session = db.createSession({
      id: uuidv4(),
      title: truncate(message, 24),
      model: DEFAULT_MODEL,
      customer_name: visitorName,
      channel: 'embed',
      site_id: siteId,
      visitor_id: visitorId,
    });
  }

  await runChatPipeline(req, res, { session, customerName: visitorName, model: DEFAULT_MODEL, message, startedAt, now, visitorId, siteId });
}));

/* ============================ 多渠道统一接入（邮件 / 即时通讯） ============================ */
// 外部渠道（邮件网关、IM 机器人）将消息统一投递到此，由服务端完成意图识别、知识库检索、
// 转人工判定与自动回复生成；回复文本由调用方负责外发（本服务不绑定具体邮件 / IM 网关）。
// 鉴权：请求体 secret 字段或 x-ingest-secret 头，必须等于环境变量 INGEST_SECRET。

function checkIngestSecret(req: express.Request, res: express.Response): boolean {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    res.status(503).json({ error: '服务端未配置 INGEST_SECRET，外部渠道接入不可用' });
    return false;
  }
  const provided = (req.body?.secret as string) || (req.headers['x-ingest-secret'] as string) || '';
  if (provided !== secret) {
    res.status(403).json({ error: '接入密钥无效' });
    return false;
  }
  return true;
}

function handleIngest(channel: ChannelType) {
  return asyncHandler(async (req, res) => {
    if (!checkIngestSecret(req, res)) return;
    const r = await ingestExternalMessage({
      channel,
      externalId: asString(req.body?.externalId, { max: 128, name: 'externalId' }),
      from: asString(req.body?.from, { max: 128, name: 'from' }),
      message: asString(req.body?.message, { name: 'message', max: 2000 }),
      subject: req.body?.subject ? asString(req.body.subject, { max: 256, name: 'subject' }) : undefined,
      siteId: req.body?.siteId ? asString(req.body.siteId, { max: 64, name: 'siteId' }) : undefined,
      customerName: req.body?.customerName ? asString(req.body.customerName, { max: 64, name: 'customerName' }) : undefined,
      preferredAgentId: req.body?.preferredAgentId ? asString(req.body.preferredAgentId, { max: 64, name: 'preferredAgentId' }) : null,
    });
    if ('error' in r) return res.status(400).json({ error: r.error });
    res.json({ ...r, channel });
  });
}

app.post('/api/ingest/email', handleIngest('email'));
app.post('/api/ingest/im', handleIngest('im'));

/* ============================ 站点管理 API（管理鉴权保护） ============================ */

// 创建接入站点（返回含 embed_token 的站点信息，token 仅此刻可见）
app.post('/api/admin/sites', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const name = asString(req.body?.name, { max: 64, name: 'name' });
  if (!name) return res.status(400).json({ error: '站点名称不能为空' });
  const domain = asString(req.body?.domain, { max: 128, name: 'domain' });
  const site = db.createSite({ name, domain });
  res.status(201).json({ site });
}));

// 站点列表（聚合会话数，隐藏 embed_token）
app.get('/api/admin/sites', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (_req, res) => {
  res.json({ sites: db.listSites() });
}));

// 更新站点（改名 / 域名 / 启用停用）
app.patch('/api/admin/sites/:id', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const patch: db.UpdateSiteInput = {};
  if (req.body?.name !== undefined) patch.name = asString(req.body.name, { max: 64, name: 'name' });
  if (req.body?.domain !== undefined) patch.domain = asString(req.body.domain, { max: 128, name: 'domain' });
  if (req.body?.status !== undefined) patch.status = asOneOf(req.body.status, ['active', 'disabled'] as const, 'status');
  const site = db.updateSite(req.params.id, patch);
  if (!site) return res.status(404).json({ error: '站点不存在' });
  res.json({ site: { ...site, embed_token: undefined } });
}));

// 软停用站点（保留数据，停止接受嵌入流量）
app.delete('/api/admin/sites/:id', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const site = db.updateSite(req.params.id, { status: 'disabled' });
  if (!site) return res.status(404).json({ error: '站点不存在' });
  res.json({ success: true, site: { ...site, embed_token: undefined } });
}));

/* ============================ FAQ 知识库 API ============================ */

app.get('/api/faqs', asyncHandler(async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  let faqs = db.getAllFaqs(false);
  if (category) faqs = faqs.filter((f) => f.category === category);
  res.json({ faqs });
}));

app.post('/api/faqs', requireAuth, asyncHandler(async (req, res) => {
  const category = asString(req.body?.category, { max: 32, name: 'category' });
  const question = asString(req.body?.question, { max: 500, name: 'question' });
  const answer = asString(req.body?.answer, { max: 4000, name: 'answer' });
  if (!category || !question || !answer) throw new HttpError(400, 'category / question / answer 为必填项');
  const keywords = asString(req.body?.keywords, { max: 200, name: 'keywords' });
  const tags = asTagString(req.body?.tags, 20, 32, 'tags');
  const enabled = asBool(req.body?.enabled, true) ? 1 : 0;
  const faq = db.upsertFaq({ id: uuidv4(), category, question, answer, keywords, tags, enabled });
  res.json({ faq });
}));

app.patch('/api/faqs/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = db.getFaq(req.params.id);
  if (!existing) throw new HttpError(404, 'FAQ 不存在');
  // 仅允许已知字段更新，避免盲目展开 req.body 注入越权字段
  const patch = req.body || {};
  const merged = {
    ...existing,
    id: existing.id,
    category: patch.category !== undefined ? asString(patch.category, { max: 32, name: 'category' }) : existing.category,
    question: patch.question !== undefined ? asString(patch.question, { max: 500, name: 'question' }) : existing.question,
    answer: patch.answer !== undefined ? asString(patch.answer, { max: 4000, name: 'answer' }) : existing.answer,
    keywords: patch.keywords !== undefined ? asString(patch.keywords, { max: 200, name: 'keywords' }) : existing.keywords,
    tags: patch.tags !== undefined ? asTagString(patch.tags, 20, 32, 'tags') : existing.tags,
    enabled: patch.enabled !== undefined ? (asBool(patch.enabled, true) ? 1 : 0) : existing.enabled,
  };
  if (!merged.category || !merged.question || !merged.answer) {
    throw new HttpError(400, 'category / question / answer 不能为空');
  }
  const faq = db.upsertFaq(merged);
  res.json({ faq });
}));

app.delete('/api/faqs/:id', requireAuth, asyncHandler(async (req, res) => {
  const ok = db.deleteFaq(req.params.id);
  if (!ok) throw new HttpError(404, 'FAQ 不存在');
  res.json({ success: true });
}));

/** 坐席 Copilot 辅助：基于客户消息给出草稿/KR参考/画像洞察/下一步动作（需登录） */
app.post('/api/copilot/suggest', requireAuth, asyncHandler(async (req, res) => {
  const message = asString(req.body?.message, { name: 'message' });
  if (!message) throw new HttpError(400, 'message 不能为空');
  const sessionId = req.body?.sessionId
    ? asString(req.body.sessionId, { name: 'sessionId', max: 64 })
    : undefined;
  const customerId = req.body?.customerId
    ? asString(req.body.customerId, { name: 'customerId', max: 128 })
    : undefined;
  const suggestion = await getCopilotSuggestions({ sessionId, customerId, message });
  res.json(suggestion);
}));

/** 知识库检索预览（管理后台调试用） */
app.post('/api/faqs/search', asyncHandler(async (req, res) => {
  const q = asString(req.body?.query, { name: 'query' });
  if (!q) throw new HttpError(400, '查询内容不能为空');
  const intent = asString(req.body?.intent, { name: 'intent' });
  const result = classifyIntent(q);
  const hits = await retrieveRag(q, (intent as IntentId) || result.intent, 5);
  res.json({ intent: result, hits, threshold: HIT_THRESHOLD, directThreshold: DIRECT_ANSWER_THRESHOLD });
}));

/** 「猜你想问」推荐接口：低阈值相关 FAQ，供前端对话卡片或后台联想输入调用 */
app.post('/api/faqs/recommend', asyncHandler(async (req, res) => {
  const q = asString(req.body?.query, { name: 'query' });
  if (!q) throw new HttpError(400, '查询内容不能为空');
  const intent = asString(req.body?.intent, { name: 'intent' });
  const topK = Math.min(8, Math.max(1, Number(req.body?.topK) || 3));
  const exclude = Array.isArray(req.body?.excludeIds) ? req.body.excludeIds.map(String) : [];
  const hits = recommendFaqs(q, (intent as IntentId) || undefined, topK, exclude);
  res.json({ recommended: hits });
}));

/** 批量导入 FAQ（CSV / JSON），用于把真实业务知识库一键入库 */
app.post('/api/admin/import/faqs', requireAuth, asyncHandler(async (req, res) => {
  const format = asString(req.body?.format, { max: 8, name: 'format', default: 'json' });
  const raw = req.body?.data;
  let rows: Array<{ category: string; question: string; answer: string; keywords: string; tags: string }> = [];

  if (format === 'csv') {
    const text = typeof raw === 'string' ? raw : '';
    if (!text.trim()) throw new HttpError(400, 'CSV 内容不能为空');
    rows = parseCsv(text).map((c) => ({
      category: (c.category ?? c['类目'] ?? '').trim(),
      question: (c.question ?? c['问题'] ?? '').trim(),
      answer: (c.answer ?? c['答案'] ?? '').trim(),
      keywords: (c.keywords ?? c['关键词'] ?? '').trim(),
      tags: (c.tags ?? c['标签'] ?? '').trim(),
    }));
  } else if (format === 'json') {
    if (!Array.isArray(raw)) throw new HttpError(400, 'JSON 模式 data 须为对象数组');
    rows = raw.map((r: any) => ({
      category: String(r?.category ?? r?.类目 ?? '').trim(),
      question: String(r?.question ?? r?.问题 ?? '').trim(),
      answer: String(r?.answer ?? r?.答案 ?? '').trim(),
      keywords: String(r?.keywords ?? r?.关键词 ?? '').trim(),
      tags: String(r?.tags ?? r?.标签 ?? '').trim(),
    }));
  } else {
    throw new HttpError(400, 'format 仅支持 json / csv');
  }

  const errors: string[] = [];
  let imported = 0;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.category || !r.question || !r.answer) {
      errors.push(`第 ${i + 1} 行：category/question/answer 缺失`);
      continue;
    }
    if (r.question.length > 500 || r.answer.length > 4000 || r.category.length > 32) {
      errors.push(`第 ${i + 1} 行：字段超长`);
      continue;
    }
    const key = r.question.toLowerCase();
    if (seen.has(key)) continue; // 同批次按问题去重
    seen.add(key);
    db.upsertFaq({
      id: uuidv4(),
      category: r.category,
      question: r.question,
      answer: r.answer,
      keywords: r.keywords.slice(0, 200),
      tags: r.tags.slice(0, 200),
      enabled: 1,
    });
    imported++;
  }
  logger.info(`导入 FAQ：成功 ${imported} 条，跳过/错误 ${errors.length} 条 操作人=${(req.user as any)?.sub}`);
  res.json({ imported, errors });
}));

/** 轻量 CSV 解析（支持双引号转义与字段内逗号/换行） */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (field.length || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

/* ============================ 满意度 API ============================ */

app.post('/api/satisfaction', asyncHandler(async (req, res) => {
  const sessionId = asString(req.body?.sessionId, { name: 'sessionId' });
  if (!sessionId) throw new HttpError(400, 'sessionId 为必填项');
  if (!db.getSession(sessionId)) throw new HttpError(404, '会话不存在');
  const rating = asIntInRange(req.body?.rating, 1, 5, 'rating');
  const messageId = req.body?.messageId != null ? asString(req.body.messageId, { name: 'messageId' }) : null;
  const tags = asTagString(req.body?.tags, 10, 32, 'tags');
  const comment = asString(req.body?.comment, { max: 500, name: 'comment' });
  const resolved = asBool(req.body?.resolved);
  const record = db.createSatisfaction({
    id: uuidv4(),
    session_id: sessionId,
    message_id: messageId,
    rating,
    tags,
    comment,
    resolved: resolved ? 1 : 0,
  });
  db.updateSession(sessionId, { resolved: resolved || rating >= 4 ? 1 : 0 });
  res.json({ satisfaction: record });
}));

app.get('/api/satisfaction', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ items: db.getAllSatisfaction() });
}));

/* ============================ 客户满意度评价（CSAT） ============================ */

// 公开：问卷元信息（供匿名问卷页渲染；不返回 PII）
app.get('/api/csat/survey/:token', asyncHandler(async (req, res) => {
  const meta = getSurveyMeta(req.params.token);
  if (meta.status === 'notfound') return res.status(404).json({ error: '问卷不存在或已失效' });
  res.json(meta);
}));

// 公开：匿名提交（凭 survey_token，无需登录）
app.post('/api/csat/submit', asyncHandler(async (req, res) => {
  const { token, rating, comment, tags } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: '缺少问卷 token' });
  if (rating == null) return res.status(400).json({ error: '缺少评分' });
  try {
    const status = submitSurvey(token, Number(rating), comment ? String(comment).slice(0, 1000) : null, tags ? String(tags).slice(0, 200) : null);
    if (status === 'notfound') return res.status(404).json({ error: '问卷不存在或已失效' });
    if (status === 'already') return res.status(409).json({ error: '您已评价过，感谢支持', already: true });
    if (status === 'expired') return res.status(410).json({ error: '问卷已过期，无法提交' });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || '提交失败' });
  }
}));

// 管理：CSAT 聚合统计
app.get('/api/admin/csat', requireAuth, asyncHandler(async (_req, res) => {
  res.json(db.getCsatStats());
}));

// 管理：手动派发问卷（admin / manager）
app.post('/api/admin/csat/dispatch', requireAuth, requireRole('admin', 'manager'), asyncHandler(async (req, res) => {
  const { sessionId, ticketId, channel, toAddress, customerName, baseUrl } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: '缺少 sessionId' });
  const base = baseUrl || `${req.protocol}://${req.get('host')}`;
  const result = dispatchSurvey({
    sessionId,
    ticketId: ticketId ?? null,
    channel: channel || 'web',
    toAddress: toAddress || null,
    customerName: customerName || null,
    baseUrl: base,
  });
  res.json(result);
}));

// 管理：解决工单并自动派发满意度问卷
app.post('/api/admin/tickets/:id/resolve', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const t = db.getTicket(id);
  if (!t) return res.status(404).json({ error: '工单不存在' });
  db.updateTicket(id, { status: 'resolved' });
  const sess = db.getSession(t.session_id);
  const channel = t.channel || sess?.channel || 'web';
  // 邮件渠道用客户标识（customer_id，邮件场景即为邮箱）作为收件人
  const toAddress = channel === 'email' ? sess?.customer_id || null : null;
  const survey = dispatchSurvey({
    sessionId: t.session_id,
    ticketId: id,
    channel,
    toAddress,
    customerName: t.customer_name || sess?.customer_name || null,
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  res.json({ ticket: { ...t, status: 'resolved' }, survey });
}));

/* ============================ 工单 API ============================ */

app.get('/api/tickets', requireAuth, (req, res) => {
  const { status } = req.query;
  res.json({ tickets: db.getTickets(status ? String(status) : undefined) });
});

app.patch('/api/tickets/:id', requireAuth, asyncHandler(async (req, res) => {
  const updates: Partial<Pick<db.DbTicket, 'status' | 'assignee' | 'note' | 'priority'>> = {};
  if (req.body?.status !== undefined) updates.status = asOneOf(req.body.status, ['pending', 'processing', 'resolved', 'closed'], 'status') as db.TicketStatus;
  if (req.body?.priority !== undefined) updates.priority = asOneOf(req.body.priority, ['low', 'medium', 'high', 'urgent'], 'priority') as db.TicketPriority;
  if (req.body?.assignee !== undefined) updates.assignee = asString(req.body.assignee, { max: 32, name: 'assignee' }) || null;
  if (req.body?.note !== undefined) updates.note = asString(req.body.note, { max: 500, name: 'note' }) || null;
  const ok = db.updateTicket(req.params.id, updates);
  if (!ok) throw new HttpError(404, '工单不存在');
  res.json({ success: true });
}));

/* ============================ 管理后台 API ============================ */

// 看板聚合较重（含首响时延统计，最坏需扫描数千会话），加短 TTL 缓存。
// 仪表盘为轮询刷新，15s 内复用同一份聚合，避免高频请求反复冻结事件循环。
let statsCache: { at: number; payload: unknown } | null = null;
const STATS_TTL_MS = 15_000;
app.get('/api/admin/stats', requireAuth, asyncHandler(async (_req, res) => {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) {
    return res.json(statsCache.payload);
  }
  const stats = db.getDashboardStats();
  const payload = {
    ...stats,
    intentDistribution: stats.intentDistribution.map((i) => ({
      ...i,
      label: INTENT_META[i.intent as IntentId]?.label || i.intent,
      color: INTENT_META[i.intent as IntentId]?.color || '#888',
    })),
  };
  statsCache = { at: now, payload };
  res.json(payload);
}));

app.get('/api/admin/conversations', requireAuth, asyncHandler(async (req, res) => {
  const { status, intent, keyword, channel } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  const result = db.getConversationList(
    {
      status: status ? String(status) : undefined,
      intent: intent ? String(intent) : undefined,
      keyword: keyword ? String(keyword) : undefined,
      channel: channel ? String(channel) : undefined,
    },
    { page, pageSize },
  );
  res.json({
    conversations: result.rows.map((c) => ({
      ...c,
      intent_label: c.primary_intent ? INTENT_META[c.primary_intent as IntentId]?.label ?? c.primary_intent : '—',
    })),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}));

/** 对话记录 CSV 导出（管理鉴权保护） */
app.get('/api/admin/conversations/export', requireAuth, asyncHandler(async (req, res) => {
  const { status, intent, keyword, channel } = req.query;
  const rows = db.getConversationExport({
    status: status ? String(status) : undefined,
    intent: intent ? String(intent) : undefined,
    keyword: keyword ? String(keyword) : undefined,
    channel: channel ? String(channel) : undefined,
  });
  const headers = ['会话ID', '标题', '客户', '意图', '状态', '是否解决', '消息数', '平均评分', '工单数', '转人工原因', '创建时间', '更新时间'];
  const csvCell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.title,
        r.customer_name,
        r.primary_intent,
        r.status,
        r.resolved ? '是' : '否',
        r.message_count,
        r.avg_rating == null ? '' : Number(r.avg_rating).toFixed(2),
        r.ticket_count,
        r.handoff_reason,
        r.created_at,
        r.updated_at,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM 头确保 Excel 正确识别 UTF-8 中文
  const csv = '﻿' + lines.join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conversations-${stamp}.csv"`);
  res.send(csv);
}));

/* ============================ 演示数据 API ============================ */

app.get('/api/orders', (_req, res) => {
  res.json({ orders: listOrders() });
});

app.post('/api/admin/reset-demo', requireAuth, asyncHandler(async (_req, res) => {
  db.clearAllData();
  const count = seedDemoData(true);
  res.json({ success: true, seeded: count });
}));

/* ============================ 数据管理（备份 / 完整性 / 空间回收） ============================ */
app.get('/api/admin/db/meta', requireAuth, asyncHandler(async (_req, res) => {
  res.json(db.getDbMeta());
}));

app.get('/api/admin/db/backup', requireAuth, (_req, res) => {
  try {
    const dest = db.backupDb();
    const filename = path.basename(dest);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(dest);
    const cleanup = () => fs.unlink(dest, () => {});
    stream.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'backup_stream_failed' });
      else res.destroy();
    });
    stream.on('end', cleanup);
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'backup_failed', message: String((e as Error).message || e) });
  }
});

app.get('/api/admin/db/integrity', requireAuth, asyncHandler(async (_req, res) => {
  res.json(db.checkIntegrity());
}));

app.post('/api/admin/db/vacuum', requireAuth, (_req, res) => {
  try {
    const r = db.vacuumDb();
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(500).json({ error: 'vacuum_failed', message: String((e as Error).message || e) });
  }
});

/* ============================ 生产环境静态托管 ============================ */
// 构建产物 dist/ 存在时，由 Express 直接托管前端并支持 SPA 前端路由回退。
// 开发模式（Vite 提供前端 + 代理 /api）时 dist 不存在，此段不生效。
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA 回退：所有非 /api 路径返回 index.html（需位于 API 路由注册之后）
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
  logger.info('已启用前端静态托管（dist/）');
}

/* ============================ 404 与集中错误处理 ============================ */
// 须注册在所有路由之后；4 参数签名使其仅在 next(err) 时触发，不会拦截正常请求。
app.use(notFoundHandler);
app.use(errorHandler);

/* ============================ 启动 ============================ */

// 预热内存会话索引，保证异步渠道线程续接在服务启动后即可命中（无需等首条 DB 回退）
preloadSessionRegistry();
// 启动邮件网关（未配置 EMAIL_ENABLED 时自动禁用，零副作用）
startEmailGateway();

const server = app.listen(PORT, () => {
  logger.info(
    `智能客服 Agent 服务端已启动 | 地址 http://localhost:${PORT} | 模式 ${AGENT_MODE} | FAQ ${db.faqCount()} 条 | DB SQLite(data/chat.db)`,
  );
  probeSdk();
  void confirmSdk();
});

/* ============================ 优雅退出 ============================ */
function shutdown(signal: string) {
  logger.info(`收到 ${signal}，开始优雅关闭…`);
  server.close(async () => {
    // 先停邮件网关轮询，避免关闭期间再向写入队列投递
    try {
      stopEmailGateway();
    } catch (e) {
      logger.warn(`[shutdown] 邮件网关停止异常: ${(e as Error)?.message || e}`);
    }
    // 再刷完写入队列残留，确保异步渠道消息全部落库再关连接
    try {
      await drainWriteQueue();
    } catch (e) {
      logger.warn(`[shutdown] 写入队列 drain 异常: ${(e as Error)?.message || e}`);
    }
    try {
      db.default.close();
    } catch {
      /* ignore */
    }
    logger.info('服务与数据库连接已关闭');
    process.exit(0);
  });
  // 兜底：若 8s 内未正常关闭则强制退出
  const t = setTimeout(() => process.exit(1), 8000);
  if (t.unref) t.unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
