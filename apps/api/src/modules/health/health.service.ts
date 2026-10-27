import { withTimeout } from '../../lib/timeout.js';

export type DependencyName = 'mongodb' | 'redis' | 'prometheus' | 'loki';

/** A probe resolves when the dependency is usable and rejects otherwise. */
export type DependencyProbe = (signal: AbortSignal) => Promise<unknown>;

/** `null` marks a dependency that is intentionally not configured in this deployment. */
export type DependencyProbes = Record<DependencyName, DependencyProbe | null>;

export type DependencyStatus =
  { status: 'up' | 'down'; latencyMs: number } | { status: 'not_configured' };

/**
 * - `ready`: every dependency is configured and up.
 * - `degraded`: every configured dependency is up, but some are not configured, so the features
 *   that need them are unavailable. Reported honestly rather than as `ready`.
 * - `not_ready`: a configured dependency is down.
 */
export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export interface ReadinessReport {
  status: ReadinessStatus;
  checkedAt: string;
  dependencies: Record<DependencyName, DependencyStatus>;
}

export type ProbeFailureListener = (name: DependencyName, error: unknown) => void;

export class HealthService {
  constructor(
    private readonly probes: DependencyProbes,
    private readonly timeoutMs: number,
    private readonly onProbeFailure: ProbeFailureListener = () => undefined,
  ) {}

  async checkReadiness(): Promise<ReadinessReport> {
    const names = Object.keys(this.probes) as DependencyName[];
    const results = await Promise.all(names.map((name) => this.runProbe(name)));
    const dependencies = Object.fromEntries(names.map((name, i) => [name, results[i]])) as Record<
      DependencyName,
      DependencyStatus
    >;

    let status: ReadinessStatus = 'ready';
    if (results.some((result) => result.status === 'down')) status = 'not_ready';
    else if (results.some((result) => result.status === 'not_configured')) status = 'degraded';

    return { status, checkedAt: new Date().toISOString(), dependencies };
  }

  private async runProbe(name: DependencyName): Promise<DependencyStatus> {
    const probe = this.probes[name];
    if (!probe) return { status: 'not_configured' };

    const controller = new AbortController();
    const started = performance.now();
    try {
      await withTimeout(probe(controller.signal), this.timeoutMs);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      controller.abort();
      // The failure reason is logged server-side only; responses expose up/down, never details.
      this.onProbeFailure(name, error);
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    }
  }
}
