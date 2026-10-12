import { useState } from 'react';
import { Globe, Plus, Copy, Check, Power, Trash2, AlertCircle, Loader2, Code2 } from 'lucide-react';
import type { Site } from '../hooks/useApi';

interface Props {
  sites: Site[];
  loading: boolean;
  error: string | null;
  /** 创建站点：返回含 embed_token 的完整 Site（token 仅此刻可见） */
  onCreate: (data: { name: string; domain?: string }) => Promise<Site>;
  onUpdate: (id: string, patch: { name?: string; domain?: string; status?: 'active' | 'disabled' }) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
  onReload: () => void;
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ChannelManager({ sites, loading, error, onCreate, onUpdate, onDelete, onReload }: Props) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<Site | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const embedCode = justCreated
    ? `<script
  src="${origin}/embed.js"
  data-site-id="${justCreated.site_id}"
  data-token="${justCreated.embed_token}"
  data-color="#1e3a8a"
  data-title="在线客服"
  data-server="${origin}"></script>`
    : '';

  const handleCreate = async () => {
    if (!name.trim()) {
      setLocalError('请填写站点名称');
      return;
    }
    setCreating(true);
    setLocalError(null);
    try {
      const site = await onCreate({ name: name.trim(), domain: domain.trim() || undefined });
      setJustCreated(site);
      setName('');
      setDomain('');
    } catch (e: any) {
      setLocalError(e?.message || '创建站点失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!embedCode) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(embedCode);
      } else {
        fallbackCopy(embedCode);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      fallbackCopy(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleToggle = async (s: Site) => {
    setBusyId(s.id);
    setLocalError(null);
    try {
      await onUpdate(s.id, { status: s.status === 'active' ? 'disabled' : 'active' });
    } catch (e: any) {
      setLocalError(e?.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (s: Site) => {
    if (!confirm(`确认停用站点「${s.name}」吗？历史会话数据会保留，但第三方网站将不再能发送消息。`)) return;
    setBusyId(s.id);
    setLocalError(null);
    try {
      await onDelete(s.id);
    } catch (e: any) {
      setLocalError(e?.message || '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 创建表单 */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
          <Globe size={15} className="text-accent" /> 新增接入站点
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">站点名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：某某官网"
              className="w-full text-sm mt-1 px-3 py-2 rounded-lg bg-input border border-border outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">授权域名（可选，仅作记录）</label>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="如：example.com"
              className="w-full text-sm mt-1 px-3 py-2 rounded-lg bg-input border border-border outline-none focus:border-accent"
            />
          </div>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-3 inline-flex items-center gap-1.5 text-sm px-4 py-2 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 transition-base"
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          生成嵌入码
        </button>
        {(localError || error) && (
          <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
            <AlertCircle size={14} />
            {localError || error}
          </div>
        )}
      </div>

      {/* 嵌入码（仅创建后可见一次，token 不二次展示） */}
      {justCreated && (
        <div className="rounded-2xl border border-accent/40 bg-accent-light p-4 sm:p-5 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium flex items-center gap-1.5">
              <Code2 size={15} className="text-accent" /> 已生成嵌入码（请妥善保存，token 仅展示一次）
            </h3>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-accent text-accent hover:bg-accent hover:text-accent-foreground transition-base"
            >
              {copied ? (
                <>
                  <Check size={13} /> 已复制
                </>
              ) : (
                <>
                  <Copy size={13} /> 复制
                </>
              )}
            </button>
          </div>
          <pre className="text-xs bg-background/70 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
            {embedCode}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            将以上代码粘贴到第三方网站的 &lt;body&gt; 末尾即可。浮动客服窗口样式经 Shadow DOM 隔离，不会与宿主网站冲突；
            所有会话会实时同步进本客服后台「对话记录」，可在此查看与介入。
          </p>
        </div>
      )}

      {/* 站点列表 */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <span className="text-sm font-medium">接入站点</span>
          <span className="text-xs text-muted-foreground">（{sites.length}）</span>
          <button
            onClick={onReload}
            className="ml-auto text-xs text-muted-foreground hover:text-accent transition-base"
          >
            刷新
          </button>
        </div>
        {loading && sites.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">加载中…</div>
        ) : sites.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">还没有接入站点，先创建一个吧。</div>
        ) : (
          <div className="divide-y divide-border">
            {sites.map((s) => (
              <div key={s.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{s.name}</span>
                    <span
                      className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                        s.status === 'active' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {s.status === 'active' ? '启用中' : '已停用'}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    站点ID：{s.site_id} · 会话数：{s.session_count ?? 0}
                    {s.domain ? ` · 域名：${s.domain}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(s)}
                    disabled={busyId === s.id}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  >
                    <Power size={13} /> {s.status === 'active' ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={() => handleDelete(s)}
                    disabled={busyId === s.id}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-destructive hover:text-destructive transition-base disabled:opacity-50"
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
