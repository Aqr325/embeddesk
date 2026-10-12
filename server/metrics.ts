/**
 * 进程内轻量指标层（零依赖，商用运维可观测性基础）
 *
 * 设计取舍：
 *  - 不引入 Prometheus / OpenTelemetry 等外部依赖，避免部署负担；
 *  - 指标存活于进程内存，重启归零（与「访问日志落盘」互补：日志追溯明细，指标看趋势）；
 *  - 计数器均为 O(1) 原子自增，不阻塞请求主链路；
 *  - 时延分位采用定长环形缓冲（默认 200 样本）做近似排序，避免全量存储。
 *
 * 后续若需对接监控系统，只需在 recordRequest 处追加一次 exporter 上报即可。
 *
 * 本模块同时提供 Prometheus text exposition 序列化（prometheus()），
 * 业务指标（会话/工单/满意度等）由路由层用 getDashboardStats() 拼接后一并导出。
 */
type Bucket = '2xx' | '3xx' | '4xx' | '5xx';

export interface MetricsSnapshot {
  uptimeSec: number;
  startedAt: string;
  total: number;
  byBucket: Record<Bucket, number>;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  samples: number;
}

class Metrics {
  private readonly startTime = Date.now();
  private total = 0;
  private readonly byBucket: Record<Bucket, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  private errors = 0;
  private latSum = 0;
  private latCount = 0;
  private readonly ring: number[] = [];
  private readonly RING_MAX = 200;

  /** 记录一次已完成请求（在 res 'finish' 事件中调用） */
  record(status: number, durationMs: number): void {
    this.total++;
    const b: Bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
    this.byBucket[b]++;
    if (status >= 500) this.errors++;
    this.latSum += durationMs;
    this.latCount++;
    if (this.ring.length >= this.RING_MAX) this.ring.shift();
    this.ring.push(durationMs);
  }

  /** 导出当前快照（鉴权端点与管理看板共用） */
  snapshot(): MetricsSnapshot {
    const sorted = [...this.ring].sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
    const uptimeSec = Math.round((Date.now() - this.startTime) / 1000);
    return {
      uptimeSec,
      startedAt: new Date(this.startTime).toISOString(),
      total: this.total,
      byBucket: { ...this.byBucket },
      errors: this.errors,
      errorRate: this.total ? Number((this.errors / this.total).toFixed(4)) : 0,
      avgLatencyMs: this.latCount ? Math.round(this.latSum / this.latCount) : 0,
      p50LatencyMs: pct(50),
      p95LatencyMs: pct(95),
      p99LatencyMs: pct(99),
      samples: sorted.length,
    };
  }

  /**
   * 序列化为 Prometheus text exposition（仅进程级指标）。
   * 业务指标（会话/工单/满意度等）由路由层用 db.getDashboardStats() 拼接后一并导出。
   * 格式遵循 Prometheus Exposition Format 0.0.4：HELP/TYPE 元信息与样本分离，counter 单调递增。
   */
  prometheus(): string {
    const s = this.snapshot();
    const lines: string[] = [];
    const metric = (name: string, type: 'counter' | 'gauge', help: string, body: string): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(body);
    };

    metric('csa_http_requests_total', 'counter', 'Total number of HTTP requests handled by the agent service', `csa_http_requests_total ${s.total}`);

    const bucketBody = (Object.keys(s.byBucket) as Bucket[])
      .map((b) => `csa_http_requests_by_class_total{class="${b}"} ${s.byBucket[b]}`)
      .join('\n');
    metric('csa_http_requests_by_class_total', 'counter', 'HTTP requests grouped by response status class', bucketBody);

    metric('csa_http_errors_total', 'counter', 'HTTP responses with status code >= 500', `csa_http_errors_total ${s.errors}`);

    const durBody = [
      `csa_http_request_duration_ms{quantile="avg"} ${s.avgLatencyMs}`,
      `csa_http_request_duration_ms{quantile="p50"} ${s.p50LatencyMs}`,
      `csa_http_request_duration_ms{quantile="p95"} ${s.p95LatencyMs}`,
      `csa_http_request_duration_ms{quantile="p99"} ${s.p99LatencyMs}`,
    ].join('\n');
    metric('csa_http_request_duration_ms', 'gauge', 'HTTP request latency in milliseconds (approximate quantiles over recent samples)', durBody);

    metric('csa_uptime_seconds', 'gauge', 'Process uptime in seconds since last start', `csa_uptime_seconds ${s.uptimeSec}`);

    return lines.join('\n') + '\n';
  }
}

export const metrics = new Metrics();

/** 便捷封装：供访问日志中间件一行调用 */
export function recordRequest(status: number, durationMs: number): void {
  metrics.record(status, durationMs);
}
