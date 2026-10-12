import type { DashboardStats } from '../types';

/** 意图分布环形图 */
export function IntentDonut({ data }: { data: DashboardStats['intentDistribution'] }) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  const radius = 52;
  const cx = 70;
  const cy = 70;
  const circ = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" className="w-36 h-36 shrink-0">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--td-bg-color-component)" strokeWidth={16} />
        {data.map((d) => {
          const len = (d.count / total) * circ;
          const seg = (
            <circle
              key={d.intent}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={16}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              className="transition-all"
            />
          );
          offset += len;
          return seg;
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-foreground" fontSize="20" fontWeight="600">
          {total}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="fill-muted-foreground" fontSize="10">
          总意图数
        </text>
      </svg>
      <div className="space-y-1.5 min-w-0 flex-1">
        {data.map((d) => (
          <div key={d.intent} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="truncate flex-1">{d.label}</span>
            <span className="text-muted-foreground tabular-nums">{d.count}</span>
            <span className="text-muted-foreground/70 tabular-nums w-9 text-right">
              {Math.round((d.count / total) * 100)}%
            </span>
          </div>
        ))}
        {data.length === 0 && <div className="text-xs text-muted-foreground">暂无数据</div>}
      </div>
    </div>
  );
}

/** 评分分布柱状图 */
export function RatingBars({ data }: { data: DashboardStats['ratingDistribution'] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2">
      {[5, 4, 3, 2, 1].map((star) => {
        const item = data.find((d) => d.rating === star);
        const count = item?.count ?? 0;
        return (
          <div key={star} className="flex items-center gap-2 text-xs">
            <span className="w-3 text-muted-foreground">{star}★</span>
            <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-muted-foreground tabular-nums">{count}</span>
          </div>
        );
      })}
      {data.length === 0 && <div className="text-xs text-muted-foreground">暂无评价</div>}
    </div>
  );
}

/** 每日趋势面积图 */
export function TrendArea({ data }: { data: DashboardStats['dailyTrend'] }) {
  if (data.length === 0) return <div className="text-xs text-muted-foreground py-4">暂无趋势数据</div>;
  const w = 320;
  const h = 120;
  const pad = 8;
  const maxS = Math.max(1, ...data.map((d) => d.sessions));
  const stepX = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const pts = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (d.sessions / maxS) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32">
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--td-brand-color)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--td-brand-color)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#trendGrad)" />
        <path d={line} fill="none" stroke="var(--td-brand-color)" strokeWidth={2} />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill="var(--td-brand-color)" />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground px-1">
        <span>{data[0]?.date?.slice(5)}</span>
        <span>{data[data.length - 1]?.date?.slice(5)}</span>
      </div>
    </div>
  );
}

/** 通用环形图（适用于渠道、客户等级等任意 {label,count,color} 分布） */
export function DonutChart({ data }: { data: Array<{ label: string; count: number; color: string }> }) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  const radius = 52;
  const cx = 70;
  const cy = 70;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  if (data.length === 0) return <div className="text-xs text-muted-foreground py-4">暂无数据</div>;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" className="w-36 h-36 shrink-0">
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--td-bg-color-component)" strokeWidth={16} />
        {data.map((d) => {
          const len = (d.count / total) * circ;
          const seg = (
            <circle
              key={d.label}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={16}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              className="transition-all"
            />
          );
          offset += len;
          return seg;
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-foreground" fontSize="20" fontWeight="600">
          {total}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="fill-muted-foreground" fontSize="10">
          总计
        </text>
      </svg>
      <div className="space-y-1.5 min-w-0 flex-1">
        {data.map((d) => (
          <div key={d.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="truncate flex-1">{d.label}</span>
            <span className="text-muted-foreground tabular-nums">{d.count}</span>
            <span className="text-muted-foreground/70 tabular-nums w-9 text-right">
              {Math.round((d.count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const CHANNEL_META: Record<string, { label: string; color: string }> = {
  web: { label: '网页', color: '#0052d9' },
  embed: { label: '嵌入站点', color: '#8e56dd' },
  email: { label: '邮件', color: '#00a870' },
  im: { label: '即时通讯', color: '#e37318' },
};

const TIER_META: Record<string, { label: string; color: string }> = {
  vip: { label: 'VIP 客户', color: '#d54941' },
  regular: { label: '常客', color: '#0052d9' },
  new: { label: '新客', color: '#8b8b8b' },
};

/** 渠道分布环形图 */
export function ChannelDonut({ data }: { data: DashboardStats['channelDistribution'] }) {
  const mapped = data.map((d) => ({
    label: CHANNEL_META[d.channel]?.label ?? d.channel,
    count: d.count,
    color: CHANNEL_META[d.channel]?.color ?? '#888',
  }));
  return <DonutChart data={mapped} />;
}

/** 客户等级分布环形图 */
export function TierDonut({ data }: { data: DashboardStats['customerTierDistribution'] }) {
  const mapped = data.map((d) => ({
    label: TIER_META[d.tier]?.label ?? d.tier,
    count: d.count,
    color: TIER_META[d.tier]?.color ?? '#888',
  }));
  return <DonutChart data={mapped} />;
}

/** 工单 SLA 概览面板 */
export function SlaPanel({ sla }: { sla: DashboardStats['ticketSla'] }) {
  const breachedRate = sla.open ? Math.round((sla.breached / sla.open) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-2xl font-semibold text-foreground">{sla.open}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">未结工单</div>
        </div>
        <div>
          <div className="text-2xl font-semibold text-destructive">{sla.breached}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">已超时</div>
        </div>
        <div>
          <div className="text-2xl font-semibold text-emerald-600">{sla.withinSla}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">时限内</div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-destructive"
          style={{ width: `${breachedRate}%` }}
        />
      </div>
      <div className="text-[11px] text-muted-foreground text-center">
        SLA 超时率 {breachedRate}%
      </div>
    </div>
  );
}

/** 首次响应时延面板 */
export function ResponsePanel({ rt }: { rt: DashboardStats['responseTimes'] }) {
  if (!rt.sampleSize) return <div className="text-xs text-muted-foreground py-4">暂无响应数据</div>;
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-lg font-semibold text-foreground">{rt.avg}s</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">平均</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-foreground">{rt.median}s</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">中位数</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-foreground">{rt.p95}s</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">P95</div>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground text-center">
        样本量 {rt.sampleSize} 次会话
      </div>
    </div>
  );
}
