import {
  MAX_RECORD_AGE_MS,
  MAX_RECORD_FUTURE_SKEW_MS,
  MAX_RECORDS_PER_BATCH,
  batchEnvelopeSchema,
  httpRequestMetricSchema,
  logRecordSchema,
  toFieldErrors,
  type HttpRequestMetric,
  type LogRecord,
} from '@aop/validation';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import type { IngestionPrincipal } from '../api-keys/key-authenticator.js';
import { ProjectModel } from '../projects/project.model.js';
import type { CustomerMetrics } from './customer-metrics.js';
import { LokiWriteError, type LogWriter } from './loki-writer.js';
import { methodLabel, normalizeRoute, statusClassLabel } from './normalize.js';
import { redactAttributes, redactText } from './redact.js';

export type Signal = 'metrics' | 'logs';

export interface RecordError {
  signal: Signal;
  index: number;
  code: 'INVALID_RECORD' | 'TIMESTAMP_OUT_OF_RANGE';
  message: string;
}

export interface IngestResult {
  accepted: Record<Signal, number>;
  rejected: Record<Signal, number>;
  /** First errors only (bounded response size). Counts above are exact. */
  errors: RecordError[];
}

const MAX_REPORTED_ERRORS = 50;
const TOUCH_INTERVAL_MS = 30_000;

export interface IngestDeps {
  customerMetrics: CustomerMetrics;
  /** `null` when this deployment runs without the corresponding backend. */
  logWriter: LogWriter | null;
  metricsEnabled: boolean;
  platformMetrics: PlatformMetrics;
  logger: Logger;
  now?: () => Date;
}

/**
 * Validates, scopes, and routes one telemetry batch.
 *
 * Acknowledgement contract (docs/ingestion-api.md):
 * - Logs count as accepted only once Loki has acknowledged the push.
 * - Metrics count as accepted once recorded in the gateway registry. They become queryable after
 *   the next Prometheus scrape, and are lost if the process stops before that scrape.
 * - If the log backend fails, the whole request fails (503) and *nothing* from it is recorded,
 *   so an SDK retry of the batch cannot double-count metrics.
 */
export class TelemetryIngestService {
  private readonly now: () => Date;

  constructor(private readonly deps: IngestDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async ingest(principal: IngestionPrincipal, body: unknown): Promise<IngestResult> {
    const envelope = this.parseEnvelope(body);
    // The project's environment is authoritative (PRD ING-013).
    const declared = envelope.service.environment;
    if (declared !== undefined && declared !== principal.environment) {
      throw new AppError(
        400,
        'ENVIRONMENT_MISMATCH',
        `This key belongs to a "${principal.environment}" project, but the batch declares "${declared}".`,
        { expected: principal.environment },
      );
    }
    const now = this.now().getTime();

    const errors: RecordError[] = [];
    const rejected: Record<Signal, number> = { metrics: 0, logs: 0 };
    const reject = (signal: Signal, index: number, code: RecordError['code'], message: string) => {
      rejected[signal] += 1;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ signal, index, code, message });
    };
    const inWindow = (iso: string) => {
      const t = Date.parse(iso);
      return t >= now - MAX_RECORD_AGE_MS && t <= now + MAX_RECORD_FUTURE_SKEW_MS;
    };

    const metrics = this.validateRecords(
      'metrics',
      envelope.metrics,
      httpRequestMetricSchema,
      inWindow,
      reject,
    );
    const logs = this.validateRecords('logs', envelope.logs, logRecordSchema, inWindow, reject);
    const acceptedCount = metrics.length + logs.length;

    if (acceptedCount === 0) {
      this.countRejections(rejected);
      throw new AppError(400, 'NO_VALID_RECORDS', 'No record in the batch was valid.', {
        rejected,
        errors,
      });
    }
    if (metrics.length > 0 && !this.deps.metricsEnabled) {
      throw backendUnavailable('metrics', 'Metrics storage is not configured in this deployment.');
    }
    if (logs.length > 0 && !this.deps.logWriter) {
      throw backendUnavailable('logs', 'Log storage is not configured in this deployment.');
    }

    const service = envelope.service.name;
    if (logs.length > 0 && this.deps.logWriter) await this.writeLogs(principal, service, logs);
    for (const metric of metrics) this.observe(principal, service, metric);

    const accepted = { metrics: metrics.length, logs: logs.length };
    const { ingestRecords } = this.deps.platformMetrics;
    ingestRecords.inc({ signal: 'metrics', outcome: 'accepted' }, accepted.metrics);
    ingestRecords.inc({ signal: 'logs', outcome: 'accepted' }, accepted.logs);
    this.countRejections(rejected);
    this.touchProject(principal);
    return { accepted, rejected, errors };
  }

  private readonly lastTouched = new Map<string, number>();

  /**
   * Records "last data received" for the project (shown as telemetry freshness in the UI). It is
   * written at most every 30 s per project, off the request path, and `$max` keeps it monotonic
   * when several instances write.
   */
  private touchProject(principal: IngestionPrincipal): void {
    const key = principal.projectId.toHexString();
    const now = this.now();
    if (now.getTime() - (this.lastTouched.get(key) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(key, now.getTime());
    ProjectModel.updateOne(
      { _id: principal.projectId, organizationId: principal.organizationId },
      { $max: { lastTelemetryAt: now } },
    ).catch((error: unknown) =>
      this.deps.logger.warn({ err: (error as Error).message }, 'Failed to record lastTelemetryAt'),
    );
  }

  private parseEnvelope(body: unknown) {
    const parsed = batchEnvelopeSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_BATCH', 'The batch envelope is invalid.', {
        fields: toFieldErrors(parsed.error),
      });
    }
    const envelope = parsed.data;
    const total = envelope.metrics.length + envelope.logs.length;
    if (total > MAX_RECORDS_PER_BATCH) {
      throw new AppError(
        413,
        'BATCH_TOO_LARGE',
        `A batch may contain at most ${MAX_RECORDS_PER_BATCH} records.`,
        { limit: MAX_RECORDS_PER_BATCH, received: total },
      );
    }
    if (total === 0) throw new AppError(400, 'EMPTY_BATCH', 'The batch contains no records.');
    return envelope;
  }

  private validateRecords<T extends { timestamp: string }>(
    signal: Signal,
    records: unknown[],
    schema: z.ZodType<T>,
    inWindow: (iso: string) => boolean,
    reject: (signal: Signal, index: number, code: RecordError['code'], message: string) => void,
  ): T[] {
    const valid: T[] = [];
    records.forEach((record, index) => {
      const parsed = schema.safeParse(record);
      if (!parsed.success) {
        const fields = toFieldErrors(parsed.error);
        const [field, message] = Object.entries(fields)[0] ?? ['_root', 'invalid record'];
        reject(signal, index, 'INVALID_RECORD', `${field}: ${message}`);
        return;
      }
      if (!inWindow(parsed.data.timestamp)) {
        reject(
          signal,
          index,
          'TIMESTAMP_OUT_OF_RANGE',
          'timestamp must be within the last 24 h and at most 5 min ahead',
        );
        return;
      }
      valid.push(parsed.data);
    });
    return valid;
  }

  private async writeLogs(principal: IngestionPrincipal, service: string, logs: LogRecord[]) {
    const writer = this.deps.logWriter;
    if (!writer) return;
    const { backendRequests, backendDuration } = this.deps.platformMetrics;
    const stop = backendDuration.startTimer({ backend: 'loki' });
    try {
      await writer.write(
        // Loki tenant = organization (PRD LOG-009), always from the verified key.
        principal.organizationId.toHexString(),
        {
          projectId: principal.projectId.toHexString(),
          service,
          environment: principal.environment,
        },
        logs.map((log) => ({
          timestampMs: Date.parse(log.timestamp),
          severity: log.severity,
          message: redactText(log.message),
          requestId: log.requestId,
          attributes: log.attributes ? redactAttributes(log.attributes) : undefined,
        })),
      );
      backendRequests.inc({ backend: 'loki', outcome: 'success' });
    } catch (error) {
      backendRequests.inc({ backend: 'loki', outcome: 'failure' });
      this.deps.logger.error({ err: (error as Error).message }, 'Log backend write failed');
      const retryable = !(error instanceof LokiWriteError) || error.retryable;
      throw new AppError(
        retryable ? 503 : 502,
        'BACKEND_WRITE_FAILED',
        retryable
          ? 'Log storage is temporarily unavailable. Nothing from this batch was recorded; retry it.'
          : 'Log storage rejected the batch. Nothing from this batch was recorded.',
        { retryable },
      );
    } finally {
      stop();
    }
  }

  private observe(principal: IngestionPrincipal, service: string, metric: HttpRequestMetric) {
    this.deps.customerMetrics.observe({
      organizationId: principal.organizationId.toHexString(),
      projectId: principal.projectId.toHexString(),
      environment: principal.environment,
      service,
      method: methodLabel(metric.method),
      route: normalizeRoute(metric.route),
      statusClass: statusClassLabel(metric.statusCode),
      durationSeconds: metric.durationMs / 1000,
    });
  }

  private countRejections(rejected: Record<Signal, number>) {
    const { ingestRecords } = this.deps.platformMetrics;
    ingestRecords.inc({ signal: 'metrics', outcome: 'rejected' }, rejected.metrics);
    ingestRecords.inc({ signal: 'logs', outcome: 'rejected' }, rejected.logs);
  }
}

function backendUnavailable(signal: Signal, message: string) {
  return new AppError(503, 'BACKEND_NOT_CONFIGURED', message, { signal, retryable: false });
}
