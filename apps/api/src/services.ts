import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { AlertEvaluator } from './modules/alerts/alert-evaluator.js';
import { AlertWorker } from './modules/alerts/alert-worker.js';
import { AlertService } from './modules/alerts/alert.service.js';
import { Notifier } from './modules/alerts/notifier.js';
import { SecretBox } from './modules/alerts/secret-box.js';
import type { UrlPolicy } from './modules/alerts/ssrf.js';
import { WebhookClient, type WebhookSender } from './modules/alerts/webhook-client.js';
import type { AppConfig } from './config/index.js';
import type { RateLimiter } from './lib/rate-limiter.js';
import { ApiKeyService } from './modules/api-keys/api-key.service.js';
import { KeyAuthenticator } from './modules/api-keys/key-authenticator.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionService } from './modules/auth/session.service.js';
import type { HealthService } from './modules/health/health.service.js';
import { OperatorService } from './modules/operator/operator.service.js';
import { PlanLimitsCache } from './modules/plans/plan.service.js';
import { ProjectService } from './modules/projects/project.service.js';
import { QuotaService } from './modules/usage/quota.service.js';
import { CustomerMetrics } from './modules/telemetry/customer-metrics.js';
import { TelemetryIngestService } from './modules/telemetry/ingest.service.js';
import { LokiWriter, type LogWriter } from './modules/telemetry/loki-writer.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';
import {
  LokiQueryClient,
  PrometheusQueryClient,
  type LokiQueryApi,
  type PrometheusQueryApi,
} from './modules/query/backend-clients.js';
import { LogsQueryService } from './modules/query/logs-query.service.js';
import { MetricsQueryService } from './modules/query/metrics-query.service.js';

export interface Services {
  auth: AuthService;
  sessions: SessionService;
  limiter: RateLimiter;
  keyAuth: KeyAuthenticator;
  apiKeys: ApiKeyService;
  projects: ProjectService;
  customerMetrics: CustomerMetrics;
  ingest: TelemetryIngestService;
  metricsQuery: MetricsQueryService;
  logsQuery: LogsQueryService;
  alerts: AlertService;
  alertEvaluator: AlertEvaluator;
  notifier: Notifier;
  alertWorker: AlertWorker;
  quota: QuotaService;
  operator: OperatorService;
  now: () => Date;
}

export interface ServiceOptions {
  config: AppConfig;
  logger: Logger;
  limiter: RateLimiter;
  platformMetrics: PlatformMetrics;
  health: HealthService;
  /** Overrides the Loki writer (tests). Defaults to a real writer when LOKI_URL is set. */
  logWriter?: LogWriter | null;
  /** Override the query backends (tests). Default to real clients when URLs are configured. */
  prometheusQuery?: PrometheusQueryApi | null;
  lokiQuery?: LokiQueryApi | null;
  /** Override the webhook transport (tests). */
  webhookSender?: WebhookSender;
  /** Override DNS resolution for the SSRF policy (tests simulate rebinding with it). */
  webhookResolve?: UrlPolicy['resolve'];
  now?: () => Date;
}

/** Builds the domain services. Shared by the server and the tests so both wire them alike. */
export function createServices(options: ServiceOptions): Services {
  const { config, logger, limiter, platformMetrics, health } = options;
  const now = options.now ?? (() => new Date());

  const keyAuth = new KeyAuthenticator(
    config.telemetryKeyPepper,
    config.apiKeyCacheTtlMs,
    logger,
    now,
  );
  // Revoking or rotating a key evicts it from this process's cache immediately.
  const apiKeys = new ApiKeyService(
    config.telemetryKeyPepper,
    (keyId) => keyAuth.invalidate(keyId),
    now,
  );

  const customerMetrics = new CustomerMetrics(config.cardinality, (dimension) =>
    platformMetrics.cardinalityOverflow.inc({ dimension }),
  );
  const logWriter =
    options.logWriter !== undefined
      ? options.logWriter
      : config.lokiUrl
        ? new LokiWriter(config.lokiUrl, config.backendTimeoutMs)
        : null;

  const prometheusQuery =
    options.prometheusQuery !== undefined
      ? options.prometheusQuery
      : config.prometheusUrl
        ? new PrometheusQueryClient(
            config.prometheusUrl,
            config.backendTimeoutMs,
            platformMetrics,
            logger,
          )
        : null;
  const lokiQuery =
    options.lokiQuery !== undefined
      ? options.lokiQuery
      : config.lokiUrl
        ? new LokiQueryClient(config.lokiUrl, config.backendTimeoutMs, platformMetrics, logger)
        : null;

  // Webhooks: SSRF policy and sender shared by the save-time check, test sends, and deliveries.
  const urlPolicy: UrlPolicy = {
    allowPrivateNetworks: config.alerts.allowPrivateNetworks,
    ...(options.webhookResolve ? { resolve: options.webhookResolve } : {}),
  };
  const webhookSender =
    options.webhookSender ??
    new WebhookClient({ ...urlPolicy, timeoutMs: config.alerts.webhookTimeoutMs });
  const secretBox = new SecretBox(config.alerts.encryptionKey);
  const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const alertEvaluator = new AlertEvaluator({
    prometheus: prometheusQuery,
    logger,
    metrics: platformMetrics,
    workerId,
    now,
  });
  const notifier = new Notifier({
    sender: webhookSender,
    secretBox,
    logger,
    metrics: platformMetrics,
    workerId,
    appBaseUrl: config.appBaseUrl.replace(/\/+$/, ''),
    now,
  });

  const quota = new QuotaService({
    plans: new PlanLimitsCache(config.planCacheTtlMs, () => now().getTime()),
    metrics: platformMetrics,
    logger,
    now,
  });
  const alertWorker = new AlertWorker(alertEvaluator, notifier, logger, config.alerts.tickMs);

  return {
    now,
    quota,
    operator: new OperatorService({ health, metrics: platformMetrics, alertWorker, logger, now }),
    alerts: new AlertService(secretBox, urlPolicy, webhookSender),
    alertEvaluator,
    notifier,
    alertWorker,
    auth: new AuthService(logger),
    sessions: new SessionService(
      {
        secret: config.sessionSecret,
        idleTtlMs: config.session.idleTtlMs,
        absoluteTtlMs: config.session.absoluteTtlMs,
      },
      now,
    ),
    limiter,
    keyAuth,
    apiKeys,
    projects: new ProjectService(apiKeys),
    customerMetrics,
    ingest: new TelemetryIngestService({
      customerMetrics,
      logWriter,
      // Metrics are only "stored" if a Prometheus is configured to scrape them.
      metricsEnabled: Boolean(config.prometheusUrl),
      platformMetrics,
      quota,
      logger,
      now,
    }),
    metricsQuery: new MetricsQueryService(prometheusQuery, now),
    logsQuery: new LogsQueryService(lokiQuery, now),
  };
}
