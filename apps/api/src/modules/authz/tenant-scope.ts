import { OBJECT_ID_PATTERN } from '@aop/validation';
import { Types } from 'mongoose';
import { AppError, notFound } from '../../lib/errors.js';
import { MembershipModel, type Role } from '../organizations/organization.model.js';
import { can, type Action } from './policy.js';

/**
 * Proof that a user may act within one organization. It is created only by `resolveOrgScope`,
 * from the authenticated session plus a membership lookup, and never from client-supplied
 * tenant fields. Every tenant-owned query takes its `organizationId` from a scope object.
 */
export interface TenantScope {
  readonly organizationId: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly role: Role;
}

export function parseObjectId(value: unknown): Types.ObjectId | null {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value)
    ? new Types.ObjectId(value)
    : null;
}

/**
 * Resolves the caller's scope in an organization. Non-members get the same 404 as a
 * non-existent organization, so organization IDs cannot be probed for existence.
 */
export async function resolveOrgScope(
  userId: Types.ObjectId,
  organizationIdParam: unknown,
): Promise<TenantScope> {
  const organizationId = parseObjectId(organizationIdParam);
  if (!organizationId) throw notFound('Organization not found.');

  const membership = await MembershipModel.findOne(
    { organizationId, userId, status: 'active' },
    { role: 1 },
  ).lean();
  if (!membership) throw notFound('Organization not found.');

  return Object.freeze({ organizationId, userId, role: membership.role });
}

/** Throws 403 when the scope's role does not permit `action`. */
export function assertCan(scope: TenantScope, action: Action): void {
  if (!can(scope.role, action)) {
    throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.', { action });
  }
}
