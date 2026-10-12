import { useState } from 'react';
import { Star, CheckCircle2 } from 'lucide-react';
import { APP_CONFIG } from '../config';

interface Props {
  rating?: { rating: number; tags: string[]; comment: string; resolved: boolean };
  onSubmit: (rating: number, tags: string[], comment: string, resolved: boolean) => void;
}

/** 满意度评价条：五星 + 标签 + 评论 */
export function SatisfactionBar({ rating, onSubmit }: Props) {
  const [hover, setHover] = useState(0);
  const [value, setValue] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [resolved, setResolved] = useState(true);

  if (rating) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2 px-1">
        <CheckCircle2 size={14} className="text-accent" />
        <span>已评价 {rating.rating} 星</span>
        {rating.tags?.length > 0 && (
          <span className="text-foreground/70">{rating.tags.join('、')}</span>
        )}
      </div>
    );
  }

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const submit = () => {
    if (value === 0) return;
    onSubmit(value, tags, comment, resolved);
  };

  return (
    <div className="mt-2 rounded-xl border border-border bg-card/60 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">本次回答是否解决了你的问题？</span>
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setValue(n)}
              className="-m-1 p-1 transition-colors max-sm:min-w-[36px] max-sm:min-h-[36px]"
              aria-label={`${n} 星`}
            >
              <Star
                size={18}
                className={
                  n <= (hover || value) ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground/40'
                }
              />
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {APP_CONFIG.ratingTags.map((t) => (
          <button
            key={t}
            onClick={() => toggleTag(t)}
            className={`px-2 py-0.5 rounded-full text-xs border transition-colors max-sm:py-1.5 max-sm:min-h-[36px] ${
              tags.includes(t)
                ? 'border-accent bg-accent-light text-accent'
                : 'border-border text-muted-foreground hover:border-accent/50'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="补充说明（选填）"
        className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
      />

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
            className="accent-accent"
          />
          已解决
        </label>
        <button
          onClick={submit}
          disabled={value === 0}
          className="px-3 py-1 rounded-lg bg-accent text-accent-foreground text-xs font-medium disabled:opacity-40 hover:opacity-90 max-sm:min-h-[40px]"
        >
          提交评价
        </button>
      </div>
    </div>
  );
}
