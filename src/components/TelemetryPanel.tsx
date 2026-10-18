/**
 * TelemetryPanel —— 端侧遥测异常看板
 *
 * 贴合「无人机反制 / IoT」主题：设备端周期上报遥测快照，服务端按产品阈值做异常检测，
 * 命中即自动建工单 + 智能升级 + 通知（端云协同、主动运维）。此处展示遥测流水，
 * 并提供「模拟设备异常上报」一键演示，现场验证「异常 → 自动建单」闭环。
 */
import { useState } from 'react';
import { Cpu, AlertTriangle, CheckCircle2, Radio, Ticket as TicketIcon, Loader2, Zap } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import type { DeviceTelemetry } from '../types';

interface TelemetryData {
  total: number;
  anomalies: number;
  recent: DeviceTelemetry[];
}

function prettySnapshot(snapshot: string | null): string {
  if (!snapshot) return '—';
  try {
    return JSON.stringify(JSON.parse(snapshot), null, 2);
  } catch {
    return snapshot;
  }
}

const DEMO_PRODUCTS = ['DJ8341', 'SDJ800', 'DJ500', 'default'];

export function TelemetryPanel({ data, onMutate }: { data: TelemetryData; onMutate?: () => void }) {
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const simulate = async () => {
    setSending(true);
    try {
      const product = DEMO_PRODUCTS[Math.floor(Math.random() * DEMO_PRODUCTS.length)];
      const deviceId = `DEMO-${Math.floor(1000 + Math.random() * 9000)}`;
      const snapshot = {
        temperature: 88 + Math.floor(Math.random() * 15), // 触发温度阈值
        voltage: 10 + Math.random() * 8,
        signal: -95 - Math.floor(Math.random() * 20),
        online: true,
        uptimeSec: 3600 + Math.floor(Math.random() * 7200),
      };
      await fetch(API_BASE + '/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, product, snapshot }),
      });
      onMutate?.();
    } catch {
      /* 忽略：演示按钮不影响主流程 */
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* 概览 + 演示触发 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
          <Radio size={15} className="text-accent" />
          <div>
            <div className="text-xs text-muted-foreground">上报总量</div>
            <div className="text-lg font-semibold tabular-nums">{data.total}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
          <AlertTriangle size={15} className="text-destructive" />
          <div>
            <div className="text-xs text-muted-foreground">异常命中</div>
            <div className="text-lg font-semibold tabular-nums text-destructive">{data.anomalies}</div>
          </div>
        </div>
        <button
          onClick={simulate}
          disabled={sending}
          className="ml-auto inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
          title="模拟一次设备遥测异常上报，验证自动建单闭环"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          {sending ? '上报中…' : '模拟设备异常上报'}
        </button>
      </div>

      {/* 遥测流水 */}
      {data.recent.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center text-sm text-muted-foreground">
          暂无设备遥测数据。点击右上角「模拟设备异常上报」体验端云协同的自动建单闭环。
        </div>
      ) : (
        <div className="space-y-2">
          {data.recent.map((t) => {
            const isOpen = expanded === t.id;
            return (
              <div key={t.id} className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : t.id)}
                  className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-muted/40 transition-base"
                >
                  {t.anomaly ? (
                    <AlertTriangle size={15} className="text-destructive shrink-0" />
                  ) : (
                    <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      <Cpu size={12} className="inline text-accent mr-1" />
                      {t.device_id}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {t.product || '未知型号'}
                      {t.model ? ` · ${t.model}` : ''} · {t.created_at?.slice(0, 19)?.replace('T', ' ')}
                    </div>
                  </div>
                  {t.anomaly ? (
                    <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive shrink-0">
                      {t.anomaly_reason}
                    </span>
                  ) : (
                    <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
                      正常
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="px-3.5 pb-3 pt-1 border-t border-border animate-fade-in space-y-2">
                    <div className="text-[11px] text-muted-foreground">遥测快照</div>
                    <pre className="text-[11px] bg-background/60 rounded-lg p-2.5 overflow-x-auto text-foreground/85 whitespace-pre-wrap">
                      {prettySnapshot(t.snapshot)}
                    </pre>
                    {t.ticket_id && (
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-accent">
                        <TicketIcon size={12} /> 已自动建单 {t.ticket_id.slice(0, 8)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
