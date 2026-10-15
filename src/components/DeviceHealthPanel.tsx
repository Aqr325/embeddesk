import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Gauge,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wrench,
} from 'lucide-react';
import { api } from '../hooks/useApi';
import { DEVICE_RISK_LABELS, HEALTH_TREND_LABELS } from '../types';
import type { DeviceHealth, DeviceHealthData, DeviceRiskLevel } from '../types';

/** 风险等级 → 样式（浅色主题：低饱和底色 + 深色文字，保证对比度） */
const RISK_STYLE: Record<DeviceRiskLevel, { chip: string; bar: string; text: string }> = {
  healthy: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', text: 'text-emerald-700' },
  watch: { chip: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-500', text: 'text-amber-700' },
  at_risk: { chip: 'bg-orange-50 text-orange-700 border-orange-200', bar: 'bg-orange-500', text: 'text-orange-700' },
  critical: { chip: 'bg-rose-50 text-rose-700 border-rose-200', bar: 'bg-rose-500', text: 'text-rose-700' },
};

const TREND_ICON = {
  improving: <TrendingUp size={13} className="text-emerald-600" />,
  stable: <ChevronRight size={13} className="text-slate-400" />,
  declining: <TrendingDown size={13} className="text-rose-600" />,
};

function HealthBar({ value }: { value: number }) {
  const level: DeviceRiskLevel = value < 40 ? 'critical' : value < 60 ? 'at_risk' : value < 80 ? 'watch' : 'healthy';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${RISK_STYLE[level].bar}`} style={{ width: `${Math.max(2, value)}%` }} />
      </div>
      <span className={`text-xs font-semibold tabular-nums ${RISK_STYLE[level].text}`}>{value}</span>
    </div>
  );
}

/**
 * 设备健康度看板（预测性维护）
 *
 * 把端侧遥测历史聚合成每台设备的健康分 / 趋势 / 维护建议，
 * 排序规则「最需要关注的排最前」，直接对应售后工程师的作业队列。
 */
export function DeviceHealthPanel() {
  const [data, setData] = useState<DeviceHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getDeviceHealth());
    } catch (e) {
      setError((e as Error)?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <RefreshCw size={14} className="animate-spin" /> 正在聚合设备健康度…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        加载失败：{error}
        <button onClick={() => void load()} className="ml-2 underline">重试</button>
      </div>
    );
  }

  const d = data;
  if (!d || d.source === 'empty' || !d.devices.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
        <Cpu size={28} className="mx-auto mb-3 text-slate-400" />
        <p className="text-sm text-muted-foreground">暂无设备遥测数据</p>
        <p className="mt-1 text-xs text-muted-foreground">
          设备上报遥测后，这里会聚合成健康分、趋势与维护建议（预测性维护）
        </p>
      </div>
    );
  }

  const s = d.summary;
  const needsAttention = d.devices.filter((x) => x.riskLevel === 'at_risk' || x.riskLevel === 'critical');

  return (
    <div className="space-y-4">
      {/* 顶部说明 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-start gap-2">
          <Gauge size={16} className="mt-0.5 shrink-0 text-indigo-600" />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">设备健康度评分引擎</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              把逐条端侧遥测聚合成每台设备的健康分（0-100）与趋势：越近的异常惩罚越重，
              能识别「正在恶化」的设备，让售后从坏了再修变成坏之前介入。
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {/* 汇总瓦片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="设备总数" value={s.totalDevices} tone="slate" />
        <Tile label="平均健康分" value={s.avgHealth} tone="indigo" />
        <Tile label="健康" value={s.healthy} tone="emerald" />
        <Tile label="观察" value={s.watch} tone="amber" />
        <Tile label="风险" value={s.atRisk} tone="orange" />
        <Tile label="危急" value={s.critical} tone="rose" />
      </div>

      {/* 需关注设备提示 */}
      {needsAttention.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>{needsAttention.length}</strong> 台设备需要介入（
            {needsAttention.filter((x) => x.trend === 'declining').length} 台正在恶化），建议按下方队列派单巡检。
          </span>
        </div>
      )}

      {/* 设备队列（最需关注在前） */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">设备</th>
              <th className="px-4 py-2.5 text-left font-medium">型号 / 产品</th>
              <th className="px-4 py-2.5 text-left font-medium">健康分</th>
              <th className="px-4 py-2.5 text-left font-medium">等级</th>
              <th className="px-4 py-2.5 text-left font-medium">趋势</th>
              <th className="px-4 py-2.5 text-left font-medium">上报 / 异常</th>
              <th className="px-4 py-2.5 text-left font-medium">维护建议</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.devices.map((dev) => (
              <tr key={dev.deviceId} className="hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{dev.deviceId}</div>
                  {dev.hasOpenTicket && (
                    <span className="mt-0.5 inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                      已有未结工单
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {dev.model || '—'}
                  <div className="text-[11px] text-slate-400">{dev.product || ''}</div>
                </td>
                <td className="px-4 py-3"><HealthBar value={dev.health} /></td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${RISK_STYLE[dev.riskLevel].chip}`}>
                    {DEVICE_RISK_LABELS[dev.riskLevel]}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                    {TREND_ICON[dev.trend]} {HEALTH_TREND_LABELS[dev.trend]}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                  {dev.reportCount} 次
                  <span className="text-rose-600"> / {dev.anomalyCount} 异常</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-start gap-1.5 text-xs text-slate-600">
                    <Wrench size={12} className="mt-0.5 shrink-0 text-slate-400" />
                    <span className="leading-relaxed">{dev.recommendation}</span>
                  </div>
                  {dev.lastAnomalyReason && (
                    <div className="mt-1 text-[11px] text-slate-400">最近异常：{dev.lastAnomalyReason}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 评分规则说明 */}
      <details className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-slate-600">评分规则（确定性，可现场复现）</summary>
        <ul className="mt-2 space-y-1 leading-relaxed">
          <li>• 基准分 100；每条异常上报按「距现在第几条」衰减扣分：14/12/10…最低 4 分/条</li>
          <li>• 一条上报含多个异常项，每多一项追加 3 分；「设备离线」追加 6 分</li>
          <li>• 等级：≥80 健康 / 60-79 观察 / 40-59 风险 / &lt;40 危急</li>
          <li>• 趋势：最近 3 条上报算出的分数高于/低于全周期 3 分以上 → 改善中 / 恶化中</li>
        </ul>
      </details>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 bg-white text-slate-800',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    orange: 'border-orange-200 bg-orange-50 text-orange-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tones[tone] || tones.slate}`}>
      <div className="flex items-center gap-1.5 text-[11px] opacity-80">
        {tone === 'emerald' && <CheckCircle2 size={11} />}
        {tone === 'rose' && <AlertTriangle size={11} />}
        {tone === 'indigo' && <Activity size={11} />}
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
