import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, LogIn, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { APP_CONFIG } from '../config';

export function AdminLogin() {
  const { login, isAuthed } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (isAuthed) {
    navigate('/admin', { replace: true });
    return null;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate('/admin', { replace: true });
    } catch (err: any) {
      setError(err?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-background p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-7 space-y-5 shadow-sm animate-fade-in-up"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent text-accent-foreground flex items-center justify-center">
            <Lock size={20} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">管理后台登录</h1>
            <p className="text-xs text-muted-foreground">{APP_CONFIG.name}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">用户名</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            disabled={loading}
            className="w-full text-sm px-3 py-2.5 rounded-lg bg-input border border-border outline-none transition-base focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="请输入管理员密码"
            disabled={loading}
            className="w-full text-sm px-3 py-2.5 rounded-lg bg-input border border-border outline-none transition-base focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2.5 animate-fade-in">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium px-4 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 transition-base"
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin text-accent-foreground" />
          ) : (
            <>
              <LogIn size={15} /> 登录
            </>
          )}
        </button>

        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
          默认用户名 admin；初始密码由服务端在首次启动时生成并打印于日志。
          <br />
          生产环境请通过环境变量固化 ADMIN_USERNAME / ADMIN_PASSWORD。
        </p>
      </form>
    </div>
  );
}
