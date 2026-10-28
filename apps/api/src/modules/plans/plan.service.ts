import type { Types } from 'mongoose';
import { OrganizationModel } from '../organizations/organization.model.js';
import { PlanModel, type PlanDoc, type PlanLimits } from './plan.model.js';

export const DEFAULT_PLAN_CODE = 'developer';

/**
 * Starter limits for the seeded Developer plan. These are demo-system ceilings, not commercial
 * promises. They live in the database so they can change without code edits.
 */
const DEVELOPER_PLAN: Omit<PlanDoc, '_id'> = {
  code: DEFAULT_PLAN_CODE,
  name: 'Developer',
  limits: {
    eventsPerDay: 250_000,
    bytesPerDay: 250 * 1024 * 1024,
    maxProjects: 3,
    maxDashboards: 5,
    maxAlertRules: 10,
  },
  allowedRetentionDays: { metrics: [15], logs: [7], traces: [3] },
  active: true,
};

/**
 * Creates the default plan if it is missing. It is idempotent and safe on every startup. It
 * never overwrites an existing plan, so an operator's edits to its limits survive restarts.
 */
export async function ensureDefaultPlan(): Promise<PlanDoc> {
  const plan = await PlanModel.findOneAndUpdate(
    { code: DEFAULT_PLAN_CODE },
    { $setOnInsert: DEVELOPER_PLAN },
    { upsert: true, returnDocument: 'after', lean: true },
  );
  if (!plan) throw new Error('Default plan upsert returned no document');
  return plan;
}

/**
 * Looks up an organization's plan limits for the ingestion hot path, with a short cache so a
 * busy organization does not cost two extra database reads per batch. A plan change takes
 * effect within `ttlMs` on every instance.
 */
export class PlanLimitsCache {
  private readonly entries = new Map<string, { limits: PlanLimits; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async limitsFor(organizationId: Types.ObjectId): Promise<PlanLimits> {
    const key = organizationId.toHexString();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.limits;

    const limits = await planLimitsFor(organizationId);
    if (this.ttlMs > 0) this.entries.set(key, { limits, expiresAt: this.now() + this.ttlMs });
    return limits;
  }
}

/** The organization's current plan limits, read from the database. */
export async function planLimitsFor(organizationId: Types.ObjectId): Promise<PlanLimits> {
  const org = await OrganizationModel.findById(organizationId, { planId: 1 }).lean();
  if (!org) throw new Error(`Organization ${organizationId.toHexString()} not found`);
  const plan = await PlanModel.findById(org.planId, { limits: 1 }).lean();
  if (!plan) throw new Error(`Plan ${org.planId.toHexString()} missing for organization`);
  return plan.limits;
}
