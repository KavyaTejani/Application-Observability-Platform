import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import type { PlanLimitsCache } from '../plans/plan.service.js';
import { OrgUsageDailyModel, UsageDailyModel } from './usage.models.js';

/** `YYYY-MM-DD` of the UTC day containing `date`. Quota windows are UTC days (PRD QUOTA-001). */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The start of the next UTC day, when the daily quota resets. */
export function nextUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/** Whole seconds until the quota resets, for `Retry-After` (at least 1). */
export function secondsUntilReset(date: Date): number {
  return Math.max(1, Math.ceil((nextUtcMidnight(date).getTime() - date.getTime()) / 1000));
}

export interface QuotaSubject {
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
}

/** Records and bytes held against an organization's daily quota for one batch. */
export interface Reservation {
  subject: QuotaSubject;
  dayUtc: string;
  records: number;
  bytes: number;
}

export interface QuotaDeps {
  plans: PlanLimitsCache;
  metrics: PlatformMetrics;
  logger: Logger;
  now: () => Date;
}

/**
 * Daily ingestion quota per organization (PRD §8.8).
 *
 * Source of truth: the `orgUsageDaily` counter in MongoDB. A reservation is one conditional
 * `$inc` whose filter requires `records <= limit - n` and `bytes <= limit - b`, so concurrent
 * batches are serialized by MongoDB's document-level atomicity and cannot together exceed the
 * limit. No separate reconciliation is needed because no second counter exists; the per-project
 * `usageDaily` documents are a breakdown for display and are not used for enforcement.
 *
 * A batch is admitted or refused whole: there is no partial acceptance at the quota boundary.
 */
export class QuotaService {
  constructor(private readonly deps: QuotaDeps) {}

  /**
   * Reserves quota for a batch or throws `429 QUOTA_EXCEEDED`. If MongoDB cannot be reached the
   * request fails with a retryable `503` rather than bypassing the quota (fail closed).
   */
  async reserve(subject: QuotaSubject, records: number, bytes: number): Promise<Reservation> {
    const now = this.deps.now();
    const dayUtc = utcDay(now);
    const limits = await this.unavailableOnError(() =>
      this.deps.plans.limitsFor(subject.organizationId),
    );
    const key = { organizationId: subject.organizationId, dayUtc };
    const tryInc = () =>
      OrgUsageDailyModel.updateOne(
        {
          ...key,
          records: { $lte: limits.eventsPerDay - records },
          bytes: { $lte: limits.bytesPerDay - bytes },
        },
        { $inc: { records, bytes } },
      );

    let result = await this.unavailableOnError(tryInc);
    if (result.matchedCount === 0) {
      // Either the day's counter does not exist yet, or the batch does not fit. Create the
      // counter (a no-op if it exists; a concurrent creator may win the race) and try once more.
      await this.unavailableOnError(async () => {
        try {
          await OrgUsageDailyModel.updateOne(
            key,
            { $setOnInsert: { records: 0, bytes: 0 } },
            { upsert: true },
          );
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
        }
      });
      result = await this.unavailableOnError(tryInc);
    }

    if (result.matchedCount === 0) {
      const usage = await OrgUsageDailyModel.findOne(key, { records: 1, bytes: 1 }).lean();
      const used = { records: usage?.records ?? 0, bytes: usage?.bytes ?? 0 };
      const limit =
        used.records + records > limits.eventsPerDay ? ('records' as const) : ('bytes' as const);
      this.deps.metrics.quotaRejections.inc({ limit });
      await this.recordOutcome(subject, dayUtc, { rejected: records, quotaRejected: records });
      const retryAfterSeconds = secondsUntilReset(now);
      throw new AppError(
        429,
        'QUOTA_EXCEEDED',
        limit === 'records'
          ? `The organization's daily limit of ${limits.eventsPerDay} telemetry records has been reached. It resets at 00:00 UTC.`
          : `The organization's daily limit of ${limits.bytesPerDay} ingested bytes has been reached. It resets at 00:00 UTC.`,
        {
          limit,
          used: limit === 'records' ? used.records : used.bytes,
          allowed: limit === 'records' ? limits.eventsPerDay : limits.bytesPerDay,
          batch: limit === 'records' ? records : bytes,
          resetsAt: nextUtcMidnight(now).toISOString(),
          retryAfterSeconds,
          // Retrying before the reset cannot succeed, so SDKs drop the batch instead.
          retryable: false,
        },
      );
    }
    return { subject, dayUtc, records, bytes };
  }

  /** Returns a reservation whose records were not durably handed off (QUOTA-003). */
  async release(reservation: Reservation): Promise<void> {
    try {
      await OrgUsageDailyModel.updateOne(
        { organizationId: reservation.subject.organizationId, dayUtc: reservation.dayUtc },
        { $inc: { records: -reservation.records, bytes: -reservation.bytes } },
      );
    } catch (error) {
      // The reservation stays counted: an overcount, never an overrun.
      this.deps.logger.error({ err: (error as Error).message }, 'Failed to release quota');
    }
  }

  /** Records the accepted part of a reserved batch, plus any rejected records, per project. */
  async commit(reservation: Reservation, rejected: number): Promise<void> {
    await this.recordOutcome(reservation.subject, reservation.dayUtc, {
      accepted: reservation.records,
      acceptedBytes: reservation.bytes,
      rejected,
    });
  }

  /** Records rejected records for a batch that never reached a reservation. */
  async recordRejected(subject: QuotaSubject, rejected: number): Promise<void> {
    if (rejected > 0) await this.recordOutcome(subject, utcDay(this.deps.now()), { rejected });
  }

  /**
   * Per-project counters are informational. A failed write is logged, never surfaced: the
   * telemetry itself was handled correctly and the quota counter is already exact.
   */
  private async recordOutcome(
    subject: QuotaSubject,
    dayUtc: string,
    counts: {
      accepted?: number;
      acceptedBytes?: number;
      rejected?: number;
      quotaRejected?: number;
    },
  ): Promise<void> {
    try {
      await UsageDailyModel.updateOne(
        { organizationId: subject.organizationId, projectId: subject.projectId, dayUtc },
        {
          $inc: {
            acceptedRecords: counts.accepted ?? 0,
            acceptedBytes: counts.acceptedBytes ?? 0,
            rejectedRecords: counts.rejected ?? 0,
            quotaRejectedRecords: counts.quotaRejected ?? 0,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      this.deps.logger.warn({ err: (error as Error).message }, 'Failed to record project usage');
    }
  }

  private async unavailableOnError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.deps.logger.error({ err: (error as Error).message }, 'Quota check failed');
      throw new AppError(
        503,
        'QUOTA_UNAVAILABLE',
        'Usage limits cannot be checked right now. Nothing from this batch was recorded; retry it.',
        { retryable: true },
      );
    }
  }
}
