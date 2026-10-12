import { useState } from 'react';
import { ScanSearch, Tag, BookOpen, PackageSearch, ChevronDown } from 'lucide-react';
import type { TurnAnalysis } from '../types';
import { IntentBadge } from './IntentBadge';

interface Props {
  analysis: TurnAnalysis;
  defaultOpen?: boolean;
}

/** 单轮意图识别 + 知识库检索结果的可视化面板 */
export function AnalysisPanel({ analysis, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const conf = Math.round((analysis.confidence ?? 0) * 100);

  return (
    <div className="rounded-xl border border-border bg-card/60 text-foreground">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50 rounded-xl"
      >
        <ScanSearch size={14} className="text-accent" />
        <span className="font-medium">意图分析</span>
        <IntentBadge intent={analysis.intent} />
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[11px]">置信度 {conf}%</span>
          <ChevronDown
            size={14}
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5 text-xs">
          {/* 关键词命中 */}
          {analysis.matchedKeywords?.length > 0 && (
            <div className="flex items-start gap-2">
              <Tag size={13} className="mt-0.5 text-muted-foreground shrink-0" />
              <div className="flex flex-wrap gap-1">
                {analysis.matchedKeywords.map((k, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded bg-muted text-foreground/80"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 知识库命中 */}
          <div className="flex items-start gap-2">
            <BookOpen size={13} className="mt-0.5 text-muted-foreground shrink-0" />
            {analysis.faqHits?.length ? (
              <div className="space-y-1 w-full">
                {analysis.faqHits.map((h, i) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2 py-1"
                  >
                    <span className="truncate">{h.question}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {Math.round((h.score ?? 0) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">知识库未命中</span>
            )}
          </div>

          {/* 订单挂载 */}
          {analysis.orderNo && (
            <div className="flex items-center gap-2">
              <PackageSearch size={13} className="text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">
                订单号 {analysis.orderNo}
                <span className={analysis.orderFound ? ' text-accent' : ' text-destructive'}>
                  {analysis.orderFound ? ' · 已查询' : ' · 未找到'}
                </span>
              </span>
            </div>
          )}

          {/* 置信度条 */}
          <div className="pt-1">
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${conf}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
