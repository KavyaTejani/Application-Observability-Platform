import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { AppError, notFound } from '../../lib/errors.js';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { clientIp, rateLimit } from '../../middleware/rate-limit.js';
import type { OperatorService } from './operator.service.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Operator authentication: a static bearer token from configuration. The operator is not an
 * organization role, so sessions grant nothing here. Both sides are hashed before the
 * constant-time comparison, which also hides the token's length.
 */
function requireOperatorToken(token: string): RequestHandler {
  const expected = digest(token);
  return (req, res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="operator"');
      throw new AppError(401, 'UNAUTHENTICATED', 'A valid operator token is required.');
    }
    next();
  };
}

/**
 * Mounted at `/api/v1/operator`. `/health` is the documented path; `/status` serves the same
 * report under a name that browser content blockers do not filter (the web operator view uses
 * it). Without OPERATOR_TOKEN the routes do not exist on the public port.
 */
export function operatorRouter(
  operator: OperatorService,
  token: string | undefined,
  limiter: RateLimiter,
): Router {
  const router = Router();
  if (!token) {
    router.use(() => {
      throw notFound();
    });
    return router;
  }
  router.use(
    rateLimit(limiter, [{ name: 'operator:ip', limit: 60, windowSeconds: 60, key: clientIp }]),
    requireOperatorToken(token),
  );
  router.get(['/health', '/status'], async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ report: await operator.report() });
  });
  return router;
}

/** Internal-listener variant: reachable only on the private network, so no token. */
export function internalOperatorRouter(operator: OperatorService): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    res.json({ report: await operator.report() });
  });
  return router;
}
