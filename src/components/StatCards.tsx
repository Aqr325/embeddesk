import { MessagesSquare, Users, Handshake, CheckCircle2, Star, Timer, Database, ThumbsUp } from 'lucide-react';
import type { DashboardStats } from '../types';

interface Props {
  stats: DashboardStats;
}

interface Card {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone: string;
}

export function StatCards({ stats }: Props) {
  const cards: Card[] = [
    {
      label: '总会话数',
      value: String(stats.totalSessions),
      sub: `进行中 ${stats.activeSessions}`,
      icon: <MessagesSquare size={18} />,
      tone: 'text-accent bg-accent-light',
    },
    {
      label: '转人工率',
      value: `${Math.round(stats.handoffRate * 100)}%`,
      sub: `${stats.handoffSessions} 次转接`,
      icon: <Handshake size={18} />,
      tone: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30',
    },
    {
      label: '一次解决率',
      value: `${Math.round(stats.resolutionRate * 100)}%`,
      sub: '无需转人工',
      icon: <CheckCircle2 size={18} />,
      tone: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30',
    },
    {
      label: '平均评分',
      value: stats.avgRating ? stats.avgRating.toFixed(2) : '—',
      sub: `${stats.ratingCount} 条评价`,
      icon: <Star size={18} />,
      tone: 'text-amber-500 bg-amber-100 dark:bg-amber-900/30',
    },
    {
      label: '平均首响',
      value: stats.avgLatencyMs ? `${(stats.avgLatencyMs / 1000).toFixed(1)}s` : '—',
      sub: '对话链路耗时',
      icon: <Timer size={18} />,
      tone: 'text-sky-600 bg-sky-100 dark:bg-sky-900/30',
    },
    {
      label: '知识库命中率',
      value: `${Math.round(stats.kbHitRate * 100)}%`,
      sub: '问答有 FAQ 支撑',
      icon: <Database size={18} />,
      tone: 'text-violet-600 bg-violet-100 dark:bg-violet-900/30',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-2xl border border-border bg-card p-4">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${c.tone}`}>
            {c.icon}
          </div>
          <div className="text-2xl font-semibold text-foreground leading-none">{c.value}</div>
          <div className="text-xs text-muted-foreground mt-1.5">{c.label}</div>
          {c.sub && <div className="text-[11px] text-muted-foreground/70 mt-0.5">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}
