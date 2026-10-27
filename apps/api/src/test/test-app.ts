import { pino } from 'pino';
import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import { MemoryRateLimiter, type RateLimiter } from '../lib/rate-limiter.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { SessionService } from '../modules/auth/session.service.js';
import {
  HealthService,
  type DependencyName,
  type DependencyProbe,
} from '../modules/health/health.service.js';
import { createPlatformMetrics } from '../observability/platform-metrics.js';

/** The browser origin tests send on state-changing requests (must be in allowedOrigins). */
export const TEST_ORIGIN = 'http://localhost:5173';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: TEST_ORIGIN,
  MONGODB_URI: 'mongodb://localhost:27017/aop-test',
  REDIS_URL: 'redis://localhost:6379',
  PROMETHEUS_URL: 'http://localhost:9090',
  LOKI_URL: 'http://localhost:3100',
  SESSION_SECRET: 's'.repeat(32),
  TELEMETRY_KEY_PEPPER: 'p'.repeat(32),
});

const up: DependencyProbe = async () => undefined;

export interface TestAppOptions {
  probes?: Partial<Record<DependencyName, DependencyProbe | null>>;
  config?: Partial<AppConfig>;
  limiter?: RateLimiter;
}

/** Builds the public app with stubbed dependency probes (all up unless overridden). */
export function buildTestApp(options: TestAppOptions = {}) {
  const config = { ...testConfig, ...options.config };
  const logger = pino({ level: 'silent' });
  const metrics = createPlatformMetrics();
  const health = new HealthService(
    { mongodb: up, redis: up, prometheus: up, loki: up, ...options.probes },
    200,
  );
  const sessions = new SessionService({
    secret: config.sessionSecret,
    idleTtlMs: config.session.idleTtlMs,
    absoluteTtlMs: config.session.absoluteTtlMs,
  });
  const app = createApp({
    config,
    logger,
    health,
    metrics,
    auth: new AuthService(logger),
    sessions,
    limiter: options.limiter ?? new MemoryRateLimiter(),
  });
  return { app, metrics, sessions, config };
}
