import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  requestId: string;
}

/**
 * Carries the current request ID across async boundaries, so `logger.info()` anywhere in a
 * request handler (even deep in a service call) is tagged with the right request.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

const SAFE_INBOUND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Reuses a well-formed inbound `X-Request-Id`, otherwise generates one. */
export function resolveRequestId(inbound: string | string[] | undefined): string {
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return value && SAFE_INBOUND_ID.test(value)
    ? value
    : `req_${randomBytes(12).toString('base64url')}`;
}

export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;
