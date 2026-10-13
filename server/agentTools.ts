/**
 * 客服 Agent 领域工具层（in-process MCP server）
 *
 * 通过 @tencent-ai/agent-sdk 的 createSdkMcpServer + tool() 注册「受约束的客服工具」，
 * 注入到大模型 Agent 中，使 Agent 能够：
 *   - search_knowledge：检索标准 FAQ 知识库（语义/混合打分）；
 *   - query_order：实时查询订单物流 / 售后；
 *   - get_customer：读取客户长期画像，做个性化服务；
 *   - create_ticket：当判断需转人工 / 升级时，自动建单（含优先级 / SLA / 坐席分配）。
 *
 * 设计约束：
 *   - 仅暴露上述业务工具，绝不包含 Bash / 文件 / 网络等内置高危能力（由调用方以 tools:[] 禁用）；
 *   - create_ticket 内置「会话维度防重」：已有未结工单时直接返回，避免 Agent 重复建单；
 *   - 工具副作用（建单 / 改会话状态）均为同步落库，与主链路同库，保证一致性；
 *   - allowCreateTicket=false 时（web / embed 走 HANDOFF_TOKEN 机制）不注册建单工具。
 */
import { createSdkMcpServer, tool, type SdkMcpServerResult, type SdkMcpToolDefinition } from '@tencent-ai/agent-sdk';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { persistTicket } from './store.js';
import { retrieveRag, buildRagContext } from './rag.js';
import { resolveOrderContext } from './orders.js';
import { computePriority, computeSlaDue, assignTicket } from './tickets.js';
import type { IntentId } from './intent.js';
import { logger } from './logger.js';
import { escalateFromContext, higherPriority, notifyEscalation } from './escalation.js';

/** 工具调用上下文：由调用方（web / 外部渠道）传入，决定工具可访问的会话与客户维度 */
export interface CsaToolContext {
  channel: string;
  sessionId: string;
  customerId?: string | null;
  customerName: string;
  /** 可选：会话历史（role/content），供 create_ticket 时做情绪/升级判定；缺省为空 */
  history?: Array<{ role: string; content: string }>;
  /** 是否允许 Agent 调用 create_ticket 建单（外部异步渠道允许；web / embed 走 HANDOFF_TOKEN 机制故默认关闭） */
  allowCreateTicket: boolean;
}

/** create_ticket 工具成功建单 / 命中发现已有工单时回传的结构 */
export interface CsaCreatedTicket {
  ticketId: string;
  priority: string;
  assignee: string | null;
  queuePosition: number;
  reason: string;
}

/** Agent 调用工具期间捕获的副作用，供调用方在文本之外做决策（如是否已建单） */
export interface CsaToolCaptured {
  toolCalls: string[];
  tickets: CsaCreatedTicket[];
}

export const CSA_TOOL_NAMES = ['search_knowledge', 'query_order', 'get_customer', 'create_ticket'] as const;

const PRIORITY_LABEL: Record<string, string> = { low: '低', medium: '普通', high: '高', urgent: '紧急' };

function formatProfile(profile: db.DbCustomerProfile | undefined): string | null {
  if (!profile) return null;
  const lines: string[] = [];
  if (profile.name) lines.push(`- 称呼/联系人：${profile.name}`);
  if (profile.company) lines.push(`- 所属企业：${profile.company}`);
  if (profile.industry) lines.push(`- 行业：${profile.industry}`);
  if (profile.contact) lines.push(`- 联系方式：${profile.contact}`);
  if (profile.tags) lines.push(`- 标签：${profile.tags}`);
  if (profile.preferences) lines.push(`- 偏好/诉求：${profile.preferences}`);
  if (profile.notes) lines.push(`- 备注：${profile.notes}`);
  if (profile.history_summary) lines.push(`- 历史概要：${profile.history_summary}`);
  if (profile.session_count > 0) lines.push(`- 历史接触次数：${profile.session_count}`);
  if (profile.tier && profile.tier !== 'new') lines.push(`- 客户等级：${profile.tier}`);
  return lines.length ? lines.join('\n') : null;
}

export interface CsaToolBundle {
  server: SdkMcpServerResult;
  captured: CsaToolCaptured;
  /** 仅用于单元测试 / 直接调用，生产路径经 SDK 调度 */
  tools: Array<{ name: string; handler: (args: any, extra?: any) => any }>;
}

/**
 * 创建客服 Agent 工具集（in-process MCP server）。
 * 返回 server（注入 query 的 mcpServers）、captured（副作用捕获）、tools（便于直接调用验证）。
 */
export function createCsaAgentTools(ctx: CsaToolContext): CsaToolBundle {
  const captured: CsaToolCaptured = { toolCalls: [], tickets: [] };

  const searchKnowledge = tool(
    'search_knowledge',
    '检索客服知识库（FAQ 标准答案）。当用户问题需要依据政策条款、退换货/物流/技术处理流程等标准答案时调用。返回匹配问题与标准答案文本。',
    {
      query: z.string().describe('用户的检索问句'),
      intent: z
        .string()
        .optional()
        .describe('可选：已识别的业务意图（refund/order_query/tech_support/complaint 等），用于提升检索精度'),
    },
    async ({ query, intent }) => {
      captured.toolCalls.push('search_knowledge');
      const hits = await retrieveRag(query, (intent as IntentId) || null, 3);
      if (!hits.length) return { content: [{ type: 'text', text: '知识库未检索到相关标准答案。' }] };
      return { content: [{ type: 'text', text: buildRagContext(hits) }] };
    },
  );

  const queryOrder = tool(
    'query_order',
    '实时查询订单状态、物流与售后信息。当用户提供订单号并询问物流、发货、退换货进度时调用。返回订单上下文文本。',
    { orderNo: z.string().describe('订单号，如 SO2026...') },
    async ({ orderNo }) => {
      captured.toolCalls.push('query_order');
      const r = await resolveOrderContext(String(orderNo));
      return { content: [{ type: 'text', text: r.context }] };
    },
  );

  const getCustomer = tool(
    'get_customer',
    '查询客户长期画像（企业、行业、等级、历史接触、偏好）。用于个性化服务。仅当已知 customerId 且对服务有必要时调用。',
    { customerId: z.string().describe('客户标识（customer_id）') },
    async ({ customerId }) => {
      captured.toolCalls.push('get_customer');
      const text = formatProfile(db.getCustomerProfile(String(customerId)));
      return { content: [{ type: 'text', text: text || '未找到该客户的画像信息。' }] };
    },
  );

  const createTicket = tool(
    'create_ticket',
    '创建工单并转人工。当判断问题超出自助处理范围、客户要求投诉/索赔/升级、或需要人工跟进时调用。自动计算优先级、SLA 与坐席分配。',
    {
      intent: z.string().describe('业务意图（refund/order_query/tech_support/complaint/human_service 等）'),
      summary: z.string().describe('工单摘要（用户诉求的简要描述）'),
      reason: z.string().describe('建单原因 / 触发规则'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('可选：显式优先级；缺省由系统综合客户等级 / 意图 / 情绪计算'),
    },
    async ({ intent, summary, reason, priority }) => {
      captured.toolCalls.push('create_ticket');
      // 会话维度防重：已有未结工单则直接返回，避免 Agent 重复建单
      const open = db
        .getTicketsBySession(ctx.sessionId)
        .filter((t) => t.status === 'pending' || t.status === 'processing');
      if (open.length) {
        const t = open[0];
        return {
          content: [
            {
              type: 'text',
              text: `该会话已有未结工单 ${t.id.slice(0, 8).toUpperCase()}，无需重复建单。优先级：${PRIORITY_LABEL[t.priority] || t.priority}。`,
            },
          ],
        };
      }
      const intentId = (intent as IntentId) ?? 'other';
      const tier = ctx.customerId ? db.getCustomerProfile(ctx.customerId)?.tier || 'new' : 'new';
      const prBase: db.TicketPriority =
        (priority as db.TicketPriority) || computePriority({ intent: intentId, customerTier: tier }).priority;
      // 情感识别 + 智能升级：基于工单摘要 + 会话历史产出情绪与升级决策，叠加优先级
      const esc = escalateFromContext({
        message: String(summary),
        history: ctx.history?.map((m) => ({ role: m.role, content: m.content })) || [],
        currentPriority: prBase,
        unresolved: true,
      });
      const pr: db.TicketPriority = higherPriority(prBase, esc.decision.priority);
      const assign = assignTicket(intentId, {});
      const ticketId = uuidv4();
      const slaDue = computeSlaDue(pr, new Date().toISOString());
      const queuePosition = db.countTicketsByStatus('pending') + 1;
      await persistTicket({
        id: ticketId,
        session_id: ctx.sessionId,
        customer_name: ctx.customerName,
        intent: intentId,
        reason: String(reason),
        trigger_rule: 'AGENT_TOOL',
        summary: String(summary).slice(0, 200),
        sentiment: esc.sentiment,
        escalated: esc.decision.escalate ? 1 : 0,
        escalation_reason: esc.decision.reason,
        priority: pr,
        status: 'pending',
        assignee: assign.assignee,
        sla_due_at: slaDue,
        channel: ctx.channel,
      });
      if (esc.decision.notify) {
        void notifyEscalation({
          ticketId,
          priority: pr,
          reason: esc.decision.reason || '智能升级',
          channel: ctx.channel,
          customer: ctx.customerName,
        });
      }
      db.updateSession(ctx.sessionId, { status: 'waiting_human', handoff: 1, handoff_reason: String(reason) });
      captured.tickets.push({ ticketId, priority: pr, assignee: assign.assignee, queuePosition, reason: String(reason) });
      logger.info(`[agentTools] Agent 经工具建单 ${ticketId.slice(0, 8)} intent=${intentId} priority=${pr} assignee=${assign.assignee}`);
      return {
        content: [
          {
            type: 'text',
            text: `已为您创建工单 ${ticketId.slice(0, 8).toUpperCase()}（优先级：${PRIORITY_LABEL[pr] || pr}，受理坐席：${assign.assignee || '公共队列'}）。人工专员将据此跟进。`,
          },
        ],
      };
    },
  );

  const toolList: SdkMcpToolDefinition<any>[] = [searchKnowledge, queryOrder, getCustomer];
  if (ctx.allowCreateTicket) toolList.push(createTicket);

  const server = createSdkMcpServer({ name: 'csa-tools', version: '1.0.0', tools: toolList });
  return { server, captured, tools: toolList.map((t) => ({ name: t.name, handler: t.handler })) };
}
