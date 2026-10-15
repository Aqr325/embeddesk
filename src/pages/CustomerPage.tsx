import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareText, Sparkles, BookOpen, RotateCcw, Wifi, WifiOff, UserSquare2 } from 'lucide-react';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useChat } from '../hooks/useChat';
import { useVoice } from '../hooks/useVoice';
import { api } from '../hooks/useApi';
import { MessageBubble } from '../components/MessageBubble';
import { ChatInput } from '../components/ChatInput';
import { IntentBadge } from '../components/IntentBadge';
import { CustomerProfilePanel } from '../components/CustomerProfilePanel';
import { AgentTraceView } from '../components/AgentTraceView';
import { STATUS_LABELS } from '../types';
import type { Faq } from '../types';

export function CustomerPage() {
  const {
    meta,
    session,
    messages,
    isStreaming,
    isThinking,
    loadError,
    ratings,
    customerId,
    setCustomerId,
    send,
    stop,
    reset,
    rate,
  } = useChat();

  /* 语音交互：语音输入（转写后直接发送）+ 语音播报（可选自动朗读）。
     能力探测失败时 useVoice 内部静默降级，UI 自动隐藏入口。 */
  const voice = useVoice({
    onFinal: (text) => {
      // 识别结束即发送，形成「说一句 → 问一句」的自然对话节奏
      if (!isStreaming) void send(text, customerId ?? undefined);
    },
  });

  /* 自动播报：开启后，最新一条 AI 回复生成完毕即朗读 */
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!voice.autoSpeak) return;
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.isStreaming && m.content);
    if (!last || last.id === lastSpokenRef.current) return;
    lastSpokenRef.current = last.id;
    voice.speak(last.id, last.content);
  }, [messages, voice.autoSpeak, voice]);

  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [faqQuery, setFaqQuery] = useState('');
  const [faqLoading, setFaqLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFaqLoading(true);
    api
      .getFaqs()
      .then((r) => setFaqs(r.faqs))
      .catch(() => {})
      .finally(() => setFaqLoading(false));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isThinking]);

  const lastAnalysis = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].analysis) return messages[i].analysis;
    }
    return null;
  }, [messages]);

  const filteredFaqs = useMemo(() => {
    if (!faqQuery.trim()) return faqs;
    const q = faqQuery.toLowerCase();
    return faqs.filter(
      (f) =>
        f.question.toLowerCase().includes(q) ||
        f.answer.toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q),
    );
  }, [faqs, faqQuery]);

  return (
    <div className="flex h-full">
      {/* 主聊天区 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 会话头 */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <div className="w-9 h-9 rounded-xl bg-accent text-accent-foreground flex items-center justify-center">
            <MessageSquareText size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-medium leading-tight">{session?.title ?? '智能客服咨询'}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              {session && <span>{STATUS_LABELS[session.status]}</span>}
              {meta && (
                <span className="inline-flex items-center gap-1">
                  {meta.sdkAvailable ? (
                    <Wifi size={11} className="text-emerald-500" />
                  ) : (
                    <WifiOff size={11} className="text-muted-foreground" />
                  )}
                  {meta.engine}
                </span>
              )}
            </div>
          </div>
          <div className="hidden md:flex items-center gap-1.5">
            <UserSquare2 size={14} className="text-muted-foreground" />
            <input
              value={customerId ?? ''}
              onChange={(e) => setCustomerId(e.target.value.trim() || null)}
              placeholder="客户标识"
              className="text-xs w-32 px-2 py-1 rounded-lg bg-input border border-border outline-none focus:border-accent"
              title="填写客户唯一标识（如邮箱 / 手机号 / 客户号），用于跨会话长期画像；留空则不关联"
            />
          </div>
          <button
            onClick={reset}
            className="ml-auto inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-colors max-sm:min-h-[44px]"
          >
            <RotateCcw size={13} /> 新会话
          </button>
        </div>

        {/* 消息流 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4 overscroll-contain">
          {messages.length === 0 && !isThinking && (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
              <div className="w-14 h-14 rounded-2xl bg-accent-light flex items-center justify-center">
                <Sparkles size={26} className="text-accent" />
              </div>
              <div>
                <p className="font-medium text-foreground">你好，我是「小云」，你的智能客服助手</p>
                <p className="text-sm mt-1">可以问我退款、订单物流、设备配网、发票等问题</p>
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id}>
              <MessageBubble
                message={m}
                rating={m.id ? ratings[m.id] : undefined}
                onRate={(r, t, c, res) => rate(m.id, r, t, c, res)}
                voice={voice}
              />
              {m.role === 'assistant' && m.trace && (
                <div className="flex justify-start mt-1.5">
                  <div className="ml-10 max-w-[88%]">
                    <AgentTraceView trace={m.trace} />
                  </div>
                </div>
              )}
              {m.role === 'assistant' && m.recommendations && m.recommendations.length > 0 && (
                <div className="flex justify-start mt-1.5">
                  <div className="ml-10 max-w-[80%] space-y-1.5">
                    <div className="text-[11px] text-muted-foreground">猜你想问</div>
                    <div className="flex flex-wrap gap-1.5">
                      {m.recommendations.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => send(r.question, customerId ?? undefined)}
                          disabled={isStreaming}
                          className="text-left text-xs px-2.5 py-1.5 rounded-lg border border-border bg-card hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
                          title={r.category}
                        >
                          {r.question}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isThinking && (
            <div className="flex justify-start">
              <div className="flex gap-2.5">
                <div className="w-8 h-8 rounded-full bg-card border border-border text-accent flex items-center justify-center">
                  <Sparkles size={16} />
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-card border border-border px-4 py-3">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {loadError && (
            <div className="text-center text-xs text-destructive">{loadError}</div>
          )}
        </div>

        {/* 输入区 */}
        <ChatInput
          onSend={(text) => send(text, customerId ?? undefined)}
          onStop={stop}
          disabled={isStreaming}
          streaming={isStreaming}
          voice={voice}
        />
      </div>

      {/* 右侧栏：实时分析 + 知识库 */}
      <aside className="hidden lg:flex w-80 shrink-0 flex-col border-l border-border bg-background">
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* 客户长期画像 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2 tracking-wide flex items-center gap-1.5">
              <UserSquare2 size={13} /> 客户长期画像
            </h3>
            <div className="rounded-xl border border-border bg-card p-3">
              <CustomerProfilePanel customerId={customerId} />
            </div>
          </section>

          {/* 实时意图分析 */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2 tracking-wide">实时意图分析</h3>
            {lastAnalysis ? (
              <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <IntentBadge intent={lastAnalysis.intent} size="md" />
                  <span className="text-xs text-muted-foreground">
                    置信度 {Math.round((lastAnalysis.confidence ?? 0) * 100)}%
                  </span>
                </div>
                {lastAnalysis.matchedKeywords?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {lastAnalysis.matchedKeywords.map((k, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-muted text-[11px] text-foreground/80">
                        {k}
                      </span>
                    ))}
                  </div>
                )}
                {lastAnalysis.orderNo && (
                  <div className="text-xs text-muted-foreground">
                    订单 {lastAnalysis.orderNo}
                    <span className={lastAnalysis.orderFound ? ' text-accent' : ' text-destructive'}>
                      {lastAnalysis.orderFound ? ' 已查询' : ' 未找到'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-card/50 p-4 text-center text-xs text-muted-foreground">
                发送消息后，此处展示意图识别与知识库检索结果
              </div>
            )}
          </section>

          {/* 知识库 FAQ */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground mb-2 tracking-wide flex items-center gap-1">
              <BookOpen size={13} /> 知识库 FAQ（{faqs.length}）
            </h3>
            <input
              value={faqQuery}
              onChange={(e) => setFaqQuery(e.target.value)}
              placeholder="搜索知识库…"
              className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent mb-2"
            />
            <div className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {faqLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card p-2.5 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                ))
              ) : filteredFaqs.length === 0 ? (
                <EmptyState
                  icon={<BookOpen size={18} />}
                  title="未找到知识库条目"
                  description={faqQuery ? '换个关键词试试' : '知识库暂为空'}
                />
              ) : (
                filteredFaqs.map((f) => (
                  <div key={f.id} className="rounded-lg border border-border bg-card p-2.5">
                    <div className="text-xs font-medium">{f.question}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                      {f.answer}
                    </div>
                    <div className="mt-1 text-[10px] text-accent/70">{f.category}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
