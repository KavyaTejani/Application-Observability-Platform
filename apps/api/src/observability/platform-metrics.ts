import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The platform's own metrics (SELF-002). This registry is exposed only on the internal
 * listener. Labels are bounded enumerations: route templates, methods, and status classes —
 * never raw paths, user IDs, emails, or keys.
 */
export interface PlatformMetrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status_class'>;
  httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  dependencyProbeFailures: Counter<'dependency'>;
  authEvents: Counter<'event'>;
}

export function createPlatformMetrics(): PlatformMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'aop-api' });
  collectDefaultMetrics({ register: registry, prefix: 'aop_' });

  return {
    registry,
    httpRequests: new Counter({
      name: 'aop_http_requests_total',
      help: 'API requests handled, by route template, method, and status class.',
      labelNames: ['method', 'route', 'status_class'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'aop_http_request_duration_seconds',
      help: 'API request duration in seconds.',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    dependencyProbeFailures: new Counter({
      name: 'aop_dependency_probe_failures_total',
      help: 'Readiness probe failures by dependency.',
      labelNames: ['dependency'],
      registers: [registry],
    }),
    authEvents: new Counter({
      name: 'aop_auth_events_total',
      help: 'Authentication events: register, login_success, login_failure.',
      labelNames: ['event'],
      registers: [registry],
    }),
  };
}
