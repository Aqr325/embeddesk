import { useState } from 'react';
import { Headset, UserCog } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import type { Ticket } from '../types';
import type { Employee } from '../hooks/useApi';
import { TICKET_STATUS_LABELS, PRIORITY_LABELS, SENTIMENT_LABELS } from '../types';
import { IntentBadge } from '../components/IntentBadge';

/** 情绪 → 徽章配色（与 SENTIMENT_LABELS 对应） */
const SENTIMENT_STYLES: Record<string, string> = {
  positive: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
  neutral: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  negative: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  angry: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};

function splitTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Props {
  tickets: Ticket[];
  onUpdate: (
    id: string,
    patch: Partial<Pick<Ticket, 'status' | 'assignee' | 'note' | 'priority'>>,
  ) => void;
  employees?: Employee[];
}

const STATUS_OPTIONS = Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const PRIORITY_OPTIONS = Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }));

export function TicketList({ tickets, onUpdate, employees }: Props) {
  const [openNote, setOpenNote] = useState<string | null>(null);

  if (tickets.length === 0) {
    return (
      <EmptyState
        icon={<Headset size={20} />}
        title="暂无转人工工单"
        description="客户触发转人工规则后将在此显示"
        className="rounded-2xl border border-border bg-card"
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {tickets.map((t) => (
        <div key={t.id} className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 flex items-center justify-center shrink-0">
              <Headset size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <IntentBadge intent={t.intent ?? 'other'} />
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-foreground/80">
                  {PRIORITY_LABELS[t.priority]}优先级
                </span>
                {t.escalated ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 font-medium">
                    智能升级
                  </span>
                ) : null}
                {t.sentiment && SENTIMENT_LABELS[t.sentiment] && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${SENTIMENT_STYLES[t.sentiment] ?? SENTIMENT_STYLES.neutral}`}
                  >
                    情绪·{SENTIMENT_LABELS[t.sentiment]}
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">#{t.id.slice(0, 8)}</span>
              </div>
              <p className="text-sm text-foreground/90 mt-1.5">{t.reason}</p>
              {t.escalated && t.escalation_reason ? (
                <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">升级原因：{t.escalation_reason}</p>
              ) : null}
              {t.summary && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">摘要：{t.summary}</p>
              )}
              {splitTags(t.tags).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {splitTags(t.tags).map((tag) => (
                    <span
                      key={tag}
                      className="text-[11px] px-1.5 py-0.5 rounded-md bg-accent/10 text-accent border border-accent/20"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[11px] text-muted-foreground mt-1">
                客户：{t.customer_name ?? '访客'} · 触发规则：{t.trigger_rule}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border">
            <label className="text-xs text-muted-foreground">状态</label>
            <select
              value={t.status}
              onChange={(e) => onUpdate(t.id, { status: e.target.value as Ticket['status'] })}
              className="text-xs px-2 py-1 rounded-lg bg-input border border-border outline-none focus:border-accent max-sm:py-2.5 max-sm:min-h-[40px]"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <label className="text-xs text-muted-foreground ml-1">优先级</label>
            <select
              value={t.priority}
              onChange={(e) => onUpdate(t.id, { priority: e.target.value as Ticket['priority'] })}
              className="text-xs px-2 py-1 rounded-lg bg-input border border-border outline-none focus:border-accent max-sm:py-2.5 max-sm:min-h-[40px]"
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 ml-auto">
              <UserCog size={14} className="text-muted-foreground" />
              <input
                value={t.assignee ?? ''}
                onChange={(e) => onUpdate(t.id, { assignee: e.target.value })}
                placeholder="负责人"
                list="ticket-assignee-list"
                className="text-xs w-24 px-2 py-1 rounded-lg bg-input border border-border outline-none focus:border-accent max-sm:py-2.5 max-sm:min-h-[40px]"
              />
              {employees && employees.length > 0 && (
                <datalist id="ticket-assignee-list">
                  {employees.map((e) => (
                    <option key={e.id} value={e.username}>
                      {e.display_name || e.username}
                    </option>
                  ))}
                </datalist>
              )}
              <button
                onClick={() => setOpenNote(openNote === t.id ? null : t.id)}
                className="text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent max-sm:min-h-[40px]"
              >
                备注
              </button>
            </div>
          </div>

          {openNote === t.id && (
            <textarea
              defaultValue={t.note ?? ''}
              onBlur={(e) => onUpdate(t.id, { note: e.target.value })}
              placeholder="填写处理备注…"
              className="mt-2 w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent resize-none"
              rows={2}
            />
          )}
        </div>
      ))}
    </div>
  );
}
