import type { Role } from '../organizations/organization.model.js';

/**
 * Every permission-checked action in the product. Handlers ask "may this role do X?" through
 * `can()` instead of comparing role strings inline, so the whole RBAC policy lives here and is
 * covered by one matrix test.
 */
export type Action =
  | 'organization:read'
  | 'organization:manage'
  | 'members:read'
  | 'members:manage'
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:delete'
  | 'apiKey:read'
  | 'apiKey:manage'
  | 'telemetry:read'
  | 'incident:read'
  | 'alertRule:create'
  | 'alertRule:manageAny'
  | 'destination:read'
  | 'destination:manage'
  | 'usage:read'
  | 'quota:manage';

/**
 * Owner manages the organization, projects, keys, quotas, destinations, and all alert rules.
 * Member views telemetry and incidents and may create alert rules using existing destinations;
 * ownership of a member's own rules is checked separately, against `createdBy`.
 */
const MEMBER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'organization:read',
  'members:read',
  'project:read',
  'apiKey:read',
  'telemetry:read',
  'incident:read',
  'alertRule:create',
  'destination:read',
  'usage:read',
]);

export function can(role: Role, action: Action): boolean {
  if (role === 'owner') return true;
  return MEMBER_ACTIONS.has(action);
}
