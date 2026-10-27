import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limiter.js';

export interface RateLimitRule {
  /** Stable rule name, used in the counter key. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Partition key, e.g. client IP. Return null to skip this rule for the request. */
  key: (req: Request) => string | null;
}

/**
 * Applies rate-limit rules in order and rejects with 429 and `Retry-After` on the first one that
 * is exceeded. If the limiter backend (Redis) is unavailable, the request is allowed and the
 * failure logged. This deliberately fails open, so a Redis outage cannot lock every user out of
 * login. The trade-off is documented in the threat model.
 */
export function rateLimit(limiter: RateLimiter, rules: RateLimitRule[]): RequestHandler {
  return async (req, res, next) => {
    for (const rule of rules) {
      const partition = rule.key(req);
      if (partition === null) continue;
      let result;
      try {
        result = await limiter.hit(`${rule.name}:${partition}`, rule.limit, rule.windowSeconds);
      } catch (error) {
        req.log.warn(
          { err: (error as Error).message, rule: rule.name },
          'Rate limiter unavailable',
        );
        continue;
      }
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
    }
    next();
  };
}

/** Client IP as resolved by Express (honours `trust proxy` only when configured). */
export const clientIp = (req: Request): string => req.ip ?? 'unknown';
