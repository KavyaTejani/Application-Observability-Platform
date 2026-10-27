import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SAFE_INBOUND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Correlation ID for logs and error responses. A well-formed inbound `X-Request-Id` is reused
 * so callers can correlate; anything else is replaced to keep log lines safe and bounded.
 */
export function generateRequestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers['x-request-id'];
  const id =
    typeof inbound === 'string' && SAFE_INBOUND_ID.test(inbound)
      ? inbound
      : `req_${randomBytes(12).toString('base64url')}`;
  res.setHeader('X-Request-Id', id);
  return id;
}
