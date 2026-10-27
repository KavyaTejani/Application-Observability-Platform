import type { Express } from 'express';
import request from 'supertest';
import { hashPassword } from '../modules/auth/password.js';
import { MembershipModel } from '../modules/organizations/organization.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { TEST_ORIGIN } from './test-app.js';

export const TEST_PASSWORD = 'correct horse battery staple';

let sequence = 0;
const uniqueEmail = (label: string) => `${label}-${++sequence}-${Date.now()}@test.example`;

export interface TestUser {
  agent: ReturnType<typeof request.agent>;
  organizationId: string;
  email: string;
}

/** Registers a new user with their own organization and returns a signed-in agent. */
export async function signUp(app: Express, label: string): Promise<TestUser> {
  const agent = request.agent(app);
  const email = uniqueEmail(label);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', TEST_ORIGIN)
    .send({ name: label, email, password: TEST_PASSWORD, organizationName: `${label} org` });
  if (res.status !== 201)
    throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, organizationId: res.body.organizations[0].id, email };
}

/** Adds a new user to an existing organization with the given role and signs them in. */
export async function addMember(
  app: Express,
  organizationId: string,
  label: string,
  role: 'owner' | 'member' = 'member',
): Promise<TestUser> {
  const email = uniqueEmail(label);
  const user = await UserModel.create({
    name: label,
    emailNormalized: email,
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
  await MembershipModel.create({ organizationId, userId: user._id, role });
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/login')
    .set('Origin', TEST_ORIGIN)
    .send({ email, password: TEST_PASSWORD });
  return { agent, organizationId, email };
}

/** POST with the allowed Origin header, as the browser app sends it. */
export const post = (agent: TestUser['agent'], path: string, body: unknown = {}) =>
  agent
    .post(path)
    .set('Origin', TEST_ORIGIN)
    .send(body as object);

export const patch = (agent: TestUser['agent'], path: string, body: unknown = {}) =>
  agent
    .patch(path)
    .set('Origin', TEST_ORIGIN)
    .send(body as object);

export const del = (agent: TestUser['agent'], path: string) =>
  agent.delete(path).set('Origin', TEST_ORIGIN);

export async function createProject(
  user: TestUser,
  name = `Project ${++sequence}`,
  environment = 'development',
): Promise<string> {
  const res = await post(user.agent, `/api/v1/organizations/${user.organizationId}/projects`, {
    name,
    environment,
  });
  if (res.status !== 201) throw new Error(`createProject failed: ${JSON.stringify(res.body)}`);
  return res.body.project.id;
}

export async function createKey(user: TestUser, projectId: string, name = 'test key') {
  const res = await post(user.agent, `/api/v1/projects/${projectId}/keys`, { name });
  if (res.status !== 201) throw new Error(`createKey failed: ${JSON.stringify(res.body)}`);
  return res.body as { key: { keyId: string; prefix: string }; secret: string };
}
