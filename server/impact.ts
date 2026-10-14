/**
 * AI 成效看板（Impact Dashboard）
 *
 * 把三大支柱（企业知识助手 / 工作流自动化 / AI 副驾驶）的「能力」转化为「可量化的商业价值」，
 * 直接回应评委最关心的问题：这套 AI 到底帮企业省了多少、提了多少效？
 *
 * 数据来源全部为既有确定性链路留痕（agent_runs / tickets / workflow_rules / knowledge_gaps /
 * device_telemetry），零新依赖、沙箱可演示。任意异常均降级为空结构（source='empty'）。
 */
import * as db from './db.js';
import { logger } from './logger.js';

export interface ImpactKpi {
  /** 自助解决率：编排以「知识库直答」闭环的会话占比 */
  selfServiceRate: number;
  /** 副驾驶采纳率：由 AI 副驾驶一键执行创建的工单占比 */
  copilotAdoptionRate: number;
  /** 工作流自动执行率：编排命中工作流规则的会话占比 */
  workflowAutoRate: number;
  /** 知识盲区收敛率：已补全/处理的盲区占历史盲区总量比例 */
  gapClosureRate: number;
  /** 平均编排时延（ms） */
  avgLatencyMs: number;
}

export interface ImpactData {
  source: 'db' | 'empty';
  windowDays: number;
  totals: {
    runs: number;
    tickets: number;
    copilotTickets: number;
    workflowHits: number;
    gaps: number;
    gapsResolved: number;
    anomalies: number;
  };
  kpis: ImpactKpi;
  /** 动作分布趋势（按天）：自助回复 vs 转人工 */
  actionTrend: Array<{ date: string; answer: number; handoff: number }>;
  /** 风险趋势（按天）：平均风险分 + 高风险会话数 */
  riskTrend: Array<{ date: string; avgRisk: number; high: number }>;
  /** 工作流规则命中 TOP */
  workflowTop: Array<{ name: string; hits: number }>;
  /** 本赛事数据为演示数据（方案 §7 统一口径），前端显式标注 */
  demo: boolean;
}

function dayKey(ts?: string): string {
  if (!ts) return 'unknown';
  return ts.slice(0, 10);
}

function safeParseArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function getImpact(): ImpactData {
  const empty: ImpactData = {
    source: 'empty',
    windowDays: 0,
    totals: { runs: 0, tickets: 0, copilotTickets: 0, workflowHits: 0, gaps: 0, gapsResolved: 0, anomalies: 0 },
    kpis: { selfServiceRate: 0, copilotAdoptionRate: 0, workflowAutoRate: 0, gapClosureRate: 0, avgLatencyMs: 0 },
    actionTrend: [],
    riskTrend: [],
    workflowTop: [],
    demo: true,
  };

  try {
    const runs = db.listAgentRuns(5000);
    if (!runs.length) return empty;

    const answers = runs.filter((r) => r.final_action === 'answer').length;
    const handoffs = runs.filter((r) => r.final_action === 'handoff').length;
    const workflowRuns = runs.filter((r) => safeParseArray(r.workflow_matched).length > 0).length;

    const tickets = db.getTickets();
    const copilotTickets = tickets.filter((t) => t.trigger_rule === 'COPILOT_EXECUTE').length;
    const totalTickets = tickets.length;

    const rules = db.listWorkflowRules(false);
    const workflowHits = rules.reduce((s, r) => s + (r.hit_count || 0), 0);
    const workflowTop = rules
      .filter((r) => (r.hit_count || 0) > 0)
      .map((r) => ({ name: r.name, hits: r.hit_count || 0 }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 6);

    const gapTotal =
      db.countKnowledgeGaps('pending') + db.countKnowledgeGaps('resolved') + db.countKnowledgeGaps('dismissed');
    const gapResolved = db.countKnowledgeGaps('resolved');

    const latencies = runs.map((r) => r.latency_ms).filter((l): l is number => typeof l === 'number');
    const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

    const anomalies = db.countDeviceTelemetry(true);

    // 趋势
    const actionMap = new Map<string, { answer: number; handoff: number }>();
    const riskMap = new Map<string, { sum: number; n: number; high: number }>();
    for (const r of runs) {
      const d = dayKey(r.created_at);
      if (!actionMap.has(d)) actionMap.set(d, { answer: 0, handoff: 0 });
      const a = actionMap.get(d)!;
      if (r.final_action === 'answer') a.answer++;
      else if (r.final_action === 'handoff') a.handoff++;
      const risk = r.risk_score ?? 0;
      if (!riskMap.has(d)) riskMap.set(d, { sum: 0, n: 0, high: 0 });
      const rm = riskMap.get(d)!;
      rm.sum += risk;
      rm.n++;
      if (r.risk_level === 'high') rm.high++;
    }
    const actionTrend = [...actionMap.entries()]
      .map(([date, v]) => ({ date, answer: v.answer, handoff: v.handoff }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);
    const riskTrend = [...riskMap.entries()]
      .map(([date, v]) => ({ date, avgRisk: v.n ? Math.round(v.sum / v.n) : 0, high: v.high }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);

    return {
      source: 'db',
      windowDays: actionTrend.length || riskTrend.length || 1,
      totals: {
        runs: runs.length,
        tickets: totalTickets,
        copilotTickets,
        workflowHits,
        gaps: gapTotal,
        gapsResolved: gapResolved,
        anomalies,
      },
      kpis: {
        selfServiceRate: Math.round((answers / runs.length) * 100),
        copilotAdoptionRate: totalTickets ? Math.round((copilotTickets / totalTickets) * 100) : 0,
        workflowAutoRate: Math.round((workflowRuns / runs.length) * 100),
        gapClosureRate: gapTotal ? Math.round((gapResolved / gapTotal) * 100) : 0,
        avgLatencyMs,
      },
      actionTrend,
      riskTrend,
      workflowTop,
      demo: true,
    };
  } catch (e) {
    logger.warn(`[impact] 聚合异常，降级空数据: ${(e as Error).message}`);
    return empty;
  }
}
