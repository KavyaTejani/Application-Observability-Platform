import { currentRequestId, requestContext, resolveRequestId } from './context.js';
import { sanitizeAttributes, sanitizeMessage } from './sanitize.js';
import {
  SdkError,
  type BatchRequest,
  type BatchResponse,
  type ClientOptions,
  type ClientStats,
  type ConnectionTestResult,
  type DropReason,
  type HttpRequestMetric,
  type LogRecord,
  type Severity,
} from './types.js';

const API_KEY_PATTERN = /^aop_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SERVER_MAX_BATCH = 500;
const UNMATCHED_ROUTE = '/__unmatched__';

type Item = { type: 'metric'; record: HttpRequestMetric } | { type: 'log'; record: LogRecord };

export type LogMethod = (message: string, attributes?: Record<string, unknown>) => void;
export type Logger = Record<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal', LogMethod>;

/** Minimal request/response shapes, so the SDK needs no Express dependency. */
export interface MiddlewareRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  baseUrl?: string;
  route?: { path?: unknown };
}
export interface MiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}
export type Middleware = (
  req: MiddlewareRequest,
  res: MiddlewareResponse,
  next: () => void,
) => void;

interface SendOutcome {
  kind: 'sent' | 'retry' | 'drop';
  retryAfterMs?: number;
  error?: SdkError;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Buffers telemetry in memory and sends it to the ingestion API in batches.
 *
 * Bounded by design (PRD SDK-005):
 * - At most `maxBufferSize` records are held. Beyond that, new records are dropped and counted.
 * - A batch is retried at most `maxRetries` times for transient failures, with exponential
 *   backoff and full jitter (honouring `Retry-After`), then dropped and counted.
 * - Permanent failures (invalid key, invalid batch) are dropped immediately and not retried.
 *
 * The API key is held in a private field: it is never logged, printed, or included in errors.
 */
export class ObservabilityClient {
  readonly #apiKey: string;
  readonly logger: Logger;
  private readonly endpoint: string;
  private readonly options: Required<
    Omit<ClientOptions, 'apiKey' | 'endpoint' | 'environment' | 'onError' | 'debug' | 'fetch'>
  > &
    Pick<ClientOptions, 'environment' | 'onError' | 'debug'>;
  private readonly fetchImpl: typeof fetch;
  private queue: Item[] = [];
  private flushing: Promise<void> | null = null;
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private bufferFullReported = false;
  private readonly counters: ClientStats = {
    buffered: 0,
    sent: { metrics: 0, logs: 0 },
    rejectedByServer: 0,
    dropped: { bufferFull: 0, nonRetryable: 0, retriesExhausted: 0, shutdown: 0 },
  };

  constructor(options: ClientOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new SdkError('endpoint must be an absolute URL', 'INVALID_CONFIG');
    }
    // Validate the key's shape without ever echoing it.
    if (!API_KEY_PATTERN.test(options.apiKey ?? '')) {
      throw new SdkError('apiKey is missing or not an ingestion key (aop_…)', 'INVALID_CONFIG');
    }
    if (!SERVICE_NAME_PATTERN.test(options.serviceName ?? '')) {
      throw new SdkError(
        'serviceName must be 1–63 chars of letters, digits, . _ -',
        'INVALID_CONFIG',
      );
    }

    this.#apiKey = options.apiKey;
    this.endpoint = endpoint.origin + endpoint.pathname.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.options = {
      serviceName: options.serviceName,
      environment: options.environment,
      flushIntervalMs: options.flushIntervalMs ?? 5000,
      maxBatchSize: Math.min(options.maxBatchSize ?? SERVER_MAX_BATCH, SERVER_MAX_BATCH),
      maxBufferSize: options.maxBufferSize ?? 10_000,
      maxRetries: options.maxRetries ?? 3,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
      retryMaxDelayMs: options.retryMaxDelayMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      logRequests: options.logRequests ?? true,
      onError: options.onError,
      debug: options.debug,
    };

    const log =
      (severity: Severity): LogMethod =>
      (message, attributes) =>
        this.log(severity, message, attributes);
    this.logger = {
      trace: log('TRACE'),
      debug: log('DEBUG'),
      info: log('INFO'),
      warn: log('WARN'),
      error: log('ERROR'),
      fatal: log('FATAL'),
    };

    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    // Never keep the host process alive just to flush telemetry.
    this.timer.unref();
  }

  /** Records one HTTP request. The middleware calls this; use it directly for other frameworks. */
  recordRequest(request: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }): void {
    this.enqueue({
      type: 'metric',
      record: {
        kind: 'http_request',
        timestamp: new Date().toISOString(),
        method: request.method.toUpperCase(),
        route: request.route.startsWith('/') ? request.route : `/${request.route}`,
        statusCode: request.statusCode,
        durationMs: Math.max(0, Math.round(request.durationMs * 1000) / 1000),
      },
    });
  }

  log(severity: Severity, message: string, attributes?: Record<string, unknown>): void {
    const requestId = currentRequestId();
    this.enqueue({
      type: 'log',
      record: {
        timestamp: new Date().toISOString(),
        severity,
        message: sanitizeMessage(message),
        ...(requestId ? { requestId } : {}),
        ...(attributes ? { attributes: sanitizeAttributes(attributes) } : {}),
      },
    });
  }

  /**
   * Express-compatible middleware: assigns a request ID (and echoes it as `X-Request-Id`), makes it
   * available to `logger` for the rest of the request, and records method, route *template*,
   * status, and duration when the response finishes. Raw URLs are never used as labels.
   */
  middleware(): Middleware {
    return (req, res, next) => {
      const started = performance.now();
      const requestId = resolveRequestId(req.headers['x-request-id']);
      res.setHeader('X-Request-Id', requestId);

      res.on('finish', () => {
        const routePath = req.route?.path;
        const route =
          typeof routePath === 'string'
            ? `${req.baseUrl ?? ''}${routePath}` || '/'
            : UNMATCHED_ROUTE;
        const durationMs = performance.now() - started;
        const statusCode = res.statusCode;
        this.recordRequest({ method: req.method, route, statusCode, durationMs });

        if (this.options.logRequests) {
          const severity: Severity =
            statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
          requestContext.run({ requestId }, () =>
            this.log(
              severity,
              `${req.method} ${route} ${statusCode} in ${Math.round(durationMs)} ms`,
              {
                method: req.method,
                route,
                statusCode,
                durationMs: Math.round(durationMs),
              },
            ),
          );
        }
      });

      requestContext.run({ requestId }, next);
    };
  }

  /** Sends everything currently buffered. Resolves when the buffer is empty. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (this.queue.length === 0) return;
    this.flushing = this.drain();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /**
   * Stops the flush timer and sends what is buffered, waiting at most `timeoutMs`. Records still
   * unsent after the deadline are dropped and counted. Call it on SIGTERM / SIGINT (SDK-006).
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    // Clear the deadline so a fast flush does not hold the process open until it fires.
    clearTimeout(deadline);
    if (timedOut && this.queue.length > 0) {
      this.drop(
        'shutdown',
        this.queue.length,
        new SdkError('shutdown deadline reached', 'SHUTDOWN_TIMEOUT'),
      );
      this.queue = [];
    }
  }

  /** Verifies endpoint and key without sending telemetry (SDK-007). */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}/v1/telemetry/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as {
        project?: ConnectionTestResult['project'];
        error?: { code: string; message: string };
      };
      return res.ok
        ? { ok: true, status: res.status, project: body.project }
        : {
            ok: false,
            status: res.status,
            error: body.error ?? { code: 'HTTP_ERROR', message: `HTTP ${res.status}` },
          };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: { code: 'NETWORK_ERROR', message: (error as Error).message },
      };
    }
  }

  stats(): ClientStats {
    return {
      ...this.counters,
      buffered: this.queue.length,
      sent: { ...this.counters.sent },
      dropped: { ...this.counters.dropped },
    };
  }

  private enqueue(item: Item): void {
    if (this.closed) {
      this.counters.dropped.shutdown += 1;
      return;
    }
    if (this.queue.length >= this.options.maxBufferSize) {
      this.counters.dropped.bufferFull += 1;
      if (!this.bufferFullReported) {
        this.bufferFullReported = true;
        this.report(
          new SdkError('telemetry buffer full; dropping new records', 'BUFFER_FULL', undefined, 1),
        );
      }
      return;
    }
    this.queue.push(item);
    if (this.queue.length >= this.options.maxBatchSize && !this.flushing) void this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxBatchSize);
      await this.sendWithRetries(batch);
    }
  }

  private async sendWithRetries(batch: Item[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.send(batch);
      if (outcome.kind === 'sent') return;
      if (outcome.kind === 'drop') {
        this.drop('nonRetryable', batch.length, outcome.error);
        return;
      }
      if (attempt >= this.options.maxRetries) {
        this.drop('retriesExhausted', batch.length, outcome.error);
        return;
      }
      const backoff = Math.min(
        this.options.retryMaxDelayMs,
        this.options.retryBaseDelayMs * 2 ** attempt,
      );
      const jittered = Math.random() * backoff; // full jitter
      const delay = Math.min(
        this.options.retryMaxDelayMs,
        Math.max(jittered, outcome.retryAfterMs ?? 0),
      );
      this.options.debug?.(
        `batch of ${batch.length} failed (${outcome.error?.code}); retry ${attempt + 1} in ${Math.round(delay)} ms`,
      );
      await sleep(delay);
    }
  }

  private async send(batch: Item[]): Promise<SendOutcome> {
    const body: BatchRequest = {
      schemaVersion: 1,
      service: {
        name: this.options.serviceName,
        ...(this.options.environment ? { environment: this.options.environment } : {}),
      },
      metrics: batch.flatMap((item) => (item.type === 'metric' ? [item.record] : [])),
      logs: batch.flatMap((item) => (item.type === 'log' ? [item.record] : [])),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/v1/telemetry/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      return {
        kind: 'retry',
        error: new SdkError(`network error: ${(error as Error).message}`, 'NETWORK_ERROR'),
      };
    }

    const payload = (await res.json().catch(() => ({}))) as Partial<BatchResponse> & {
      error?: { code?: string; message?: string; details?: { retryable?: boolean } };
    };

    if (res.status === 202) {
      this.counters.sent.metrics += payload.accepted?.metrics ?? 0;
      this.counters.sent.logs += payload.accepted?.logs ?? 0;
      const rejected = (payload.rejected?.metrics ?? 0) + (payload.rejected?.logs ?? 0);
      this.counters.rejectedByServer += rejected;
      this.bufferFullReported = false;
      if (rejected > 0) {
        const first = payload.errors?.[0];
        this.report(
          new SdkError(
            `server rejected ${rejected} record(s)${first ? `: ${first.message}` : ''}`,
            'RECORDS_REJECTED',
            202,
            rejected,
          ),
        );
      }
      this.options.debug?.(`sent ${batch.length} record(s)`);
      return { kind: 'sent' };
    }

    const error = new SdkError(
      payload.error?.message ?? `ingestion failed with HTTP ${res.status}`,
      payload.error?.code ?? 'HTTP_ERROR',
      res.status,
      batch.length,
    );
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || payload.error?.details?.retryable === false) return { kind: 'drop', error };

    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      kind: 'retry',
      error,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    };
  }

  private drop(reason: DropReason, count: number, error?: SdkError): void {
    this.counters.dropped[reason] += count;
    this.report(
      error ??
        new SdkError(
          `dropped ${count} record(s): ${reason}`,
          reason.toUpperCase(),
          undefined,
          count,
        ),
    );
  }

  private report(error: SdkError): void {
    this.options.debug?.(`telemetry error ${error.code}: ${error.message}`);
    try {
      this.options.onError?.(error);
    } catch {
      // A failing user callback must never break the host application.
    }
  }
}

export function createClient(options: ClientOptions): ObservabilityClient {
  return new ObservabilityClient(options);
}
