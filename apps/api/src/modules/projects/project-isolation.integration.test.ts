import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createKey,
  createProject,
  del,
  patch,
  post,
  signUp,
  type TestUser,
} from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { ApiKeyModel } from '../api-keys/api-key.model.js';
import { ProjectModel } from './project.model.js';

useTestDatabase();

/**
 * Tenant isolation for projects and API keys (PRD §14.2 items 1 and 4, M3 surface). Organization
 * A and organization B each own a project and a key. Every cross-tenant path must fail with
 * 404 and must leave B's data untouched.
 */
describe('project and key tenant isolation', () => {
  const { app } = buildTestApp({ limiter: unlimited });
  let a: TestUser;
  let b: TestUser;
  let projectA: string;
  let projectB: string;
  let keyB: { key: { keyId: string }; secret: string };

  beforeAll(async () => {
    a = await signUp(app, 'alice');
    b = await signUp(app, 'bob');
    projectA = await createProject(a, 'Alpha');
    projectB = await createProject(b, 'Bravo');
    await createKey(a, projectA);
    keyB = await createKey(b, projectB);
  });

  it('does not list another organization’s projects', async () => {
    const res = await a.agent.get(`/api/v1/organizations/${b.organizationId}/projects`);
    expect(res.status).toBe(404);
    const own = await a.agent.get(`/api/v1/organizations/${a.organizationId}/projects`);
    expect(own.body.projects.map((p: { id: string }) => p.id)).toEqual([projectA]);
  });

  it('cannot create a project inside another organization', async () => {
    const res = await post(a.agent, `/api/v1/organizations/${b.organizationId}/projects`, {
      name: 'Injected',
      environment: 'production',
    });
    expect(res.status).toBe(404);
    expect(
      await ProjectModel.exists({ organizationId: b.organizationId, name: 'Injected' }),
    ).toBeNull();
  });

  it('cannot read, rename, or delete another tenant’s project by its ID', async () => {
    expect((await a.agent.get(`/api/v1/projects/${projectB}`)).status).toBe(404);
    expect((await patch(a.agent, `/api/v1/projects/${projectB}`, { name: 'Owned' })).status).toBe(
      404,
    );
    expect((await del(a.agent, `/api/v1/projects/${projectB}`)).status).toBe(404);

    const untouched = await ProjectModel.findById(projectB).lean();
    expect(untouched).toMatchObject({ name: 'Bravo', status: 'active' });
  });

  it('cannot list, create, revoke, or rotate another tenant’s keys', async () => {
    const base = `/api/v1/projects/${projectB}/keys`;
    expect((await a.agent.get(base)).status).toBe(404);
    expect((await post(a.agent, base, { name: 'stolen' })).status).toBe(404);
    expect((await post(a.agent, `${base}/${keyB.key.keyId}/revoke`)).status).toBe(404);
    expect((await post(a.agent, `${base}/${keyB.key.keyId}/rotate`)).status).toBe(404);
    expect(await ApiKeyModel.countDocuments({ projectId: projectB })).toBe(1);
  });

  it('cannot revoke another tenant’s key through its own project path', async () => {
    // B's public keyId presented under A's project. The lookup is scoped to A's project.
    const res = await post(a.agent, `/api/v1/projects/${projectA}/keys/${keyB.key.keyId}/revoke`);
    expect(res.status).toBe(404);
    expect((await ApiKeyModel.findOne({ keyId: keyB.key.keyId }).lean())?.status).toBe('active');
  });

  it('derives the ingestion tenant from the key only, ignoring forged tenant headers', async () => {
    const res = await request(app)
      .post('/v1/telemetry/test')
      .set('Authorization', `Bearer ${keyB.secret}`)
      .set('X-Scope-OrgID', a.organizationId)
      .send({ organizationId: a.organizationId, projectId: projectA });
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectB);
  });
});
