/**
 * 设备健康度评分引擎（Device Health Scoring / 预测性维护）
 *
 * 承接端侧遥测（D）：把逐条异常上报聚合成「每台设备的健康分 + 趋势 + 维护建议」，
 * 让售后从「设备坏了再救火」变成「坏之前就介入」——这是 IoT/无人机反制场景
 * 最具说服力的商业价值点（降低宕机、减少返修、延长设备寿命）。
 *
 * 设计要点：
 *   - 纯确定性评分（不依赖 LLM），同样的遥测历史必然得到同样的健康分，可现场复现；
 *   - 越近的异常惩罚越重（指数衰减），符合工程直觉：上周高温比上月高温更危险；
 *   - 趋势判定用「近期窗口 vs 全周期」对比，能识别「正在恶化」的设备；
 *   - 建议动作按风险等级 + 异常类型（温度/电压/信号/离线）组合给出，直接可执行。
 */
import * as db from './db.js';

export type DeviceRiskLevel = 'healthy' | 'watch' | 'at_risk' | 'critical';
export type HealthTrend = 'improving' | 'stable' | 'declining';

export interface DeviceHealth {
  deviceId: string;
  product: string | null;
  model: string | null;
  /** 0-100，越高越健康 */
  health: number;
  riskLevel: DeviceRiskLevel;
  trend: HealthTrend;
  /** 最近一次健康分（仅用最近 3 条上报计算），用于趋势对比 */
  recentHealth: number;
  reportCount: number;
  anomalyCount: number;
  /** 最近一次异常原因（无异常为 null） */
  lastAnomalyReason: string | null;
  lastSeen: string | null;
  /** 是否已有未结工单在跟进 */
  hasOpenTicket: boolean;
  /** 可执行的维护建议 */
  recommendation: string;
  /** 建议紧急程度（用于看板排序/着色） */
  urgency: 'none' | 'low' | 'medium' | 'high';
}

export interface DeviceHealthData {
  source: 'db' | 'empty';
  summary: {
    totalDevices: number;
    healthy: number;
    watch: number;
    atRisk: number;
    critical: number;
    avgHealth: number;
    declining: number;
  };
  /** 按健康分升序（最需要关注的排最前） */
  devices: DeviceHealth[];
  generatedAt: string;
}

/** 风险等级阈值 */
const CRITICAL_BELOW = 40;
const AT_RISK_BELOW = 60;
const WATCH_BELOW = 80;

/** 单条异常上报的惩罚：越近越重（第 i 条异常，i 从 0 开始） */
function anomalyPenalty(indexFromNewest: number, reasonCount: number, offline: boolean): number {
  const base = Math.max(4, 14 - indexFromNewest * 2);
  const extraReasons = Math.max(0, reasonCount - 1) * 3;
  const offlinePenalty = offline ? 6 : 0;
  return base + extraReasons + offlinePenalty;
}

function toRiskLevel(health: number): DeviceRiskLevel {
  if (health < CRITICAL_BELOW) return 'critical';
  if (health < AT_RISK_BELOW) return 'at_risk';
  if (health < WATCH_BELOW) return 'watch';
  return 'healthy';
}

/** 按异常类型给出针对性维护建议（温度/电压/信号/离线 → 具体检修动作） */
function buildRecommendation(riskLevel: DeviceRiskLevel, reasons: string[]): { text: string; urgency: DeviceHealth['urgency'] } {
  const joined = reasons.join('；');
  const specifics: string[] = [];
  if (joined.includes('温度')) specifics.push('重点检查散热风扇与功放模块积尘');
  if (joined.includes('电压')) specifics.push('检测电池健康度/电源适配器输出');
  if (joined.includes('信号')) specifics.push('排查天线馈线与射频链路连接');
  if (joined.includes('离线')) specifics.push('确认现场供电与网络回传通道');

  const tail = specifics.length ? `；${specifics.join('；')}` : '';
  switch (riskLevel) {
    case 'critical':
      return { text: `立即停机检修，安排备件替换${tail}`, urgency: 'high' };
    case 'at_risk':
      return { text: `48 小时内安排现场巡检，准备备件${tail}`, urgency: 'medium' };
    case 'watch':
      return { text: `纳入观察名单，将遥测上报频率提高一倍${tail}`, urgency: 'low' };
    default:
      return { text: '按常规周期维护即可', urgency: 'none' };
  }
}

/** 由一段上报历史算健康分（recentOnly=true 时只用最近 3 条） */
function scoreReports(reports: Array<{ anomaly: number; anomaly_reason: string | null }>, recentOnly = false): { health: number; reasons: string[] } {
  const list = recentOnly ? reports.slice(0, 3) : reports;
  let score = 100;
  const reasons: string[] = [];
  let anomalyIdx = 0;
  for (const r of list) {
    if (r.anomaly !== 1) continue;
    const reasonList = (r.anomaly_reason || '').split('；').filter(Boolean);
    score -= anomalyPenalty(anomalyIdx, reasonList.length, reasonList.some((x) => x.includes('离线')));
    anomalyIdx += 1;
    if (anomalyIdx <= 2) reasons.push(...reasonList);
  }
  return { health: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * 聚合全部设备遥测 → 健康度看板数据。
 * 异常降级：DB 不可用或无量测数据时返回 source='empty' 的空结构（best-effort，不抛错）。
 */
export function getDeviceHealth(): DeviceHealthData {
  const generatedAt = new Date().toISOString();
  const empty: DeviceHealthData = {
    source: 'empty',
    summary: { totalDevices: 0, healthy: 0, watch: 0, atRisk: 0, critical: 0, avgHealth: 0, declining: 0 },
    devices: [],
    generatedAt,
  };
  try {
    const rows = db.listDeviceTelemetry(2000);
    if (!rows.length) return empty;

    // 按设备分组，组内按时间倒序（listDeviceTelemetry 已 DESC，这里保持）
    const byDevice = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byDevice.get(r.device_id) || [];
      arr.push(r);
      byDevice.set(r.device_id, arr);
    }

    // 已有未结工单的设备集合（避免对同一设备重复派单）
    const openTickets = new Set(
      db
        .getTickets('pending')
        .map((t) => t.customer_name || '')
        .filter((n) => n.startsWith('设备 '))
        .map((n) => n.replace(/^设备\s*/, '')),
    );

    const devices: DeviceHealth[] = [];
    for (const [deviceId, reports] of byDevice) {
      const { health, reasons } = scoreReports(reports);
      const { health: recentHealth } = scoreReports(reports, true);
      const riskLevel = toRiskLevel(health);
      let trend: HealthTrend = 'stable';
      if (recentHealth > health + 3) trend = 'improving';
      else if (recentHealth < health - 3) trend = 'declining';
      const anomalyReports = reports.filter((r) => r.anomaly === 1);
      const rec = buildRecommendation(riskLevel, anomalyReports.slice(0, 2).flatMap((r) => (r.anomaly_reason || '').split('；')).filter(Boolean));
      devices.push({
        deviceId,
        product: reports[0]?.product ?? null,
        model: reports[0]?.model ?? null,
        health,
        riskLevel,
        trend,
        recentHealth,
        reportCount: reports.length,
        anomalyCount: anomalyReports.length,
        lastAnomalyReason: anomalyReports[0]?.anomaly_reason ?? null,
        lastSeen: reports[0]?.created_at ?? null,
        hasOpenTicket: openTickets.has(deviceId),
        recommendation: rec.text,
        urgency: rec.urgency,
      });
    }

    // 最需要关注的排最前：健康分升序，同级按异常次数降序
    devices.sort((a, b) => a.health - b.health || b.anomalyCount - a.anomalyCount);
    const avg = Math.round(devices.reduce((s, d) => s + d.health, 0) / devices.length);
    return {
      source: 'db',
      summary: {
        totalDevices: devices.length,
        healthy: devices.filter((d) => d.riskLevel === 'healthy').length,
        watch: devices.filter((d) => d.riskLevel === 'watch').length,
        atRisk: devices.filter((d) => d.riskLevel === 'at_risk').length,
        critical: devices.filter((d) => d.riskLevel === 'critical').length,
        avgHealth: avg,
        declining: devices.filter((d) => d.trend === 'declining').length,
      },
      devices,
      generatedAt,
    };
  } catch (e) {
    // 看板类接口绝不因单点异常 500：降级为空结构，前端显示「暂无数据」
    return empty;
  }
}
