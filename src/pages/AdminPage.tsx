import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  MessagesSquare,
  Headset,
  BookOpen,
  TrendingUp,
  Globe,
  Download,
  Loader2,
  AlertCircle,
  Database,
  ShieldCheck,
  Archive,
  Activity,
  Users,
  FileUp,
  Filter,
  AlarmClock,
  Timer,
  Star,
  Smile,
  Bot,
  Lightbulb,
  Workflow,
  BarChart3,
  Radio,
  HeartPulse,
  Microscope,
} from 'lucide-react';
import { useAdmin } from '../hooks/useAdmin';
import { useAuth } from '../hooks/useAuth';
import { api } from '../hooks/useApi';
import type { CsatStats } from '../hooks/useApi';
import { StatCards } from '../components/StatCards';
import { IntentDonut, RatingBars, TrendArea, ChannelDonut, TierDonut, SlaPanel, ResponsePanel } from '../components/IntentChart';
import { ConversationTable } from '../components/ConversationTable';
import { TicketList } from '../components/TicketList';
import { FaqManager } from '../components/FaqManager';
import { EmployeeManager } from '../components/EmployeeManager';
import { ChannelManager } from '../components/ChannelManager';
import { DataImport } from '../components/DataImport';
import { LlmSettings } from '../components/LlmSettings';
import { InsightsPanel } from '../components/InsightsPanel';
import { KnowledgeGapPanel } from '../components/KnowledgeGapPanel';
import { WorkflowRules } from '../components/WorkflowRules';
import { ImpactDashboard } from '../components/ImpactDashboard';
import { TelemetryPanel } from '../components/TelemetryPanel';
import { DeviceHealthPanel } from '../components/DeviceHealthPanel';
import { RootCausePanel } from '../components/RootCausePanel';
import { Skeleton } from '../components/ui/Skeleton';

type Tab = 'conversations' | 'tickets' | 'faqs' | 'gaps' | 'workflow' | 'insights' | 'employees' | 'data' | 'channels' | 'ai' | 'impact' | 'telemetry' | 'health' | 'rootcause';

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分`;
  return `${sec}秒`;
}

function AdminSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-7 w-2/3" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card p-4">
            <Skeleton className="h-4 w-1/3 mb-3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="p-3 border-b border-border flex gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-4 w-1/5" />
              <Skeleton className="h-4 w-1/6" />
              <Skeleton className="h-4 w-1/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AdminPage() {
  const admin = useAdmin();
  const { hasRole, username } = useAuth();
  const [tab, setTab] = useState<Tab>('conversations');
  const [exporting, setExporting] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);

  const canManage = hasRole('admin', 'manager');

  const tabs: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    {
      id: 'conversations',
      label: '对话记录',
      icon: <MessagesSquare size={15} />,
      count: admin.pagination.total || admin.conversations.length,
    },
    { id: 'tickets', label: '工单', icon: <Headset size={15} />, count: admin.tickets.length },
    { id: 'faqs', label: '知识库', icon: <BookOpen size={15} />, count: admin.faqs.length },
    { id: 'insights', label: '洞察', icon: <TrendingUp size={15} />, count: admin.insights?.totals.questions },
  ];
  if (canManage) {
    tabs.push({ id: 'employees', label: '员工管理', icon: <Users size={15} />, count: admin.employees.length });
    tabs.push({ id: 'data', label: '数据导入', icon: <FileUp size={15} /> });
    tabs.push({ id: 'gaps', label: '知识盲区', icon: <Lightbulb size={15} /> });
    tabs.push({ id: 'workflow', label: '工作流', icon: <Workflow size={15} /> });
    tabs.push({ id: 'channels', label: '渠道接入', icon: <Globe size={15} />, count: admin.sites.length });
    tabs.push({ id: 'ai', label: '模型配置', icon: <Bot size={15} /> });
    tabs.push({ id: 'impact', label: 'AI 成效', icon: <BarChart3 size={15} /> });
    tabs.push({ id: 'telemetry', label: '设备遥测', icon: <Radio size={15} /> });
    tabs.push({ id: 'health', label: '设备健康', icon: <HeartPulse size={15} /> });
    tabs.push({ id: 'rootcause', label: '根因洞察', icon: <Microscope size={15} /> });
  }

  const visibleTickets = mineOnly && username ? admin.tickets.filter((t) => t.assignee === username) : admin.tickets;

  /* CSAT 满意度问卷聚合（独立拉取，避免与看板聚合耦合） */
  const [csat, setCsat] = useState<CsatStats | null>(null);
  const [csatLoading, setCsatLoading] = useState(false);
  const loadCsat = useCallback(async () => {
    setCsatLoading(true);
    try {
      setCsat(await api.getCsat());
    } catch {
      /* 401 由全局拦截，这里静默 */
    } finally {
      setCsatLoading(false);
    }
  }, []);
  useEffect(() => {
    loadCsat();
  }, [loadCsat]);

  /* AI 成效看板 + 设备遥测看板（管理后台专属，需 canManage） */
  const [impact, setImpact] = useState<import('../types').ImpactData | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [telemetry, setTelemetry] = useState<{ total: number; anomalies: number; recent: import('../types').DeviceTelemetry[] } | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const loadImpact = useCallback(async () => {
    setImpactLoading(true);
    try {
      setImpact(await api.getImpact());
    } catch {
      /* 401 全局拦截，静默 */
    } finally {
      setImpactLoading(false);
    }
  }, []);
  const loadTelemetry = useCallback(async () => {
    setTelemetryLoading(true);
    try {
      setTelemetry(await api.getTelemetry(100));
    } catch {
      /* 401 全局拦截，静默 */
    } finally {
      setTelemetryLoading(false);
    }
  }, []);
  useEffect(() => {
    if (canManage) {
      loadImpact();
      loadTelemetry();
    }
  }, [canManage, loadImpact, loadTelemetry]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await admin.exportConversations();
    } catch {
      admin.loadAll(); // 401 已被全局拦截，这里仅兜底
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6">
        {/* 页头 */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-accent text-accent-foreground flex items-center justify-center shrink-0">
              <LayoutDashboard size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold truncate">管理后台</h1>
              <p className="text-xs text-muted-foreground">对话记录 · 满意度统计 · 工单与知识库</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <button
              onClick={handleExport}
              disabled={exporting || tab !== 'conversations'}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50 disabled:hover:border-border"
              title="导出当前筛选条件下的对话记录（CSV）"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
            <button
              onClick={() => admin.loadAll()}
              disabled={admin.loading}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
              title="刷新数据"
            >
              <RefreshCw size={14} className={admin.loading ? 'animate-spin' : ''} /> 刷新
            </button>
            <button
              onClick={async () => {
                if (confirm('确认重置为演示数据？当前所有数据将被清空。')) await admin.resetDemo();
              }}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-destructive hover:text-destructive transition-base"
            >
              <RotateCcw size={14} /> 重置演示数据
            </button>
          </div>
        </div>

        {admin.error && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-sm px-4 py-3 animate-fade-in">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{admin.error}</span>
          </div>
        )}

        {admin.loading ? (
          <AdminSkeleton />
        ) : (
          <>
            {/* 统计卡片 */}
            {admin.stats && <StatCards stats={admin.stats} />}

            {/* 图表区 */}
            {admin.stats && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3">意图分布</h3>
                  <IntentDonut data={admin.stats.intentDistribution} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3">评分分布</h3>
                  <RatingBars data={admin.stats.ratingDistribution} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <TrendingUp size={15} className="text-accent" /> 每日会话趋势
                  </h3>
                  <TrendArea data={admin.stats.dailyTrend} />
                </div>
              </div>
            )}

            {/* 运营看板：渠道 / 客户等级 / SLA / 响应时延 */}
            {admin.stats && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3">渠道分布</h3>
                  <ChannelDonut data={admin.stats.channelDistribution} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3">客户等级分布</h3>
                  <TierDonut data={admin.stats.customerTierDistribution} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <AlarmClock size={15} className="text-accent" /> 工单 SLA
                  </h3>
                  <SlaPanel sla={admin.stats.ticketSla} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <Timer size={15} className="text-accent" /> 首次响应时延
                  </h3>
                  <ResponsePanel rt={admin.stats.responseTimes} />
                </div>
              </div>
            )}

            {/* Tab 切换 */}
            <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-base whitespace-nowrap max-sm:min-h-[44px] ${
                    tab === t.id
                      ? 'border-accent text-accent'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.icon}
                  {t.label}
                  {t.count != null && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab 内容 */}
            <div key={tab} className="animate-fade-in">
              {tab === 'conversations' && (
                <ConversationTable
                  conversations={admin.conversations}
                  filters={admin.filters}
                  onFilter={admin.applyFilters}
                  pagination={admin.pagination}
                  onPageChange={admin.changePage}
                />
              )}
              {tab === 'tickets' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setMineOnly((v) => !v)}
                      className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 min-h-[40px] rounded-lg border transition-base ${
                        mineOnly
                          ? 'border-accent text-accent bg-accent-light'
                          : 'border-border text-muted-foreground hover:border-accent hover:text-accent'
                      }`}
                      title={username ? `仅显示分配给 @${username} 的工单` : '仅显示我负责的工单'}
                    >
                      <Filter size={13} /> 只看我负责
                    </button>
                    {mineOnly && (
                      <span className="text-xs text-muted-foreground">
                        共 {visibleTickets.length} 条（分配给 @
                        {username}）
                      </span>
                    )}
                  </div>
                  <TicketList tickets={visibleTickets} onUpdate={admin.updateTicket} employees={admin.employees} />
                </div>
              )}
              {tab === 'faqs' && <FaqManager faqs={admin.faqs} onAdd={admin.addFaq} onDelete={admin.removeFaq} />}
              {tab === 'gaps' && <KnowledgeGapPanel />}
              {tab === 'workflow' && <WorkflowRules />}
              {tab === 'insights' && <InsightsPanel data={admin.insights} />}
              {tab === 'employees' && (
                <EmployeeManager
                  employees={admin.employees}
                  loading={admin.employeesLoading}
                  error={admin.employeesError}
                  currentUsername={username}
                  onCreate={admin.createEmployee}
                  onUpdate={admin.updateEmployee}
                  onDelete={admin.deleteEmployee}
                  onReload={admin.loadEmployees}
                />
              )}
              {tab === 'data' && <DataImport onImport={admin.importFaqs} />}
              {tab === 'channels' && (
                <ChannelManager
                  sites={admin.sites}
                  loading={admin.sitesLoading}
                  error={admin.sitesError}
                  onCreate={admin.createSite}
                  onUpdate={admin.updateSite}
                  onDelete={admin.deleteSite}
                  onReload={admin.loadSites}
                />
              )}
              {tab === 'ai' && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <Bot size={16} className="text-accent" />
                    <h3 className="text-sm font-medium">大模型配置</h3>
                    <span className="text-xs text-muted-foreground">模型类型 · API 密钥 · 温度 · 最大回复长度 · 系统提示词</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    此处配置将实时生效于全渠道 AI 客服（web / 嵌入 / 邮件 / IM）。改动保存后无需重启服务。
                  </p>
                  <LlmSettings />
                </div>
              )}
              {tab === 'impact' && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <BarChart3 size={16} className="text-accent" />
                    <h3 className="text-sm font-medium">AI 成效看板</h3>
                    <span className="text-xs text-muted-foreground">自助解决率 · 副驾驶采纳率 · 工作流自动执行率 · 知识盲区收敛率</span>
                    <button
                      onClick={loadImpact}
                      disabled={impactLoading}
                      className="ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] max-sm:min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                      title="刷新成效数据"
                    >
                      <RefreshCw size={13} className={impactLoading ? 'animate-spin' : ''} /> 刷新
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    把企业知识助手 / 工作流自动化 / AI 副驾驶三大支柱的「能力」转化为「可量化的商业价值」。
                  </p>
                  {impact ? (
                    <ImpactDashboard data={impact} />
                  ) : impactLoading ? (
                    <Skeleton className="h-40 w-full" />
                  ) : (
                    <p className="text-sm text-muted-foreground">成效数据加载中…</p>
                  )}
                </div>
              )}
              {tab === 'telemetry' && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <Radio size={16} className="text-accent" />
                    <h3 className="text-sm font-medium">设备遥测看板</h3>
                    <span className="text-xs text-muted-foreground">端侧遥测异常 → 自动建单 / 升级 / 通知（端云协同）</span>
                    <button
                      onClick={loadTelemetry}
                      disabled={telemetryLoading}
                      className="ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] max-sm:min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                      title="刷新遥测数据"
                    >
                      <RefreshCw size={13} className={telemetryLoading ? 'animate-spin' : ''} /> 刷新
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    贴合无人机反制 / IoT 主题：设备周期上报遥测快照，异常命中即自动建工单并触发智能升级。
                  </p>
                  {telemetry ? (
                    <TelemetryPanel data={telemetry} onMutate={loadTelemetry} />
                  ) : telemetryLoading ? (
                    <Skeleton className="h-40 w-full" />
                  ) : (
                    <p className="text-sm text-muted-foreground">遥测数据加载中…</p>
                  )}
                </div>
              )}
              {tab === 'health' && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <HeartPulse size={16} className="text-accent" />
                    <h3 className="text-sm font-medium">设备健康度看板</h3>
                    <span className="text-xs text-muted-foreground">遥测聚合 → 健康分 / 趋势 / 维护建议（预测性维护）</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    把逐条异常上报聚合成每台设备的健康分，越近的异常权重越高；排序即售后作业队列，最需要关注的排最前。
                  </p>
                  <DeviceHealthPanel />
                </div>
              )}
              {tab === 'rootcause' && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <Microscope size={16} className="text-accent" />
                    <h3 className="text-sm font-medium">工单根因洞察</h3>
                    <span className="text-xs text-muted-foreground">反复出现的根因 + 类型判定 + 可执行建议</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    从历史工单里挖出客户反复来找我们的真正原因，并判定该补知识库、该查批次还是该改流程。
                  </p>
                  <RootCausePanel />
                </div>
              )}
            </div>

            {/* 数据管理 */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
              <div className="flex items-center gap-2 mb-4">
                <Database size={16} className="text-accent" />
                <h3 className="text-sm font-medium">数据管理</h3>
                {admin.dbMeta && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    库体积 {formatBytes(admin.dbMeta.totalBytes)} · schema v{admin.dbMeta.schemaVersion} · {admin.dbMeta.journalMode}
                  </span>
                )}
              </div>

              {admin.dbError && (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-sm px-4 py-3 mb-4">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{admin.dbError}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => admin.backupDb()}
                  disabled={admin.dbBusy.backup}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="下载数据库一致性快照（含 WAL 刷盘）"
                >
                  {admin.dbBusy.backup ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {admin.dbBusy.backup ? '备份中…' : '备份数据库'}
                </button>
                <button
                  onClick={() => admin.checkIntegrity()}
                  disabled={admin.dbBusy.integrity}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="执行 integrity_check 与 foreign_key_check"
                >
                  {admin.dbBusy.integrity ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {admin.dbBusy.integrity ? '自检中…' : '完整性自检'}
                </button>
                <button
                  onClick={async () => {
                    if (confirm('执行 VACUUM 将重建数据库文件以回收空闲空间，大库会短暂占用 IO，确认继续？')) await admin.vacuumDb();
                  }}
                  disabled={admin.dbBusy.vacuum}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="回收已删除数据占用的磁盘空间"
                >
                  {admin.dbBusy.vacuum ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                  {admin.dbBusy.vacuum ? '回收中…' : '回收空间'}
                </button>
              </div>

              {admin.integrity && (
                <div
                  className={`mt-4 rounded-xl border px-4 py-3 text-sm animate-fade-in ${
                    admin.integrity.ok ? 'border-success/40 bg-success/10 text-success' : 'border-destructive/40 bg-destructive/10 text-destructive'
                  }`}
                >
                  {admin.integrity.ok ? (
                    <p>完整性自检通过：无结构损坏、无外键孤儿记录。</p>
                  ) : (
                    <p>检测到问题：{admin.integrity.integrity.join('；')}</p>
                  )}
                  {admin.integrity.foreignKeyIssues.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 space-y-1 text-xs">
                      {admin.integrity.foreignKeyIssues.slice(0, 5).map((f, i) => (
                        <li key={i}>
                          {f.table} (rowid={f.rowid}) 引用 {f.parent} 缺失
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-muted-foreground">
                    {Object.entries(admin.integrity.tableCounts).map(([t, c]) => (
                      <span key={t}>
                        {t}: <span className="text-foreground">{c}</span> 行
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 运行概览（实时指标，每 15s 自动刷新） */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
              <div className="flex items-center gap-2 mb-4">
                <Activity size={16} className="text-accent" />
                <h3 className="text-sm font-medium">运行概览</h3>
                <span className="text-xs text-muted-foreground">实时指标 · 15s 自动刷新</span>
                <button
                  onClick={() => admin.exportPrometheus()}
                  disabled={admin.promBusy}
                  className="ml-auto sm:ml-3 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] max-sm:min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="导出 Prometheus 指标文本（.prom）"
                >
                  <Download size={13} className={admin.promBusy ? 'animate-spin' : ''} />
                  导出 Prometheus
                </button>
                <button
                  onClick={() => admin.refreshMetrics()}
                  disabled={admin.metricsLoading}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] max-sm:min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="立即刷新指标"
                >
                  <RefreshCw size={13} className={admin.metricsLoading ? 'animate-spin' : ''} />
                  刷新
                </button>
              </div>

              {admin.metrics ? (
                (() => {
                  const m = admin.metrics!;
                  const tiles: Array<{ label: string; value: string; tone: string }> = [
                    { label: '运行时长', value: formatUptime(m.uptimeSec), tone: 'text-foreground' },
                    { label: '累计请求', value: m.total.toLocaleString(), tone: 'text-foreground' },
                    {
                      label: '错误率',
                      value: `${(m.errorRate * 100).toFixed(2)}%`,
                      tone: m.errors > 0 ? 'text-destructive' : 'text-success',
                    },
                    { label: '平均时延', value: `${m.avgLatencyMs}ms`, tone: 'text-foreground' },
                    { label: 'P95 时延', value: `${m.p95LatencyMs}ms`, tone: 'text-foreground' },
                    { label: 'P99 时延', value: `${m.p99LatencyMs}ms`, tone: m.p99LatencyMs > 3000 ? 'text-warning' : 'text-foreground' },
                  ];
                  return (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        {tiles.map((t) => (
                          <div key={t.label} className="rounded-xl border border-border bg-background/40 p-3">
                            <div className="text-xs text-muted-foreground">{t.label}</div>
                            <div className={`mt-1 text-lg font-semibold ${t.tone}`}>{t.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* 知识库检索缓存（KB LRU 命中率，区别于答案命中率） */}
                      {m.kbCache && (
                        <div className="mt-3">
                          <div className="text-xs text-muted-foreground mb-2">
                            知识库检索缓存（LRU 命中收益，区别于答案命中率）
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">缓存命中率</div>
                              <div className="mt-1 text-lg font-semibold text-accent">{m.kbCache.hitRate}%</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">缓存命中数</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">{m.kbCache.hits.toLocaleString()}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">缓存未命中</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">{m.kbCache.misses.toLocaleString()}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">缓存条目</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {m.kbCache.lruSize} <span className="text-xs text-muted-foreground">/ {m.kbCache.lruMax}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* RAG 检索增强（同义词扩展召回 + 可选语义向量融合） */}
                      {m.rag && (
                        <div className="mt-3">
                          <div className="text-xs text-muted-foreground mb-2">
                            RAG 检索增强（同义词扩展召回 + 可选语义向量融合）
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">检索调用数</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">{m.rag.retrievals.toLocaleString()}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">同义词扩展命中</div>
                              <div className="mt-1 text-lg font-semibold text-accent">{m.rag.expanded.toLocaleString()}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">语义融合使用</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">{m.rag.semanticUsed.toLocaleString()}</div>
                            </div>
                            <div className="rounded-xl border border-border bg-background/40 p-3">
                              <div className="text-xs text-muted-foreground">语义检索开关</div>
                              <div className="mt-1 text-lg font-semibold text-foreground">{m.rag.semantic ? '已启用' : '未配置'}</div>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()
              ) : admin.metricsLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <p className="text-sm text-muted-foreground">指标加载中…</p>
              )}
            </div>

            {/* 客户满意度（CSAT）看板 */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 animate-fade-in">
              <div className="flex items-center gap-2 mb-4">
                <Smile size={16} className="text-accent" />
                <h3 className="text-sm font-medium">客户满意度（CSAT）</h3>
                <span className="text-xs text-muted-foreground">问卷回收与评分分布</span>
                <button
                  onClick={loadCsat}
                  disabled={csatLoading}
                  className="ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] max-sm:min-h-[40px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                  title="刷新满意度数据"
                >
                  <RefreshCw size={13} className={csatLoading ? 'animate-spin' : ''} />
                  刷新
                </button>
              </div>

              {csat ? (
                <>
                  {/* 概览瓦片 */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    <div className="rounded-xl border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">平均评分</div>
                      <div className="mt-1 text-lg font-semibold text-accent">
                        {csat.avgRating > 0 ? `${csat.avgRating} / 5` : '—'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">回收率</div>
                      <div className="mt-1 text-lg font-semibold text-foreground">{csat.responseRate}%</div>
                    </div>
                    <div className="rounded-xl border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">NPS 近似</div>
                      <div className="mt-1 text-lg font-semibold text-foreground">{csat.npsLike}%</div>
                    </div>
                    <div className="rounded-xl border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">已回收 / 派发</div>
                      <div className="mt-1 text-lg font-semibold text-foreground">
                        {csat.responded} <span className="text-xs text-muted-foreground">/ {csat.total}</span>
                      </div>
                    </div>
                    <div className="rounded-xl border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">待回收</div>
                      <div className="mt-1 text-lg font-semibold text-foreground">{csat.pending}</div>
                    </div>
                  </div>

                  {/* 评分分布 + 渠道分布 */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">评分分布（1-5 星）</div>
                      <div className="space-y-1.5">
                        {[5, 4, 3, 2, 1].map((r) => {
                          const item = csat.ratingDistribution.find((d) => d.rating === r);
                          const count = item?.count || 0;
                          const max = Math.max(1, ...csat.ratingDistribution.map((d) => d.count));
                          const pct = (count / max) * 100;
                          const tone =
                            r >= 4 ? 'bg-success' : r === 3 ? 'bg-accent' : 'bg-destructive';
                          return (
                            <div key={r} className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground w-10 shrink-0 flex items-center gap-0.5">
                                {r} <Star size={10} className="fill-amber-400 text-amber-400" />
                              </span>
                              <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-xs text-muted-foreground w-8 text-right">{count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">渠道回收</div>
                      <div className="space-y-2">
                        {csat.byChannel.length === 0 && (
                          <p className="text-xs text-muted-foreground">暂无派发记录</p>
                        )}
                        {csat.byChannel.map((c) => (
                          <div key={c.channel} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground capitalize">{c.channel}</span>
                            <span className="text-foreground">
                              {c.responded} / {c.total}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 近期评价 */}
                  {csat.recent.length > 0 && (
                    <div className="mt-4">
                      <div className="text-xs text-muted-foreground mb-2">近期评价</div>
                      <div className="space-y-2 max-h-56 overflow-y-auto">
                        {csat.recent.slice(0, 8).map((row) => (
                          <div key={row.token} className="rounded-xl border border-border bg-background/40 p-3">
                            <div className="flex items-center gap-2">
                              <span className="flex items-center gap-0.5">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <Star
                                    key={n}
                                    size={12}
                                    className={n <= (row.rating || 0) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}
                                  />
                                ))}
                              </span>
                              <span className="text-xs text-muted-foreground capitalize">{row.channel}</span>
                              {row.responded_at && (
                                <span className="text-xs text-muted-foreground ml-auto">
                                  {row.responded_at.slice(0, 10)}
                                </span>
                              )}
                            </div>
                            {row.comment && (
                              <p className="text-sm text-foreground mt-1.5 break-words">{row.comment}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : csatLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <p className="text-sm text-muted-foreground">满意度数据加载中…</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
