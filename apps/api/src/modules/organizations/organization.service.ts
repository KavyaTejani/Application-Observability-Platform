import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { notFound } from '../../lib/errors.js';
import type { TenantScope } from '../authz/tenant-scope.js';
import { UserModel } from '../users/user.model.js';
import {
  MembershipModel,
  OrganizationModel,
  type OrganizationDoc,
  type Role,
} from './organization.model.js';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface OrganizationDetail extends OrganizationSummary {
  retention: OrganizationDoc['retention'];
  createdAt: string;
}

export interface MemberSummary {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

/** URL-safe slug with a random suffix, so two organizations named alike never collide. */
export function makeSlug(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/** Organizations the user is an active member of, with their role in each. */
export async function listOrganizationsForUser(
  userId: Types.ObjectId,
): Promise<OrganizationSummary[]> {
  const memberships = await MembershipModel.find({ userId, status: 'active' })
    .sort({ createdAt: 1 })
    .lean();
  if (memberships.length === 0) return [];

  const organizations = await OrganizationModel.find({
    _id: { $in: memberships.map((m) => m.organizationId) },
  }).lean();
  const byId = new Map(organizations.map((org) => [org._id.toHexString(), org]));

  return memberships.flatMap((membership) => {
    const org = byId.get(membership.organizationId.toHexString());
    return org
      ? [{ id: org._id.toHexString(), name: org.name, slug: org.slug, role: membership.role }]
      : [];
  });
}

export async function getOrganization(scope: TenantScope): Promise<OrganizationDetail> {
  const org = await OrganizationModel.findOne({ _id: scope.organizationId }).lean();
  if (!org) throw notFound('Organization not found.');
  return {
    id: org._id.toHexString(),
    name: org.name,
    slug: org.slug,
    role: scope.role,
    retention: org.retention,
    createdAt: org.createdAt.toISOString(),
  };
}

export async function listMembers(scope: TenantScope): Promise<MemberSummary[]> {
  const memberships = await MembershipModel.find({
    organizationId: scope.organizationId,
    status: 'active',
  })
    .sort({ createdAt: 1 })
    .lean();
  const users = await UserModel.find(
    { _id: { $in: memberships.map((m) => m.userId) } },
    { name: 1, emailNormalized: 1 },
  ).lean();
  const byId = new Map(users.map((user) => [user._id.toHexString(), user]));

  return memberships.flatMap((membership) => {
    const user = byId.get(membership.userId.toHexString());
    if (!user) return [];
    return [
      {
        userId: user._id.toHexString(),
        name: user.name,
        email: user.emailNormalized,
        role: membership.role,
        joinedAt: membership.createdAt.toISOString(),
      },
    ];
  });
}
