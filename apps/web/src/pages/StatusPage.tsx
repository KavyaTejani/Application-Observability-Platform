import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Button, Card, Spinner } from '../components/ui';
import type { DependencyStatus, ReadinessReport } from '../lib/types';

const OVERALL_LABEL: Record<ReadinessReport['status'], string> = {
  ready: '✔ Ready',
  degraded: '◐ Degraded: some telemetry backends are not configured in this deployment',
  not_ready: '✖ Not ready',
};

function describeDependency(dep: DependencyStatus): { text: string; className: string } {
  switch (dep.status) {
    case 'up':
      return { text: `✔ up (${dep.latencyMs} ms)`, className: 'text-emerald-700' };
    case 'down':
      return { text: '✖ down', className: 'text-red-700' };
    case 'not_configured':
      return { text: '— not configured', className: 'text-slate-500' };
  }
}

async function fetchReadiness(signal: AbortSignal): Promise<ReadinessReport> {
  // `/api/v1/status` rather than `/health/ready`: content blockers block monitoring-style paths.
  const res = await fetch('/api/v1/status', { signal });
  // 503 still carries a report describing which dependency is down.
  if (res.status !== 200 && res.status !== 503) throw new Error(`Unexpected HTTP ${res.status}`);
  return (await res.json()) as ReadinessReport;
}

/** Public page showing live readiness of the API and its backends. */
export function StatusPage() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: ({ signal }) => fetchReadiness(signal),
    // Retries ride out cold starts on the free hosting tier.
    retry: 3,
    retryDelay: (attempt) => 3000 * (attempt + 1),
    refetchInterval: 30_000,
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link to="/" className="text-sm text-slate-600 underline">
        ← Back to the app
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">System status</h1>
      <p className="mt-2 text-slate-600">Live readiness of the platform and its backends.</p>

      <div className="mt-6" aria-live="polite">
        <Card>
          {status.isPending && <Spinner label="Checking API readiness…" />}

          {status.isError && (
            <div className="space-y-3">
              <Alert>
                Could not reach the API ({status.error.message}). The server may be starting up;
                this can take up to a minute after a period of inactivity.
              </Alert>
              <Button onClick={() => void status.refetch()}>Retry</Button>
            </div>
          )}

          {status.data && (
            <>
              <p className="font-medium">API: {OVERALL_LABEL[status.data.status]}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {Object.entries(status.data.dependencies).map(([name, dep]) => {
                  const { text, className } = describeDependency(dep);
                  return (
                    <li key={name} className="flex justify-between">
                      <span>{name}</span>
                      <span className={className}>{text}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-4 text-xs text-slate-500">
                Checked {new Date(status.data.checkedAt).toLocaleTimeString()}
              </p>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
