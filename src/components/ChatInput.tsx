import { useState, useRef, type KeyboardEvent } from 'react';
import { SendHorizontal, Square, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { APP_CONFIG } from '../config';
import type { UseVoiceResult } from '../hooks/useVoice';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
  streaming: boolean;
  /** 语音能力（浏览器不支持时为 supported=false，按钮自动隐藏） */
  voice?: UseVoiceResult;
}

export function ChatInput({ onSend, onStop, disabled, streaming, voice }: Props) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };

  const submit = () => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
    requestAnimationFrame(autoGrow);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="border-t border-border bg-background px-4 py-3"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
    >
      {/* 快捷问法 */}
      <div className="flex flex-wrap gap-2 mb-2">
        {APP_CONFIG.quickAsks.map((q, i) => (
          <button
            key={i}
            onClick={() => onSend(q.text)}
            disabled={disabled}
            className="px-3 py-1.5 rounded-full text-xs border border-border bg-card text-foreground/80 hover:border-accent hover:text-accent transition-base active:scale-95 disabled:opacity-40 max-sm:min-h-[40px] max-sm:py-2.5"
          >
            {q.text}
          </button>
        ))}
      </div>

      {/* 实时转写提示 + 自动播报开关 */}
      {(voice?.listening || voice?.ttsSupported) && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
          {voice?.listening && (
            <span className="inline-flex items-center gap-1.5 text-rose-600">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              正在聆听{voice.interim ? `：${voice.interim}` : '，请说话…'}
            </span>
          )}
          {voice?.ttsSupported && (
            <button
              onClick={() => voice.setAutoSpeak(!voice.autoSpeak)}
              className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-1 transition-base ${
                voice.autoSpeak
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              title={voice.autoSpeak ? '关闭自动播报' : '开启自动播报（AI 回复自动朗读）'}
            >
              {voice.autoSpeak ? <Volume2 size={12} /> : <VolumeX size={12} />}
              {voice.autoSpeak ? '自动播报开' : '自动播报关'}
            </button>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* 语音输入：浏览器不支持时自动隐藏（零依赖降级） */}
        {voice?.speechSupported && (
          <button
            onClick={() => (voice.listening ? voice.stopListening() : voice.startListening())}
            disabled={disabled}
            className={`shrink-0 w-10 h-10 min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-base active:scale-95 disabled:opacity-40 ${
              voice.listening
                ? 'bg-rose-500 text-white animate-pulse'
                : 'bg-input border border-border text-muted-foreground hover:border-accent hover:text-accent'
            }`}
            title={voice.listening ? '停止录音' : '语音输入'}
            aria-label={voice.listening ? '停止录音' : '语音输入'}
          >
            {voice.listening ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
        )}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            // 移动端键盘弹出后确保输入栏可见
            window.setTimeout(() => taRef.current?.scrollIntoView({ block: 'end' }), 300);
          }}
          rows={1}
          placeholder="输入你的问题，Enter 发送 / Shift+Enter 换行"
          className="flex-1 resize-none rounded-xl bg-input border border-border px-3.5 py-2.5 text-sm outline-none transition-base focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 placeholder:text-muted-foreground/60 max-h-[140px]"
        />
        {streaming ? (
          <button
            onClick={onStop}
            className="shrink-0 w-10 h-10 min-w-[44px] min-h-[44px] rounded-xl bg-destructive text-destructive-foreground flex items-center justify-center hover:opacity-90 active:scale-95 transition-base"
            title="停止生成"
          >
            <Square size={16} className="fill-current" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="shrink-0 w-10 h-10 min-w-[44px] min-h-[44px] rounded-xl bg-accent text-accent-foreground flex items-center justify-center hover:opacity-90 active:scale-95 disabled:opacity-40 disabled:active:scale-100 transition-base"
            title="发送"
          >
            <SendHorizontal size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
