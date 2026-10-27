/**
 * Application error with a stable, machine-readable code. Handlers throw these; the error
 * middleware turns them into the documented `{ error: { code, message, requestId, details } }`
 * response shape.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'The requested resource was not found.') =>
  new AppError(404, 'NOT_FOUND', message);
