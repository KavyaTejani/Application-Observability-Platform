import { describe, expect, it } from 'vitest';
import { can, type Action } from './policy.js';

/** The full RBAC matrix from the requirements: [action, owner, member]. */
const MATRIX: Array<[Action, boolean, boolean]> = [
  ['organization:read', true, true],
  ['organization:manage', true, false],
  ['members:read', true, true],
  ['members:manage', true, false],
  ['project:read', true, true],
  ['project:create', true, false],
  ['project:update', true, false],
  ['project:delete', true, false],
  ['apiKey:read', true, true],
  ['apiKey:manage', true, false],
  ['telemetry:read', true, true],
  ['incident:read', true, true],
  ['alertRule:create', true, true],
  ['alertRule:manageAny', true, false],
  ['destination:read', true, true],
  ['destination:manage', true, false],
  ['usage:read', true, true],
  ['quota:manage', true, false],
];

describe('RBAC policy', () => {
  it.each(MATRIX)('%s → owner=%s, member=%s', (action, owner, member) => {
    expect(can('owner', action)).toBe(owner);
    expect(can('member', action)).toBe(member);
  });
});
