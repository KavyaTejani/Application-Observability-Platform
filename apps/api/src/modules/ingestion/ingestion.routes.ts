import { Router, type Request, type RequestHandler } from 'express';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import type { IngestionPrincipal, KeyAuthenticator } from '../api-keys/key-authenticator.js';

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

/** Mounted at `/v1/telemetry`. Versioned separately from the product API (PRD §12). */
export function ingestionRouter(keys: KeyAuthenticator, limiter: RateLimiter): Router {
  const router = Router();
  router.use(requireApiKey(keys));

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
