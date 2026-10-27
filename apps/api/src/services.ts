import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import type { RateLimiter } from './lib/rate-limiter.js';
import { ApiKeyService } from './modules/api-keys/api-key.service.js';
import { KeyAuthenticator } from './modules/api-keys/key-authenticator.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { ProjectService } from './modules/projects/project.service.js';
import { CustomerMetrics } from './modules/telemetry/customer-metrics.js';
import { TelemetryIngestService } from './modules/telemetry/ingest.service.js';
import { LokiWriter, type LogWriter } from './modules/telemetry/loki-writer.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';

export interface Services {
  auth: AuthService;
  sessions: SessionService;
  limiter: RateLimiter;
  keyAuth: KeyAuthenticator;
  apiKeys: ApiKeyService;
  projects: ProjectService;
  customerMetrics: CustomerMetrics;
  ingest: TelemetryIngestService;
}

export interface ServiceOptions {
  config: AppConfig;
  logger: Logger;
  limiter: RateLimiter;
  platformMetrics: PlatformMetrics;
  /** Overrides the Loki writer (tests). Defaults to a real writer when LOKI_URL is set. */
  logWriter?: LogWriter | null;
  now?: () => Date;
}

/** Builds the domain services. Shared by the server and the tests so both wire them alike. */
export function createServices(options: ServiceOptions): Services {
  const { config, logger, limiter, platformMetrics } = options;
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

  return {
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
      logger,
      now,
    }),
  };
}
