import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/index.js';
import { pingLoki, pingPrometheus } from './infra/http-backends.js';
import { connectMongo, pingMongo } from './infra/mongo.js';
import { createRedis } from './infra/redis.js';
import { createInternalApp } from './internal-app.js';
import { createLogger } from './lib/logger.js';
import { RedisRateLimiter } from './lib/rate-limiter.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { HealthService } from './modules/health/health.service.js';
import { ensureDefaultPlan } from './modules/plans/plan.service.js';
import { createPlatformMetrics } from './observability/platform-metrics.js';

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nSee .env.example for the required variables.\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** Keeps retrying the initial MongoDB connection so the API can start before the database. */
async function connectMongoWithRetry(
  uri: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await connectMongo(uri, logger);
      return;
    } catch (error) {
      const delayMs = Math.min(attempt * 1000, 10_000);
      logger.warn({ attempt, delayMs, err: (error as Error).message }, 'MongoDB connect failed');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config);
  const metrics = createPlatformMetrics();
  const redis = createRedis(config.redisUrl, logger);
  const { prometheusUrl, lokiUrl } = config;
  if (!prometheusUrl || !lokiUrl) {
    logger.warn(
      { prometheus: Boolean(prometheusUrl), loki: Boolean(lokiUrl) },
      'Telemetry backend not configured; metrics/log features are unavailable in this deployment',
    );
  }

  const health = new HealthService(
    {
      mongodb: () => pingMongo(mongoose.connection),
      redis: () => redis.ping(),
      prometheus: prometheusUrl ? (signal) => pingPrometheus(prometheusUrl, signal) : null,
      loki: lokiUrl ? (signal) => pingLoki(lokiUrl, signal) : null,
    },
    config.healthCheckTimeoutMs,
    (dependency, error) => {
      metrics.dependencyProbeFailures.inc({ dependency });
      logger.warn({ dependency, err: (error as Error).message }, 'Readiness probe failed');
    },
  );

  const app = createApp({
    config,
    logger,
    health,
    metrics,
    auth: new AuthService(logger),
    sessions: new SessionService({
      secret: config.sessionSecret,
      idleTtlMs: config.session.idleTtlMs,
      absoluteTtlMs: config.session.absoluteTtlMs,
    }),
    limiter: new RedisRateLimiter(redis),
  });
  const internalApp = createInternalApp(metrics);

  const server: Server = app.listen(config.port, () =>
    logger.info({ port: config.port, env: config.env }, 'API listening'),
  );
  const internalServer: Server = internalApp.listen(config.internalPort, () =>
    logger.info({ port: config.internalPort }, 'Internal metrics listener started'),
  );

  void connectMongoWithRetry(config.mongoUri, logger).then(async () => {
    try {
      await ensureDefaultPlan();
    } catch (error) {
      logger.error({ err: error }, 'Failed to seed the default plan');
    }
  });
  redis.connect().catch((err: Error) => logger.warn({ err: err.message }, 'Redis connect failed'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await Promise.allSettled([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => internalServer.close(() => resolve())),
    ]);
    await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
