import { useEffect, useState, useCallback } from 'react';
import { Lightbulb, Plus, Check, X, RefreshCw, BookOpen, Sparkles } from 'lucide-react';
import { api } from '../hooks/useApi';
import type { KnowledgeGap, KnowledgeGapStats } from '../types';

const STATUS_LABEL: Record<string, string> = { pending: '待补充', resolved: '已解决', dismissed: '已忽略' };
const SOURCE_LABEL: Record<string, string> = {
  chat: '网页客服',
  embed: '嵌入站点',
  email: '邮件',
  im: 'IM',
  tool: 'Agent 工具',
  copilot: '坐席辅助',
  agent: 'AI 内核',
  search: '后台检索',
  demo: '演示',
};
const INTENT_LABEL: Record<string, string> = {
  refund: '退款退货',
  order_query: '订单查询',
  tech_support: '技术支持',
  complaint: '投诉抱怨',
  human_service: '转人工',
  greeting: '寒暄',
  other: '其它',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 知识盲区面板（企业知识助手 · 自进化闭环）
 *
 * 汇聚全渠道「知识库未命中」的客户真实问题，按未命中次数排序。
 * 运营可一键补全为标准 FAQ（补全即消解盲区），或忽略误报项。
 */
export function KnowledgeGapPanel() {
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [stats, setStats] = useState<KnowledgeGapStats | null>(null);
  const [status, setStatus] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<KnowledgeGap | null>(null);
  const [answer, setAnswer] = useState('');
  const [category, setCategory] = useState('知识补全');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await api.getKnowledgeGaps(status);
      setGaps(r.gaps);
      setStats(r.stats);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = (g: KnowledgeGap) => {
    setEditing(g);
    setAnswer('');
    setCategory('知识补全');
  };

  const submitCreate = async () => {
    if (!editing || !answer.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.createFaqFromGap(editing.id, { answer: answer.trim(), category: category.trim() || undefined });
      setEditing(null);
      setMsg(`已补全「${editing.query}」为标准知识，该盲区已消解`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '补全失败');
    } finally {
      setSaving(false);
    }
  };

  const doResolve = async (g: KnowledgeGap) => {
    try {
      await api.resolveKnowledgeGap(g.id);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '操作失败');
    }
  };

  const doDismiss = async (g: KnowledgeGap) => {
    try {
      await api.dismissKnowledgeGap(g.id);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '操作失败');
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-1">
        <Lightbulb size={16} className="text-accent" />
        <h3 className="text-sm font-medium">知识盲区</h3>
        <span className="text-xs text-muted-foreground">全渠道未命中问题 · 驱动知识库自进化</span>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        客户真实提问在知识库中未命中时自动沉淀于此。点击「补知识」将其转为标准 FAQ，下次同类问题即可命中——形成「发现盲区 → 补全 → 消解」闭环。
      </p>

      {/* 统计 + 状态筛选 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(['pending', 'resolved', 'dismissed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-base ${
              status === s ? 'border-accent text-accent bg-accent-light' : 'border-border text-muted-foreground hover:border-accent hover:text-accent'
            }`}
          >
            {STATUS_LABEL[s]}
            {stats && (
              <span className="tabular-nums opacity-70">
                {s === 'pending' ? stats.pending : s === 'resolved' ? stats.resolved : stats.dismissed}
              </span>
            )}
          </button>
        ))}
      </div>

      {msg && (
        <div className="text-xs mb-3 px-3 py-2 rounded-lg bg-accent/10 text-accent border border-accent/20">{msg}</div>
      )}

      {/* 列表 */}
      {loading && gaps.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">加载中…</div>
      ) : gaps.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center border border-dashed border-border rounded-xl">
          <Sparkles size={20} className="mx-auto mb-2 opacity-40" />
          暂无{STATUS_LABEL[status]}的盲区
          {status === 'pending' && '——知识库当前覆盖良好'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left font-medium py-2 pr-3">未命中问题</th>
                <th className="text-left font-medium py-2 px-3 whitespace-nowrap">意图</th>
                <th className="text-left font-medium py-2 px-3 whitespace-nowrap">来源</th>
                <th className="text-right font-medium py-2 px-3 whitespace-nowrap">次数</th>
                <th className="text-left font-medium py-2 px-3 whitespace-nowrap">首次 / 最近</th>
                <th className="text-right font-medium py-2 pl-3 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-2 pr-3 max-w-[280px]">
                    <span className="text-foreground/90" title={g.query}>{g.query}</span>
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">{g.intent ? INTENT_LABEL[g.intent] || g.intent : '—'}</td>
                  <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">{g.source ? SOURCE_LABEL[g.source] || g.source : '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    <span className={g.missCount >= 3 ? 'text-rose-500 font-medium' : 'text-foreground/80'}>{g.missCount}</span>
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap text-muted-foreground tabular-nums">
                    {fmtTime(g.firstSeen)} / {fmtTime(g.lastSeen)}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap">
                    {status === 'pending' ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => openCreate(g)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-accent/40 text-accent hover:bg-accent hover:text-white transition-base"
                          title="以该问题创建标准 FAQ"
                        >
                          <Plus size={12} /> 补知识
                        </button>
                        <button
                          onClick={() => doResolve(g)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-emerald-600 hover:border-emerald-400 transition-base"
                          title="标记为已解决"
                        >
                          <Check size={12} />
                        </button>
                        <button
                          onClick={() => doDismiss(g)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-rose-600 hover:border-rose-400 transition-base"
                          title="忽略此盲区"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{STATUS_LABEL[g.status] || g.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 一键补全弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setEditing(null)}>
          <div
            className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <BookOpen size={16} className="text-accent" />
              <h4 className="text-sm font-medium">补全知识</h4>
            </div>
            <label className="block text-xs text-muted-foreground mb-1">问题（来自盲区，不可改）</label>
            <div className="text-xs text-foreground/90 bg-muted/40 rounded-lg p-2 mb-3 border border-border">{editing.query}</div>
            <label className="block text-xs text-muted-foreground mb-1">标准答案</label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              autoFocus
              placeholder="填写该问题的标准答案，保存后立即进入知识库可被检索…"
              className="w-full text-xs rounded-lg border border-border bg-background p-2 mb-3 focus:border-accent focus:outline-none resize-none"
            />
            <label className="block text-xs text-muted-foreground mb-1">类目</label>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-xs rounded-lg border border-border bg-background p-2 mb-4 focus:border-accent focus:outline-none"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-base disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={submitCreate}
                disabled={saving || !answer.trim()}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 transition-base disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存并消解盲区'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
