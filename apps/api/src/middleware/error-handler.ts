import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound());

interface HttpLikeError {
  status?: number;
  type?: string;
}

/**
 * Converts every error into the documented error envelope. Unexpected errors are logged with
 * their stack server-side and returned as a generic 500 carrying only the request ID.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const requestId = String(req.id);

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, requestId, details: err.details },
    });
    return;
  }

  // Errors raised by express.json() (malformed JSON, oversized body).
  const httpErr = err as HttpLikeError;
  if (httpErr.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.', requestId },
    });
    return;
  }
  if (httpErr.type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.', requestId },
    });
    return;
  }

  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Quote the request ID if you report this.',
      requestId,
    },
  });
};
