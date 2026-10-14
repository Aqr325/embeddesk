import { useEffect, useState, useCallback } from 'react';
import { Workflow, Plus, Trash2, RefreshCw, X, Zap, Bell, ArrowUpCircle, Ticket, Tag, Gauge } from 'lucide-react';
import { api } from '../hooks/useApi';
import type { WorkflowRule, WorkflowConditions, WorkflowActions } from '../types';

const INTENT_OPTIONS = [
  { v: 'refund', l: '退款退货' },
  { v: 'order_query', l: '订单查询' },
  { v: 'tech_support', l: '技术支持' },
  { v: 'complaint', l: '投诉抱怨' },
  { v: 'human_service', l: '转人工' },
];
const SENTIMENT_OPTIONS = [
  { v: 'angry', l: '愤怒' },
  { v: 'negative', l: '负面' },
  { v: 'neutral', l: '中性' },
  { v: 'positive', l: '正面' },
];
const TIER_OPTIONS = [
  { v: 'vip', l: 'VIP' },
  { v: 'key', l: '重点' },
  { v: 'regular', l: '普通' },
  { v: 'new', l: '新客户' },
];
const CHANNEL_OPTIONS = [
  { v: 'web', l: '网页' },
  { v: 'embed', l: '嵌入' },
  { v: 'email', l: '邮件' },
  { v: 'im', l: 'IM' },
];
const PRIORITY_OPTIONS = [
  { v: '', l: '不设置' },
  { v: 'low', l: '低' },
  { v: 'medium', l: '普通' },
  { v: 'high', l: '高' },
  { v: 'urgent', l: '紧急' },
];

interface Draft {
  id?: string;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  intent: string[];
  sentiment: string[];
  customerTier: string[];
  channel: string[];
  keywords: string;
  unresolvedStreakGte: string;
  hasOpenTicket: 'any' | 'yes' | 'no';
  escalate: boolean;
  createTicket: boolean;
  autoHandoff: boolean;
  notify: boolean;
  setPriority: string;
  tag: string;
}

const emptyDraft: Draft = {
  name: '',
  description: '',
  priority: 100,
  enabled: true,
  intent: [],
  sentiment: [],
  customerTier: [],
  channel: [],
  keywords: '',
  unresolvedStreakGte: '',
  hasOpenTicket: 'any',
  escalate: false,
  createTicket: false,
  autoHandoff: false,
  notify: false,
  setPriority: '',
  tag: '',
};

function toConditions(d: Draft): WorkflowConditions {
  const c: WorkflowConditions = {};
  if (d.intent.length) c.intent = d.intent;
  if (d.sentiment.length) c.sentiment = d.sentiment;
  if (d.customerTier.length) c.customerTier = d.customerTier;
  if (d.channel.length) c.channel = d.channel;
  if (d.keywords.trim()) c.keywords = d.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (d.unresolvedStreakGte.trim()) c.unresolvedStreakGte = Number(d.unresolvedStreakGte) || undefined;
  if (d.hasOpenTicket !== 'any') c.hasOpenTicket = d.hasOpenTicket === 'yes';
  return c;
}
function toActions(d: Draft): WorkflowActions {
  const a: WorkflowActions = {};
  if (d.escalate) a.escalate = true;
  if (d.createTicket) a.createTicket = true;
  if (d.autoHandoff) a.autoHandoff = true;
  if (d.notify) a.notify = true;
  if (d.setPriority) a.setPriority = d.setPriority as WorkflowActions['setPriority'];
  if (d.tag.trim()) a.tag = d.tag.trim();
  return a;
}
function fromRule(r: WorkflowRule): Draft {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    priority: r.priority,
    enabled: r.enabled,
    intent: r.conditions.intent || [],
    sentiment: r.conditions.sentiment || [],
    customerTier: r.conditions.customerTier || [],
    channel: r.conditions.channel || [],
    keywords: (r.conditions.keywords || []).join(', '),
    unresolvedStreakGte: r.conditions.unresolvedStreakGte != null ? String(r.conditions.unresolvedStreakGte) : '',
    hasOpenTicket: r.conditions.hasOpenTicket == null ? 'any' : r.conditions.hasOpenTicket ? 'yes' : 'no',
    escalate: !!r.actions.escalate,
    createTicket: !!r.actions.createTicket,
    autoHandoff: !!r.actions.autoHandoff,
    notify: !!r.actions.notify,
    setPriority: r.actions.setPriority || '',
    tag: r.actions.tag || '',
  };
}
function sumConditions(d: Draft): string {
  const p: string[] = [];
  if (d.intent.length) p.push(`意图∈{${d.intent.join('/')}}`);
  if (d.sentiment.length) p.push(`情绪∈{${d.sentiment.join('/')}}`);
  if (d.customerTier.length) p.push(`等级∈{${d.customerTier.join('/')}}`);
  if (d.channel.length) p.push(`渠道∈{${d.channel.join('/')}}`);
  if (d.keywords.trim()) p.push(`含词[${d.keywords}]`);
  if (d.unresolvedStreakGte.trim()) p.push(`未解决≥${d.unresolvedStreakGte}轮`);
  if (d.hasOpenTicket !== 'any') p.push(d.hasOpenTicket === 'yes' ? '有未结工单' : '无未结工单');
  return p.length ? p.join(' 且 ') : '（无条件，恒触发）';
}
function sumActions(d: Draft): string {
  const p: string[] = [];
  if (d.escalate) p.push('升级');
  if (d.createTicket) p.push('建工单');
  if (d.autoHandoff) p.push('强制转人工');
  if (d.notify) p.push('通知');
  if (d.setPriority) p.push(`优先级→${d.setPriority}`);
  if (d.tag.trim()) p.push(`标签[${d.tag}]`);
  return p.length ? p.join(' · ') : '（无动作）';
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-lg border transition-base ${
        active ? 'border-accent text-accent bg-accent-light' : 'border-border text-muted-foreground hover:border-accent hover:text-accent'
      }`}
    >
      {children}
    </button>
  );
}

function toggleIn(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * 工作流规则面板（工作流自动化 · 可视化「条件 → 动作」编排）
 *
 * 运营在此编排自动化规则，命中即对建单/升级决策生效（只增强不削弱）。
 * 命中计数（hitCount）反映规则真实作用效果。
 */
export function WorkflowRules() {
  const [rules, setRules] = useState<WorkflowRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getWorkflowRules();
      setRules(r.rules);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!draft || !draft.name.trim()) {
      setMsg('规则名不能为空');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        enabled: draft.enabled,
        priority: draft.priority,
        conditions: toConditions(draft),
        actions: toActions(draft),
      };
      if (draft.id) await api.updateWorkflowRule(draft.id, payload);
      else await api.createWorkflowRule(payload);
      setDraft(null);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: WorkflowRule) => {
    try {
      await api.updateWorkflowRule(r.id, { enabled: !r.enabled });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '操作失败');
    }
  };

  const del = async (r: WorkflowRule) => {
    if (!window.confirm(`删除规则「${r.name}」？`)) return;
    try {
      await api.deleteWorkflowRule(r.id);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '删除失败');
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Workflow size={16} className="text-accent" />
        <h3 className="text-sm font-medium">工作流自动化</h3>
        <span className="text-xs text-muted-foreground">条件 → 动作 · 全建单路径统一生效</span>
        <div className="ml-auto inline-flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
          <button
            onClick={() => setDraft({ ...emptyDraft })}
            className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-lg bg-accent text-white hover:opacity-90 transition-base"
          >
            <Plus size={13} /> 新建规则
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        命中条件时自动执行动作（升级转人工 / 建工单 / 提升优先级 / 通知值班 / 打标签）。规则与情感升级引擎叠加，只增强、不削弱。数字越小优先级越高。
      </p>

      {msg && <div className="text-xs mb-3 px-3 py-2 rounded-lg bg-accent/10 text-accent border border-accent/20">{msg}</div>}

      {rules.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center border border-dashed border-border rounded-xl">
          <Workflow size={20} className="mx-auto mb-2 opacity-40" />
          暂无规则，点击「新建规则」开始编排自动化
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => {
            const d = fromRule(r);
            return (
              <div key={r.id} className={`rounded-xl border p-3 ${r.enabled ? 'border-border bg-background/60' : 'border-border/50 bg-muted/20 opacity-60'}`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs tabular-nums text-muted-foreground bg-muted rounded px-1.5 py-0.5">#{r.priority}</span>
                  <span className="text-sm font-medium text-foreground/90">{r.name}</span>
                  {!r.enabled && <span className="text-[11px] text-muted-foreground">（已停用）</span>}
                  <span className="ml-auto inline-flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground tabular-nums" title="命中次数">命中 {r.hitCount}</span>
                    <button onClick={() => toggle(r)} className="text-muted-foreground hover:text-accent transition-base" title={r.enabled ? '停用' : '启用'}>
                      {r.enabled ? <Zap size={14} className="text-emerald-500" /> : <Zap size={14} />}
                    </button>
                    <button onClick={() => setDraft(fromRule(r))} className="text-xs px-2 py-0.5 rounded-lg border border-border text-muted-foreground hover:text-accent hover:border-accent transition-base">编辑</button>
                    <button onClick={() => del(r)} className="text-muted-foreground hover:text-rose-600 transition-base" title="删除">
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {r.description && <div className="text-xs text-muted-foreground mb-1.5">{r.description}</div>}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                  <span className="text-muted-foreground">
                    <span className="text-foreground/60">条件：</span>
                    <span className="font-mono text-foreground/80">{sumConditions(d)}</span>
                  </span>
                  <span className="text-muted-foreground">
                    <span className="text-foreground/60">动作：</span>
                    <span className="font-mono text-accent">{sumActions(d)}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 新建 / 编辑弹窗 */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 py-8" onClick={() => !saving && setDraft(null)}>
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-5 shadow-xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Workflow size={16} className="text-accent" />
              <h4 className="text-sm font-medium">{draft.id ? '编辑规则' : '新建规则'}</h4>
              <button onClick={() => setDraft(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">规则名</label>
                <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className="w-full text-xs rounded-lg border border-border bg-background p-2 focus:border-accent focus:outline-none" placeholder="如：VIP 客诉紧急升级" />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">优先级（数字越小越靠前）</label>
                <input type="number" value={draft.priority} onChange={(e) => set({ priority: Number(e.target.value) || 100 })} className="w-full text-xs rounded-lg border border-border bg-background p-2 focus:border-accent focus:outline-none" />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1">描述（可选）</label>
              <input value={draft.description} onChange={(e) => set({ description: e.target.value })} className="w-full text-xs rounded-lg border border-border bg-background p-2 focus:border-accent focus:outline-none" />
            </div>

            {/* 条件 */}
            <div className="rounded-xl border border-border p-3 mb-3">
              <div className="text-xs font-medium text-foreground/80 mb-2 flex items-center gap-1"><Gauge size={13} /> 触发条件（同组多选为「或」，不同组为「且」）</div>
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-16">意图</span>
                  {INTENT_OPTIONS.map((o) => <Chip key={o.v} active={draft.intent.includes(o.v)} onClick={() => set({ intent: toggleIn(draft.intent, o.v) })}>{o.l}</Chip>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-16">情绪</span>
                  {SENTIMENT_OPTIONS.map((o) => <Chip key={o.v} active={draft.sentiment.includes(o.v)} onClick={() => set({ sentiment: toggleIn(draft.sentiment, o.v) })}>{o.l}</Chip>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-16">客户等级</span>
                  {TIER_OPTIONS.map((o) => <Chip key={o.v} active={draft.customerTier.includes(o.v)} onClick={() => set({ customerTier: toggleIn(draft.customerTier, o.v) })}>{o.l}</Chip>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-16">渠道</span>
                  {CHANNEL_OPTIONS.map((o) => <Chip key={o.v} active={draft.channel.includes(o.v)} onClick={() => set({ channel: toggleIn(draft.channel, o.v) })}>{o.l}</Chip>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-16">关键词</span>
                  <input value={draft.keywords} onChange={(e) => set({ keywords: e.target.value })} placeholder="逗号分隔，任一命中即可" className="flex-1 min-w-[180px] text-xs rounded-lg border border-border bg-background p-1.5 focus:border-accent focus:outline-none" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">未解决轮次 ≥</span>
                    <input type="number" min={1} value={draft.unresolvedStreakGte} onChange={(e) => set({ unresolvedStreakGte: e.target.value })} className="w-16 text-xs rounded-lg border border-border bg-background p-1.5 focus:border-accent focus:outline-none" placeholder="N" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">未结工单</span>
                    <Chip active={draft.hasOpenTicket === 'any'} onClick={() => set({ hasOpenTicket: 'any' })}>不限</Chip>
                    <Chip active={draft.hasOpenTicket === 'yes'} onClick={() => set({ hasOpenTicket: 'yes' })}>有</Chip>
                    <Chip active={draft.hasOpenTicket === 'no'} onClick={() => set({ hasOpenTicket: 'no' })}>无</Chip>
                  </div>
                </div>
              </div>
            </div>

            {/* 动作 */}
            <div className="rounded-xl border border-border p-3 mb-4">
              <div className="text-xs font-medium text-foreground/80 mb-2 flex items-center gap-1"><Zap size={13} /> 执行动作</div>
              <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
                <Chip active={draft.escalate} onClick={() => set({ escalate: !draft.escalate })}><span className="inline-flex items-center gap-1"><ArrowUpCircle size={12} /> 升级</span></Chip>
                <Chip active={draft.createTicket} onClick={() => set({ createTicket: !draft.createTicket })}><span className="inline-flex items-center gap-1"><Ticket size={12} /> 建工单</span></Chip>
                <Chip active={draft.autoHandoff} onClick={() => set({ autoHandoff: !draft.autoHandoff })}>强制转人工</Chip>
                <Chip active={draft.notify} onClick={() => set({ notify: !draft.notify })}><span className="inline-flex items-center gap-1"><Bell size={12} /> 通知</span></Chip>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">提升优先级</span>
                  <select value={draft.setPriority} onChange={(e) => set({ setPriority: e.target.value })} className="text-xs rounded-lg border border-border bg-background p-1.5 focus:border-accent focus:outline-none">
                    {PRIORITY_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1.5">
                  <Tag size={12} className="text-muted-foreground" />
                  <input value={draft.tag} onChange={(e) => set({ tag: e.target.value })} placeholder="标签" className="w-32 text-xs rounded-lg border border-border bg-background p-1.5 focus:border-accent focus:outline-none" />
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="accent-accent" />
              启用此规则
            </label>

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDraft(null)} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-base disabled:opacity-50">取消</button>
              <button onClick={save} disabled={saving} className="text-xs px-4 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 transition-base disabled:opacity-50">
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
