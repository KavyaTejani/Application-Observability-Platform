import type { Logger } from 'pino';
import type { Types } from 'mongoose';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import type { PrometheusQueryApi } from '../query/backend-clients.js';
import { buildRangeExpression } from '../query/promql.js';
import {
  AlertRuleModel,
  IncidentModel,
  NotificationDestinationModel,
  NotificationJobModel,
  type AlertRuleDoc,
  type NotificationEvent,
} from './alert.models.js';
import { isBreach, transition, type EvaluationOutcome } from './state-machine.js';

export interface EvaluatorDeps {
  prometheus: PrometheusQueryApi | null;
  logger: Logger;
  metrics: PlatformMetrics;
  workerId: string;
  now?: () => Date;
  /** How long a claimed rule stays locked if the evaluator dies mid-evaluation. */
  leaseMs?: number;
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

/** One open incident per rule: the fingerprint identifies "this rule's condition". */
export const fingerprintFor = (ruleId: Types.ObjectId) => `rule:${ruleId.toHexString()}`;

export function describeValue(metricKey: AlertRuleDoc['metricKey'], value: number): string {
  return metricKey === 'error_rate' ? `${(value * 100).toFixed(2)}%` : `${Math.round(value)} ms`;
}

const OPERATOR_TEXT = { gt: '>', gte: '≥', lt: '<', lte: '≤' } as const;

/**
 * Evaluates alert rules (PRD Workflow E, ALERT-004, ALERT-011). Rules are claimed with an atomic
 * lease, so any number of API/worker instances can run this loop concurrently without evaluating
 * a rule twice. The scope of every query comes from the rule record, never from user input.
 */
export class AlertEvaluator {
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(private readonly deps: EvaluatorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.leaseMs = deps.leaseMs ?? 60_000;
  }

  /** Evaluates every due rule (up to `limit`). Returns how many were evaluated. */
  async runDue(limit = 50): Promise<number> {
    let count = 0;
    while (count < limit) {
      const rule = await this.claim();
      if (!rule) break;
      await this.evaluate(rule);
      count++;
    }
    return count;
  }

  private async claim(): Promise<AlertRuleDoc | null> {
    const now = this.now();
    return AlertRuleModel.findOneAndUpdate(
      {
        enabled: true,
        nextEvaluationAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { lockedUntil: new Date(now.getTime() + this.leaseMs), lockedBy: this.deps.workerId },
      },
      { sort: { nextEvaluationAt: 1 }, returnDocument: 'after', lean: true },
    );
  }

  /** Measures the rule's metric over its window; zero traffic is "no data", never 0. */
  async measure(rule: AlertRuleDoc): Promise<EvaluationOutcome> {
    if (!this.deps.prometheus)
      return { kind: 'error', message: 'Metrics storage is not configured' };
    const scope = {
      organizationId: rule.organizationId.toHexString(),
      projectId: rule.projectId.toHexString(),
    };
    // The window doubles as the rate window: step = window gives rate(...[window]).
    const metricKey = rule.metricKey === 'error_rate' ? 'error_rate' : 'p95_latency';
    const expr = buildRangeExpression(
      metricKey,
      scope,
      rule.serviceName ? { serviceName: rule.serviceName } : {},
      [],
      rule.windowSeconds,
    );
    try {
      const result = await this.deps.prometheus.query(
        expr,
        Math.floor(this.now().getTime() / 1000),
      );
      const raw = Number(result[0]?.value[1]);
      if (result.length === 0 || !Number.isFinite(raw)) return { kind: 'noData' };
      const value = rule.metricKey === 'p95_latency' ? raw * 1000 : raw;
      return isBreach(rule.operator, value, rule.threshold)
        ? { kind: 'breach', value }
        : { kind: 'ok', value };
    } catch (error) {
      return { kind: 'error', message: (error as Error).message.slice(0, 200) };
    }
  }

  async evaluate(rule: AlertRuleDoc): Promise<void> {
    const stop = this.deps.metrics.alertEvaluationDuration.startTimer();
    const now = this.now();
    try {
      const outcome = await this.measure(rule);
      this.deps.metrics.alertEvaluations.inc({ outcome: outcome.kind });

      const open = await IncidentModel.findOne({ alertRuleId: rule._id, status: 'firing' }).lean();
      const next = transition(
        { consecutiveBreaches: rule.consecutiveBreaches, consecutiveOk: rule.consecutiveOk },
        open !== null,
        outcome,
        {
          forEvaluations: rule.forEvaluations,
          resolveAfterEvaluations: rule.resolveAfterEvaluations,
        },
      );
      const value = 'value' in outcome ? outcome.value : null;

      if (next.incident === 'open') await this.openIncident(rule, value as number, now);
      else if (next.incident === 'update' && open) {
        await IncidentModel.updateOne(
          { _id: open._id, status: 'firing' },
          { $set: { lastTriggeredAt: now, lastValue: value } },
        );
      } else if (next.incident === 'resolve' && open) {
        const resolved = await IncidentModel.findOneAndUpdate(
          { _id: open._id, status: 'firing' },
          {
            $set: {
              status: 'resolved',
              resolvedAt: now,
              ...(value !== null ? { lastValue: value } : {}),
            },
          },
          { returnDocument: 'after', lean: true },
        );
        if (resolved) await this.enqueue(rule, resolved._id, 'incident_resolved', now);
      }

      await AlertRuleModel.updateOne(
        { _id: rule._id, lockedBy: this.deps.workerId },
        {
          $set: {
            lastState: next.state,
            consecutiveBreaches: next.consecutiveBreaches,
            consecutiveOk: next.consecutiveOk,
            lastEvaluatedAt: now,
            nextEvaluationAt: new Date(now.getTime() + rule.evaluationIntervalSeconds * 1000),
            // An error keeps the last known value: we learned nothing new.
            ...(outcome.kind === 'error' ? { lastError: outcome.message } : { lastValue: value }),
          },
          $unset: {
            lockedUntil: '',
            lockedBy: '',
            ...(outcome.kind === 'error' ? {} : { lastError: '' }),
          },
        },
      );
    } catch (error) {
      // Never leave a rule wedged: release the lease and retry next interval.
      this.deps.logger.error(
        { err: error, ruleId: rule._id.toHexString() },
        'Alert evaluation failed',
      );
      await AlertRuleModel.updateOne(
        { _id: rule._id, lockedBy: this.deps.workerId },
        {
          $set: {
            nextEvaluationAt: new Date(now.getTime() + rule.evaluationIntervalSeconds * 1000),
          },
          $unset: { lockedUntil: '', lockedBy: '' },
        },
      ).catch(() => undefined);
    } finally {
      stop();
    }
  }

  private async openIncident(rule: AlertRuleDoc, value: number, now: Date): Promise<void> {
    const title = `${rule.name}: ${rule.metricKey === 'error_rate' ? 'error rate' : 'p95 latency'} ${describeValue(rule.metricKey, value)} ${OPERATOR_TEXT[rule.operator]} ${describeValue(rule.metricKey, rule.threshold)}`;
    try {
      const incident = await IncidentModel.create({
        organizationId: rule.organizationId,
        projectId: rule.projectId,
        alertRuleId: rule._id,
        fingerprint: fingerprintFor(rule._id),
        status: 'firing',
        title,
        startedAt: now,
        lastTriggeredAt: now,
        lastValue: value,
        ruleSnapshot: {
          metricKey: rule.metricKey,
          operator: rule.operator,
          threshold: rule.threshold,
          windowSeconds: rule.windowSeconds,
        },
      });
      await this.enqueue(rule, incident._id, 'incident_firing', now);
    } catch (error) {
      // Another evaluator opened it first; the partial unique index guarantees exactly one.
      if (!isDuplicateKeyError(error)) throw error;
      await IncidentModel.updateOne(
        { alertRuleId: rule._id, status: 'firing' },
        { $set: { lastTriggeredAt: now, lastValue: value } },
      );
    }
  }

  /** Queues a notification once per (incident, destination, event): deduplicated by index. */
  private async enqueue(
    rule: AlertRuleDoc,
    incidentId: Types.ObjectId,
    event: NotificationEvent,
    now: Date,
  ) {
    if (!rule.notificationDestinationId) return;
    const destination = await NotificationDestinationModel.findOne(
      { _id: rule.notificationDestinationId, organizationId: rule.organizationId, enabled: true },
      { _id: 1 },
    ).lean();
    if (!destination) return;
    await NotificationJobModel.updateOne(
      { incidentId, destinationId: destination._id, event },
      {
        $setOnInsert: {
          organizationId: rule.organizationId,
          projectId: rule.projectId,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
        },
      },
      { upsert: true },
    );
  }
}
