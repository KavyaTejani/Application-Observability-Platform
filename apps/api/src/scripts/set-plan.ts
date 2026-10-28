/**
 * Moves an organization to a plan, creating or adjusting that plan first. There is no plan
 * editor in the MVP (PRD QUOTA-006 is P1), so this is the operator's tool for demos, quota tests,
 * and the raised-quota load-test profile.
 *
 *   npm run plan:set -w @aop/api -- --org owner@demo.local --plan tiny --events-per-day 200
 *   npm run plan:set -w @aop/api -- --org owner@demo.local --plan developer      (restore)
 *
 * `--org` takes an organization ID, a slug, or an owner's email address. Limit flags are
 * optional: a new plan copies the Developer limits and overrides the ones given. The shared
 * Developer plan itself is never modified here, because every organization uses it.
 * Running API instances pick up the change within PLAN_CACHE_TTL_SECONDS.
 */
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { loadConfig } from '../config/index.js';
import { MembershipModel, OrganizationModel } from '../modules/organizations/organization.model.js';
import { PlanModel, type PlanLimits } from '../modules/plans/plan.model.js';
import { DEFAULT_PLAN_CODE, ensureDefaultPlan } from '../modules/plans/plan.service.js';
import { UserModel } from '../modules/users/user.model.js';

const LIMIT_FLAGS = {
  'events-per-day': 'eventsPerDay',
  'bytes-per-day': 'bytesPerDay',
  'max-projects': 'maxProjects',
  'max-alert-rules': 'maxAlertRules',
} as const satisfies Record<string, keyof PlanLimits>;

async function findOrganization(ref: string) {
  if (ref.includes('@')) {
    const user = await UserModel.findOne({ emailNormalized: ref.trim().toLowerCase() }).lean();
    const membership =
      user &&
      (await MembershipModel.findOne({ userId: user._id, role: 'owner', status: 'active' }).lean());
    return membership ? OrganizationModel.findById(membership.organizationId) : null;
  }
  if (mongoose.isValidObjectId(ref)) return OrganizationModel.findById(ref);
  return OrganizationModel.findOne({ slug: ref });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      plan: { type: 'string' },
      ...Object.fromEntries(Object.keys(LIMIT_FLAGS).map((flag) => [flag, { type: 'string' }])),
    },
  });
  const orgRef = values.org;
  const code = values.plan?.trim().toLowerCase();
  if (typeof orgRef !== 'string' || !code || !/^[a-z0-9-]{2,40}$/.test(code)) {
    throw new Error('Usage: --org <id|slug|owner email> --plan <code> [--events-per-day N] ...');
  }
  const overrides: Partial<PlanLimits> = {};
  for (const [flag, field] of Object.entries(LIMIT_FLAGS)) {
    const raw = (values as Record<string, unknown>)[flag];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${flag} must be a whole number >= 0`);
    overrides[field] = n;
  }

  const config = loadConfig();
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    const developer = await ensureDefaultPlan();
    const org = await findOrganization(orgRef);
    if (!org) throw new Error(`No organization found for "${orgRef}"`);

    let plan = await PlanModel.findOne({ code });
    if (code === DEFAULT_PLAN_CODE && Object.keys(overrides).length > 0) {
      throw new Error('The Developer plan is shared by every organization; use another plan code.');
    }
    if (!plan) {
      plan = await PlanModel.create({
        code,
        name: code.charAt(0).toUpperCase() + code.slice(1),
        limits: { ...developer.limits, ...overrides },
        allowedRetentionDays: developer.allowedRetentionDays,
        active: true,
      });
    } else if (Object.keys(overrides).length > 0) {
      plan.set('limits', { ...plan.toObject().limits, ...overrides });
      await plan.save();
    }
    org.planId = plan._id;
    await org.save();

    process.stdout.write(
      `Organization "${org.name}" is now on plan "${plan.code}":\n` +
        `${JSON.stringify(plan.toObject().limits, null, 2)}\n` +
        `Running APIs apply it within ${config.planCacheTtlMs / 1000} s.\n`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
