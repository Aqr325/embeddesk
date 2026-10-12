import { useState, Fragment } from 'react';
import { ChevronRight, MessageCircle, Ticket as TicketIcon, Star, Search, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import type { ConversationRow } from '../types';
import { STATUS_LABELS } from '../types';
import { IntentBadge } from '../components/IntentBadge';
import { CopilotPanel } from './CopilotPanel';
import { api } from '../hooks/useApi';
import type { AdminFilters, Pagination } from '../hooks/useAdmin';

interface Props {
  conversations: ConversationRow[];
  filters: AdminFilters;
  onFilter: (next: AdminFilters) => void;
  pagination: Pagination;
  onPageChange: (page: number) => void;
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

/** 来源列文案：区分 本站网页 / 嵌入站点 / 邮件 / 即时通讯 四类渠道 */
function channelLabel(c: ConversationRow): { text: string; tone: 'web' | 'embed' | 'email' | 'im' } {
  if (c.channel === 'embed') return { text: c.site_name ? `嵌入·${c.site_name}` : '嵌入站点', tone: 'embed' };
  if (c.channel === 'email') return { text: '邮件', tone: 'email' };
  if (c.channel === 'im') return { text: '即时通讯', tone: 'im' };
  return { text: '本站网页', tone: 'web' };
}

const CHANNEL_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'web', label: '本站网页' },
  { value: 'embed', label: '嵌入站点' },
  { value: 'email', label: '邮件' },
  { value: 'im', label: '即时通讯' },
];

export function ConversationTable({ conversations, filters, onFilter, pagination, onPageChange }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { content: string; role: string }[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const toggle = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!detail[id]) {
      setLoadingId(id);
      try {
        const data = await api.getSession(id);
        setDetail((prev) => ({
          ...prev,
          [id]: data.messages.map((m) => ({ content: m.content, role: m.role })),
        }));
      } catch {
        setDetail((prev) => ({ ...prev, [id]: [] }));
      } finally {
        setLoadingId(null);
      }
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.keyword}
            onChange={(e) => onFilter({ ...filters, keyword: e.target.value })}
            placeholder="搜索标题 / 客户 / 内容…"
            className="w-full text-xs pl-8 pr-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
          />
        </div>
        <select
          value={filters.status}
          onChange={(e) => onFilter({ ...filters, status: e.target.value })}
          className="text-xs px-2 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={filters.channel}
          onChange={(e) => onFilter({ ...filters, channel: e.target.value })}
          className="text-xs px-2 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
        >
          {CHANNEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-xs text-muted-foreground text-left">
              <th className="px-3 py-2 font-medium w-8"></th>
              <th className="px-3 py-2 font-medium">会话</th>
              <th className="px-3 py-2 font-medium">客户</th>
              <th className="px-3 py-2 font-medium">意图</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">来源</th>
              <th className="px-3 py-2 font-medium text-center">消息</th>
              <th className="px-3 py-2 font-medium text-center">评分</th>
              <th className="px-3 py-2 font-medium text-center">工单</th>
              <th className="px-3 py-2 font-medium">时间</th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => (
              <Fragment key={c.id}>
                <tr
                  className="border-t border-border hover:bg-muted/40 cursor-pointer"
                  onClick={() => toggle(c.id)}
                >
                  <td className="px-3 py-2.5">
                    <ChevronRight
                      size={15}
                      className={`text-muted-foreground transition-transform ${expanded === c.id ? 'rotate-90' : ''}`}
                    />
                  </td>
                  <td className="px-3 py-2.5 max-w-[220px]">
                    <div className="truncate font-medium">{c.title}</div>
                    {c.handoff_reason && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400 truncate">
                        {c.handoff_reason}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{c.customer_name ?? '访客'}</td>
                  <td className="px-3 py-2.5">
                    <IntentBadge intent={c.primary_intent} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-foreground/80">
                      {STATUS_LABELS[c.status] ?? c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {(() => {
                      const ch = channelLabel(c);
                      const toneClass =
                        ch.tone === 'embed'
                          ? 'bg-accent/10 text-accent'
                          : ch.tone === 'email'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : ch.tone === 'im'
                              ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                              : 'bg-muted text-muted-foreground';
                      return (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${toneClass}`}>{ch.text}</span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2.5 text-center text-muted-foreground tabular-nums">
                    {c.message_count}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {c.avg_rating != null ? (
                      <span className="inline-flex items-center gap-0.5 text-xs text-amber-500">
                        <Star size={12} className="fill-amber-400" />
                        {c.avg_rating.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {c.ticket_count > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-xs text-amber-600">
                        <TicketIcon size={12} /> {c.ticket_count}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                    {c.created_at?.slice(0, 10)}
                  </td>
                </tr>
                {expanded === c.id && (
                  <tr key={c.id + '-d'} className="border-t border-border bg-muted/30">
                    <td colSpan={10} className="px-6 py-3">
                      {loadingId === c.id ? (
                        <div className="text-xs text-muted-foreground">加载对话内容…</div>
                      ) : (
                        <>
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {(detail[c.id] ?? []).map((m, i) => (
                              <div key={i} className="flex gap-2 text-xs">
                                <span
                                  className={`shrink-0 w-12 text-right font-medium ${
                                    m.role === 'user' ? 'text-accent' : 'text-muted-foreground'
                                  }`}
                                >
                                  {m.role === 'user' ? '客户' : '客服'}
                                </span>
                                <p className="flex-1 whitespace-pre-wrap text-foreground/85 leading-relaxed">
                                  {m.content}
                                </p>
                              </div>
                            ))}
                            {(!detail[c.id] || detail[c.id].length === 0) && (
                              <div className="text-xs text-muted-foreground">无消息记录</div>
                            )}
                          </div>
                          <CopilotPanel
                            sessionId={c.id}
                            message={(detail[c.id] ?? []).filter((m) => m.role === 'user').pop()?.content ?? ''}
                            primaryIntent={c.primary_intent}
                          />
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {conversations.length === 0 && (
              <tr>
                <td colSpan={10}>
                  <EmptyState
                    icon={<MessageCircle size={20} />}
                    title="暂无符合条件的对话记录"
                    description="调整筛选条件或清空关键词试试"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页控制 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-t border-border text-xs text-muted-foreground">
        <span>共 {pagination.total} 条记录</span>
        <div className="flex items-center gap-1">
          <button
            disabled={pagination.page <= 1}
            onClick={() => onPageChange(pagination.page - 1)}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg border border-border hover:border-accent disabled:opacity-40 disabled:hover:border-border transition-base"
            title="上一页"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-2 tabular-nums">
            {pagination.page} / {Math.max(1, Math.ceil(pagination.total / pagination.pageSize))}
          </span>
          <button
            disabled={pagination.page >= Math.ceil(pagination.total / pagination.pageSize)}
            onClick={() => onPageChange(pagination.page + 1)}
            className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center rounded-lg border border-border hover:border-accent disabled:opacity-40 disabled:hover:border-border transition-base"
            title="下一页"
          >
            <ChevronRightIcon size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
