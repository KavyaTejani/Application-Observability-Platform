import {
  TIME_RANGE_SECONDS,
  type MetricKey,
  type MetricQuery,
  type TimeRange,
} from '@aop/validation';
import { AppError } from '../../lib/errors.js';
import type { ProjectScope } from '../authz/tenant-scope.js';
import { ProjectModel } from '../projects/project.model.js';
import type { PrometheusQueryApi } from './backend-clients.js';
import {
  buildRangeExpression,
  buildSummaryExpressions,
  labelMatchers,
  stepSeconds,
  type MetricScope,
} from './promql.js';

export type MetricUnit = 'requests_per_second' | 'ratio' | 'milliseconds';

const UNITS: Record<MetricKey, MetricUnit> = {
  request_rate: 'requests_per_second',
  error_rate: 'ratio',
  client_error_rate: 'ratio',
  p50_latency: 'milliseconds',
  p95_latency: 'milliseconds',
  p99_latency: 'milliseconds',
};

export interface MetricSeries {
  /** Only the requested group-by dimensions; tenant labels are never returned. */
  labels: Record<string, string>;
  /** [epoch ms, value]. `null` means no data at that time, which is distinct from 0 (MET-006). */
  points: Array<[number, number | null]>;
}

export interface MetricQueryResult {
  metricKey: MetricKey;
  unit: MetricUnit;
  range: TimeRange;
  stepSeconds: number;
  start: string;
  end: string;
  series: MetricSeries[];
  noData: boolean;
}

export interface MetricSummary {
  range: TimeRange;
  /** Approximate: Prometheus `increase()` extrapolates to the window edges. */
  requests: number | null;
  requestRate: number | null;
  serverErrorRate: number | null;
  clientErrorRate: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null };
  lastTelemetryAt: string | null;
}

/** Parses a Prometheus sample value. NaN and ±Inf (e.g. 0/0 or an empty histogram) mean no data. */
function sampleValue(raw: string | undefined, toMs: boolean): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return toMs ? value * 1000 : value;
}

const scopeLabels = (scope: ProjectScope): MetricScope => ({
  organizationId: scope.organizationId.toHexString(),
  projectId: scope.projectId.toHexString(),
});

export class MetricsQueryService {
  constructor(
    private readonly prometheus: PrometheusQueryApi | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(): PrometheusQueryApi {
    if (!this.prometheus) {
      throw new AppError(
        503,
        'BACKEND_NOT_CONFIGURED',
        'Metrics storage is not configured in this deployment.',
        {
          retryable: false,
        },
      );
    }
    return this.prometheus;
  }

  async query(scope: ProjectScope, query: MetricQuery): Promise<MetricQueryResult> {
    const prometheus = this.client();
    const step = stepSeconds(query);
    // Align to the step so repeated refreshes hit the same timestamps and points stay stable.
    const end = Math.floor(this.now().getTime() / 1000 / step) * step;
    const start = end - TIME_RANGE_SECONDS[query.range];
    const expr = buildRangeExpression(
      query.metricKey,
      scopeLabels(scope),
      query.filters,
      query.groupBy,
      step,
    );
    const toMs = UNITS[query.metricKey] === 'milliseconds';

    const raw = await prometheus.queryRange(expr, start, end, step);
    const timeline: number[] = [];
    for (let t = start; t <= end; t += step) timeline.push(t);

    const series = raw.map((item): MetricSeries => {
      const byTime = new Map(item.values.map(([t, v]) => [Math.round(t), v]));
      return {
        labels: Object.fromEntries(query.groupBy.map((dim) => [dim, item.metric[dim] ?? ''])),
        points: timeline.map((t) => [t * 1000, sampleValue(byTime.get(t), toMs)]),
      };
    });

    return {
      metricKey: query.metricKey,
      unit: UNITS[query.metricKey],
      range: query.range,
      stepSeconds: step,
      start: new Date(start * 1000).toISOString(),
      end: new Date(end * 1000).toISOString(),
      series,
      noData: series.every((s) => s.points.every(([, v]) => v === null)),
    };
  }

  async summary(
    scope: ProjectScope,
    range: TimeRange,
    serviceName?: string,
  ): Promise<MetricSummary> {
    const prometheus = this.client();
    const exprs = buildSummaryExpressions(scopeLabels(scope), range, serviceName);
    const time = Math.floor(this.now().getTime() / 1000);
    const instant = async (expr: string, toMs = false) =>
      sampleValue((await prometheus.query(expr, time))[0]?.value[1], toMs);

    const [requests, serverErrors, clientErrors, p50, p95, p99, project] = await Promise.all([
      instant(exprs.requests),
      instant(exprs.serverErrors),
      instant(exprs.clientErrors),
      instant(exprs.p50, true),
      instant(exprs.p95, true),
      instant(exprs.p99, true),
      ProjectModel.findOne(
        { _id: scope.projectId, organizationId: scope.organizationId },
        { lastTelemetryAt: 1 },
      ).lean(),
    ]);

    // No requests in the window means "no data", not a 0% error rate (PRD glossary).
    const hasTraffic = requests !== null && requests > 0;
    const ratio = (part: number | null) => (hasTraffic ? (part ?? 0) / (requests as number) : null);
    return {
      range,
      requests: hasTraffic ? Math.round(requests as number) : requests === null ? null : 0,
      requestRate: hasTraffic ? (requests as number) / TIME_RANGE_SECONDS[range] : null,
      serverErrorRate: ratio(serverErrors),
      clientErrorRate: ratio(clientErrors),
      latencyMs: { p50, p95, p99 },
      lastTelemetryAt: project?.lastTelemetryAt?.toISOString() ?? null,
    };
  }

  /** Services that reported metrics for this project (filter options). */
  async services(scope: ProjectScope): Promise<string[]> {
    if (!this.prometheus) return [];
    return this.prometheus.labelValues(
      'service',
      `app_http_requests_total${labelMatchers(scopeLabels(scope))}`,
    );
  }
}
