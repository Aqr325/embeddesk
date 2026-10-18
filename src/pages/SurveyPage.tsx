import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Star, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';

type MetaStatus = 'pending' | 'completed' | 'expired' | 'notfound' | 'loading' | 'error';

const QUICK_TAGS = ['响应及时', '解答专业', '态度友好', '问题解决', '流程繁琐', '等待较久'];

export function SurveyPage() {
  const { token = '' } = useParams();
  const [status, setStatus] = useState<MetaStatus>('loading');
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/csat/survey/${encodeURIComponent(token)}`);
        if (!res.ok) {
          if (alive) setStatus('notfound');
          return;
        }
        const data = await res.json();
        if (alive) setStatus(data.status || 'notfound');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const toggleTag = (t: string) => {
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const submit = async () => {
    if (rating < 1) return;
    setSubmitting(true);
    try {
      const res = await fetch(API_BASE + '/api/csat/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, rating, comment: comment.slice(0, 1000), tags: tags.join(',') }),
      });
      if (res.status === 409) {
        setResult({ ok: true, msg: '您已评价过，感谢您的支持！' });
        setStatus('completed');
        return;
      }
      if (res.status === 410) {
        setResult({ ok: false, msg: '问卷已过期，无法提交。' });
        setStatus('expired');
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setResult({ ok: false, msg: e.error || '提交失败，请稍后重试' });
        return;
      }
      setResult({ ok: true, msg: '感谢您的反馈，我们已经收到！' });
      setStatus('completed');
    } catch {
      setResult({ ok: false, msg: '网络异常，提交失败' });
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-muted-foreground">
        <Loader2 className="animate-spin" /> <span className="ml-2">加载问卷中…</span>
      </div>
    );
  }

  if (status === 'notfound' || status === 'error') {
    return (
      <CenterCard icon={<AlertCircle className="text-destructive" />} title="问卷不存在或已失效">
        该评价链接无效，请确认链接是否完整，或联系客服重新发送。
      </CenterCard>
    );
  }

  if (status === 'expired') {
    return (
      <CenterCard icon={<AlertCircle className="text-warning" />} title="问卷已过期">
        本次满意度问卷已超过 7 天有效期，感谢您的关注。
      </CenterCard>
    );
  }

  if (status === 'completed') {
    return (
      <CenterCard icon={<CheckCircle2 className="text-success" />} title="评价已提交">
        {result?.msg || '感谢您的反馈！'}
      </CenterCard>
    );
  }

  // status === 'pending' → 渲染评分表单
  const display = hover || rating;
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-sm">
        <h1 className="text-lg font-semibold">请为本次客服服务评分</h1>
        <p className="text-sm text-muted-foreground mt-1">您的评价将帮助我们持续改进服务质量。</p>

        <div className="flex items-center justify-center gap-2 my-6">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              className="transition-transform hover:scale-110 focus:outline-none"
              aria-label={`${n} 星`}
            >
              <Star
                size={36}
                className={n <= display ? 'text-amber-400 fill-amber-400' : 'text-muted-foreground/40'}
              />
            </button>
          ))}
        </div>
        <div className="text-center text-sm text-muted-foreground mb-4">
          {display ? ['很不满意', '不满意', '一般', '满意', '非常满意'][display - 1] : '请点击星星打分'}
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggleTag(t)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-base ${
                tags.includes(t) ? 'border-accent text-accent bg-accent-light' : 'border-border text-muted-foreground hover:border-accent'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="补充说明（可选）"
          className="w-full rounded-xl border border-border bg-background p-3 text-sm resize-none focus:outline-none focus:border-accent"
        />

        {result && !result.ok && (
          <p className="mt-3 text-sm text-destructive flex items-center gap-1.5">
            <AlertCircle size={14} /> {result.msg}
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={rating < 1 || submitting}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-accent text-accent-foreground text-sm font-medium py-2.5 min-h-[44px] transition-base hover:opacity-90 disabled:opacity-50"
        >
          {submitting && <Loader2 size={15} className="animate-spin" />}
          {rating < 1 ? '请先打分' : '提交评价'}
        </button>
      </div>
    </div>
  );
}

function CenterCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="flex justify-center mb-3">{icon}</div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground mt-2">{children}</p>
      </div>
    </div>
  );
}
