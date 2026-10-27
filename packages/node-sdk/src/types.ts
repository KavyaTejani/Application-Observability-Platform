/** Wire format for schema version 1 of the ingestion API (docs/ingestion-api.md). */

export type Environment = 'development' | 'staging' | 'production';
export type Severity = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type AttributeValue = string | number | boolean | null;
export type Attributes = Record<string, AttributeValue>;

export interface HttpRequestMetric {
  kind: 'http_request';
  timestamp: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export interface LogRecord {
  timestamp: string;
  severity: Severity;
  message: string;
  requestId?: string;
  attributes?: Attributes;
}

export interface BatchRequest {
  schemaVersion: 1;
  service: { name: string; environment?: Environment };
  metrics: HttpRequestMetric[];
  logs: LogRecord[];
}

export interface BatchResponse {
  requestId: string;
  accepted: { metrics: number; logs: number };
  rejected: { metrics: number; logs: number };
  errors: Array<{ signal: 'metrics' | 'logs'; index: number; code: string; message: string }>;
}

export interface ClientOptions {
  /** Base URL of the platform, e.g. `https://observability.example.com`. */
  endpoint: string;
  /** Project ingestion key (`aop_…`). Read it from the environment; never commit it. */
  apiKey: string;
  /** Name of this service; becomes the `service` label. */
  serviceName: string;
  /** Must match the project's environment if set. */
  environment?: Environment;
  /** Send buffered telemetry at least this often. Default 5000 ms. */
  flushIntervalMs?: number;
  /** Records per request (server maximum 500). Default 500. */
  maxBatchSize?: number;
  /** Records held in memory; when full, new records are dropped and counted. Default 10 000. */
  maxBufferSize?: number;
  /** Retries per batch for transient failures (network, 429, 5xx). Default 3. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  requestTimeoutMs?: number;
  /** Log every HTTP request seen by the middleware (INFO, WARN for 4xx, ERROR for 5xx). Default true. */
  logRequests?: boolean;
  /** Called when a batch is dropped or the server rejects records. Never receives the API key. */
  onError?: (error: SdkError) => void;
  /** Diagnostic output; messages never contain the API key. */
  debug?: (message: string) => void;
  /** Injectable fetch, for tests and custom agents. */
  fetch?: typeof fetch;
}

export type DropReason = 'bufferFull' | 'nonRetryable' | 'retriesExhausted' | 'shutdown';

export class SdkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly droppedRecords = 0,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

export interface ClientStats {
  buffered: number;
  sent: { metrics: number; logs: number };
  /** Records the server refused individually (e.g. invalid timestamp). */
  rejectedByServer: number;
  dropped: Record<DropReason, number>;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: number;
  project?: { id: string; name: string; environment: Environment };
  error?: { code: string; message: string };
}
