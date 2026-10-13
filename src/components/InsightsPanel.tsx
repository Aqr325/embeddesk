import type { InsightsData } from '../types';
import { ChannelDonut, TrendArea } from './IntentChart';
import { Database, BarChart3, TrendingUp } from 'lucide-react';

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border ${tone}`}>{children}</span>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground/70">{sub}</div>}
    </div>
  );
}

function RankList({ title, items, render }: { title: string; items: Array<{ count: number }>; render: (it: any, i: number) => React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium mb-3">{title}</h3>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4">暂无数据</div>
      ) : (
        <ol className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <span className="w-5 h-5 shrink-0 rounded-full bg-muted text-muted-foreground text-[11px] flex items-center justify-center tabular-nums">
                {i + 1}
              </span>
              <span className="flex-1 min-w-0 truncate">{render(it, i)}</span>
              <span className="text-muted-foreground tabular-nums text-xs">{it.count}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function InsightsPanel({ data }: { data: InsightsData | null }) {
  if (!data) return <div className="text-sm text-muted-foreground">洞察数据加载中…</div>;

  const sourceLabel =
    data.source === 'bigquery' ? 'BigQuery 事件流' : data.source === 'local' ? '本地 JSONL 兜底' : '无事件数据';
  const sourceTone =
    data.source === 'bigquery'
      ? 'border-sky-500/40 text-sky-600 bg-sky-100/40 dark:bg-sky-900/30'
      : data.source === 'local'
        ? 'border-amber-500/40 text-amber-600 bg-amber-100/40 dark:bg-amber-900/30'
        : 'border-muted text-muted-foreground';

  // ChannelDonut / TrendArea 复用现有类型（结构兼容）
  const channelDist = data.channelDistribution.map((c) => ({ channel: c.channel, count: c.count }));
  const ticketTrend = data.ticketTrend.map((t) => ({ date: t.date, sessions: t.tickets, messages: 0, avgRating: null }));
  const questionTrend = data.questionTrend.map((t) => ({ date: t.date, sessions: t.questions, messages: 0, avgRating: null }));

  return (
    <div className="space-y-4 animate-fade-in">
      {/* 来源 + 演示数据 徽章 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={sourceTone}>
          <span className="inline-flex items-center gap-1">
            <Database size={11} /> {sourceLabel}
          </span>
        </Badge>
        <Badge tone="border-violet-500/40 text-violet-600 bg-violet-100/40 dark:bg-violet-900/30">
          <span className="inline-flex items-center gap-1">
            <BarChart3 size={11} /> 演示数据
          </span>
        </Badge>
        {data.windowDays > 0 && <span className="text-xs text-muted-foreground">统计窗口约 {data.windowDays} 天</span>}
      </div>

      {/* 概览瓦片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="提问总数" value={String(data.totals.questions)} sub={`渠道 ${data.channelDistribution.length} 类`} />
        <Tile label="检索命中率" value={`${data.searchHitRate}%`} sub={`${data.totals.searchHits} 次检索`} />
        <Tile label="自动建单" value={String(data.totals.tickets)} sub="意向识别→工单" />
        <Tile label="时延样本" value={String(data.totals.latencySamples)} sub="关键路径耗时" />
      </div>

      {/* 图表区：渠道分布 + 工单趋势 + 提问趋势 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-3">渠道分布</h3>
          {channelDist.length ? <ChannelDonut data={channelDist} /> : <div className="text-xs text-muted-foreground py-4">暂无数据</div>}
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-accent" /> 工单趋势
          </h3>
          {ticketTrend.length ? <TrendArea data={ticketTrend} /> : <div className="text-xs text-muted-foreground py-4">暂无建单事件</div>}
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-accent" /> 提问趋势
          </h3>
          {questionTrend.length ? <TrendArea data={questionTrend} /> : <div className="text-xs text-muted-foreground py-4">暂无提问事件</div>}
        </div>
      </div>

      {/* 排行：TOP 知识点 + 热门查询 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RankList title="TOP 知识点（检索命中）" items={data.topDocs} render={(it: any) => <span className="truncate">{it.label}</span>} />
        <RankList title="热门查询" items={data.topQueries} render={(it: any) => <span className="truncate">{it.query}</span>} />
      </div>
    </div>
  );
}
