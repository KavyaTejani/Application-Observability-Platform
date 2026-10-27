import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';

export interface PromRangeSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}
export interface PromInstantSample {
  metric: Record<string, string>;
  value: [number, string];
}

export interface PrometheusQueryApi {
  queryRange(
    expr: string,
    startSec: number,
    endSec: number,
    stepSec: number,
  ): Promise<PromRangeSeries[]>;
  query(expr: string, timeSec: number): Promise<PromInstantSample[]>;
  labelValues(label: string, match: string): Promise<string[]>;
}

export interface LokiStreamResult {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

export interface LokiQueryApi {
  queryRange(
    tenantId: string,
    query: string,
    params: { startNs: bigint; endNs: bigint; limit: number },
  ): Promise<LokiStreamResult[]>;
  labelValues(
    tenantId: string,
    label: string,
    query: string,
    startNs: bigint,
    endNs: bigint,
  ): Promise<string[]>;
}

const unavailable = (backend: string) =>
  new AppError(
    503,
    'QUERY_BACKEND_UNAVAILABLE',
    `${backend} is temporarily unavailable. Try again shortly.`,
    {
      retryable: true,
    },
  );

/** Shared fetch with deadline, platform metrics, and error mapping that never leaks backend detail. */
async function call<T>(
  backend: 'prometheus' | 'loki_query',
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  metrics: PlatformMetrics,
  logger: Logger,
): Promise<T> {
  const stop = metrics.backendDuration.startTimer({ backend });
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      metrics.backendRequests.inc({ backend, outcome: 'failure' });
      logger.warn({ err: (error as Error).message, backend }, 'Query backend unreachable');
      throw unavailable(label);
    }
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      data?: T;
      error?: string;
    } | null;
    if (!res.ok || !body || (backend === 'prometheus' && body.status !== 'success')) {
      metrics.backendRequests.inc({ backend, outcome: 'failure' });
      if (res.status >= 500 || res.status === 429) throw unavailable(label);
      // A 4xx for a server-generated query is a bug on our side, not the user's: log the detail,
      // return a generic error.
      logger.error(
        { backend, status: res.status, error: body?.error?.slice(0, 300) },
        'Query rejected by backend',
      );
      throw new AppError(502, 'QUERY_FAILED', 'The query could not be executed.');
    }
    metrics.backendRequests.inc({ backend, outcome: 'success' });
    return (body.data ?? body) as T;
  } finally {
    stop();
  }
}

export class PrometheusQueryClient implements PrometheusQueryApi {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly metrics: PlatformMetrics,
    private readonly logger: Logger,
  ) {}

  private post<T>(path: string, params: Record<string, string>): Promise<T> {
    return call<T>(
      'prometheus',
      'Metrics storage',
      `${this.baseUrl}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      },
      this.timeoutMs,
      this.metrics,
      this.logger,
    );
  }

  async queryRange(expr: string, startSec: number, endSec: number, stepSec: number) {
    const data = await this.post<{ result: PromRangeSeries[] }>('/api/v1/query_range', {
      query: expr,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
    return data.result;
  }

  async query(expr: string, timeSec: number) {
    const data = await this.post<{ result: PromInstantSample[] }>('/api/v1/query', {
      query: expr,
      time: String(timeSec),
    });
    return data.result;
  }

  async labelValues(label: string, match: string) {
    return this.post<string[]>(`/api/v1/label/${encodeURIComponent(label)}/values`, {
      'match[]': match,
    });
  }
}

export class LokiQueryClient implements LokiQueryApi {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly metrics: PlatformMetrics,
    private readonly logger: Logger,
  ) {}

  private get<T>(tenantId: string, path: string, params: Record<string, string>): Promise<T> {
    return call<T>(
      'loki_query',
      'Log storage',
      `${this.baseUrl}${path}?${new URLSearchParams(params)}`,
      // The tenant header is always set here, from the authorized scope (PRD LOG-002).
      { headers: { 'X-Scope-OrgID': tenantId } },
      this.timeoutMs,
      this.metrics,
      this.logger,
    );
  }

  async queryRange(
    tenantId: string,
    query: string,
    p: { startNs: bigint; endNs: bigint; limit: number },
  ) {
    const data = await this.get<{ result: LokiStreamResult[] }>(
      tenantId,
      '/loki/api/v1/query_range',
      {
        query,
        start: p.startNs.toString(),
        end: p.endNs.toString(),
        limit: String(p.limit),
        direction: 'backward',
      },
    );
    return data.result;
  }

  async labelValues(
    tenantId: string,
    label: string,
    query: string,
    startNs: bigint,
    endNs: bigint,
  ) {
    const data = await this.get<string[] | undefined>(
      tenantId,
      `/loki/api/v1/label/${encodeURIComponent(label)}/values`,
      {
        query,
        start: startNs.toString(),
        end: endNs.toString(),
      },
    );
    return data ?? [];
  }
}
