import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { resolveOrgScope, type TenantScope } from '../modules/authz/tenant-scope.js';
import type { SessionService } from '../modules/auth/session.service.js';

const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

/** The authenticated session for a handler behind `requireAuth`. */
export function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

/**
 * The verified tenant scope for a handler behind `requireOrgScope`. A handler that forgot the
 * middleware fails closed with a 500 instead of running without a tenant boundary.
 */
export function scopeOf(req: Request): TenantScope {
  if (!req.scope) throw new Error('Tenant scope missing: route is not behind requireOrgScope');
  return req.scope;
}

/**
 * Authentication: identifies the user from the session cookie, if any. It never rejects on its
 * own, so public routes can share it. Authorization (`requireAuth`, `requireOrgScope`) is a
 * separate step.
 */
export function sessionAuth(sessions: SessionService, cookieName: string): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[cookieName];
    if (typeof token === 'string' && token.length > 0 && token.length <= 128) {
      const session = await sessions.resolve(token);
      if (session) req.auth = { ...session, token };
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  authOf(req);
  next();
};

/**
 * Attaches a TenantScope for the `:organizationId` route parameter after verifying active
 * membership. Must run after `requireAuth`.
 */
export const requireOrgScope: RequestHandler = async (req, _res, next) => {
  req.scope = await resolveOrgScope(authOf(req).userId, req.params.organizationId);
  next();
};
