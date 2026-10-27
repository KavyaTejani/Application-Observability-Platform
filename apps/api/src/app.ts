import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import { sessionAuth } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { originCheck } from './middleware/origin-check.js';
import { generateRequestId } from './middleware/request-id.js';
import { requestMetrics } from './middleware/request-metrics.js';
import { webAppRouter } from './middleware/web-app.js';
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter, statusRouter } from './modules/health/health.routes.js';
import type { HealthService } from './modules/health/health.service.js';
import { ingestionRouter } from './modules/ingestion/ingestion.routes.js';
import { organizationRouter } from './modules/organizations/organization.routes.js';
import { organizationProjectsRouter, projectRouter } from './modules/projects/project.routes.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';
import type { Services } from './services.js';

export interface AppDeps extends Services {
  config: AppConfig;
  logger: Logger;
  health: HealthService;
  metrics: PlatformMetrics;
}

/** Public HTTP application: product API, telemetry ingress, and health endpoints. */
export function createApp(deps: AppDeps): Express {
  const { config, logger, health, metrics, sessions, projects, apiKeys, keyAuth, limiter, ingest } =
    deps;
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
  api.use('/organizations/:organizationId/projects', organizationProjectsRouter(projects));
  api.use('/organizations', organizationRouter());
  api.use('/projects/:projectId/keys', apiKeyRouter(apiKeys));
  api.use('/projects', projectRouter(projects));
  app.use('/api/v1', api);

  // Telemetry ingress: project-key authenticated. No cookies, so no CSRF surface.
  app.use('/v1/telemetry', ingestionRouter({ keyAuth, limiter, ingest, metrics }));

  if (config.webDistDir) app.use(webAppRouter(config.webDistDir));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
