import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { hashPassword } from '../auth/password.js';
import { assertCan, resolveOrgScope } from '../authz/tenant-scope.js';
import { UserModel } from '../users/user.model.js';
import { MembershipModel } from './organization.model.js';

useTestDatabase();

/**
 * Metadata tenant isolation (PRD §14.2, items 1 and 7 for the M2 surface). Organization A and
 * organization B have distinct users. A seeded member of A checks the member role. These are
 * release blockers: every route added in later milestones extends this suite.
 */
describe('organization tenant isolation', () => {
  const { app } = buildTestApp();
  const PASSWORD = 'correct horse battery staple';

  const alice = request.agent(app); // owner of org A
  const bob = request.agent(app); // owner of org B
  const carol = request.agent(app); // seeded member of org A
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    const ra = await alice.post('/api/v1/auth/register').set('Origin', TEST_ORIGIN).send({
      name: 'Alice',
      email: 'alice@a.example',
      password: PASSWORD,
      organizationName: 'Org A',
    });
    const rb = await bob
      .post('/api/v1/auth/register')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'Bob', email: 'bob@b.example', password: PASSWORD, organizationName: 'Org B' });
    orgA = ra.body.organizations[0].id;
    orgB = rb.body.organizations[0].id;

    // Invitations are a P1 feature; membership is seeded directly, as the PRD allows for the MVP.
    const carolUser = await UserModel.create({
      name: 'Carol',
      emailNormalized: 'carol@a.example',
      passwordHash: await hashPassword(PASSWORD),
    });
    await MembershipModel.create({ organizationId: orgA, userId: carolUser._id, role: 'member' });
    await carol
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'carol@a.example', password: PASSWORD });
  });

  it('lists only the caller’s own organizations', async () => {
    const res = await alice.get('/api/v1/organizations');
    expect(res.status).toBe(200);
    expect(res.body.organizations.map((o: { id: string }) => o.id)).toEqual([orgA]);
  });

  it('lets a member read their organization', async () => {
    const res = await alice.get(`/api/v1/organizations/${orgA}`);
    expect(res.status).toBe(200);
    expect(res.body.organization).toMatchObject({ id: orgA, name: 'Org A', role: 'owner' });
  });

  it('returns 404, not 403, for another tenant’s organization (no existence oracle)', async () => {
    const res = await alice.get(`/api/v1/organizations/${orgB}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const nonexistent = await alice.get('/api/v1/organizations/0123456789abcdef01234567');
    expect(nonexistent.status).toBe(404);
    expect(nonexistent.body.error.message).toBe(res.body.error.message);
  });

  it('does not leak another tenant’s member list', async () => {
    const res = await alice.get(`/api/v1/organizations/${orgB}/members`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('bob@b.example');
  });

  it('rejects malformed organization IDs without querying', async () => {
    const res = await alice.get('/api/v1/organizations/not-an-id');
    expect(res.status).toBe(404);
  });

  it('requires authentication for every organization route', async () => {
    for (const path of ['/api/v1/organizations', `/api/v1/organizations/${orgA}`]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('gives a seeded member read access with the member role', async () => {
    const org = await carol.get(`/api/v1/organizations/${orgA}`);
    expect(org.status).toBe(200);
    expect(org.body.organization.role).toBe('member');

    const members = await carol.get(`/api/v1/organizations/${orgA}/members`);
    expect(members.status).toBe(200);
    const roles = Object.fromEntries(
      members.body.members.map((m: { email: string; role: string }) => [m.email, m.role]),
    );
    expect(roles).toEqual({ 'alice@a.example': 'owner', 'carol@a.example': 'member' });
  });

  it('denies owner-only actions to a member at the scope layer', async () => {
    const carolUser = await UserModel.findOne({ emailNormalized: 'carol@a.example' }).lean();
    const scope = await resolveOrgScope(carolUser!._id, orgA);
    expect(() => assertCan(scope, 'project:create')).toThrow(/role does not allow/);
    expect(() => assertCan(scope, 'telemetry:read')).not.toThrow();
  });

  it('revokes access immediately when a membership is removed', async () => {
    const carolUser = await UserModel.findOne({ emailNormalized: 'carol@a.example' }).lean();
    await MembershipModel.updateOne(
      { organizationId: orgA, userId: carolUser!._id },
      { status: 'removed' },
    );
    expect((await carol.get(`/api/v1/organizations/${orgA}`)).status).toBe(404);
    expect((await carol.get('/api/v1/organizations')).body.organizations).toEqual([]);
  });
});
