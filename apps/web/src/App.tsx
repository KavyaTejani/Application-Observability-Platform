import { useEffect, useState } from 'react';

type DependencyName = 'mongodb' | 'redis' | 'prometheus' | 'loki';

type DependencyStatus = { status: 'up' | 'down'; latencyMs: number } | { status: 'not_configured' };

interface ReadinessReport {
  status: 'ready' | 'degraded' | 'not_ready';
  checkedAt: string;
  dependencies: Record<DependencyName, DependencyStatus>;
}

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

type ReadinessState =
  | { kind: 'loading' }
  | { kind: 'loaded'; report: ReadinessReport }
  | { kind: 'error'; message: string };

async function fetchReadiness(signal: AbortSignal): Promise<ReadinessReport> {
  const res = await fetch('/health/ready', { signal });
  // 503 still carries a report describing which dependency is down.
  if (res.status !== 200 && res.status !== 503) throw new Error(`Unexpected HTTP ${res.status}`);
  return (await res.json()) as ReadinessReport;
}

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3000;

/** Retries transient failures, e.g. while the host is waking up or switching deploys. */
async function fetchReadinessWithRetry(signal: AbortSignal): Promise<ReadinessReport> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchReadiness(signal);
    } catch (error) {
      if (signal.aborted || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * Foundations milestone shell: shows live API readiness so the local stack can be verified from
 * the browser. Replaced by the authenticated application in the identity milestone.
 */
export function App() {
  const [state, setState] = useState<ReadinessState>({ kind: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchReadinessWithRetry(controller.signal)
      .then((report) => setState({ kind: 'loaded', report }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Request failed',
        });
      });
    return () => controller.abort();
  }, [reloadCount]);

  const retry = () => {
    setState({ kind: 'loading' });
    setReloadCount((count) => count + 1);
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Application Observability Platform</h1>
      <p className="mt-2 text-slate-600">
        Metrics, logs, and alerts for Node.js services. Platform status:
      </p>

      <section aria-live="polite" className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        {state.kind === 'loading' && <p className="text-slate-500">Checking API readiness…</p>}

        {state.kind === 'error' && (
          <div>
            <p className="text-red-700">
              Could not reach the API ({state.message}). The server may be starting up; this can
              take up to a minute after a period of inactivity.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Retry
            </button>
          </div>
        )}

        {state.kind === 'loaded' && (
          <>
            <p className="font-medium">API: {OVERALL_LABEL[state.report.status]}</p>
            <ul className="mt-3 space-y-1 text-sm">
              {Object.entries(state.report.dependencies).map(([name, dep]) => {
                const { text, className } = describeDependency(dep);
                return (
                  <li key={name} className="flex justify-between">
                    <span>{name}</span>
                    <span className={className}>{text}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
