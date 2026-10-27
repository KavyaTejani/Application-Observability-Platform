import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import type { RateLimiter } from './lib/rate-limiter.js';
import { ApiKeyService } from './modules/api-keys/api-key.service.js';
import { KeyAuthenticator } from './modules/api-keys/key-authenticator.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { ProjectService } from './modules/projects/project.service.js';

export interface Services {
  auth: AuthService;
  sessions: SessionService;
  limiter: RateLimiter;
  keyAuth: KeyAuthenticator;
  apiKeys: ApiKeyService;
  projects: ProjectService;
}

/** Builds the domain services. Shared by the server and the tests so both wire them alike. */
export function createServices(
  config: AppConfig,
  logger: Logger,
  limiter: RateLimiter,
  now: () => Date = () => new Date(),
): Services {
  const keyAuth = new KeyAuthenticator(
    config.telemetryKeyPepper,
    config.apiKeyCacheTtlMs,
    logger,
    now,
  );
  // Revoking or rotating a key evicts it from this process's cache immediately.
  const apiKeys = new ApiKeyService(
    config.telemetryKeyPepper,
    (keyId) => keyAuth.invalidate(keyId),
    now,
  );
  return {
    auth: new AuthService(logger),
    sessions: new SessionService(
      {
        secret: config.sessionSecret,
        idleTtlMs: config.session.idleTtlMs,
        absoluteTtlMs: config.session.absoluteTtlMs,
      },
      now,
    ),
    limiter,
    keyAuth,
    apiKeys,
    projects: new ProjectService(apiKeys),
  };
}
