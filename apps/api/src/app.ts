import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { generateRequestId } from './middleware/request-id.js';
import { requestMetrics } from './middleware/request-metrics.js';
import { healthRouter } from './modules/health/health.routes.js';
import type { HealthService } from './modules/health/health.service.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  health: HealthService;
  metrics: PlatformMetrics;
}

/** Public HTTP application: product API, telemetry ingress, and health endpoints. */
export function createApp({ config, logger, health, metrics }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(
    pinoHttp({
      logger,
      genReqId: generateRequestId,
      // Health probes run every few seconds; logging them would drown out real traffic.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health/') ?? false },
      // Log only what is needed to correlate a request; headers and bodies may carry secrets.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(requestMetrics(metrics));
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter(health));

  app.get('/api/v1', (_req, res) => {
    res.json({ name: 'Application Observability Platform API', version: 'v1' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
