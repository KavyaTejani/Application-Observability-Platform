import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors.js';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import type { IngestionPrincipal, KeyAuthenticator } from '../api-keys/key-authenticator.js';
import type { TelemetryIngestService } from '../telemetry/ingest.service.js';

/**
 * Authenticates a telemetry writer by project API key. Browser sessions are not accepted here
 * (ING-002): this router never parses cookies.
 */
export function requireApiKey(keys: KeyAuthenticator): RequestHandler {
  return async (req, res, next) => {
    try {
      req.ingest = await keys.authenticate(req.headers.authorization);
    } catch (error) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="telemetry"');
      throw error;
    }
    next();
  };
}

export function ingestOf(req: Request): IngestionPrincipal {
  if (!req.ingest)
    throw new Error('Ingestion principal missing: route is not behind requireApiKey');
  return req.ingest;
}

export interface IngestionRouterDeps {
  keyAuth: KeyAuthenticator;
  limiter: RateLimiter;
  ingest: TelemetryIngestService;
  metrics: PlatformMetrics;
}

/** Mounted at `/v1/telemetry`. Versioned separately from the product API (PRD §12). */
export function ingestionRouter({
  keyAuth,
  limiter,
  ingest,
  metrics,
}: IngestionRouterDeps): Router {
  const router = Router();
  router.use(requireApiKey(keyAuth));

  /**
   * Telemetry batch ingestion (schema v1, docs/ingestion-api.md). The request-rate limit sits
   * per key, before validation. The daily usage quota arrives in M7.
   */
  router.post(
    '/batch',
    rateLimit(limiter, [
      { name: 'ingest:key', limit: 300, windowSeconds: 10, key: (req) => ingestOf(req).keyId },
    ]),
    async (req, res) => {
      const stop = metrics.ingestDuration.startTimer();
      try {
        const result = await ingest.ingest(ingestOf(req), req.body);
        metrics.ingestRequests.inc({ outcome: 'accepted' });
        res.status(202).json({ requestId: String(req.id), ...result });
      } catch (error) {
        metrics.ingestRequests.inc({
          outcome: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        });
        if (error instanceof AppError && error.status === 503) res.setHeader('Retry-After', '5');
        throw error;
      } finally {
        stop();
      }
    },
  );

  /**
   * Connection check for SDKs and the CLI (PRD §12.4, SDK-007). It confirms the key is valid
   * and reports which project it writes to, without accepting any telemetry.
   */
  router.post(
    '/test',
    rateLimit(limiter, [
      {
        name: 'telemetry-test:key',
        limit: 30,
        windowSeconds: 60,
        key: (req) => ingestOf(req).keyId,
      },
    ]),
    (req, res) => {
      const principal = ingestOf(req);
      res.json({
        ok: true,
        keyId: principal.keyId,
        project: {
          id: principal.projectId.toHexString(),
          name: principal.projectName,
          environment: principal.environment,
        },
        receivedAt: new Date().toISOString(),
      });
    },
  );

  return router;
}
