import { pino } from 'pino';
import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import { MemoryRateLimiter, type RateLimiter } from '../lib/rate-limiter.js';
import {
  HealthService,
  type DependencyName,
  type DependencyProbe,
} from '../modules/health/health.service.js';
import { createPlatformMetrics } from '../observability/platform-metrics.js';
import { createServices } from '../services.js';

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

/**
 * Admits everything. Used by suites that create many accounts from one test IP; the rate
 * limit itself is covered by dedicated tests that use the real limiters.
 */
export const unlimited: RateLimiter = {
  hit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
};

export interface TestAppOptions {
  probes?: Partial<Record<DependencyName, DependencyProbe | null>>;
  config?: Partial<AppConfig>;
  limiter?: RateLimiter;
  /** Injectable clock for expiry tests. */
  now?: () => Date;
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
  const services = createServices(
    config,
    logger,
    options.limiter ?? new MemoryRateLimiter(),
    options.now,
  );
  const app = createApp({ config, logger, health, metrics, ...services });
  return { app, metrics, config, ...services };
}
