import { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Link2,
  RefreshCw,
  Search,
  Wrench,
} from 'lucide-react';
import { api } from '../hooks/useApi';
import { ROOT_CAUSE_KIND_LABELS } from '../types';
import type { RootCauseData, RootCauseKind } from '../types';

/** 根因类型 → 徽章样式（浅色主题） */
const KIND_STYLE: Record<RootCauseKind, string> = {
  hardware_batch: 'bg-orange-50 text-orange-700 border-orange-200',
  doc_gap: 'bg-sky-50 text-sky-700 border-sky-200',
  service_flow: 'bg-violet-50 text-violet-700 border-violet-200',
  other: 'bg-slate-100 text-slate-600 border-slate-200',
};

const WINDOWS = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

/**
 * 工单根因聚类洞察
 *
 * 回答管理层三问：客户为什么反复来找我们 / 是产品问题还是说明不清 / 该补什么。
 * 纯确定性文本统计，同样的工单必然得到同样的排序（可现场复现）。
 */
export function RootCausePanel() {
  const [data, setData] = useState<RootCauseData | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (days = windowDays) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getRootCauses(days));
    } catch (e) {
      setError((e as Error)?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(30);
  }, []);

  return (
    <div className="space-y-4">
      {/* 说明 + 窗口切换 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start gap-3">
          <Search size={16} className="mt-0.5 shrink-0 text-indigo-600" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-slate-800">工单根因聚类洞察</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              把工单文本聚成「反复出现的根因」，并判定是硬件批次、说明缺失还是服务流程，
              直接给出该补知识库、该查批次还是该改流程的可执行建议。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => {
                  setWindowDays(w.days);
                  void load(w.days);
                }}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  windowDays === w.days
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {w.label}
              </button>
            ))}
            <button
              onClick={() => void load()}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          加载失败：{error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <RefreshCw size={14} className="animate-spin" /> 正在聚类工单根因…
        </div>
      )}

      {data && data.source === 'db' && (
        <>
          {/* 结论摘要 */}
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-4">
            <div className="flex items-start gap-2">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-indigo-600" />
              <div>
                <div className="text-sm font-semibold text-indigo-900">结论</div>
                <p className="mt-1 text-xs leading-relaxed text-indigo-800">{data.summary}</p>
                <p className="mt-1.5 text-[11px] text-indigo-600">
                  统计口径：{data.totalTickets} 张工单（其中已结 {data.resolvedTickets} 张，优先用已结样本挖根因）
                </p>
              </div>
            </div>
          </div>

          {/* 根因列表 */}
          {data.clusters.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-muted-foreground">
              窗口内未形成重复性根因（最高频关键词不足 2 次）
            </div>
          ) : (
            <div className="space-y-3">
              {data.clusters.map((c, idx) => (
                <div key={c.keyword} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-[11px] font-semibold text-slate-600">
                      {idx + 1}
                    </span>
                    <span className="text-sm font-semibold text-slate-800">「{c.keyword}」</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {c.count} 次 · 占 {c.ratio}%
                    </span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[c.kind]}`}>
                      {c.kindLabel || ROOT_CAUSE_KIND_LABELS[c.kind]}
                    </span>
                    {c.inGapList && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                        <BookOpen size={10} /> 已在知识盲区清单
                      </span>
                    )}
                  </div>

                  {/* 建议 */}
                  <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-slate-50 px-3 py-2">
                    <Wrench size={12} className="mt-0.5 shrink-0 text-slate-400" />
                    <span className="text-xs leading-relaxed text-slate-700">{c.suggestion}</span>
                  </div>

                  {/* 意图分布 + 样本 */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Link2 size={10} /> 关联意图：
                      {c.intents.map((it) => `${it.intent}×${it.count}`).join('、') || '无'}
                    </span>
                    <span>
                      样本：{c.samples.map((s) => `#${s.id.slice(0, 6)}`).join(' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 共现对 */}
          {data.coOccurrences.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h4 className="text-xs font-semibold text-slate-700">高频共现（同一张工单里一起出现的关键词）</h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.coOccurrences.map((co) => (
                  <span
                    key={co.pair.join('|')}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
                  >
                    {co.pair[0]} <span className="text-slate-300">+</span> {co.pair[1]}
                    <span className="font-semibold text-indigo-600">×{co.count}</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                共现往往意味着「同一类客户困境」：例如「干扰距离 + 使用方法」同时高频，说明该补一篇场景化选型+操作指引，
                而不是零散加两条 FAQ。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
