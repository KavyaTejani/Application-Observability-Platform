import { Counter, Histogram, Registry } from 'prom-client';

/**
 * Fixed latency buckets in seconds. Percentiles derived from them (p50/p95/p99 via
 * `histogram_quantile`) are approximations, interpolated within the containing bucket (PRD MET-001).
 */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

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
 */
export class CustomerMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<Labels>;
  private readonly duration: Histogram<Labels>;
  private readonly routesByProject = new Map<string, Set<string>>();
  private readonly servicesByProject = new Map<string, Set<string>>();

  constructor(
    private readonly limits: CardinalityLimits,
    private readonly onOverflow: (dimension: 'route' | 'service') => void = () => undefined,
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
    this.requests.inc(labels);
    this.duration.observe(labels, obs.durationSeconds);
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
