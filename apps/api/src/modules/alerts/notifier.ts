import type { Logger } from 'pino';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import { ProjectModel } from '../projects/project.model.js';
import {
  AlertRuleModel,
  IncidentModel,
  NotificationDeliveryModel,
  NotificationDestinationModel,
  NotificationJobModel,
  type NotificationJobDoc,
} from './alert.models.js';
import { signPayload, type SecretBox } from './secret-box.js';
import type { WebhookResult, WebhookSender } from './webhook-client.js';

/** Delay before retry N (after attempt N failed). After the last one the job is abandoned. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface NotifierDeps {
  sender: WebhookSender;
  secretBox: SecretBox;
  logger: Logger;
  metrics: PlatformMetrics;
  workerId: string;
  appBaseUrl: string;
  now?: () => Date;
  leaseMs?: number;
}

/**
 * Delivers queued incident notifications (PRD ALERT-007, ALERT-008). Each attempt is recorded in
 * `notificationDeliveries`. Failures are retried with backoff and never touch the incident itself;
 * SSRF-blocked destinations are recorded as `blocked` and never retried.
 */
export class Notifier {
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? (() => new Date());
    this.leaseMs = deps.leaseMs ?? 60_000;
  }

  async runDue(limit = 20): Promise<number> {
    let count = 0;
    while (count < limit) {
      const job = await this.claim();
      if (!job) break;
      await this.deliver(job);
      count++;
    }
    return count;
  }

  private claim() {
    const now = this.now();
    return NotificationJobModel.findOneAndUpdate(
      {
        status: 'pending',
        nextAttemptAt: { $lte: now },
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { lockedUntil: new Date(now.getTime() + this.leaseMs), lockedBy: this.deps.workerId },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after', lean: true },
    );
  }

  async deliver(job: NotificationJobDoc): Promise<void> {
    const startedAt = this.now();
    const attempt = job.attempts + 1;
    const [destination, incident] = await Promise.all([
      NotificationDestinationModel.findOne({
        _id: job.destinationId,
        organizationId: job.organizationId,
      }).lean(),
      IncidentModel.findOne({ _id: job.incidentId, organizationId: job.organizationId }).lean(),
    ]);

    let result: WebhookResult;
    if (!destination || !destination.enabled || !incident) {
      result = {
        status: 'failed',
        errorSummary: 'Destination disabled or deleted',
        retryable: false,
      };
    } else {
      const [rule, project] = await Promise.all([
        AlertRuleModel.findOne(
          { _id: incident.alertRuleId },
          { name: 1, metricKey: 1, operator: 1, threshold: 1, windowSeconds: 1 },
        ).lean(),
        ProjectModel.findOne({ _id: incident.projectId }, { name: 1, environment: 1 }).lean(),
      ]);
      const body = JSON.stringify({
        event: job.event,
        deliveryId: job._id.toHexString(),
        attempt,
        sentAt: startedAt.toISOString(),
        incident: {
          id: incident._id.toHexString(),
          title: incident.title,
          status: incident.status,
          startedAt: incident.startedAt.toISOString(),
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
          lastValue: incident.lastValue ?? null,
          url: `${this.deps.appBaseUrl}/orgs/${incident.organizationId.toHexString()}/projects/${incident.projectId.toHexString()}/alerts/incidents/${incident._id.toHexString()}`,
        },
        rule: {
          id: incident.alertRuleId.toHexString(),
          name: rule?.name ?? null,
          ...incident.ruleSnapshot,
        },
        project: project
          ? {
              id: incident.projectId.toHexString(),
              name: project.name,
              environment: project.environment,
            }
          : { id: incident.projectId.toHexString() },
      });
      let secret: string | null = null;
      try {
        secret = this.deps.secretBox.decrypt(destination.signingSecretEncrypted);
      } catch {
        this.deps.logger.error(
          { destinationId: destination._id.toHexString() },
          'Cannot decrypt signing secret',
        );
      }
      const timestamp = Math.floor(startedAt.getTime() / 1000);
      result = await this.deps.sender.send(destination.url, body, {
        'X-AOP-Event': job.event,
        'X-AOP-Delivery': job._id.toHexString(),
        ...(secret ? { 'X-AOP-Signature': signPayload(secret, body, timestamp) } : {}),
      });
    }

    const finishedAt = this.now();
    await NotificationDeliveryModel.create({
      organizationId: job.organizationId,
      projectId: job.projectId,
      destinationId: job.destinationId,
      incidentId: job.incidentId,
      event: job.event,
      attempt,
      status: result.status,
      responseStatus: 'responseStatus' in result ? result.responseStatus : undefined,
      startedAt,
      finishedAt,
      errorSummary: result.status === 'success' ? undefined : result.errorSummary,
    });
    this.deps.metrics.notificationAttempts.inc({ outcome: result.status });

    const retry = result.status === 'failed' && result.retryable && attempt < MAX_ATTEMPTS;
    const status: NotificationJobDoc['status'] =
      result.status === 'success'
        ? 'delivered'
        : result.status === 'blocked'
          ? 'blocked'
          : retry
            ? 'pending'
            : 'failed';
    if (result.status !== 'success') {
      this.deps.logger.warn(
        { jobId: job._id.toHexString(), attempt, outcome: result.status, willRetry: retry },
        'Webhook delivery unsuccessful',
      );
    }
    await NotificationJobModel.updateOne(
      { _id: job._id, lockedBy: this.deps.workerId },
      {
        $set: {
          status,
          attempts: attempt,
          ...(retry
            ? {
                nextAttemptAt: new Date(finishedAt.getTime() + (RETRY_DELAYS_MS[attempt - 1] ?? 0)),
              }
            : {}),
        },
        $unset: { lockedUntil: '', lockedBy: '' },
      },
    );
  }
}
