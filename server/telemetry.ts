/**
 * 端侧遥测异常自动建单（Edge Telemetry → Auto Ticket）
 *
 * 贴合「无人机反制 / IoT」主题：设备端（干扰枪、侦打一体机、基站等）周期上报遥测快照，
 * 服务端按产品阈值做异常检测，命中即自动建工单 + 智能升级 + 通知，实现「端云协同、主动运维」。
 *
 * 设计要点：
 *   - 纯确定性阈值检测（不依赖 LLM），沙箱/真实环境行为一致、可演示；
 *   - 复用既有建单单一入口 persistTicket + escalateFromContext（含工作流增强），与全渠道同源；
 *   - 遥测快照落 devices_telemetry 表（v16），并写入工单 device 字段（v12 端侧遥测预留），直达售后。
 */
import * as db from './db.js';
import { v4 as uuidv4 } from 'uuid';
import { escalateFromContext, higherPriority, notifyEscalation } from './escalation.js';
import { persistTicket } from './store.js';
import { computePriority, computeSlaDue, assignTicket } from './tickets.js';
import { classifyIntent } from './intent.js';
import { logger } from './logger.js';

export interface TelemetrySnapshot {
  temperature?: number;
  voltage?: number;
  signal?: number;
  online?: boolean;
  uptimeSec?: number;
  [k: string]: unknown;
}

export interface TelemetryIngestResult {
  id: string;
  deviceId: string;
  anomaly: boolean;
  reason: string | null;
  ticketId?: string;
  priority?: db.TicketPriority;
}

/** 产品类型 → 异常阈值（无人机反制设备典型工况示意） */
const PRODUCT_THRESHOLDS: Record<string, { temp: number; voltageMin: number; voltageMax: number; signalMin: number }> = {
  // 干扰枪 / 侦打一体机：功放温度高、锂电池供电
  default: { temp: 80, voltageMin: 9, voltageMax: 28, signalMin: -95 },
  DJ8341: { temp: 85, voltageMin: 11, voltageMax: 16.8, signalMin: -100 },
  SDJ800: { temp: 82, voltageMin: 11, voltageMax: 16.8, signalMin: -98 },
  DJ500: { temp: 75, voltageMin: 20, voltageMax: 28, signalMin: -92 },
};

function detectAnomaly(
  product: string | undefined,
  snap: TelemetrySnapshot,
): { anomaly: boolean; reasons: string[] } {
  const t = PRODUCT_THRESHOLDS[product || ''] || PRODUCT_THRESHOLDS.default;
  const reasons: string[] = [];
  if (snap.temperature != null && snap.temperature > t.temp) {
    reasons.push(`温度过高 ${snap.temperature}℃（阈值 ${t.temp}℃）`);
  }
  if (snap.voltage != null && (snap.voltage < t.voltageMin || snap.voltage > t.voltageMax)) {
    reasons.push(`电压越界 ${snap.voltage}V（正常 ${t.voltageMin}-${t.voltageMax}V）`);
  }
  if (snap.signal != null && snap.signal < t.signalMin) {
    reasons.push(`信号弱 ${snap.signal}dBm（阈值 ${t.signalMin}dBm）`);
  }
  if (snap.online === false) {
    reasons.push('设备离线');
  }
  return { anomaly: reasons.length > 0, reasons };
}

/**
 * 接收一次设备遥测上报：异常检测 → 落库 → 命中即自动建单/升级/通知。
 */
export function ingestTelemetry(input: {
  deviceId: string;
  product?: string;
  model?: string;
  snapshot: Record<string, unknown>;
}): TelemetryIngestResult {
  const snap = (input.snapshot || {}) as TelemetrySnapshot;
  const { anomaly, reasons } = detectAnomaly(input.product, snap);
  const id = uuidv4();
  let ticketId: string | undefined;
  let priority: db.TicketPriority | undefined;

  if (anomaly) {
    const reason = reasons.join('；');
    const message = `设备遥测异常（${input.product || '未知型号'} ${input.deviceId}）：${reason}`;
    const intentResult = classifyIntent(message);
    const tier = 'new';
    const prBase = computePriority({ intent: intentResult.intent, customerTier: tier }).priority;
    const esc = escalateFromContext({
      message,
      history: [],
      currentPriority: prBase,
      unresolved: true,
      channel: 'im',
      intent: intentResult.intent,
      customerTier: tier,
      hasOpenTicket: false,
    });
    priority = higherPriority(prBase, esc.decision.priority);
    const assign = assignTicket(intentResult.intent, {});
    ticketId = uuidv4();
    // P0 修复（verify_award 套件实跑抓到）：tickets.session_id 存在指向 sessions 的外键约束，
    // 而遥测建单用的是合成会话 id（`__telemetry__<deviceId>`），该行不存在时 db.createTicket 会
    // 同步抛 SQLITE_CONSTRAINT_FOREIGNKEY；异常穿透 async persistTicket 后被 `void` 调用点吞成
    // unhandled rejection，Node ≥15 默认行为直接杀掉整个服务进程——一台设备一次异常遥测即可打垮客服服务。
    // 修法：建单前幂等确保「设备会话」行存在（设备即会话，后台可顺藤摸瓜定位到设备时间线）。
    const telemetrySessionId = `__telemetry__${input.deviceId}`;
    try {
      if (!db.getSession(telemetrySessionId)) {
        db.createSession({
          id: telemetrySessionId,
          title: `设备 ${input.deviceId} 遥测会话`,
          model: 'telemetry',
          customer_name: `设备 ${input.deviceId}`,
          channel: 'im',
          status: 'active',
        });
      }
      // 留一条系统消息，坐席在会话详情里能看到这次异常上报的原文
      db.createMessage({
        id: uuidv4(),
        session_id: telemetrySessionId,
        role: 'system',
        content: `[端侧遥测] ${message}`,
      });
    } catch (e) {
      logger.warn(`[telemetry] 设备会话准备失败（仍尝试建单）: ${(e as Error)?.message || e}`);
    }
    void persistTicket({
      id: ticketId,
      session_id: telemetrySessionId,
      customer_name: `设备 ${input.deviceId}`,
      intent: intentResult.intent,
      reason: '端侧遥测异常自动建单',
      trigger_rule: 'TELEMETRY_ANOMALY',
      summary: message,
      sentiment: null,
      escalated: esc.decision.escalate ? 1 : 0,
      escalation_reason: esc.decision.reason,
      priority,
      status: 'pending',
      assignee: assign.assignee,
      sla_due_at: computeSlaDue(priority, new Date().toISOString()),
      channel: 'im',
      device_snapshot: JSON.stringify(input.snapshot),
    }).catch((e) => {
      // 兜底：建单失败绝不能演变为进程级 unhandled rejection（见上方 P0 注释）
      logger.error(`[telemetry] 自动建单失败（已降级，不影响服务进程）: ${(e as Error)?.message || e}`);
    });
    if (esc.decision.notify) {
      void notifyEscalation({ ticketId, priority, reason: message, channel: 'im', customer: input.deviceId })
        .catch((e) => logger.warn(`[escalation] 通知发送异常（已忽略）: ${(e as Error)?.message || e}`));
    }
    logger.info(`[telemetry] 设备 ${input.deviceId} 异常自动建单 ${ticketId.slice(0, 8)} priority=${priority}`);
  }

  db.insertDeviceTelemetry({
    id,
    device_id: input.deviceId,
    product: input.product ?? null,
    model: input.model ?? null,
    snapshot: JSON.stringify(input.snapshot),
    anomaly: anomaly ? 1 : 0,
    anomaly_reason: reasons.join('；') || null,
    ticket_id: ticketId ?? null,
    created_at: new Date().toISOString(),
  });

  return { id, deviceId: input.deviceId, anomaly, reason: reasons.join('；') || null, ticketId, priority };
}
