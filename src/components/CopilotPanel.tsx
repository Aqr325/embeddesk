import { useEffect, useState } from 'react';
import { Sparkles, Copy, RefreshCw, Check, BookOpen, Lightbulb, UserCog } from 'lucide-react';
import { api } from '../hooks/useApi';
import type { CopilotSuggestion, CopilotInsight } from '../types';

interface Props {
  /** 会话 ID（用于关联客户画像 / 未结工单 / 连续未解决轮次） */
  sessionId?: string;
  /** 客户标识（可选，缺省由 sessionId 反查） */
  customerId?: string;
  /** 待辅助分析的客户最新消息 */
  message: string;
  /** 会话主意图（可选，仅用于展示上下文） */
  primaryIntent?: string | null;
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: '正面',
  neutral: '中性',
  negative: '负面',
  angry: '愤怒',
};
const SENTIMENT_TONE: Record<string, string> = {
  positive: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  neutral: 'bg-muted text-muted-foreground',
  negative: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  angry: 'bg-rose-600/15 text-rose-700 dark:text-rose-300',
};
const TIER_LABEL: Record<string, string> = {
  vip: 'VIP 客户',
  key: '重点客户',
  new: '新客户',
  regular: '普通客户',
};

function InsightChips({ insights }: { insights: CopilotInsight }) {
  const chips: Array<{ label: string; cls: string }> = [];
  if (insights.tier && TIER_LABEL[insights.tier]) {
    chips.push({ label: TIER_LABEL[insights.tier], cls: 'bg-accent/10 text-accent' });
  }
  if (insights.sentiment && SENTIMENT_LABEL[insights.sentiment]) {
    chips.push({
      label: `情绪·${SENTIMENT_LABEL[insights.sentiment]}`,
      cls: SENTIMENT_TONE[insights.sentiment] || 'bg-muted text-muted-foreground',
    });
  }
  if (insights.openTicket) chips.push({ label: '有未结工单', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' });
  if (insights.unresolvedStreak >= 2)
    chips.push({ label: `连续 ${insights.unresolvedStreak} 轮未解决`, cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' });
  if (insights.intent) chips.push({ label: `意图·${insights.intent}`, cls: 'bg-muted text-muted-foreground' });
  if (!chips.length) return <span className="text-xs text-muted-foreground">暂无画像信号</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${c.cls}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

export function CopilotPanel({ sessionId, customerId, message, primaryIntent }: Props) {
  const [data, setData] = useState<CopilotSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    if (!message.trim()) {
      setError('暂无客户消息可供分析');
      return;
    }
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const r = await api.copilotSuggest({ sessionId, customerId, message });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copilot 分析失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    run();
    // 仅在会话/消息变化时重新分析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, message]);

  const copyDraft = async () => {
    if (!data?.draftReply) return;
    try {
      await navigator.clipboard.writeText(data.draftReply);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3 mt-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={14} className="text-accent" />
        <span className="text-xs font-medium text-accent">坐席 Copilot 辅助</span>
        <button
          onClick={run}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
          title="重新分析"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {loading && <div className="text-xs text-muted-foreground py-2">分析中客户消息与知识库…</div>}
      {error && <div className="text-xs text-rose-600 dark:text-rose-400 py-1">{error}</div>}

      {data && !loading && (
        <div className="space-y-3">
          {/* 草稿回复 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Lightbulb size={12} /> 建议回复草稿
              </span>
              <button
                onClick={copyDraft}
                disabled={!data.draftReply}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-40"
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            {data.draftReply ? (
              <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed bg-background/60 rounded-lg p-2 border border-border">
                {data.draftReply}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground bg-background/60 rounded-lg p-2 border border-border">
                知识库无强匹配标准答案，建议人工撰写或从工单/订单查证。
              </div>
            )}
          </div>

          {/* 画像洞察 */}
          <div>
            <div className="text-xs text-muted-foreground mb-1 inline-flex items-center gap-1">
              <UserCog size={12} /> 客户洞察
            </div>
            <InsightChips insights={data.insights} />
          </div>

          {/* 知识库参考 */}
          {data.kbHits.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1 inline-flex items-center gap-1">
                <BookOpen size={12} /> 知识库参考
              </div>
              <div className="space-y-1.5">
                {data.kbHits.map((h, i) => (
                  <details key={h.id} className="group rounded-lg border border-border bg-background/60">
                    <summary className="cursor-pointer list-none px-2 py-1.5 text-xs flex items-center gap-2">
                      <span className="text-accent font-medium">[{i + 1}]</span>
                      <span className="flex-1 truncate text-foreground/85">{h.question}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">{(h.score * 100).toFixed(0)}%</span>
                    </summary>
                    <p className="px-2 pb-2 text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{h.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          )}

          {/* 下一步动作 */}
          <div>
            <div className="text-xs text-muted-foreground mb-1">下一步建议</div>
            <ul className="space-y-1">
              {data.actions.map((a, i) => (
                <li key={i} className="text-xs text-foreground/85 flex items-start gap-1.5">
                  <span className="text-accent mt-0.5">•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>

          {primaryIntent && (
            <div className="text-[11px] text-muted-foreground/70">会话主意图：{primaryIntent}</div>
          )}
        </div>
      )}
    </div>
  );
}
