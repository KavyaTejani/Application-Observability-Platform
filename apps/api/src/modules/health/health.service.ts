import { withTimeout } from '../../lib/timeout.js';

export type DependencyName = 'mongodb' | 'redis' | 'prometheus' | 'loki';

/** A probe resolves when the dependency is usable and rejects otherwise. */
export type DependencyProbe = (signal: AbortSignal) => Promise<unknown>;

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checkedAt: string;
  dependencies: Record<DependencyName, DependencyStatus>;
}

export type ProbeFailureListener = (name: DependencyName, error: unknown) => void;

export class HealthService {
  constructor(
    private readonly probes: Record<DependencyName, DependencyProbe>,
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
    const allUp = results.every((result) => result.status === 'up');
    return {
      status: allUp ? 'ready' : 'not_ready',
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }

  private async runProbe(name: DependencyName): Promise<DependencyStatus> {
    const controller = new AbortController();
    const started = performance.now();
    try {
      await withTimeout(this.probes[name](controller.signal), this.timeoutMs);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      controller.abort();
      // The failure reason is logged server-side only; responses expose up/down, never details.
      this.onProbeFailure(name, error);
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    }
  }
}
