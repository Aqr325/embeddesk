import { useState } from 'react';
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import type { Faq } from '../types';

interface Props {
  faqs: Faq[];
  onAdd: (data: { category: string; question: string; answer: string; keywords?: string }) => void;
  onDelete: (id: string) => void;
}

const CATEGORIES = ['模组选型', '端侧AI推理', '功耗续航', '认证入网', '开发工具链', '量产采购', '商务支持'];

export function FaqManager({ faqs, onAdd, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: CATEGORIES[0], question: '', answer: '', keywords: '' });

  const submit = () => {
    if (!form.question.trim() || !form.answer.trim()) return;
    onAdd(form);
    setForm({ category: CATEGORIES[0], question: '', answer: '', keywords: '' });
    setOpen(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <BookOpen size={15} className="text-accent" /> 知识库管理（{faqs.length} 条）
        </h3>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent text-accent-foreground hover:opacity-90 max-sm:min-h-[40px]"
        >
          <Plus size={13} /> 新增
        </button>
      </div>

      {open && (
        <div className="p-3 space-y-2 border-b border-border bg-muted/30">
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
            placeholder="问题（简洁短语）"
            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
          />
          <textarea
            value={form.answer}
            onChange={(e) => setForm({ ...form, answer: e.target.value })}
            placeholder="标准答案"
            rows={3}
            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent resize-none"
          />
          <input
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
            placeholder="关键词（逗号分隔，选填）"
            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setOpen(false)}
              className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:border-accent max-sm:min-h-[40px]"
            >
              取消
            </button>
            <button
              onClick={submit}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-accent-foreground hover:opacity-90 max-sm:min-h-[40px]"
            >
              保存
            </button>
          </div>
        </div>
      )}

      <div className="divide-y divide-border max-h-[360px] overflow-y-auto">
        {faqs.map((f) => (
          <div key={f.id} className="p-3 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-accent">{f.category}</span>
                <span className="text-[11px] text-muted-foreground">命中 {f.hit_count}</span>
              </div>
              <div className="text-sm font-medium mt-1">{f.question}</div>
              <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{f.answer}</div>
            </div>
            <button
              onClick={() => onDelete(f.id)}
              className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 max-sm:min-w-[36px] max-sm:min-h-[36px]"
              title="删除"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {faqs.length === 0 && (
          <EmptyState
            icon={<BookOpen size={20} />}
            title="知识库为空"
            description="点击右上角「新增」添加常见问题"
          />
        )}
      </div>
    </div>
  );
}
