import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MessagesSquare, LayoutDashboard, Sun, Moon, Sparkles, LogOut } from 'lucide-react';
import { useTheme } from './hooks/useTheme';
import { api } from './hooks/useApi';
import { useAuth } from './hooks/useAuth';
import { APP_CONFIG } from './config';
import type { AppMeta } from './types';
import { CustomerPage } from './pages/CustomerPage';
import { AdminPage } from './pages/AdminPage';
import { AdminLogin } from './pages/AdminLogin';
import { SurveyPage } from './pages/SurveyPage';

function TopBar({ meta, onLogout }: { meta: AppMeta | null; onLogout: () => void }) {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const { isAuthed } = useAuth();

  const linkClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-base max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:justify-center ${
      active ? 'bg-accent-light text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`;

  return (
    <header
      className="shrink-0 border-b border-border bg-background flex items-center gap-3 px-4 sm:px-5"
      style={{
        minHeight: 'calc(3.5rem + env(safe-area-inset-top))',
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      {/* 品牌 */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-xl bg-accent text-accent-foreground flex items-center justify-center font-semibold shrink-0">
          {APP_CONFIG.nameInitial}
        </div>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold truncate">{APP_CONFIG.name}</div>
          <div className="text-[11px] text-muted-foreground hidden sm:block">{APP_CONFIG.brand}</div>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex items-center gap-1 ml-1 sm:ml-2">
        <NavLink to="/" className={({ isActive }) => linkClass(isActive && location.pathname === '/')}>
          <MessagesSquare size={16} />
          <span className="hidden sm:inline">客服工作台</span>
        </NavLink>
        <NavLink to="/admin" className={({ isActive }) => linkClass(isActive)}>
          <LayoutDashboard size={16} />
          <span className="hidden sm:inline">管理后台</span>
        </NavLink>
      </nav>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {/* 引擎状态 */}
        {meta && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-base"
            style={{
              backgroundColor: meta.sdkAvailable ? 'var(--color-success-light)' : 'var(--color-warning-light)',
              color: meta.sdkAvailable ? 'var(--color-success)' : 'var(--color-warning)',
            }}
            title={meta.engine}
          >
            <Sparkles size={12} />
            <span className="hidden sm:inline">{meta.engine}</span>
          </span>
        )}
        {/* 退出登录（仅管理员登录态可见） */}
        {isAuthed && (
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-base max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:justify-center"
            title="退出管理后台"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">退出</span>
          </button>
        )}
        {/* 主题切换 */}
        <button
          onClick={toggleTheme}
          className="w-9 h-9 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-accent transition-base max-sm:w-11 max-sm:h-11 max-sm:min-w-[44px] max-sm:min-h-[44px]"
          title={theme === 'dark' ? '切换浅色' : '切换深色'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}

export default function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const { isAuthed, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    api.getMeta().then(setMeta).catch(() => {});
  }, []);

  // 401 统一处理：清除登录态并跳转登录页
  useEffect(() => {
    const onUnauthorized = () => {
      logout();
      if (location.pathname.startsWith('/admin')) navigate('/admin/login', { replace: true });
    };
    window.addEventListener('csa:unauthorized', onUnauthorized);
    return () => window.removeEventListener('csa:unauthorized', onUnauthorized);
  }, [logout, navigate, location.pathname]);

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background text-foreground">
      <TopBar meta={meta} onLogout={logout} />
      <main className="flex-1 min-h-0">
        <div key={location.pathname} className="h-full animate-fade-in">
          <Routes>
            <Route path="/" element={<CustomerPage />} />
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route
              path="/admin"
              element={isAuthed ? <AdminPage /> : <AdminLogin />}
            />
            {/* 公开问卷页（匿名，凭 survey_token，无需登录） */}
            <Route path="/survey/:token" element={<SurveyPage />} />
            <Route path="*" element={<CustomerPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
