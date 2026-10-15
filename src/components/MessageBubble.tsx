import { Bot, User, Headset, AlertTriangle, Clock, Volume2, Square } from 'lucide-react';
import type { ChatMessage } from '../types';
import { IntentBadge } from './IntentBadge';
import { AnalysisPanel } from './AnalysisPanel';
import { SatisfactionBar } from './SatisfactionBar';
import { APP_CONFIG } from '../config';

interface Props {
  message: ChatMessage;
  rating?: { rating: number; tags: string[]; comment: string; resolved: boolean };
  onRate: (rating: number, tags: string[], comment: string, resolved: boolean) => void;
  /** 语音播报能力（不支持时不渲染朗读按钮） */
  voice?: { ttsSupported: boolean; speakingId: string | null; speak: (id: string | null, text: string) => void };
}

const SOURCE_LABEL: Record<string, string> = {
  agent: '大模型生成',
  knowledge_base: '知识库直答',
  handoff: '转人工处理',
};

export function MessageBubble({ message, rating, onRate, voice }: Props) {
  const isUser = message.role === 'user';

  // 转人工卡片
  if (message.handoff) {
    const h = message.handoff;
    return (
      <div className="flex justify-start animate-fade-in">
        <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3.5">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium text-sm">
            <Headset size={16} />
            已为你转接人工客服
          </div>
          <p className="text-sm text-foreground/80 mt-1.5 whitespace-pre-wrap">{message.content}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <AlertTriangle size={12} /> 触发规则：{h.rule}
            </span>
            <span>工单 {h.ticketId.slice(0, 8)}</span>
            <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
              排队第 {h.queuePosition} 位
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      <div className={`flex gap-2.5 max-w-[85%] ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* 头像 */}
        <div
          className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
            isUser ? 'bg-accent text-accent-foreground' : 'bg-card border border-border text-accent'
          }`}
        >
          {isUser ? <User size={16} /> : <Bot size={16} />}
        </div>

        <div className="min-w-0">
          {/* 意图分析面板（仅助手首条后展示） */}
          {!isUser && message.analysis && (
            <div className="mb-1.5">
              <AnalysisPanel analysis={message.analysis} />
            </div>
          )}

          {/* 气泡 */}
          <div
            className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
              isUser
                ? 'bg-accent text-accent-foreground rounded-tr-sm'
                : 'bg-card border border-border text-foreground rounded-tl-sm'
            }`}
          >
            {message.content}
            {message.isStreaming && (
              <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-accent/70 animate-pulse rounded-sm" />
            )}
          </div>

          {/* 降级/通知提示 */}
          {!isUser && message.noticed && (
            <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle size={11} /> {message.noticed}
            </div>
          )}

          {/* 元信息 */}
          {!isUser && !message.isStreaming && message.content && (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground px-1">
              {message.source && <span>{SOURCE_LABEL[message.source] ?? message.source}</span>}
              {message.latencyMs != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock size={10} /> {(message.latencyMs / 1000).toFixed(1)}s
                </span>
              )}
              {/* 语音播报：点击朗读本条回复，再次点击停止 */}
              {voice?.ttsSupported && (
                <button
                  onClick={() => voice.speak(message.id, message.content)}
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-base hover:text-accent ${
                    voice.speakingId === message.id ? 'text-accent' : ''
                  }`}
                  title={voice.speakingId === message.id ? '停止朗读' : '朗读这条回复'}
                  aria-label={voice.speakingId === message.id ? '停止朗读' : '朗读这条回复'}
                >
                  {voice.speakingId === message.id ? <Square size={9} className="fill-current" /> : <Volume2 size={10} />}
                  {voice.speakingId === message.id ? '停止' : '朗读'}
                </button>
              )}
            </div>
          )}

          {/* 满意度评价 */}
          {!isUser && !message.isStreaming && message.content && (
            <SatisfactionBar rating={rating} onSubmit={onRate} />
          )}
        </div>
      </div>
    </div>
  );
}
