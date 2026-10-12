import { useState } from 'react';
import { Users, UserPlus, Loader2, AlertCircle, ShieldCheck, KeyRound, Trash2, UserCog } from 'lucide-react';
import type { Employee, EmployeeRole, EmployeeStatus } from '../hooks/useApi';
import { EmptyState } from './ui/EmptyState';

/** 员工可编辑字段（密码不回传前端，仅用于更新请求） */
type EmployeePatch = {
  role?: EmployeeRole;
  status?: EmployeeStatus;
  display_name?: string;
  password?: string;
};

const ROLE_LABELS: Record<EmployeeRole, string> = {
  admin: '管理员',
  manager: '主管',
  agent: '坐席',
};
const ROLE_ORDER: EmployeeRole[] = ['admin', 'manager', 'agent'];
const STATUS_LABELS: Record<EmployeeStatus, string> = {
  active: '启用',
  disabled: '停用',
};

const inputCls =
  'text-xs px-2.5 py-1.5 rounded-lg bg-input border border-border outline-none focus:border-accent max-sm:py-2.5 max-sm:min-h-[40px]';
const btnCls =
  'inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50';

interface Props {
  employees: Employee[];
  loading: boolean;
  error: string | null;
  currentUsername: string | null;
  onCreate: (data: { username: string; display_name?: string; role: EmployeeRole; password: string }) => Promise<unknown>;
  onUpdate: (id: string, patch: EmployeePatch) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onReload: () => void;
}

function RoleBadge({ role }: { role: EmployeeRole }) {
  const tone =
    role === 'admin'
      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
      : role === 'manager'
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tone}`}>{ROLE_LABELS[role]}</span>
  );
}

export function EmployeeManager({ employees, loading, error, currentUsername, onCreate, onUpdate, onDelete, onReload }: Props) {
  const [form, setForm] = useState<{ username: string; display_name: string; role: EmployeeRole; password: string }>({
    username: '',
    display_name: '',
    role: 'agent',
    password: '',
  });
  const [creating, setCreating] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  const submitCreate = async () => {
    setFormErr(null);
    const username = form.username.trim();
    const password = form.password;
    if (!username) return setFormErr('请填写登录账号');
    if (password.length < 6) return setFormErr('密码至少 6 位');
    setCreating(true);
    try {
      await onCreate({ username, display_name: form.display_name.trim() || undefined, role: form.role, password });
      setForm({ username: '', display_name: '', role: 'agent', password: '' });
    } catch (e: any) {
      setFormErr(e?.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const runUpdate = async (id: string, patch: EmployeePatch, label: string) => {
    setRowErr(null);
    setBusyId(id);
    try {
      await onUpdate(id, patch);
    } catch (e: any) {
      setRowErr(`${label}失败：${e?.message || '请重试'}`);
    } finally {
      setBusyId(null);
    }
  };

  const resetPassword = async (emp: Employee) => {
    const pw = prompt(`为 ${emp.display_name || emp.username} 设置新密码（至少 6 位）：`);
    if (pw == null) return;
    if (pw.length < 6) return setRowErr('密码至少 6 位');
    await runUpdate(emp.id, { password: pw }, '重置密码');
  };

  const confirmDelete = async (emp: Employee) => {
    if (emp.username === currentUsername) return setRowErr('不能删除当前登录账号');
    if (!confirm(`确认停用并删除员工「${emp.display_name || emp.username}」？该操作将移除其登录权限。`)) return;
    setRowErr(null);
    setBusyId(emp.id);
    try {
      await onDelete(emp.id);
    } catch (e: any) {
      setRowErr(e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 创建员工 */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <UserPlus size={16} className="text-accent" />
          <h3 className="text-sm font-medium">新增员工 / 坐席</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 items-end">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">登录账号</label>
            <input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              placeholder="如 zhangsan"
              className={inputCls + ' w-full'}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">显示名称</label>
            <input
              value={form.display_name}
              onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
              placeholder="如 张三"
              className={inputCls + ' w-full'}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">角色</label>
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as EmployeeRole }))}
              className={inputCls + ' w-full'}
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">初始密码</label>
            <input
              type="text"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="至少 6 位"
              className={inputCls + ' w-full'}
            />
          </div>
          <button
            onClick={submitCreate}
            disabled={creating}
            className="inline-flex items-center justify-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-base disabled:opacity-50"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
        {formErr && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2 mt-3">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{formErr}</span>
          </div>
        )}
      </div>

      {/* 错误条 */}
      {(error || rowErr) && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{rowErr || error}</span>
        </div>
      )}

      {/* 列表 */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users size={16} className="text-accent" />
          <h3 className="text-sm font-medium">员工列表（{employees.length}）</h3>
          <button onClick={onReload} className="ml-auto text-xs text-muted-foreground hover:text-accent">
            刷新
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
            <Loader2 size={14} className="animate-spin" /> 加载中…
          </div>
        ) : employees.length === 0 ? (
          <EmptyState icon={<Users size={18} />} title="暂无员工" description="使用上方表单创建第一个员工账号" />
        ) : (
          <div className="space-y-2.5">
            {employees.map((emp) => {
              const isSelf = emp.username === currentUsername;
              const busy = busyId === emp.id;
              return (
                <div key={emp.id} className="rounded-xl border border-border bg-background/40 p-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{emp.display_name || emp.username}</span>
                        <RoleBadge role={emp.role} />
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                            emp.status === 'active'
                              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                              : 'bg-slate-200 dark:bg-slate-700 text-slate-500'
                          }`}
                        >
                          {STATUS_LABELS[emp.status]}
                        </span>
                        {isSelf && <span className="text-[11px] text-accent">（当前账号）</span>}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        @{emp.username} · 创建于 {new Date(emp.created_at).toLocaleDateString()}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                      {/* 角色切换 */}
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <UserCog size={13} />
                        <select
                          value={emp.role}
                          disabled={busy || isSelf}
                          onChange={(e) => runUpdate(emp.id, { role: e.target.value as EmployeeRole }, '角色变更')}
                          className={inputCls + ' disabled:opacity-50'}
                          title={isSelf ? '不能修改自己的角色' : '变更角色'}
                        >
                          {ROLE_ORDER.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 启用/停用 */}
                      <button
                        onClick={() =>
                          runUpdate(
                            emp.id,
                            { status: emp.status === 'active' ? 'disabled' : 'active' },
                            emp.status === 'active' ? '停用' : '启用',
                          )
                        }
                        disabled={busy || isSelf}
                        className={btnCls + ' disabled:opacity-50'}
                        title={isSelf ? '不能停用自己' : emp.status === 'active' ? '停用该账号' : '启用该账号'}
                      >
                        <ShieldCheck size={13} />
                        {emp.status === 'active' ? '停用' : '启用'}
                      </button>

                      {/* 重置密码 */}
                      <button
                        onClick={() => resetPassword(emp)}
                        disabled={busy}
                        className={btnCls + ' disabled:opacity-50'}
                        title="重置登录密码"
                      >
                        <KeyRound size={13} />
                        改密
                      </button>

                      {/* 删除 */}
                      <button
                        onClick={() => confirmDelete(emp)}
                        disabled={busy || isSelf}
                        className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-destructive hover:text-destructive transition-base disabled:opacity-50"
                        title={isSelf ? '不能删除自己' : '删除该账号'}
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
