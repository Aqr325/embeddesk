/** useAdmin —— 管理后台数据聚合层（含分页与导出） */
import { useCallback, useEffect, useState } from 'react';
import type { DashboardStats, ConversationRow, Ticket, Faq } from '../types';
import { api, type DbMeta, type DbIntegrity, type MetricsSnapshot, type Employee, type EmployeeRole, type EmployeeStatus, type Site } from './useApi';

export interface AdminFilters {
  status: string;
  intent: string;
  keyword: string;
  channel: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

export function useAdmin() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [faqs, setFaqs] = useState<Faq[]>([]);

  // 员工 / 坐席管理
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeesError, setEmployeesError] = useState<string | null>(null);

  // 接入站点（嵌入渠道）
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AdminFilters>({ status: '', intent: '', keyword: '', channel: '' });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 数据管理面板状态
  const [dbMeta, setDbMeta] = useState<DbMeta | null>(null);
  const [integrity, setIntegrity] = useState<DbIntegrity | null>(null);
  const [dbBusy, setDbBusy] = useState<{ meta: boolean; integrity: boolean; vacuum: boolean; backup: boolean }>({
    meta: false,
    integrity: false,
    vacuum: false,
    backup: false,
  });
  const [dbError, setDbError] = useState<string | null>(null);

  // 运行概览（实时指标，后台自动轮询）
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [promBusy, setPromBusy] = useState(false);

  const loadStats = useCallback(async () => {
    const s = await api.adminStats();
    setStats(s);
  }, []);

  const loadConversations = useCallback(
    async (nextFilters: AdminFilters, page = 1) => {
      const r = await api.adminConversations({ ...nextFilters, page, pageSize: pagination.pageSize });
      setConversations(r.conversations);
      setPagination({ page: r.page, pageSize: r.pageSize, total: r.total });
    },
    [pagination.pageSize],
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c, t, f, m] = await Promise.all([
        api.adminStats(),
        api.adminConversations({ page: 1, pageSize: 20 }),
        api.getTickets(),
        api.getFaqs(),
        api.dbMeta(),
      ]);
      setStats(s);
      setConversations(c.conversations);
      setPagination({ page: c.page, pageSize: c.pageSize, total: c.total });
      setTickets(t.tickets);
      setFaqs(f.faqs);
      setDbMeta(m);
    } catch (e: any) {
      setError(e?.message || '加载管理数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const applyFilters = useCallback(
    async (next: AdminFilters) => {
      setFilters(next);
      try {
        await loadConversations(next, 1);
      } catch (e: any) {
        setError(e?.message || '筛选失败');
      }
    },
    [loadConversations],
  );

  const changePage = useCallback(
    async (page: number) => {
      try {
        await loadConversations(filters, page);
      } catch (e: any) {
        setError(e?.message || '翻页失败');
      }
    },
    [filters, loadConversations],
  );

  const exportConversations = useCallback(async () => {
    const csv = await api.exportConversations(filters);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversations-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return csv;
  }, [filters]);

  const updateTicket = useCallback(
    async (id: string, patch: Partial<Pick<Ticket, 'status' | 'assignee' | 'note' | 'priority'>>) => {
      await api.updateTicket(id, patch);
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [],
  );

  const addFaq = useCallback(
    async (data: { category: string; question: string; answer: string; keywords?: string }) => {
      const { faq } = await api.createFaq(data);
      setFaqs((prev) => [faq, ...prev]);
    },
    [],
  );

  const removeFaq = useCallback(async (id: string) => {
    await api.deleteFaq(id);
    setFaqs((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /* ---------- 员工 / 坐席管理 ---------- */
  const loadEmployees = useCallback(async () => {
    setEmployeesLoading(true);
    setEmployeesError(null);
    try {
      const r = await api.getEmployees();
      setEmployees(r.employees);
    } catch (e: any) {
      setEmployeesError(e?.message || '加载员工列表失败');
    } finally {
      setEmployeesLoading(false);
    }
  }, []);

  const createEmployee = useCallback(
    async (data: { username: string; display_name?: string; role: EmployeeRole; password: string }) => {
      const { employee } = await api.createEmployee(data);
      setEmployees((prev) => [...prev, employee]);
      return employee;
    },
    [],
  );

  const updateEmployee = useCallback(
    async (id: string, patch: { role?: EmployeeRole; status?: EmployeeStatus; display_name?: string; password?: string }) => {
      const { employee } = await api.updateEmployee(id, patch);
      setEmployees((prev) => prev.map((e) => (e.id === id ? employee : e)));
      return employee;
    },
    [],
  );

  // 加载员工/坐席列表（供「员工管理」「工单分配」使用；无权限时由 API 返回 403，仅影响该面板）
  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  const deleteEmployee = useCallback(async (id: string) => {
    await api.deleteEmployee(id);
    setEmployees((prev) => prev.filter((e) => e.id !== id));
  }, []);

  /* ---------- 接入站点（嵌入渠道） ---------- */
  const loadSites = useCallback(async () => {
    setSitesLoading(true);
    setSitesError(null);
    try {
      const r = await api.getSites();
      setSites(r.sites);
    } catch (e: any) {
      setSitesError(e?.message || '加载接入站点失败');
    } finally {
      setSitesLoading(false);
    }
  }, []);

  /** 创建站点：返回含 embed_token 的完整信息（用于生成嵌入码）；同步写入本地列表（仅含公开字段） */
  const createSite = useCallback(async (data: { name: string; domain?: string }) => {
    const { site } = await api.createSite(data);
    setSites((prev) => [{ ...site, embed_token: undefined, session_count: 0 }, ...prev]);
    return site;
  }, []);

  const updateSite = useCallback(async (id: string, patch: { name?: string; domain?: string; status?: 'active' | 'disabled' }) => {
    const { site } = await api.updateSite(id, patch);
    setSites((prev) => prev.map((s) => (s.id === id ? { ...s, ...site, embed_token: undefined } : s)));
    return site;
  }, []);

  const deleteSite = useCallback(async (id: string) => {
    await api.deleteSite(id);
    setSites((prev) => prev.filter((s) => s.id !== id));
  }, []);

  // 加载接入站点列表（供「渠道接入」使用；无权限时由 API 返回 403，仅影响该面板）
  useEffect(() => {
    loadSites();
  }, [loadSites]);

  /** 批量导入 FAQ（CSV / JSON） */
  const importFaqs = useCallback(async (format: 'json' | 'csv', data: unknown) => {
    return api.importFaqs(format, data);
  }, []);

  const resetDemo = useCallback(async () => {
    await api.resetDemo();
    await loadAll();
  }, [loadAll]);

  const loadDbMeta = useCallback(async () => {
    setDbBusy((b) => ({ ...b, meta: true }));
    setDbError(null);
    try {
      setDbMeta(await api.dbMeta());
    } catch (e: any) {
      setDbError(e?.message || '获取数据库信息失败');
    } finally {
      setDbBusy((b) => ({ ...b, meta: false }));
    }
  }, []);

  const checkIntegrity = useCallback(async () => {
    setDbBusy((b) => ({ ...b, integrity: true }));
    setDbError(null);
    try {
      setIntegrity(await api.dbIntegrity());
    } catch (e: any) {
      setDbError(e?.message || '完整性自检失败');
    } finally {
      setDbBusy((b) => ({ ...b, integrity: false }));
    }
  }, []);

  const vacuumDb = useCallback(async () => {
    setDbBusy((b) => ({ ...b, vacuum: true }));
    setDbError(null);
    try {
      const r = await api.dbVacuum();
      setDbMeta(await api.dbMeta());
      return r;
    } catch (e: any) {
      setDbError(e?.message || '空间回收失败');
      return null;
    } finally {
      setDbBusy((b) => ({ ...b, vacuum: false }));
    }
  }, []);

  const backupDb = useCallback(async () => {
    setDbBusy((b) => ({ ...b, backup: true }));
    setDbError(null);
    try {
      await api.dbBackup();
    } catch (e: any) {
      setDbError(e?.message || '备份失败');
    } finally {
      setDbBusy((b) => ({ ...b, backup: false }));
    }
  }, []);

  const refreshMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      setMetrics(await api.getMetrics());
    } catch {
      // 非致命：指标不可用不阻塞后台其它功能，保留上一次快照
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  // 运行概览自动轮询（每 15s 刷新一次，组件卸载时清理）
  useEffect(() => {
    refreshMetrics();
    const id = setInterval(refreshMetrics, 15000);
    return () => clearInterval(id);
  }, [refreshMetrics]);

  /** 拉取 Prometheus text exposition 并触发浏览器下载 */
  const exportPrometheus = useCallback(async () => {
    setPromBusy(true);
    try {
      const text = await api.getPrometheus();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `csa-metrics-${new Date().toISOString().slice(0, 10)}.prom`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || 'Prometheus 指标导出失败');
    } finally {
      setPromBusy(false);
    }
  }, []);

  return {
    stats,
    conversations,
    tickets,
    faqs,
    filters,
    pagination,
    loading,
    error,
    dbMeta,
    integrity,
    dbBusy,
    dbError,
    loadAll,
    loadStats,
    applyFilters,
    changePage,
    exportConversations,
    updateTicket,
    addFaq,
    removeFaq,
    resetDemo,
    loadDbMeta,
    checkIntegrity,
    vacuumDb,
    backupDb,
    metrics,
    metricsLoading,
    refreshMetrics,
    promBusy,
    exportPrometheus,
    // 员工 / 坐席管理
    employees,
    employeesLoading,
    employeesError,
    loadEmployees,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    importFaqs,
    // 接入站点（嵌入渠道）
    sites,
    sitesLoading,
    sitesError,
    loadSites,
    createSite,
    updateSite,
    deleteSite,
  };
}
