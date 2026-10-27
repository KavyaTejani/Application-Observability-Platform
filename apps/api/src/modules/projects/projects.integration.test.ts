import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { addMember, createProject, del, patch, post, signUp } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { OrganizationModel } from '../organizations/organization.model.js';

useTestDatabase();

describe('projects', () => {
  const { app } = buildTestApp({ limiter: unlimited });

  it('lets an owner create, list, get, and rename a project', async () => {
    const owner = await signUp(app, 'owner');
    const create = await post(
      owner.agent,
      `/api/v1/organizations/${owner.organizationId}/projects`,
      { name: 'Shop API', environment: 'production' },
    );
    expect(create.status).toBe(201);
    expect(create.body.project).toMatchObject({
      name: 'Shop API',
      environment: 'production',
      organizationId: owner.organizationId,
    });
    const id = create.body.project.id;

    const list = await owner.agent.get(`/api/v1/organizations/${owner.organizationId}/projects`);
    expect(list.body.projects.map((p: { id: string }) => p.id)).toEqual([id]);

    expect((await owner.agent.get(`/api/v1/projects/${id}`)).body.project.name).toBe('Shop API');

    const renamed = await patch(owner.agent, `/api/v1/projects/${id}`, {
      name: 'Shop API v2',
      environment: 'development',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project).toMatchObject({ name: 'Shop API v2', environment: 'production' });
  });

  it('validates input with field errors', async () => {
    const owner = await signUp(app, 'owner');
    const res = await post(owner.agent, `/api/v1/organizations/${owner.organizationId}/projects`, {
      name: '',
      environment: 'prod',
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['environment', 'name']);
  });

  it('rejects a duplicate active name case-insensitively but allows reuse after deletion', async () => {
    const owner = await signUp(app, 'owner');
    const id = await createProject(owner, 'Billing');
    const dup = await post(owner.agent, `/api/v1/organizations/${owner.organizationId}/projects`, {
      name: 'billing',
      environment: 'staging',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PROJECT_NAME_TAKEN');

    expect((await del(owner.agent, `/api/v1/projects/${id}`)).status).toBe(204);
    expect((await owner.agent.get(`/api/v1/projects/${id}`)).status).toBe(404);
    await createProject(owner, 'Billing');
  });

  it('enforces the plan project limit, and deleting frees a slot', async () => {
    const owner = await signUp(app, 'owner');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await createProject(owner));
    const over = await post(owner.agent, `/api/v1/organizations/${owner.organizationId}/projects`, {
      name: 'Fourth',
      environment: 'development',
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PLAN_LIMIT_REACHED');

    await del(owner.agent, `/api/v1/projects/${ids[0]}`);
    await createProject(owner, 'Fourth');
  });

  it('works for organizations created before projectCount existed', async () => {
    const owner = await signUp(app, 'legacy');
    await OrganizationModel.collection.updateOne(
      { _id: new Types.ObjectId(owner.organizationId) },
      { $unset: { projectCount: '' } },
    );
    await createProject(owner, 'First after upgrade');
    const org = await OrganizationModel.findById(owner.organizationId).lean();
    expect(org?.projectCount).toBe(1);
  });

  it('cannot exceed the project limit with concurrent creates', async () => {
    const owner = await signUp(app, 'owner');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(owner.agent, `/api/v1/organizations/${owner.organizationId}/projects`, {
          name: `Concurrent ${i}`,
          environment: 'development',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const org = await OrganizationModel.findById(owner.organizationId).lean();
    expect(org?.projectCount).toBe(3);
  });

  it('lets members read projects but not create, rename, or delete them', async () => {
    const owner = await signUp(app, 'owner');
    const id = await createProject(owner, 'Readable');
    const member = await addMember(app, owner.organizationId, 'member');

    const list = await member.agent.get(`/api/v1/organizations/${owner.organizationId}/projects`);
    expect(list.status).toBe(200);
    expect((await member.agent.get(`/api/v1/projects/${id}`)).status).toBe(200);

    const create = await post(
      member.agent,
      `/api/v1/organizations/${owner.organizationId}/projects`,
      {
        name: 'Nope',
        environment: 'development',
      },
    );
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect((await patch(member.agent, `/api/v1/projects/${id}`, { name: 'x' })).status).toBe(403);
    expect((await del(member.agent, `/api/v1/projects/${id}`)).status).toBe(403);
  });
});
