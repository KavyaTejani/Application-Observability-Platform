import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import type { PlatformMetrics } from '../../observability/platform-metrics.js';
import { AlertRuleModel, IncidentModel, NotificationJobModel } from '../alerts/alert.models.js';
import type { AlertWorker } from '../alerts/alert-worker.js';
import type { HealthService } from '../health/health.service.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { ProjectModel } from '../projects/project.model.js';
import { utcDay } from '../usage/quota.service.js';
import { OrgUsageDailyModel } from '../usage/usage.models.js';

export interface OperatorDeps {
  health: HealthService;
  metrics: PlatformMetrics;
  alertWorker: AlertWorker;
  logger: Logger;
  now: () => Date;
}

/**
 * The platform operator's view of its own health (PRD SELF-004, §13 screen 9). It combines
 * dependency readiness, this instance's pipeline counters, and platform-wide state from MongoDB.
 * It reports aggregates only: no tenant names, emails, keys, or telemetry content.
 */
export class OperatorService {
  constructor(private readonly deps: OperatorDeps) {}

  async report() {
    const { health, metrics, alertWorker } = this.deps;
    const now = this.deps.now();
    const [readiness, pipeline, state] = await Promise.all([
      health.checkReadiness(),
      this.pipeline(metrics),
      this.state(now),
    ]);
    return {
      generatedAt: now.toISOString(),
      instance: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryRssBytes: process.memoryUsage().rss,
        alertWorker: alertWorker.status(),
      },
      readiness,
      pipeline,
      state,
    };
  }

  /** Counters since this process started. With several instances, each reports its own. */
  private async pipeline(m: PlatformMetrics) {
    const [records, bytes, requests, quota, backends, evaluations, notifications, http] =
      await Promise.all([
        byLabels(m.ingestRecords, ['signal', 'outcome']),
        byLabels(m.ingestBytes, ['signal']),
        byLabels(m.ingestRequests, ['outcome']),
        byLabels(m.quotaRejections, ['limit']),
        byLabels(m.backendRequests, ['backend', 'outcome']),
        byLabels(m.alertEvaluations, ['outcome']),
        byLabels(m.notificationAttempts, ['outcome']),
        byLabels(m.httpRequests, ['status_class']),
      ]);
    return {
      since: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      ingest: { records, bytes, requests, quotaRejections: quota },
      backends,
      alertEvaluations: evaluations,
      notificationAttempts: notifications,
      httpRequests: http,
    };
  }

  /** Platform-wide state from MongoDB, or `null` if it cannot be read right now. */
  private async state(now: Date) {
    try {
      const [orgs, projects, rules, disabledRules, firing, jobs, usage] = await Promise.all([
        OrganizationModel.estimatedDocumentCount(),
        ProjectModel.countDocuments({ status: 'active' }),
        AlertRuleModel.aggregate<{ _id: string; n: number }>([
          { $match: { enabled: true } },
          { $group: { _id: '$lastState', n: { $sum: 1 } } },
        ]),
        AlertRuleModel.countDocuments({ enabled: false }),
        IncidentModel.countDocuments({ status: 'firing' }),
        NotificationJobModel.aggregate<{ _id: string; n: number }>([
          { $match: { status: { $ne: 'delivered' } } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]),
        OrgUsageDailyModel.aggregate<{ records: number; bytes: number; organizations: number }>([
          { $match: { dayUtc: utcDay(now) } },
          {
            $group: {
              _id: null,
              records: { $sum: '$records' },
              bytes: { $sum: '$bytes' },
              organizations: { $sum: 1 },
            },
          },
        ]),
      ]);
      const counts = (rows: Array<{ _id: string; n: number }>) =>
        Object.fromEntries(rows.map((r) => [r._id, r.n]));
      return {
        organizations: orgs,
        activeProjects: projects,
        alertRules: { byState: counts(rules), disabled: disabledRules },
        incidentsFiring: firing,
        notificationJobs: counts(jobs),
        usageToday: {
          dayUtc: utcDay(now),
          records: usage[0]?.records ?? 0,
          bytes: usage[0]?.bytes ?? 0,
          organizations: usage[0]?.organizations ?? 0,
        },
      };
    } catch (error) {
      this.deps.logger.warn({ err: (error as Error).message }, 'Operator state query failed');
      return null;
    }
  }
}

/** Flattens a counter to `{ "a/b": value }`, keyed by the given labels in order. */
async function byLabels<T extends string>(
  counter: Counter<T>,
  labels: T[],
): Promise<Record<string, number>> {
  const { values } = await counter.get();
  const out: Record<string, number> = {};
  for (const { labels: l, value } of values) {
    const key = labels.map((name) => String(l[name] ?? '')).join('/');
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}
