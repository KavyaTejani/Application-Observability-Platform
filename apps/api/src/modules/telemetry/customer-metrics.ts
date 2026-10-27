import { Counter, Histogram, Registry } from 'prom-client';

/**
 * Fixed latency buckets in seconds. Percentiles derived from them (p50/p95/p99 via
 * `histogram_quantile`) are approximations, interpolated within the containing bucket (PRD MET-001).
 */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

const seriesKey = (labels: Record<string, string>): string =>
  JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  );

/** Reserved label value for anything beyond a cardinality cap (PRD ING-014). */
export const OVERFLOW_LABEL = '__other__';

export interface CardinalityLimits {
  maxRoutesPerProject: number;
  maxServicesPerProject: number;
}

type Labels =
  | 'organization_id'
  | 'project_id'
  | 'environment'
  | 'service'
  | 'method'
  | 'route'
  | 'status_class';

export interface HttpObservation {
  organizationId: string;
  projectId: string;
  environment: string;
  service: string;
  method: string;
  route: string;
  statusClass: string;
  durationSeconds: number;
}

/**
 * Customer request metrics, aggregated in the gateway and scraped by Prometheus from the internal
 * listener (`/telemetry-metrics`). This is separate from the platform's own registry.
 *
 * Series time reflects gateway receipt (scrape) time, not client event time (PRD ING-012).
 * Tenant labels come only from the verified API key. The per-project caps bound how many series
 * one client can create. They are kept per process, which is acceptable because they bound memory
 * per process. A restart resets the counters, and PromQL `rate()` handles counter resets.
 *
 * **Zero-initialization of new series.** `rate()`/`increase()` cannot count a counter's first
 * sample, because Prometheus never saw it at 0. If a new series (a new route, a first 5xx, or any
 * series after a restart) were exported with its first increments already applied, those requests
 * would be invisible to every query and alert. So a new label set is exported at 0 first, and its
 * increments are held until the next scrape has seen that 0 (or until `pendingMaxAgeMs` passes,
 * if nothing scrapes). The cost is up to one scrape interval of extra delay, for new series only.
 */
export class CustomerMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<Labels>;
  private readonly duration: Histogram<Labels>;
  private readonly routesByProject = new Map<string, Set<string>>();
  private readonly servicesByProject = new Map<string, Set<string>>();
  /** Label sets already exported and scraped at least once; they are updated directly. */
  private readonly live = new Set<string>();
  /** New label sets waiting for their zero to be scraped: buffered durations (seconds). */
  private readonly pending = new Map<
    string,
    { labels: Record<Labels, string>; durations: number[]; since: number }
  >();

  constructor(
    private readonly limits: CardinalityLimits,
    private readonly onOverflow: (dimension: 'route' | 'service') => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly pendingMaxAgeMs = 60_000,
  ) {
    const labelNames: Labels[] = [
      'organization_id',
      'project_id',
      'environment',
      'service',
      'method',
      'route',
      'status_class',
    ];
    this.requests = new Counter({
      name: 'app_http_requests_total',
      help: 'HTTP requests reported by customer services, by route template and status class.',
      labelNames,
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: 'app_http_request_duration_seconds',
      help: 'HTTP request duration reported by customer services, in seconds.',
      labelNames,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
    });
  }

  observe(obs: HttpObservation): void {
    const labels = {
      organization_id: obs.organizationId,
      project_id: obs.projectId,
      environment: obs.environment,
      service: this.capped(
        this.servicesByProject,
        obs.projectId,
        obs.service,
        this.limits.maxServicesPerProject,
        'service',
      ),
      method: obs.method,
      route: this.capped(
        this.routesByProject,
        obs.projectId,
        obs.route,
        this.limits.maxRoutesPerProject,
        'route',
      ),
      status_class: obs.statusClass,
    };
    const key = seriesKey(labels);
    if (this.live.has(key)) {
      this.record(labels, obs.durationSeconds);
      return;
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      waiting.durations.push(obs.durationSeconds);
      // Never hold data indefinitely if Prometheus is not scraping this process.
      if (this.now() - waiting.since >= this.pendingMaxAgeMs) this.promote(key);
      return;
    }
    // First sight of this series: export it at zero, buffer the observation.
    this.requests.inc(labels, 0);
    this.duration.zero(labels);
    this.pending.set(key, { labels, durations: [obs.durationSeconds], since: this.now() });
  }

  /**
   * Renders the registry for a scrape, then applies buffered observations: the zeros of new
   * series have now been seen, so their real values can follow on the next scrape.
   */
  async scrape(): Promise<string> {
    const text = await this.registry.metrics();
    for (const key of [...this.pending.keys()]) this.promote(key);
    return text;
  }

  private promote(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.live.add(key);
    for (const duration of entry.durations) this.record(entry.labels, duration);
  }

  private record(labels: Record<Labels, string>, durationSeconds: number): void {
    this.requests.inc(labels);
    this.duration.observe(labels, durationSeconds);
  }

  private capped(
    seen: Map<string, Set<string>>,
    projectId: string,
    value: string,
    max: number,
    dimension: 'route' | 'service',
  ): string {
    let values = seen.get(projectId);
    if (!values) {
      values = new Set();
      seen.set(projectId, values);
    }
    if (values.has(value)) return value;
    if (values.size >= max) {
      this.onOverflow(dimension);
      return OVERFLOW_LABEL;
    }
    values.add(value);
    return value;
  }
}
