import { useEffect, useState } from 'react';
import { UserSquare2, Loader2, AlertCircle, Save, History, Tag, Building2, Building, Phone, User } from 'lucide-react';
import { api, type CustomerProfile } from '../hooks/useApi';
import { EmptyState } from './ui/EmptyState';

interface Props {
  customerId: string | null;
}

type FieldKey = 'name' | 'company' | 'industry' | 'contact' | 'tags' | 'preferences' | 'notes' | 'history_summary';

const inputCls =
  'w-full text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent';

const TEXT_FIELDS: Array<{ key: FieldKey; label: string; icon: React.ReactNode; placeholder: string; area?: boolean }> = [
  { key: 'name', label: '客户姓名', icon: <User size={12} />, placeholder: '如 李工' },
  { key: 'company', label: '公司', icon: <Building2 size={12} />, placeholder: '如 某某科技' },
  { key: 'industry', label: '行业', icon: <Building size={12} />, placeholder: '如 智能家居' },
  { key: 'contact', label: '联系方式', icon: <Phone size={12} />, placeholder: '手机 / 微信' },
];

export function CustomerProfilePanel({ customerId }: Props) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [draft, setDraft] = useState<Partial<CustomerProfile>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!customerId) {
      setProfile(null);
      setDraft({});
      setError(null);
      setSavedAt(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getCustomerProfile(customerId)
      .then((r) => {
        if (!active) return;
        setProfile(r.profile);
        setDraft(r.profile ?? {});
      })
      .catch((e: any) => {
        if (active) setError(e?.message || '加载画像失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  const update = (key: FieldKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (!customerId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.upsertCustomerProfile(customerId, draft);
      setProfile(r.profile);
      setDraft(r.profile);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!customerId) {
    return (
      <EmptyState
        icon={<UserSquare2 size={18} />}
        title="未关联客户"
        description="在顶部输入客户标识后，这里会展示并支持编辑该客户的长期画像（跨会话记忆）。"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="px-1.5 py-0.5 rounded bg-muted text-foreground/80 font-mono break-all">@{customerId}</span>
        {profile && (
          <span className="flex items-center gap-1">
            <History size={11} /> {profile.session_count} 次会话
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
          <Loader2 size={14} className="animate-spin" /> 加载画像…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!loading && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {TEXT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {f.icon} {f.label}
                </label>
                <input
                  value={(draft[f.key] as string) ?? ''}
                  onChange={(e) => update(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className={inputCls}
                />
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Tag size={12} /> 标签（逗号分隔）
            </label>
            <input
              value={draft.tags ?? ''}
              onChange={(e) => update('tags', e.target.value)}
              placeholder="如 VIP, 渠道商, 技术决策人"
              className={inputCls}
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">偏好 / 诉求</label>
            <textarea
              value={draft.preferences ?? ''}
              onChange={(e) => update('preferences', e.target.value)}
              placeholder="客户偏好、购买意向、服务诉求…"
              rows={2}
              className={inputCls + ' resize-y'}
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">沟通备注</label>
            <textarea
              value={draft.notes ?? ''}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="本次及历史沟通要点…"
              rows={2}
              className={inputCls + ' resize-y'}
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">历史概要</label>
            <textarea
              value={draft.history_summary ?? ''}
              onChange={(e) => update('history_summary', e.target.value)}
              placeholder="跨会话汇总：需求演进、已购产品、待跟进事项…"
              rows={3}
              className={inputCls + ' resize-y'}
            />
          </div>

          {profile?.updated_at && (
            <div className="text-[10px] text-muted-foreground">
              最近更新：{new Date(profile.updated_at).toLocaleString()}
            </div>
          )}

          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center justify-center gap-1.5 w-full text-xs px-3 py-2 min-h-[40px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-base disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? '保存中…' : '保存画像'}
          </button>
          {savedAt && !saving && (
            <div className="text-[10px] text-success text-center">已保存（注入后续对话上下文）</div>
          )}
        </>
      )}
    </div>
  );
}
