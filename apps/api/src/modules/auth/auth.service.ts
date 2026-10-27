import type { loginSchema, registerSchema } from '@aop/validation';
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { MembershipModel, OrganizationModel } from '../organizations/organization.model.js';
import { makeSlug, type OrganizationSummary } from '../organizations/organization.service.js';
import { ensureDefaultPlan } from '../plans/plan.service.js';
import { UserModel, toPublicUser, type PublicUser } from '../users/user.model.js';
import { burnPasswordVerification, hashPassword, verifyPassword } from './password.js';

type RegisterData = z.output<typeof registerSchema>;
type LoginData = z.output<typeof loginSchema>;

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

export class AuthService {
  constructor(private readonly logger: Logger) {}

  /**
   * Creates the user, their organization, and an owner membership. A standalone MongoDB has no
   * multi-document transactions, so a failure part-way is undone with compensating deletes. A
   * half-created account can never be signed in to, because the session is issued only after
   * every step succeeds.
   */
  async register(input: RegisterData): Promise<{
    user: PublicUser;
    userId: Types.ObjectId;
    organization: OrganizationSummary;
  }> {
    // Duplicate-email disclosure is accepted in the MVP (no email verification yet) and
    // mitigated by rate limiting. It is listed as a known limitation in the threat model.
    if (await UserModel.exists({ emailNormalized: input.email })) throw emailTaken();

    const passwordHash = await hashPassword(input.password);
    const plan = await ensureDefaultPlan();

    let userId;
    let organizationId;
    try {
      const user = await UserModel.create({
        name: input.name,
        emailNormalized: input.email,
        passwordHash,
      });
      userId = user._id;

      const orgName = input.organizationName ?? `${input.name}'s Organization`;
      const org = await OrganizationModel.create({
        name: orgName,
        slug: makeSlug(orgName),
        ownerUserId: user._id,
        planId: plan._id,
      });
      organizationId = org._id;

      await MembershipModel.create({ organizationId: org._id, userId: user._id, role: 'owner' });

      return {
        user: toPublicUser(user),
        userId: user._id,
        organization: { id: org._id.toHexString(), name: org.name, slug: org.slug, role: 'owner' },
      };
    } catch (error) {
      await Promise.allSettled([
        organizationId && MembershipModel.deleteMany({ organizationId }),
        organizationId && OrganizationModel.deleteOne({ _id: organizationId }),
        userId && UserModel.deleteOne({ _id: userId }),
      ]);
      // Two concurrent signups with one email: the unique index lets exactly one succeed.
      if (isDuplicateKeyError(error)) throw emailTaken();
      this.logger.error({ err: error }, 'Registration failed; partial records removed');
      throw error;
    }
  }

  /** Returns the user on valid credentials. Every failure mode yields the same error. */
  async login(input: LoginData): Promise<{ user: PublicUser; userId: Types.ObjectId }> {
    const user = await UserModel.findOne({ emailNormalized: input.email }).select('+passwordHash');
    if (!user) {
      await burnPasswordVerification(input.password);
      throw invalidCredentials();
    }
    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid || user.status !== 'active') throw invalidCredentials();

    await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    return { user: toPublicUser(user), userId: user._id };
  }

  async getUser(userId: Types.ObjectId): Promise<PublicUser | null> {
    const user = await UserModel.findOne({ _id: userId, status: 'active' }).lean();
    return user ? toPublicUser(user) : null;
  }
}

function emailTaken() {
  return new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.', {
    fields: { email: 'An account with this email already exists' },
  });
}
