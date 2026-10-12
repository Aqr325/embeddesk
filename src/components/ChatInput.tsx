import { useState, useRef, type KeyboardEvent } from 'react';
import { SendHorizontal, Square } from 'lucide-react';
import { APP_CONFIG } from '../config';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
  streaming: boolean;
}

export function ChatInput({ onSend, onStop, disabled, streaming }: Props) {
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

      <div className="flex items-end gap-2">
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
