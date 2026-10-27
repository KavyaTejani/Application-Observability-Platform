import type { FieldErrors } from '@aop/validation';

/** Error envelope returned by every API failure: `{ error: { code, message, requestId, details } }`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: { fields?: FieldErrors; [key: string]: unknown },
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get fieldErrors(): FieldErrors {
    return this.details?.fields ?? {};
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string; details?: ApiError['details'] };
}

/**
 * Same-origin JSON client. The session cookie is HttpOnly and sent automatically by the
 * browser; no token is ever handled by JavaScript.
 */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & ErrorBody;
  if (!res.ok) {
    const err = body.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN_ERROR',
      err?.message ?? `Request failed (HTTP ${res.status})`,
      err?.requestId,
      err?.details,
    );
  }
  return body;
}

/** True when the error is shown under form fields, so no banner is needed. */
export const hasFieldErrors = (error: unknown): boolean =>
  error instanceof ApiError && Object.keys(error.fieldErrors).length > 0;

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId && error.status >= 500
      ? `${error.message} (reference: ${error.requestId})`
      : error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
