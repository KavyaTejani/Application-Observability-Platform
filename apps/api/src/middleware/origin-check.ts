import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(origin: string | undefined, referer: string | undefined): string | null {
  if (origin && origin !== 'null') return origin;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * CSRF defence for cookie-authenticated APIs (OWASP: verify origin with standard headers).
 * State-changing requests must carry an `Origin` (or, failing that, `Referer`) from an allowed
 * origin. Requests with neither are rejected: browsers always send `Origin` on cross-origin
 * POSTs, and a missing header cannot be trusted. `SameSite=Lax` cookies are a second layer.
 */
export function originCheck(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = requestOrigin(req.headers.origin, req.headers.referer);
    if (!origin || !allowed.has(origin)) {
      throw new AppError(403, 'CSRF_ORIGIN_REJECTED', 'Request origin is not allowed.');
    }
    next();
  };
}
