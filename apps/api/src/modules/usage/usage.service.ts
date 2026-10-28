import type { TenantScope } from '../authz/tenant-scope.js';
import { AlertRuleModel } from '../alerts/alert.models.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { PlanModel } from '../plans/plan.model.js';
import { ProjectModel } from '../projects/project.model.js';
import { nextUtcMidnight, utcDay } from './quota.service.js';
import { OrgUsageDailyModel, UsageDailyModel } from './usage.models.js';

const HISTORY_DAYS = 7;

/**
 * The organization's usage overview (PRD QUOTA-005): today's quota consumption against the plan,
 * a per-project breakdown, resource counts against plan limits, and the last seven days.
 */
export async function getUsage(scope: TenantScope, now: Date) {
  const organizationId = scope.organizationId;
  const dayUtc = utcDay(now);
  const firstDay = utcDay(new Date(now.getTime() - (HISTORY_DAYS - 1) * 86_400_000));

  const org = await OrganizationModel.findById(organizationId, {
    planId: 1,
    retention: 1,
  }).lean();
  if (!org) throw new Error('Organization in scope not found');
  const [plan, today, history, projectUsage, projects, alertRules] = await Promise.all([
    PlanModel.findById(org.planId, { code: 1, name: 1, limits: 1 }).lean(),
    OrgUsageDailyModel.findOne({ organizationId, dayUtc }, { records: 1, bytes: 1 }).lean(),
    OrgUsageDailyModel.find(
      { organizationId, dayUtc: { $gte: firstDay } },
      { dayUtc: 1, records: 1, bytes: 1 },
    )
      .sort({ dayUtc: -1 })
      .lean(),
    UsageDailyModel.find({ organizationId, dayUtc }).lean(),
    ProjectModel.find({ organizationId }, { name: 1, environment: 1, status: 1 }).lean(),
    AlertRuleModel.countDocuments({ organizationId }),
  ]);
  if (!plan) throw new Error('Plan for organization not found');

  const usageByProject = new Map(projectUsage.map((u) => [u.projectId.toHexString(), u]));
  // Active projects always appear; deleted ones only when they reported usage today.
  const projectRows = projects
    .filter((p) => p.status === 'active' || usageByProject.has(p._id.toHexString()))
    .map((p) => {
      const u = usageByProject.get(p._id.toHexString());
      return {
        id: p._id.toHexString(),
        name: p.name,
        environment: p.environment,
        deleted: p.status === 'deleted',
        acceptedRecords: u?.acceptedRecords ?? 0,
        acceptedBytes: u?.acceptedBytes ?? 0,
        rejectedRecords: u?.rejectedRecords ?? 0,
        quotaRejectedRecords: u?.quotaRejectedRecords ?? 0,
      };
    })
    .sort((a, b) => b.acceptedRecords - a.acceptedRecords || a.name.localeCompare(b.name));

  return {
    dayUtc,
    resetsAt: nextUtcMidnight(now).toISOString(),
    plan: { code: plan.code, name: plan.name },
    quota: {
      records: { used: today?.records ?? 0, limit: plan.limits.eventsPerDay },
      bytes: { used: today?.bytes ?? 0, limit: plan.limits.bytesPerDay },
    },
    rejected: {
      records: sum(projectRows, 'rejectedRecords'),
      quotaRecords: sum(projectRows, 'quotaRejectedRecords'),
    },
    resources: {
      projects: {
        used: projects.filter((p) => p.status === 'active').length,
        limit: plan.limits.maxProjects,
      },
      alertRules: { used: alertRules, limit: plan.limits.maxAlertRules },
    },
    retention: { metricsDays: org.retention.metricsDays, logsDays: org.retention.logsDays },
    projects: projectRows,
    history: history.map((h) => ({ dayUtc: h.dayUtc, records: h.records, bytes: h.bytes })),
  };
}

function sum<K extends string>(rows: Array<Record<K, number>>, key: K): number {
  return rows.reduce((total, row) => total + row[key], 0);
}
