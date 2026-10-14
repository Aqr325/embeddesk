/**
 * AgentTraceView —— 智能体编排中枢「AI 思考过程」可视化组件
 *
 * 把后端 runOrchestration 产出的 OrchestratorTrace 渲染为一条可见的推理链路：
 *   意图识别 → 知识检索 → 情感/风险分析 → 工作流匹配 → 主动关怀评分 → 合成决策
 * 在客服对话页（实时 SSE）与管理后台（会话留痕）两处复用。
 */
import { useState } from 'react';
import {
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Circle,
  Cpu,
  ShieldAlert,
  Sparkles,
  GitBranch,
} from 'lucide-react';
import type { AgentTrace, AgentRunRow, OrchestratorStep, FinalAction, OrchestratorStepStatus } from '../types';

const FINAL_ACTION_LABELS: Record<string, string> = {
  answer: '知识库直答',
  handoff: '转人工（建单）',
  ticket: '自动建单',
  proactive_alert: '主动关怀预警',
};

function statusMeta(status: OrchestratorStepStatus) {
  if (status === 'warn') return { icon: <AlertTriangle size={14} className="text-amber-500" />, cls: 'text-amber-600 dark:text-amber-400' };
  if (status === 'skip') return { icon: <Circle size={14} className="text-muted-foreground/40" />, cls: 'text-muted-foreground' };
  return { icon: <CheckCircle2 size={14} className="text-emerald-500" />, cls: 'text-emerald-600 dark:text-emerald-400' };
}

function riskTone(level: string): string {
  if (level === 'high') return 'bg-destructive/10 text-destructive';
  if (level === 'medium') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return 'bg-muted text-muted-foreground';
}

function sentimentTone(s: string | null): string {
  if (s === 'angry') return 'bg-destructive/10 text-destructive';
  if (s === 'negative') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  if (s === 'positive') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  return 'bg-muted text-muted-foreground';
}

/** 把 agent_runs 表行转换为前端可直接渲染的 AgentTrace（解析 steps / workflow_matched JSON） */
export function rowToTrace(row: AgentRunRow): AgentTrace {
  let steps: OrchestratorStep[] = [];
  try {
    steps = row.steps ? (JSON.parse(row.steps) as OrchestratorStep[]) : [];
  } catch {
    steps = [];
  }
  let workflowMatched: string[] = [];
  try {
    workflowMatched = row.workflow_matched ? (JSON.parse(row.workflow_matched) as string[]) : [];
  } catch {
    workflowMatched = [];
  }
  return {
    runId: row.id,
    sessionId: row.session_id,
    channel: row.channel,
    startedAt: 0,
    finishedAt: 0,
    steps,
    intent: row.intent,
    intentLabel: row.intent ?? '未知',
    knowledgeHit: row.knowledge_hit === 1,
    topScore: row.top_score,
    sentiment: row.sentiment,
    sentimentScore: row.sentiment_score ?? 0,
    riskScore: row.risk_score ?? 0,
    riskLevel: row.risk_level ?? 'low',
    workflowMatched,
    finalAction: (row.final_action as FinalAction) ?? 'answer',
    model: row.model,
    source: row.source,
    proactiveAction: null,
  };
}

export function AgentTraceView({ trace, defaultOpen = false }: { trace: AgentTrace; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const latency = trace.finishedAt && trace.startedAt ? trace.finishedAt - trace.startedAt : null;

  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      {/* 摘要头：点击展开/收起完整推理链路 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-base"
      >
        <ChevronRight size={15} className={`text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <Cpu size={14} className="text-accent" />
        <span className="text-xs font-medium">智能体推理链路</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">{trace.intentLabel}</span>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${riskTone(trace.riskLevel)}`}>
          风险 {trace.riskLevel} · {trace.riskScore}
        </span>
        {trace.sentiment && (
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${sentimentTone(trace.sentiment)}`}>{trace.sentiment}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {FINAL_ACTION_LABELS[trace.finalAction] ?? trace.finalAction}
          {latency != null && ` · ${latency}ms`}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 animate-fade-in">
          {trace.steps.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无分步详情</p>
          ) : (
            <ol className="relative ml-1.5 border-l border-border space-y-2.5 pl-4">
              {trace.steps.map((s, i) => {
                const meta = statusMeta(s.status);
                return (
                  <li key={s.id + i} className="relative">
                    <span className={`absolute -left-[22px] top-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-background`}>
                      {meta.icon}
                    </span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-foreground">{s.label}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">{s.latencyMs}ms</span>
                    </div>
                    <p className={`text-[11px] leading-relaxed ${meta.cls}`}>{s.detail}</p>
                  </li>
                );
              })}
            </ol>
          )}

          {/* 决策要素汇总 */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border">
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              <Sparkles size={11} /> 知识命中 {trace.knowledgeHit ? `是（${Math.round(trace.topScore * 100)}%）` : '否'}
            </span>
            {trace.workflowMatched.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
                <GitBranch size={11} /> 工作流 {trace.workflowMatched.join('、')}
              </span>
            )}
            {trace.proactiveAction && (
              <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive">
                <ShieldAlert size={11} /> {trace.proactiveAction}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
