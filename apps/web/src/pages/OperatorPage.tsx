import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card, Spinner, TextField } from '../components/ui';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '../lib/format';
import type { DependencyStatus, ReadinessReport } from '../lib/types';

type Counts = Record<string, number>;

interface OperatorReport {
  generatedAt: string;
  instance: {
    uptimeSeconds: number;
    nodeVersion: string;
    memoryRssBytes: number;
    alertWorker: {
      running: boolean;
      lastTickAt: string | null;
      lastTickDurationMs: number | null;
      lastTickFailed: boolean;
    };
  };
  readiness: ReadinessReport;
  pipeline: {
    since: string;
    ingest: { records: Counts; bytes: Counts; requests: Counts; quotaRejections: Counts };
    backends: Counts;
    alertEvaluations: Counts;
    notificationAttempts: Counts;
    httpRequests: Counts;
  };
  state: null | {
    organizations: number;
    activeProjects: number;
    alertRules: { byState: Counts; disabled: number };
    incidentsFiring: number;
    notificationJobs: Counts;
    usageToday: { dayUtc: string; records: number; bytes: number; organizations: number };
  };
}

class OperatorAuthError extends Error {}

async function fetchReport(token: string, signal: AbortSignal): Promise<OperatorReport> {
  // `/status` alias of `/api/v1/operator/health`: content blockers filter "health" paths.
  const res = await fetch('/api/v1/operator/status', {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
    signal,
  });
  if (res.status === 401) throw new OperatorAuthError('The operator token was not accepted.');
  if (res.status === 404) {
    throw new OperatorAuthError('The operator view is not enabled (OPERATOR_TOKEN is not set).');
  }
  if (!res.ok) throw new Error(`Unexpected HTTP ${res.status}`);
  return ((await res.json()) as { report: OperatorReport }).report;
}

/**
 * Platform operator view (PRD SELF-004). Operators are not an organization role: access needs
 * the deployment's operator token, which is kept in memory only and never stored.
 */
export function OperatorPage() {
  const [token, setToken] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ['operator', token],
    queryFn: ({ signal }) => fetchReport(token ?? '', signal),
    enabled: token !== null,
    refetchInterval: (query) => (query.state.error instanceof OperatorAuthError ? false : 10_000),
    retry: (count, error) => !(error instanceof OperatorAuthError) && count < 2,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('token') ?? '').trim();
    if (!value) return;
    // Re-submitting the same token after an error retries instead of doing nothing.
    if (value === token) void report.refetch();
    else setToken(value);
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div>
        <Link to="/" className="text-sm text-fg-muted hover:text-fg">
          ← Back to the app
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-fg">Operator health</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          The platform&apos;s own health: dependencies, the telemetry pipeline, alerting, and
          notifications. Aggregates only; no customer data.
        </p>
      </div>

      {token === null || report.error instanceof OperatorAuthError ? (
        <Card title="Operator token">
          {report.error instanceof OperatorAuthError && (
            <div className="mb-3">
              <Alert>{report.error.message}</Alert>
            </div>
          )}
          <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-3">
            <div className="min-w-64 flex-1">
              <TextField
                label="Token"
                name="token"
                type="password"
                autoComplete="off"
                hint="The OPERATOR_TOKEN of this deployment. Kept in this tab's memory only."
              />
            </div>
            <Button type="submit" className="sm:mt-7">
              Open
            </Button>
          </form>
        </Card>
      ) : report.isPending ? (
        <Spinner label="Loading operator report…" />
      ) : report.isError ? (
        <Alert>Could not load the report ({report.error.message}).</Alert>
      ) : (
        <ReportView report={report.data} onLock={() => setToken(null)} />
      )}
    </main>
  );
}

function ReportView({ report, onLock }: { report: OperatorReport; onLock: () => void }) {
  const { readiness, instance, pipeline, state } = report;
  const worker = instance.alertWorker;
  const failures =
    (pipeline.backends['loki/failure'] ?? 0) + (pipeline.backends['prometheus/failure'] ?? 0);
  return (
    <div className="space-y-6" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
        <span>
          Updated {formatDateTime(report.generatedAt)} · refreshes every 10 s · counters since this
          instance started ({formatRelative(pipeline.since)})
        </span>
        <Button variant="secondary" onClick={onLock}>
          Lock
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={`Dependencies: ${READINESS_LABEL[readiness.status]}`}>
          <ul className="space-y-1 text-sm">
            {Object.entries(readiness.dependencies).map(([name, dep]) => (
              <li key={name} className="flex justify-between">
                <span>{name}</span>
                <DependencyText dep={dep} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="This instance">
          <dl className="space-y-1 text-sm">
            <Row label="Uptime" value={formatUptime(instance.uptimeSeconds)} />
            <Row label="Node.js" value={instance.nodeVersion} />
            <Row label="Memory (RSS)" value={formatBytes(instance.memoryRssBytes)} />
            <Row
              label="Alert worker"
              value={
                !worker.running
                  ? '— not running here'
                  : worker.lastTickFailed
                    ? `✖ last pass failed (${formatRelative(worker.lastTickAt)})`
                    : `✔ last pass ${formatRelative(worker.lastTickAt)} (${worker.lastTickDurationMs ?? 0} ms)`
              }
            />
          </dl>
        </Card>
      </div>

      <Card title="Telemetry pipeline">
        <div className="grid gap-6 md:grid-cols-3">
          <CountList
            title="Records"
            counts={pipeline.ingest.records}
            empty="No records yet"
            format={formatNumber}
          />
          <CountList
            title="Requests by outcome"
            counts={pipeline.ingest.requests}
            empty="No requests yet"
            format={formatNumber}
          />
          <div className="space-y-4">
            <CountList
              title="Accepted bytes"
              counts={pipeline.ingest.bytes}
              empty="None yet"
              format={formatBytes}
            />
            <CountList
              title="Quota rejections (batches)"
              counts={pipeline.ingest.quotaRejections}
              empty="None"
              format={formatNumber}
            />
          </div>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-3">
          <CountList
            title={`Backend calls${failures > 0 ? ` (✖ ${failures} failed)` : ''}`}
            counts={pipeline.backends}
            empty="No backend calls yet"
            format={formatNumber}
          />
          <CountList
            title="Alert evaluations"
            counts={pipeline.alertEvaluations}
            empty="None yet"
            format={formatNumber}
          />
          <CountList
            title="Webhook attempts"
            counts={pipeline.notificationAttempts}
            empty="None yet"
            format={formatNumber}
          />
        </div>
      </Card>

      <Card title="Platform state">
        {state === null ? (
          <Alert>MongoDB could not be queried; platform state is unavailable.</Alert>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <dl className="space-y-1 text-sm">
              <Row label="Organizations" value={formatNumber(state.organizations)} />
              <Row label="Active projects" value={formatNumber(state.activeProjects)} />
              <Row label="Firing incidents" value={formatNumber(state.incidentsFiring)} />
              <Row
                label={`Ingested today (${state.usageToday.dayUtc})`}
                value={`${formatNumber(state.usageToday.records)} records · ${formatBytes(state.usageToday.bytes)}`}
              />
            </dl>
            <CountList
              title={`Enabled alert rules by state (${state.alertRules.disabled} disabled)`}
              counts={state.alertRules.byState}
              empty="No enabled rules"
              format={formatNumber}
            />
            <CountList
              title="Undelivered notifications"
              counts={state.notificationJobs}
              empty="✔ None outstanding"
              format={formatNumber}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

const READINESS_LABEL: Record<ReadinessReport['status'], string> = {
  ready: '✔ ready',
  degraded: '◐ degraded',
  not_ready: '✖ not ready',
};

function DependencyText({ dep }: { dep: DependencyStatus }) {
  if (dep.status === 'up') return <span className="text-ok">✔ up ({dep.latencyMs} ms)</span>;
  if (dep.status === 'down') return <span className="text-danger">✖ down</span>;
  return <span className="text-fg-muted">— not configured</span>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-fg-secondary">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function CountList({
  title,
  counts,
  empty,
  format,
}: {
  title: string;
  counts: Counts;
  empty: string;
  format: (n: number) => string;
}) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium text-fg">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : (
        <dl className="space-y-1 text-sm">
          {entries.map(([key, n]) => (
            <Row key={key} label={key.replaceAll('/', ' · ')} value={format(n)} />
          ))}
        </dl>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}
