/**
 * 多渠道统一接入模块
 *
 * 统一管理「网页（web）/ 嵌入（embed）/ 邮件（email）/ 即时通讯（im）」四类来源的会话，
 * 将它们收敛进同一张 sessions 表（以 channel 字段区分），实现：
 *  - 跨渠道身份聚合：相同联系方式（邮箱 / IM 账号）在不同渠道视为同一客户，画像互通；
 *  - 统一的处理闭环：每条外部消息都经过 意图识别 → 知识库检索 → 转人工判定 →
 *    自动回复 / 建单，与实时聊天（web/embed）共用同一套 AI 内核（Agent + 领域工具），避免规则分叉；
 *  - 异步适配：邮件 / IM 无法流式推送，因此这里产出「可直接外发」的纯文本回复，
 *    由上层路由负责投递（本模块不绑定具体邮件 / IM 网关，保持可扩展性）。
 *
 * AI 化：email / im 渠道现由 LLM Agent 生成回复（可调用 search_knowledge / query_order /
 * get_customer / create_ticket 工具）；SDK 不可用或调用异常时，自动降级为原有
 * 「知识库直答 + 引导话术 + 业务意图建单」兜底，保证异步渠道「有回执、不丢消息」。
 */
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { classifyIntent, isNegativeSentiment, type IntentId } from './intent.js';
import { HIT_THRESHOLD, type FaqHit } from './knowledge.js';
import { retrieveRag, buildRagContext } from './rag.js';
import {
  evaluateHandoff,
  buildHandoffMessage,
  detectAgentSignal,
  stripHandoffToken,
  type HandoffDecision,
  type HandoffRule,
} from './handoff.js';
import { computePriority, computeSlaDue, assignTicket } from './tickets.js';
import { resolveOrderContext, withTimeout } from './orders.js';
import { enrichProfile } from './profile.js';
import { truncate } from './nlp.js';
import { logger } from './logger.js';
import { enqueue } from './writeQueue.js';
import { getOpenSession, registerSession, touchSession as regTouchSession, setSessionStatus } from './sessionRegistry.js';
// AI 内核共享层：与 web/embed 共用同一 Agent 调用与系统提示词构造
import {
  callAgent,
  buildSystemPrompt,
  formatCustomerProfile,
  probeSdk,
  isSdkBroken,
  DEFAULT_MODEL,
  AGENT_FIRST_TOKEN_TIMEOUT,
  buildHistoryText,
} from './agentCore.js';
import { geminiConfigured } from './geminiAgent.js';
import { summarizeConversation } from './summarize.js';
import { analyzeSentiment } from './sentiment.js';
import { escalateFromContext, higherPriority, notifyEscalation } from './escalation.js';
import { getResolvedConfig } from './llmConfig.js';

export type ChannelType = 'web' | 'embed' | 'email' | 'im';

export interface IngestInput {
  /** 来源渠道 */
  channel: ChannelType;
  /** 渠道侧唯一消息标识（邮件 Message-ID / IM 消息 ID），用于幂等去重 */
  externalId: string;
  /** 客户标识（邮箱地址 / IM 账号 / 手机号），用于跨渠道聚合画像 */
  from: string;
  /** 用户消息正文 */
  message: string;
  /** 邮件主题（可选） */
  subject?: string;
  /** 嵌入渠道站点 ID（可选） */
  siteId?: string;
  /** 客户昵称（可选） */
  customerName?: string;
  /** 指定受理坐席（可选，手动指派或技能匹配覆盖） */
  preferredAgentId?: string | null;
}

export interface IngestResult {
  sessionId: string;
  customerId: string;
  intent: IntentId;
  confidence: number;
  faqHits: Array<{ id: string; question: string; answer: string; score: number }>;
  /** 可直接外发给客户的回复文本 */
  reply: string;
  /** 是否触发转人工 */
  handoff: boolean;
  ticketId?: string;
  priority?: string;
  queuePosition?: number;
  /** 工单受理坐席 ID（可能为 null：进入公共队列） */
  assignee?: string | null;
  sentimentDelta: number;
}

/** 跨渠道统一客户标识：相同联系方式视为同一客户，打通 web/email/im 画像 */
function resolveExternalCustomer(channel: ChannelType, from: string): string {
  return `ext_${channel}:${(from || 'unknown').trim().toLowerCase()}`;
}

function sentimentDeltaOf(text: string): number {
  return isNegativeSentiment(text) ? -1 : 0;
}

/** 知识库未命中且无转人工时的引导回复（异步渠道不阻塞，直接引导留资 / 转人工） */
function composeExternalReply(intent: IntentId): string {
  const guide: Record<string, string> = {
    refund: '您好，关于退款/退换货，我们已收到您的诉求，专员将在服务时间内（每日 09:00–21:00）为您核实订单与售后政策。请留意我们的回复，或回复"转人工"立即接入。',
    order_query: '您好，您的订单查询请求已收到，专员将为您核实物流与订单状态。如需加速处理，可回复订单号，或回复"转人工"。',
    tech_support: '您好，您的技术问题已记录，FAE 技术专家将在工作日 09:30–18:30 为您跟进。请尽量提供设备型号与故障现象，便于快速定位。',
    complaint: '非常抱歉给您带来不便，您的反馈已升级至专人处理，我们会尽快与您联系。',
    human_service: '好的，正在为您转接人工客服，请稍候。',
  };
  return (
    guide[intent] ||
    '您好，您的问题已收到，我们已为您安排专人在服务时间内（每日 09:00–21:00）跟进。如需立即人工协助，请回复"转人工"。'
  );
}

/** 异步渠道默认建单跟踪的业务意图集合（闲聊 / 其它不建单） */
const BUSINESS_INTENTS: IntentId[] = ['complaint', 'refund', 'tech_support', 'order_query'];

const PRIORITY_LABEL: Record<db.TicketPriority, string> = {
  low: '低',
  medium: '普通',
  high: '高',
  urgent: '紧急',
};

/**
 * 在会话维度创建工单（含优先级 / SLA / 分配），返回工单与队列信息。
 * 被升级分支与业务意图自动建单分支共用，确保建单逻辑单一来源。
 */
async function openIngestTicket(opts: {
  session: db.DbSession;
  intent: IntentId;
  reason: string;
  rule: HandoffRule | null;
  priority: db.TicketPriority;
  now: string;
  /** 规则拼装的兜底摘要（LLM 不可用时使用） */
  summary: string;
  /** 当前用户消息（尚未落库），用于生成更准确的 AI 摘要 */
  currentMessage?: string;
  preferredAgentId?: string | null;
}): Promise<{ ticketId: string; assignee: string | null; queuePosition: number; priority: db.TicketPriority }> {
  const assign = assignTicket(opts.intent, { preferredAgentId: opts.preferredAgentId });
  const assignee = assign.assignee;
  const queuePosition = db.countTicketsByStatus('pending') + 1;
  const ticketId = uuidv4();
  const slaDue = computeSlaDue(opts.priority, opts.now);
  // AI 会话摘要（工单自动填充）：基于历史消息 + 当前消息生成结构化摘要；CLI 不可达时回退规则摘要
  const histMsgs = db
    .getMessagesBySession(opts.session.id)
    .map((m) => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }));
  const sum = await summarizeConversation(histMsgs, {
    sessionId: opts.session.id,
    currentMessage: opts.currentMessage,
    timeoutMs: 12000,
  });
  // 情感识别 + 智能升级：基于当前消息 + 历史会话产出情绪与升级决策；
  // CLI 不可达时 sentiment 由词库分析兜底（senti），保证情感列在降级场景也有值。
  const esc = escalateFromContext({
    message: opts.currentMessage || opts.summary,
    history: histMsgs,
    currentPriority: opts.priority,
    unresolved: true,
  });
  const finalPriority = higherPriority(opts.priority, esc.decision.priority);
  const sentimentForTicket = sum?.sentiment ?? esc.sentiment;
  // 工单写入入队（write-behind），与消息/意图流水统一由 writeQueue 批量落库
  enqueue({
    type: 'createTicket',
    payload: {
      id: ticketId,
      session_id: opts.session.id,
      customer_name: opts.session.customer_name,
      intent: opts.intent,
      reason: opts.reason,
      trigger_rule: opts.rule,
      summary: (sum?.summary || opts.summary).slice(0, 800),
      sentiment: sentimentForTicket,
      tags: sum?.tags?.length ? sum.tags.join(',') : null,
      escalated: esc.decision.escalate ? 1 : 0,
      escalation_reason: esc.decision.reason,
      priority: finalPriority,
      status: 'pending',
      assignee,
      sla_due_at: slaDue,
      channel: opts.session.channel,
    },
  });
  // 升级通知（best-effort，不阻塞建单）
  if (esc.decision.notify) {
    void notifyEscalation({
      ticketId,
      priority: finalPriority,
      reason: esc.decision.reason || '智能升级',
      channel: opts.session.channel,
      customer: opts.session.customer_name,
    });
  }
  return { ticketId, assignee, queuePosition, priority: finalPriority };
}

/**
 * 统一外部消息接入入口。被 /api/ingest/email 与 /api/ingest/im 复用（鉴权在路由层完成）。
 * 任何单步异常均被捕获并返回 error 字段，避免单条消息污染整批投递。
 */
export async function ingestExternalMessage(input: IngestInput): Promise<IngestResult | { error: string }> {
  try {
    const message = (input.message || '').toString().slice(0, 2000);
    if (!message.trim()) return { error: '消息内容为空' };
    if (!input.from || !input.externalId) return { error: '缺少 from 或 externalId' };

    const customerId = resolveExternalCustomer(input.channel, input.from);
    const now = new Date().toISOString();
    const customerName = input.customerName || (input.channel === 'email' ? input.from : '渠道客户');

    /* ---- 会话装载：优先内存索引（同步、零 DB），未命中回退 DB，保证邮件/IM 线程连续性 ---- */
    let session: db.DbSession;
    const existing = getOpenSession(customerId, input.channel);
    if (!existing) {
      const newId = uuidv4();
      const now = new Date().toISOString();
      // 在内存中构造会话对象（与 db.createSession 返回同构），决策阶段即可使用，无需等待落库
      session = {
        id: newId,
        title: truncate(input.subject || message, 24),
        model: 'external',
        sdk_session_id: null,
        customer_id: customerId,
        customer_name: customerName,
        channel: input.channel,
        site_id: input.siteId || null,
        visitor_id: null,
        status: 'active',
        primary_intent: null,
        handoff: 0,
        handoff_reason: null,
        resolved: 0,
        created_at: now,
        updated_at: now,
      };
      // 同步登记内存索引（保证窗口内续接不重复建单），DB 写入入队（write-behind）
      registerSession({ id: newId, customerId, channel: input.channel, customerName });
      enqueue({
        type: 'createSession',
        payload: {
          id: newId,
          title: session.title,
          model: 'external',
          customer_name: customerName,
          customer_id: customerId,
          channel: input.channel,
          site_id: input.siteId || null,
          visitor_id: null,
        },
      });
    } else {
      session = existing;
    }
    // 触达：刷新会话续接窗口（同步更新内存索引）
    regTouchSession(session.id, customerId, input.channel);

    /* ---- ① 意图识别 ---- */
    const history = db.getMessagesBySession(session.id);
    const lastUserIntent = [...history]
      .reverse()
      .find((m) => m.role === 'user' && m.intent)?.intent as IntentId | undefined;
    const intentResult = classifyIntent(message, lastUserIntent ?? null);

    /* ---- ② 知识库检索 ---- */
    const faqHits = await retrieveRag(message, intentResult.intent, 3);
    const topScore = faqHits[0]?.score ?? 0;
    const hitIds = faqHits.filter((h) => h.score >= HIT_THRESHOLD).map((h) => h.id);

    /* ---- 持久化用户消息 + 意图流水（入队，write-behind 批量落库） ---- */
    enqueue({
      type: 'persistMessage',
      payload: {
        id: uuidv4(),
        session_id: session.id,
        role: 'user',
        content: message,
        created_at: now,
        intent: intentResult.intent,
        intent_confidence: intentResult.confidence,
        faq_ids: JSON.stringify(hitIds),
        source: 'user',
      },
    });
    enqueue({
      type: 'createIntentLog',
      payload: {
        id: uuidv4(),
        session_id: session.id,
        message_id: null,
        text: truncate(message, 200),
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        matched_keywords: intentResult.matchedKeywords.join(','),
        hit_faq: hitIds.length ? 1 : 0,
      },
    });
    if (!session.primary_intent || session.primary_intent === 'other') {
      enqueue({ type: 'updateSession', payload: { id: session.id, updates: { primary_intent: intentResult.intent, channel: input.channel } } });
    }

    const sentimentDelta = sentimentDeltaOf(message);

    /* ---- ④ 转人工判定（与实时聊天同源） ---- */
    const negativeCount =
      history.filter((m) => m.role === 'user' && isNegativeSentiment(m.content)).length +
      (isNegativeSentiment(message) ? 1 : 0);
    const decision: HandoffDecision = evaluateHandoff({
      text: message,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      topFaqScore: topScore,
      missStreak: db.countRecentMisses(session.id, 3),
      userTurns: db.countUserMessages(session.id),
      negativeCount,
    });

    let reply = '';
    let handoff = false;
    let ticketId: string | undefined;
    let priority: db.TicketPriority | undefined;
    let queuePosition: number | undefined;
    let assignee: string | null | undefined;
    let agentSucceeded = false;
    let usedModel = '';

    const isBusinessIntent = BUSINESS_INTENTS.includes(intentResult.intent);
    const summary = truncate(message, 200);
    const ORDER_CTX_TIMEOUT_MS = 3000;

    /* ---- AI 化：调用 LLM Agent 生成回复（带领域工具：知识检索 / 订单 / 画像 / 建单）---- */
    // Hack2skill（方案 §4 契约1）：Gemini 引擎就绪时不受 tencent SDK 可用性约束
    const useSdk = geminiConfigured() || ((await probeSdk()) && !isSdkBroken());
    if (useSdk) {
      try {
        const knowledgeContext = buildRagContext(faqHits);
        const profile = db.getCustomerProfile(customerId);
        const customerProfileText = profile ? formatCustomerProfile(profile) : null;
        const orderCtx = intentResult.orderNo
          ? await withTimeout(resolveOrderContext(intentResult.orderNo), ORDER_CTX_TIMEOUT_MS, 'order-context').catch(() => null)
          : null;
        const orderContext = orderCtx?.context ?? null;
        const llmCfg = getResolvedConfig();
        // 多轮上下文：取既有历史（排除当前消息）拼到 prompt 前，使 email/im 异步渠道也具备跨轮记忆
        const historyText = buildHistoryText(
          history.slice(0, -1).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        );
        const systemPrompt = buildSystemPrompt(intentResult.intent, knowledgeContext, orderContext, customerProfileText, {
          external: true,
          basePrompt: llmCfg.basePrompt,
          maxReplyLength: llmCfg.maxReplyLength,
        });
        const agent = await callAgent({
          prompt: message,
          systemPrompt,
          model: llmCfg.model,
          session,
          timeoutMs: AGENT_FIRST_TOKEN_TIMEOUT,
          historyText: historyText ?? undefined,
          toolCtx: {
            channel: input.channel,
            sessionId: session.id,
            customerId,
            customerName,
            allowCreateTicket: !db.hasOpenTicket(session.id),
          },
        });
        usedModel = agent.usedModel;
        const capturedTickets = agent.captured?.tickets ?? [];
        const rawText = stripHandoffToken(agent.text);

        if (capturedTickets.length) {
          // Agent 经 create_ticket 工具建单（转人工）
          handoff = true;
          ticketId = capturedTickets[0].ticketId;
          priority = capturedTickets[0].priority as db.TicketPriority;
          assignee = capturedTickets[0].assignee;
          queuePosition = capturedTickets[0].queuePosition;
          reply = rawText.trim() ? rawText : '已为您安排人工专员跟进。';
          reply += `\n\n（工单号 ${ticketId.slice(0, 8).toUpperCase()}，优先级：${PRIORITY_LABEL[priority] || priority}）`;
        } else if (detectAgentSignal(agent.text)) {
          // Agent 以 HANDOFF_TOKEN 标记请求转人工（未调用工具）：按规则建单
          const tier = db.getCustomerProfile(customerId)?.tier || 'new';
          const pr = (intentResult.intent === 'complaint' ? 'high' : computePriority({
            intent: intentResult.intent,
            customerTier: tier,
            missStreak: db.countRecentMisses(session.id, 3),
            userTurns: db.countUserMessages(session.id),
            negativeCount,
          }).priority) as db.TicketPriority;
          const t = await openIngestTicket({
            session,
            intent: intentResult.intent,
            reason: 'Agent 判定超出自助处理范围',
            rule: 'AGENT_SIGNAL',
            priority: pr,
            now,
            summary,
            currentMessage: message,
            preferredAgentId: input.preferredAgentId,
          });
          handoff = true;
          ticketId = t.ticketId;
          assignee = t.assignee;
          queuePosition = t.queuePosition;
          priority = t.priority;
          reply = rawText + `\n\n（工单号 ${ticketId.slice(0, 8).toUpperCase()}，优先级：${PRIORITY_LABEL[t.priority] || t.priority}）`;
        } else {
          // 业务意图追踪网：仍保证异步渠道「有回执、有工单跟踪」
          if (isBusinessIntent && !db.hasOpenTicket(session.id) && !hitIds.length) {
            const tier = db.getCustomerProfile(customerId)?.tier || 'new';
            const pr = computePriority({
              intent: intentResult.intent,
              customerTier: tier,
              missStreak: db.countRecentMisses(session.id, 3),
              userTurns: db.countUserMessages(session.id),
              negativeCount,
            }).priority;
            const t = await openIngestTicket({
              session,
              intent: intentResult.intent,
              reason: `异步渠道业务意图（${intentResult.intent}）自动建单`,
              rule: null,
              priority: pr,
              now,
              summary,
              currentMessage: message,
              preferredAgentId: input.preferredAgentId,
            });
            ticketId = t.ticketId;
            assignee = t.assignee;
            queuePosition = t.queuePosition;
            priority = t.priority;
            reply = rawText.trim() ? rawText : composeExternalReply(intentResult.intent);
            reply += `\n\n（已为您生成工单 ${ticketId.slice(0, 8).toUpperCase()}，客服专员将据此跟进，优先级：${PRIORITY_LABEL[t.priority] || t.priority}）`;
          } else {
            reply = rawText.trim() ? rawText : (hitIds.length ? faqHits[0].answer : composeExternalReply(intentResult.intent));
          }
        }
        agentSucceeded = true;
      } catch (e) {
        logger.warn(`[channels] Agent 调用失败，降级知识库直答: ${(e as Error)?.message || e}`);
      }
    }

    /* ---- 兜底：SDK 不可用 / Agent 异常时，回退原有规则化路径（保证有回执、不丢消息） ---- */
    if (!agentSucceeded) {
      const fb = await buildExternalFallbackReply({
        session,
        intentResult,
        faqHits,
        hitIds,
        isBusinessIntent,
        decision,
        summary,
        now,
        negativeCount,
        customerId,
        currentMessage: message,
        preferredAgentId: input.preferredAgentId,
      });
      reply = fb.reply;
      handoff = fb.handoff;
      ticketId = fb.ticketId;
      priority = fb.priority;
      queuePosition = fb.queuePosition;
      assignee = fb.assignee;
    }

    /* ---- 持久化助手回复（入队） ---- */
    enqueue({
      type: 'persistMessage',
      payload: {
        id: uuidv4(),
        session_id: session.id,
        role: 'assistant',
        content: reply,
        // Agent 成功则由 LLM 驱动（记录实际模型）；否则走规则兜底（external / knowledge_base）
        model: agentSucceeded ? usedModel || 'agent' : 'external',
        created_at: new Date().toISOString(),
        intent: intentResult.intent,
        intent_confidence: intentResult.confidence,
        faq_ids: JSON.stringify(hitIds),
        source: handoff ? 'handoff' : (agentSucceeded ? 'agent' : 'knowledge_base'),
      },
    });

    /* ---- 画像增强（容错包裹，失败不影响投递；入队 write-behind） ---- */
    enqueue({ type: 'enrichProfile', payload: { customerId, intent: intentResult.intent, message, kbHit: hitIds.length > 0 } });
    enqueue({ type: 'touchCustomerSession', payload: { customerId, sessionId: session.id } });

    return {
      sessionId: session.id,
      customerId,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      faqHits: faqHits as FaqHit[],
      reply,
      handoff,
      ticketId,
      priority,
      queuePosition,
      assignee: assignee ?? null,
      sentimentDelta,
    };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logger.error(`[channels] ingest 失败 channel=${input.channel}: ${msg}`);
    return { error: msg };
  }
}

/**
 * 异步渠道规则化兜底回复（SDK 不可用 / Agent 异常时启用）。
 * 保留原行为：升级场景生成转人工话术 + 建单；业务意图默认建单跟踪；其余走知识库直答 / 引导。
 * 抽取为独立函数，使 AI 路径与降级路径职责清晰、互不耦合。
 */
async function buildExternalFallbackReply(args: {
  session: db.DbSession;
  intentResult: { intent: IntentId; confidence: number; matchedKeywords: string[] };
  faqHits: Array<{ id: string; question: string; answer: string; score: number }>;
  hitIds: string[];
  isBusinessIntent: boolean;
  decision: HandoffDecision;
  summary: string;
  now: string;
  negativeCount: number;
  customerId: string;
  currentMessage: string;
  preferredAgentId?: string | null;
}): Promise<{
  reply: string;
  handoff: boolean;
  ticketId?: string;
  priority?: db.TicketPriority;
  queuePosition?: number;
  assignee?: string | null;
}> {
  const { session, intentResult, faqHits, hitIds, isBusinessIntent, decision, summary, now, negativeCount, customerId, currentMessage, preferredAgentId } = args;
  let reply = '';
  let handoff = false;
  let ticketId: string | undefined;
  let priority: db.TicketPriority | undefined;
  let queuePosition: number | undefined;
  let assignee: string | null | undefined;

  /* 会话维度防重：已有未结工单则不再重复建单 */
  if (!db.hasOpenTicket(session.id)) {
    if (decision.shouldHandoff) {
      handoff = true;
      const tier = db.getCustomerProfile(customerId)?.tier || 'new';
      const pr = computePriority({
        intent: intentResult.intent,
        customerTier: tier,
        missStreak: db.countRecentMisses(session.id, 3),
        userTurns: db.countUserMessages(session.id),
        negativeCount,
      });
      priority = pr.priority;
      const t = await openIngestTicket({
        session,
        intent: intentResult.intent,
        reason: decision.reason,
        rule: decision.rule,
        priority: pr.priority,
        now,
        summary,
        currentMessage,
        preferredAgentId,
      });
      ticketId = t.ticketId;
      assignee = t.assignee;
      queuePosition = t.queuePosition;
      priority = t.priority;
      reply = buildHandoffMessage({ ...decision, priority: t.priority }, ticketId, queuePosition);
    } else if (isBusinessIntent) {
      const tier = db.getCustomerProfile(customerId)?.tier || 'new';
      const pr = computePriority({
        intent: intentResult.intent,
        customerTier: tier,
        missStreak: db.countRecentMisses(session.id, 3),
        userTurns: db.countUserMessages(session.id),
        negativeCount,
      });
      priority = pr.priority;
      const t = await openIngestTicket({
        session,
        intent: intentResult.intent,
        reason: `异步渠道业务意图（${intentResult.intent}）自动建单`,
        rule: null,
        priority: pr.priority,
        now,
        summary,
        currentMessage,
        preferredAgentId,
      });
      ticketId = t.ticketId;
      assignee = t.assignee;
      queuePosition = t.queuePosition;
      const base = hitIds.length ? faqHits[0].answer : composeExternalReply(intentResult.intent);
      reply = `${base}\n\n（已为您生成工单 ${ticketId.slice(0, 8).toUpperCase()}，客服专员将据此跟进，优先级：${PRIORITY_LABEL[t.priority]}）`;
    }
  }

  /* 未建单场景（闲聊 / 其它 / 会话已有未结工单）：走知识库直答或引导 */
  if (!ticketId) {
    if (hitIds.length) reply = faqHits[0].answer;
    else reply = composeExternalReply(intentResult.intent);
  }

  return { reply, handoff, ticketId, priority, queuePosition, assignee };
}
