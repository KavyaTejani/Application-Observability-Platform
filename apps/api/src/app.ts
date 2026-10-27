import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import type { RateLimiter } from './lib/rate-limiter.js';
import { sessionAuth } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { originCheck } from './middleware/origin-check.js';
import { generateRequestId } from './middleware/request-id.js';
import { requestMetrics } from './middleware/request-metrics.js';
import { webAppRouter } from './middleware/web-app.js';
import { authRouter } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import type { SessionService } from './modules/auth/session.service.js';
import { healthRouter, statusRouter } from './modules/health/health.routes.js';
import type { HealthService } from './modules/health/health.service.js';
import { organizationRouter } from './modules/organizations/organization.routes.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  health: HealthService;
  metrics: PlatformMetrics;
  auth: AuthService;
  sessions: SessionService;
  limiter: RateLimiter;
}

/** Public HTTP application: product API, telemetry ingress, and health endpoints. */
export function createApp(deps: AppDeps): Express {
  const { config, logger, health, metrics, sessions } = deps;
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

  // Product API: cookie-session authenticated, so every state-changing request is origin-checked.
  const api = Router();
  api.use(originCheck(config.allowedOrigins));
  api.use(cookieParser());
  api.use(sessionAuth(sessions, config.session.cookieName));
  api.get('/', (_req, res) => {
    res.json({ name: 'Application Observability Platform API', version: 'v1' });
  });
  api.use('/status', statusRouter(health));
  api.use('/auth', authRouter(deps));
  api.use('/organizations', organizationRouter());
  app.use('/api/v1', api);

  if (config.webDistDir) app.use(webAppRouter(config.webDistDir));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
