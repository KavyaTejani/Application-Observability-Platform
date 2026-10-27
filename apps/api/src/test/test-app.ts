import { pino } from 'pino';
import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import {
  HealthService,
  type DependencyName,
  type DependencyProbe,
} from '../modules/health/health.service.js';
import { createPlatformMetrics } from '../observability/platform-metrics.js';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://localhost:27017/aop-test',
  REDIS_URL: 'redis://localhost:6379',
  PROMETHEUS_URL: 'http://localhost:9090',
  LOKI_URL: 'http://localhost:3100',
  SESSION_SECRET: 's'.repeat(32),
  TELEMETRY_KEY_PEPPER: 'p'.repeat(32),
});

const up: DependencyProbe = async () => undefined;

/** Builds the public app with stubbed dependency probes (all up unless overridden). */
export function buildTestApp(
  probes: Partial<Record<DependencyName, DependencyProbe | null>> = {},
  configOverrides: Partial<AppConfig> = {},
) {
  const metrics = createPlatformMetrics();
  const health = new HealthService(
    { mongodb: up, redis: up, prometheus: up, loki: up, ...probes },
    200,
  );
  const app = createApp({
    config: { ...testConfig, ...configOverrides },
    logger: pino({ level: 'silent' }),
    health,
    metrics,
  });
  return { app, metrics };
}
