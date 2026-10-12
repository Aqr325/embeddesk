/**
 * useChat —— 客服对话状态机
 * 严格消费 server/index.ts 的 SSE 事件流：
 *   init -> analysis -> (handoff) -> text* -> (notice) -> done
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionDTO } from './useApi';
import type { AppMeta, ChatMessage, IntentId, TurnAnalysis, HandoffInfo } from '../types';

export interface RatingInfo {
  rating: number;
  tags: string[];
  comment: string;
  resolved: boolean;
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

export function useChat() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<string, RatingInfo>>({});
  const [customerId, setCustomerId] = useState<string | null>(null);

  const sessionRef = useRef<SessionDTO | null>(null);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const setSessionBoth = useCallback((s: SessionDTO) => {
    sessionRef.current = s;
    setSession(s);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const m = await api.getMeta();
        if (active) setMeta(m);
      } catch {
        /* 元信息失败不阻断对话 */
      }
      try {
        const { session: s } = await api.createSession();
        if (active) setSessionBoth(s);
      } catch {
        if (active) setLoadError('初始化会话失败，请刷新页面重试');
      }
    })();
    return () => {
      active = false;
    };
  }, [setSessionBoth]);

  const send = useCallback(
    async (text: string, custId?: string) => {
      const content = (text || '').trim();
      if (!content || streamingRef.current) return;
      const cur = sessionRef.current;
      if (!cur) {
        setLoadError('会话尚未就绪，请稍候再试');
        return;
      }

      // 若传入客户标识则记到会话级状态，并随请求上报以关联长期画像
      const effectiveCustomerId = (custId ?? undefined) || undefined;
      if (effectiveCustomerId) setCustomerId(effectiveCustomerId);

      setLoadError(null);
      const assistantId = `a_${Date.now()}`;
      const userMsg: ChatMessage = {
        id: `u_${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsThinking(true);
      setIsStreaming(true);
      streamingRef.current = true;

      const ac = new AbortController();
      abortRef.current = ac;

      let realId = assistantId;
      let partial = '';
      let gotText = false;

      const patchAssistant = (patch: Partial<ChatMessage>) =>
        setMessages((prev) => prev.map((m) => (m.id === realId ? { ...m, ...patch } : m)));

      const handleEvent = (evt: SseEvent) => {
        switch (evt.type) {
          case 'init': {
            realId = (evt.assistantMessageId as string) || realId;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, id: realId } : m)));
            break;
          }
          case 'analysis': {
            const analysis: TurnAnalysis = {
              intent: evt.intent as IntentId,
              label: (evt.label as string) ?? '',
              confidence: Number(evt.confidence ?? 0),
              matchedKeywords: (evt.matchedKeywords as string[]) ?? [],
              runnerUp: (evt.runnerUp as TurnAnalysis['runnerUp']) ?? null,
              orderNo: (evt.orderNo as string) ?? null,
              orderFound: Boolean(evt.orderFound),
              faqHits: (evt.faqHits as TurnAnalysis['faqHits']) ?? [],
              scores: (evt.scores as TurnAnalysis['scores']) ?? [],
            };
            patchAssistant({ analysis });
            break;
          }
          case 'recommend': {
            const recommendations = (evt.faqs as ChatMessage['recommendations']) ?? [];
            patchAssistant({ recommendations });
            break;
          }
          case 'handoff': {
            const handoff: HandoffInfo = {
              ticketId: evt.ticketId as string,
              rule: (evt.rule as string) ?? '',
              reason: (evt.reason as string) ?? '',
              priority: (evt.priority as HandoffInfo['priority']) ?? 'medium',
              queuePosition: Number(evt.queuePosition ?? 0),
            };
            patchAssistant({ handoff });
            break;
          }
          case 'notice': {
            patchAssistant({ noticed: (evt.message as string) ?? '系统提示' });
            break;
          }
          case 'text': {
            if (!gotText) {
              gotText = true;
              setIsThinking(false);
            }
            partial += String(evt.content ?? '');
            patchAssistant({ content: partial });
            break;
          }
          case 'done': {
            patchAssistant({
              isStreaming: false,
              source: (evt.source as string) ?? undefined,
              latencyMs: evt.latencyMs != null ? Number(evt.latencyMs) : undefined,
            });
            break;
          }
          default:
            break;
        }
      };

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: cur.id,
            message: content,
            ...(effectiveCustomerId ? { customerId: effectiveCustomerId } : {}),
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          let msg = '请求失败，请稍后重试';
          try {
            const e = await res.json();
            if (e?.error) msg = e.error;
          } catch {
            /* ignore */
          }
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;
            let evt: SseEvent;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            handleEvent(evt);
          }
        }
      } catch (e) {
        const aborted = (e as { name?: string })?.name === 'AbortError';
        patchAssistant({
          isStreaming: false,
          content:
            partial ||
            (aborted ? '（已停止生成）' : '抱歉，对话服务暂时不可用，请稍后重试。'),
        });
        if (!aborted) setLoadError('对话请求失败，请重试');
      } finally {
        // 确保流式消息最终收敛：即便服务端未下发 done（异常断流 / 错误事件后即结束），
        // 也清除打字态，避免助手气泡永久停留在「输入中」。
        patchAssistant({ isStreaming: false });
        setIsThinking(false);
        setIsStreaming(false);
        streamingRef.current = false;
        abortRef.current = null;
      }
    },
    [setSessionBoth],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(async () => {
    abortRef.current?.abort();
    setMessages([]);
    setIsStreaming(false);
    setIsThinking(false);
    setLoadError(null);
    try {
      const { session: s } = await api.createSession();
      setSessionBoth(s);
    } catch {
      setLoadError('新建会话失败');
    }
  }, [setSessionBoth]);

  const rate = useCallback(
    async (
      messageId: string,
      rating: number,
      tags: string[] = [],
      comment = '',
      resolved = false,
    ) => {
      const sess = sessionRef.current;
      if (!sess) return;
      setRatings((prev) => ({
        ...prev,
        [messageId]: { rating, tags, comment, resolved },
      }));
      try {
        await api.postSatisfaction({
          sessionId: sess.id,
          messageId,
          rating,
          tags,
          comment,
          resolved,
        });
      } catch {
        setLoadError('评价提交失败，请重试');
      }
    },
    [],
  );

  return {
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
  };
}
