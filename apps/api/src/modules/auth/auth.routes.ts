import { loginSchema, registerSchema } from '@aop/validation';
import { Router, type CookieOptions, type Response } from 'express';
import type { AppConfig } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { parseInput } from '../../lib/validate.js';
import { authOf, requireAuth } from '../../middleware/authenticate.js';
import { clientIp, rateLimit } from '../../middleware/rate-limit.js';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import { listOrganizationsForUser } from '../organizations/organization.service.js';
import type { AuthService } from './auth.service.js';
import type { SessionService } from './session.service.js';

export interface AuthRouterDeps {
  config: AppConfig;
  auth: AuthService;
  sessions: SessionService;
  limiter: RateLimiter;
  metrics: PlatformMetrics;
}

/** Normalized email from an unvalidated body, for rate-limit keys only. */
const bodyEmail = (body: unknown): string | null => {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : null;
};

export function authRouter({ config, auth, sessions, limiter, metrics }: AuthRouterDeps): Router {
  const router = Router();
  const { cookieName, absoluteTtlMs } = config.session;

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  };

  const issueSession = async (res: Response, userId: Parameters<SessionService['create']>[0]) => {
    const { token } = await sessions.create(userId);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: absoluteTtlMs });
  };

  router.post(
    '/register',
    rateLimit(limiter, [{ name: 'register:ip', limit: 10, windowSeconds: 3600, key: clientIp }]),
    async (req, res) => {
      const input = parseInput(registerSchema, req.body);
      const { user, userId, organization } = await auth.register(input);
      await issueSession(res, userId);
      metrics.authEvents.inc({ event: 'register' });
      res.status(201).json({ user, organizations: [organization] });
    },
  );

  router.post(
    '/login',
    rateLimit(limiter, [
      { name: 'login:ip', limit: 30, windowSeconds: 900, key: clientIp },
      {
        name: 'login:ip-email',
        limit: 10,
        windowSeconds: 900,
        key: (req) => {
          const email = bodyEmail(req.body);
          return email ? `${clientIp(req)}:${email}` : null;
        },
      },
    ]),
    async (req, res) => {
      const input = parseInput(loginSchema, req.body);
      let result;
      try {
        result = await auth.login(input);
      } catch (error) {
        if (error instanceof AppError) metrics.authEvents.inc({ event: 'login_failure' });
        throw error;
      }
      // Session fixation defence: any pre-existing session is discarded and a new ID issued.
      if (req.auth) await sessions.revoke(req.auth.token);
      await issueSession(res, result.userId);
      metrics.authEvents.inc({ event: 'login_success' });
      res.json({ user: result.user });
    },
  );

  router.post('/logout', async (req, res) => {
    if (req.auth) await sessions.revoke(req.auth.token);
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const { userId, token } = authOf(req);
    const user = await auth.getUser(userId);
    if (!user) {
      // The account was disabled or removed after the session was issued.
      await sessions.revoke(token);
      res.clearCookie(cookieName, cookieOptions);
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    res.json({ user, organizations: await listOrganizationsForUser(userId) });
  });

  return router;
}
