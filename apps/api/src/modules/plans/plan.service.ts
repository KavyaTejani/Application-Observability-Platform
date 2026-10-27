import { PlanModel, type PlanDoc } from './plan.model.js';

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
