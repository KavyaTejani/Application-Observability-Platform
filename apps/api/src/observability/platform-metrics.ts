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
  ingestRecords: Counter<'signal' | 'outcome'>;
  ingestBytes: Counter<'signal'>;
  quotaRejections: Counter<'limit'>;
  ingestRequests: Counter<'outcome'>;
  ingestDuration: Histogram;
  backendRequests: Counter<'backend' | 'outcome'>;
  backendDuration: Histogram<'backend'>;
  cardinalityOverflow: Counter<'dimension'>;
  alertEvaluations: Counter<'outcome'>;
  alertEvaluationDuration: Histogram;
  notificationAttempts: Counter<'outcome'>;
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
    // Telemetry pipeline health (SELF-002). Per-project numbers live in usage records, never in
    // platform labels (PRD §15).
    ingestRecords: new Counter({
      name: 'aop_ingest_records_total',
      help: 'Telemetry records by signal and outcome (accepted or rejected).',
      labelNames: ['signal', 'outcome'],
      registers: [registry],
    }),
    ingestBytes: new Counter({
      name: 'aop_ingest_bytes_total',
      help: 'Estimated bytes of accepted telemetry (serialized record size), by signal.',
      labelNames: ['signal'],
      registers: [registry],
    }),
    quotaRejections: new Counter({
      name: 'aop_quota_rejections_total',
      help: 'Batches refused with QUOTA_EXCEEDED, by the limit reached (records or bytes).',
      labelNames: ['limit'],
      registers: [registry],
    }),
    ingestRequests: new Counter({
      name: 'aop_ingest_requests_total',
      help: 'Ingestion requests by outcome: a stable error code or "accepted".',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    ingestDuration: new Histogram({
      name: 'aop_ingest_request_duration_seconds',
      help: 'Server-side processing time of ingestion batches.',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    backendRequests: new Counter({
      name: 'aop_backend_requests_total',
      help: 'Calls from the gateway to telemetry backends, by outcome.',
      labelNames: ['backend', 'outcome'],
      registers: [registry],
    }),
    backendDuration: new Histogram({
      name: 'aop_backend_request_duration_seconds',
      help: 'Latency of gateway calls to telemetry backends.',
      labelNames: ['backend'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    cardinalityOverflow: new Counter({
      name: 'aop_ingest_cardinality_overflow_total',
      help: 'Observations folded into "__other__" because a per-project cap was reached.',
      labelNames: ['dimension'],
      registers: [registry],
    }),
    alertEvaluations: new Counter({
      name: 'aop_alert_evaluations_total',
      help: 'Alert rule evaluations by outcome: breach, ok, noData, error.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    alertEvaluationDuration: new Histogram({
      name: 'aop_alert_evaluation_duration_seconds',
      help: 'Time to evaluate one alert rule, including the metrics query.',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    notificationAttempts: new Counter({
      name: 'aop_notification_attempts_total',
      help: 'Webhook delivery attempts by outcome: success, failed, blocked.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
  };
}
