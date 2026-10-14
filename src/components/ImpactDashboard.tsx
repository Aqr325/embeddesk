/**
 * ImpactDashboard —— AI 成效看板
 *
 * 把三大支柱（企业知识助手 / 工作流自动化 / AI 副驾驶）的「能力」转化为「可量化的商业价值」：
 * 自助解决率 / 副驾驶采纳率 / 工作流自动执行率 / 知识盲区收敛率 / 平均编排时延，
 * 配合动作分布与风险趋势，直接回应评委最关心的问题：这套 AI 到底创造了多少价值。
 */
import { TrendingUp, Bot, Workflow, Lightbulb, Timer, Activity } from 'lucide-react';
import type { ImpactData } from '../types';

function KpiCard({
  icon,
  label,
  value,
  suffix,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  suffix?: string;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone}`}>
        {value}
        {suffix && <span className="text-sm font-normal text-muted-foreground ml-0.5">{suffix}</span>}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

export function ImpactDashboard({ data }: { data: ImpactData }) {
  const { kpis, totals, actionTrend, riskTrend, workflowTop, demo } = data;
  const maxAction = Math.max(1, ...actionTrend.map((d) => d.answer + d.handoff));
  const maxRisk = 100;
  const maxWf = Math.max(1, ...workflowTop.map((w) => w.hits));

  if (data.source === 'empty' || totals.runs === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        暂无编排留痕数据。在客服对话中发起咨询后，这里将聚合「自助解决率 / 副驾驶采纳率 / 工作流自动执行率 / 知识盲区收敛率」等成效指标。
        {demo && <div className="mt-2 text-[11px] text-muted-foreground/70">（演示数据，仅用于评审展示）</div>}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {demo && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1.5 inline-block">
          演示数据 · 用于评审展示
        </div>
      )}

      {/* KPI 卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          icon={<Bot size={13} />}
          label="自助解决率"
          value={kpis.selfServiceRate}
          suffix="%"
          tone="text-emerald-600 dark:text-emerald-400"
          hint="知识库直答闭环占比"
        />
        <KpiCard
          icon={<Bot size={13} />}
          label="副驾驶采纳率"
          value={kpis.copilotAdoptionRate}
          suffix="%"
          tone="text-accent"
          hint={`副驾驶建单 ${totals.copilotTickets}/${totals.tickets}`}
        />
        <KpiCard
          icon={<Workflow size={13} />}
          label="工作流自动执行率"
          value={kpis.workflowAutoRate}
          suffix="%"
          tone="text-violet-600 dark:text-violet-400"
          hint={`规则累计命中 ${totals.workflowHits}`}
        />
        <KpiCard
          icon={<Lightbulb size={13} />}
          label="知识盲区收敛率"
          value={kpis.gapClosureRate}
          suffix="%"
          tone="text-amber-600 dark:text-amber-400"
          hint={`已处理 ${totals.gapsResolved}/${totals.gaps}`}
        />
        <KpiCard
          icon={<Timer size={13} />}
          label="平均编排时延"
          value={kpis.avgLatencyMs}
          suffix="ms"
          tone="text-foreground"
          hint="六步推理链路总耗时"
        />
      </div>

      {/* 总量概览 */}
      <div className="flex flex-wrap gap-2">
        <span className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">编排留痕 {totals.runs}</span>
        <span className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">工单 {totals.tickets}</span>
        <span className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">遥测异常 {totals.anomalies}</span>
      </div>

      {/* 趋势图 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 动作分布趋势 */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-1 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-accent" /> 动作分布趋势
          </h3>
          <p className="text-[11px] text-muted-foreground mb-3">自助回复 vs 转人工（按天）</p>
          {actionTrend.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无趋势数据</p>
          ) : (
            <div className="flex items-end gap-1.5 h-36 overflow-x-auto pb-1">
              {actionTrend.map((d) => (
                <div key={d.date} className="flex-1 min-w-[18px] flex flex-col items-center justify-end h-full gap-0.5">
                  <div className="w-full flex flex-col justify-end gap-0.5" style={{ height: `${(d.answer + d.handoff) / maxAction * 100}%` }}>
                    <div
                      className="w-full rounded-t bg-amber-400/80"
                      style={{ height: `${d.handoff / (d.answer + d.handoff || 1) * 100}%` }}
                      title={`转人工 ${d.handoff}`}
                    />
                    <div
                      className="w-full rounded-t bg-accent"
                      style={{ height: `${d.answer / (d.answer + d.handoff || 1) * 100}%` }}
                      title={`自助回复 ${d.answer}`}
                    />
                  </div>
                  <span className="text-[9px] text-muted-foreground tabular-nums">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-accent" />自助回复</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-400/80" />转人工</span>
          </div>
        </div>

        {/* 风险趋势 */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-1 flex items-center gap-1.5">
            <Activity size={15} className="text-accent" /> 风险趋势
          </h3>
          <p className="text-[11px] text-muted-foreground mb-3">平均风险分（0-100）与高风险会话数（按天）</p>
          {riskTrend.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无趋势数据</p>
          ) : (
            <div className="flex items-end gap-1.5 h-36 overflow-x-auto pb-1">
              {riskTrend.map((d) => {
                const lvl = d.avgRisk >= 70 ? 'bg-destructive' : d.avgRisk >= 40 ? 'bg-amber-400/80' : 'bg-emerald-500/70';
                return (
                  <div key={d.date} className="flex-1 min-w-[18px] flex flex-col items-center justify-end h-full gap-0.5">
                    <div className="w-full flex flex-col items-center justify-end" style={{ height: `${(d.avgRisk / maxRisk) * 100}%` }}>
                      <div className={`w-full rounded-t ${lvl}`} style={{ height: '100%' }} title={`平均风险 ${d.avgRisk} · 高风险 ${d.high}`} />
                    </div>
                    <span className="text-[9px] text-muted-foreground tabular-nums">{d.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/70" />低风险</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-400/80" />中风险</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-destructive" />高风险</span>
          </div>
        </div>
      </div>

      {/* 工作流规则命中 TOP */}
      {workflowTop.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <Workflow size={15} className="text-accent" /> 工作流规则命中 TOP
          </h3>
          <div className="space-y-2">
            {workflowTop.map((w) => (
              <div key={w.name} className="flex items-center gap-3">
                <span className="text-xs text-foreground/90 w-40 truncate">{w.name}</span>
                <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-violet-500/80" style={{ width: `${(w.hits / maxWf) * 100}%` }} />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">{w.hits}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
