import { TIME_RANGES, type MetricKey, type TimeRange } from '@aop/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router';
import { TimeSeriesChart, type ChartSeries } from '../components/TimeSeriesChart';
import { RefreshCw } from 'lucide-react';
import { Alert, Button, Spinner, inputClass, sectionLabel } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import {
  formatMs,
  formatNumber,
  formatPercent,
  formatRelative,
  timeZoneLabel,
} from '../lib/format';
import {
  useMetricQuery,
  useMetricSummary,
  useServices,
  type MetricQueryResult,
} from '../lib/telemetry';
import type { ProjectContext } from './ProjectPage';

const RANGE_LABEL: Record<TimeRange, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
};

export function ProjectDashboardPage() {
  const { org, project } = useOutletContext<ProjectContext>();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<TimeRange>('1h');
  const [service, setService] = useState('');
  const services = useServices(project.id);
  const serviceName = service || undefined;

  const summary = useMetricSummary(project.id, range, serviceName);
  const filters = serviceName ? { serviceName } : {};
  const requestRate = useMetricQuery(project.id, { metricKey: 'request_rate', range, filters });
  const errorRate = useMetricQuery(project.id, { metricKey: 'error_rate', range, filters });
  const latency = (metricKey: MetricKey) => ({ metricKey, range, filters });
  const p50 = useMetricQuery(project.id, latency('p50_latency'));
  const p95 = useMetricQuery(project.id, latency('p95_latency'));
  const p99 = useMetricQuery(project.id, latency('p99_latency'));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['telemetry', project.id] });
  const notConfigured =
    summary.error instanceof ApiError && summary.error.code === 'BACKEND_NOT_CONFIGURED';
  const empty = summary.data && summary.data.summary.requests === null && requestRate.data?.noData;

  return (
    <div className="space-y-6">
      {/* Filters: one row above the charts, applying to all of them. */}
      <div className="flex flex-wrap items-end gap-3">
        <div
          role="group"
          aria-label="Time range"
          className="flex gap-0.5 rounded-lg bw border-line bg-surface p-0.5 select-none"
        >
          {TIME_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 font-display text-sm font-semibold transition-colors ${
                r === range ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="text-sm text-fg-secondary">
          <span className="sr-only">Service</span>
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className={inputClass}
          >
            <option value="">All services</option>
            {services.data?.services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
          Refresh
        </Button>
        <span className="text-xs text-fg-muted">
          Auto-refreshes every 30 s · times in {timeZoneLabel}
        </span>
      </div>

      {notConfigured ? (
        <Alert tone="info">
          Metrics storage is not configured in this deployment, so there is nothing to chart here.
          The full telemetry stack runs with Docker Compose (see the README).
        </Alert>
      ) : summary.isError ? (
        <Alert>{errorMessage(summary.error)}</Alert>
      ) : null}

      {empty && (
        <Alert tone="info">
          No requests recorded {RANGE_LABEL[range].toLowerCase()}. Instrument a service with the SDK
          and send traffic. Keys and setup are under{' '}
          <Link
            to={`/orgs/${org.id}/projects/${project.id}/settings`}
            className="font-medium underline"
          >
            Keys &amp; setup
          </Link>
          .
        </Alert>
      )}

      {summary.isPending ? (
        <Spinner />
      ) : (
        summary.data && <SummaryTiles summary={summary.data.summary} />
      )}

      {!notConfigured && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            query={requestRate}
            title="Request rate"
            unit="req/s"
            formatValue={formatNumber}
            toSeries={(r) => r.series.map((s) => ({ name: 'Requests', points: s.points }))}
            range={range}
          />
          <ChartCard
            query={errorRate}
            title="Server error rate (5xx)"
            unit="%"
            formatValue={(v) => formatNumber(v * 100)}
            toSeries={(r) => r.series.map((s) => ({ name: 'Error rate', points: s.points }))}
            range={range}
          />
          <div className="lg:col-span-2">
            <LatencyChart p50={p50} p95={p95} p99={p99} range={range} />
          </div>
        </div>
      )}

      <p className="text-xs text-fg-muted">
        Latency percentiles are estimated from fixed histogram buckets, so they are approximate.
        Metrics update after each 15 s collection; “no data” (gaps) means no requests, which is
        different from zero.
      </p>
    </div>
  );
}

type Query = ReturnType<typeof useMetricQuery>;

function ChartCard({
  query,
  title,
  unit,
  formatValue,
  toSeries,
  range,
}: {
  query: Query;
  title: string;
  unit: string;
  formatValue: (v: number) => string;
  toSeries: (result: MetricQueryResult) => ChartSeries[];
  range: TimeRange;
}) {
  if (query.isPending) {
    return (
      <div className="flex h-72 items-center justify-center frame">
        <Spinner label={`Loading ${title.toLowerCase()}…`} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="frame p-4">
        <p className="mb-2 font-semibold text-fg">{title}</p>
        <Alert>{errorMessage(query.error)}</Alert>
      </div>
    );
  }
  const result = query.data;
  return (
    <div className="relative">
      <TimeSeriesChart
        title={title}
        unit={unit}
        series={toSeries(result)}
        formatValue={formatValue}
        start={Date.parse(result.start)}
        end={Date.parse(result.end)}
        rangeLabel={RANGE_LABEL[range]}
      />
      {result.noData && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-fg-muted">
          No data in this time range
        </p>
      )}
    </div>
  );
}

/** p50/p95/p99 on one axis: same measure and unit, three series (legend + data table). */
function LatencyChart({
  p50,
  p95,
  p99,
  range,
}: {
  p50: Query;
  p95: Query;
  p99: Query;
  range: TimeRange;
}) {
  const queries = [p50, p95, p99];
  if (queries.some((q) => q.isPending)) {
    return (
      <div className="flex h-72 items-center justify-center frame">
        <Spinner label="Loading latency…" />
      </div>
    );
  }
  const failed = queries.find((q) => q.isError);
  if (failed) {
    return (
      <div className="frame p-4">
        <p className="mb-2 font-semibold text-fg">Latency</p>
        <Alert>{errorMessage(failed.error)}</Alert>
      </div>
    );
  }
  const results = queries.map((q) => q.data as MetricQueryResult);
  const first = results[0] as MetricQueryResult;
  const names = ['p50', 'p95', 'p99'];
  const series: ChartSeries[] = results.flatMap((r, i) =>
    r.series.map((s) => ({ name: names[i] ?? '', points: s.points })),
  );
  return (
    <div className="relative">
      <TimeSeriesChart
        title="Latency"
        unit="ms"
        series={series}
        formatValue={(v) => formatNumber(Math.round(v))}
        start={Date.parse(first.start)}
        end={Date.parse(first.end)}
        rangeLabel={RANGE_LABEL[range]}
      />
      {results.every((r) => r.noData) && (
        <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-fg-muted">
          No data in this time range
        </p>
      )}
    </div>
  );
}

function SummaryTiles({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof useMetricSummary>['data']>['summary'];
}) {
  const dash = '—';
  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: 'Requests',
      // Prometheus increase() extrapolates to the window edges, so the total is approximate.
      value: summary.requests === null ? dash : `≈ ${formatNumber(summary.requests)}`,
      hint:
        summary.requestRate === null
          ? 'no traffic'
          : `${formatNumber(summary.requestRate)} req/s avg`,
    },
    {
      label: 'Server errors (5xx)',
      value: summary.serverErrorRate === null ? dash : formatPercent(summary.serverErrorRate),
      hint: 'of requests',
    },
    {
      label: 'Client errors (4xx)',
      value: summary.clientErrorRate === null ? dash : formatPercent(summary.clientErrorRate),
      hint: 'reported separately',
    },
    {
      label: 'p50 latency',
      value: summary.latencyMs.p50 === null ? dash : formatMs(summary.latencyMs.p50),
    },
    {
      label: 'p95 latency',
      value: summary.latencyMs.p95 === null ? dash : formatMs(summary.latencyMs.p95),
    },
    {
      label: 'p99 latency',
      value: summary.latencyMs.p99 === null ? dash : formatMs(summary.latencyMs.p99),
    },
    { label: 'Last data', value: formatRelative(summary.lastTelemetryAt) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {tiles.map((tile) => (
        <div key={tile.label} className="frame p-3.5">
          <dt className={sectionLabel}>{tile.label}</dt>
          <dd className="mt-1 font-display text-xl font-bold tracking-tight text-fg tabular-nums">
            {tile.value}
          </dd>
          {tile.hint && <dd className="text-xs text-fg-muted">{tile.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
