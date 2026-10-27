import { useEffect, useState } from 'react';

type DependencyName = 'mongodb' | 'redis' | 'prometheus' | 'loki';

interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checkedAt: string;
  dependencies: Record<DependencyName, { status: 'up' | 'down'; latencyMs: number }>;
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

/**
 * Foundations milestone shell: shows live API readiness so the local stack can be verified from
 * the browser. Replaced by the authenticated application in the identity milestone.
 */
export function App() {
  const [state, setState] = useState<ReadinessState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchReadiness(controller.signal)
      .then((report) => setState({ kind: 'loaded', report }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Request failed',
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Application Observability Platform</h1>
      <p className="mt-2 text-slate-600">
        Metrics, logs, and alerts for Node.js services. Platform status:
      </p>

      <section aria-live="polite" className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        {state.kind === 'loading' && <p className="text-slate-500">Checking API readiness…</p>}

        {state.kind === 'error' && (
          <p className="text-red-700">
            Could not reach the API ({state.message}). Is <code>npm run dev:api</code> running?
          </p>
        )}

        {state.kind === 'loaded' && (
          <>
            <p className="font-medium">
              API: {state.report.status === 'ready' ? '✔ Ready' : '✖ Not ready'}
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {Object.entries(state.report.dependencies).map(([name, dep]) => (
                <li key={name} className="flex justify-between">
                  <span>{name}</span>
                  <span className={dep.status === 'up' ? 'text-emerald-700' : 'text-red-700'}>
                    {dep.status === 'up' ? `✔ up (${dep.latencyMs} ms)` : '✖ down'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
