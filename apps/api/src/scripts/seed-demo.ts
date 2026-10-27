/**
 * Seeds a demo organization with one owner and one member, so role-based behaviour can be
 * demonstrated before invitations exist (a P1 feature). Idempotent: re-running it resets the
 * two demo passwords and memberships but touches nothing else.
 *
 *   npm run seed:demo -w @aop/api
 *
 * Refuses to run in production unless ALLOW_DEMO_SEED=true is set explicitly.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../config/index.js';
import { hashPassword } from '../modules/auth/password.js';
import { MembershipModel, OrganizationModel } from '../modules/organizations/organization.model.js';
import { makeSlug } from '../modules/organizations/organization.service.js';
import { ensureDefaultPlan } from '../modules/plans/plan.service.js';
import { UserModel } from '../modules/users/user.model.js';

const DEMO_ORG_NAME = 'Demo Organization';
const DEMO_USERS = [
  { name: 'Demo Owner', email: 'owner@demo.local', role: 'owner' as const },
  { name: 'Demo Member', email: 'member@demo.local', role: 'member' as const },
];

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo users in production (set ALLOW_DEMO_SEED=true).');
  }
  const password = process.env.DEMO_PASSWORD ?? 'demo-password-2026';

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const plan = await ensureDefaultPlan();
  const passwordHash = await hashPassword(password);

  const users = await Promise.all(
    DEMO_USERS.map((demo) =>
      UserModel.findOneAndUpdate(
        { emailNormalized: demo.email },
        { $set: { name: demo.name, passwordHash, status: 'active' } },
        { upsert: true, returnDocument: 'after' },
      ),
    ),
  );
  const owner = users[0];
  if (!owner) throw new Error('Demo owner was not created');

  const org =
    (await OrganizationModel.findOne({ ownerUserId: owner._id, name: DEMO_ORG_NAME })) ??
    (await OrganizationModel.create({
      name: DEMO_ORG_NAME,
      slug: makeSlug(DEMO_ORG_NAME),
      ownerUserId: owner._id,
      planId: plan._id,
    }));

  await Promise.all(
    users.map((user, i) =>
      MembershipModel.updateOne(
        { organizationId: org._id, userId: user._id },
        { $set: { role: DEMO_USERS[i]!.role, status: 'active' } },
        { upsert: true },
      ),
    ),
  );

  console.log(`Seeded "${DEMO_ORG_NAME}" (${org._id.toHexString()})`);
  for (const demo of DEMO_USERS) console.log(`  ${demo.role.padEnd(6)}  ${demo.email}`);
  console.log(`Password: ${process.env.DEMO_PASSWORD ? '(from DEMO_PASSWORD)' : password}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
