import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, createKey, createProject, del, post, signUp } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { ApiKeyModel } from './api-key.model.js';
import { MAX_ACTIVE_KEYS_PER_PROJECT } from './api-key.service.js';

useTestDatabase();

/** Calls the key-authenticated connection-test endpoint. */
const testKey = (app: Parameters<typeof request>[0], key: string | undefined) => {
  const req = request(app).post('/v1/telemetry/test');
  return key === undefined ? req : req.set('Authorization', `Bearer ${key}`);
};

describe('API key lifecycle', () => {
  const { app } = buildTestApp({ limiter: unlimited });

  it('shows the full key exactly once and stores only its HMAC', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const created = await post(owner.agent, `/api/v1/projects/${projectId}/keys`, { name: 'prod' });

    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.secret).toMatch(/^aop_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(created.body.key).toMatchObject({
      name: 'prod',
      state: 'active',
      scopes: ['telemetry:write'],
    });
    expect(created.body.key).not.toHaveProperty('keyHash');

    const list = await owner.agent.get(`/api/v1/projects/${projectId}/keys`);
    const listed = JSON.stringify(list.body);
    const secretPart = created.body.secret.split('.')[1];
    expect(listed).not.toContain(secretPart);
    expect(listed).not.toContain('keyHash');
    expect(list.body.keys[0].prefix).toBe(created.body.key.prefix);

    const stored = await ApiKeyModel.findOne({ keyId: created.body.key.keyId }).lean();
    expect(JSON.stringify(stored)).not.toContain(secretPart);
    expect(stored?.keyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('authenticates a valid key and reports its project', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner, 'Checkout', 'staging');
    const { secret, key } = await createKey(owner, projectId);

    const res = await testKey(app, secret);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      keyId: key.keyId,
      project: { id: projectId, name: 'Checkout', environment: 'staging' },
    });
  });

  it('rejects missing, malformed, unknown, and tampered keys with one generic 401', async () => {
    const owner = await signUp(app, 'owner');
    const { secret } = await createKey(owner, await createProject(owner));
    const tampered = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const unknown = `aop_${'0'.repeat(16)}.${'A'.repeat(43)}`;

    for (const key of [undefined, 'garbage', unknown, tampered, secret.toUpperCase()]) {
      const res = await testKey(app, key);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_API_KEY');
      expect(res.headers['www-authenticate']).toContain('Bearer');
    }
  });

  it('rejects a revoked key immediately (same-process cache invalidation)', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const { secret, key } = await createKey(owner, projectId);
    expect((await testKey(app, secret)).status).toBe(200); // now cached

    const revoked = await post(
      owner.agent,
      `/api/v1/projects/${projectId}/keys/${key.keyId}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.key.state).toBe('revoked');
    expect((await testKey(app, secret)).status).toBe(401);

    // Revoking again is idempotent and keeps the original timestamp.
    const again = await post(owner.agent, `/api/v1/projects/${projectId}/keys/${key.keyId}/revoke`);
    expect(again.body.key.revokedAt).toBe(revoked.body.key.revokedAt);
  });

  it('rotates with immediate revocation by default', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const old = await createKey(owner, projectId);

    const res = await post(
      owner.agent,
      `/api/v1/projects/${projectId}/keys/${old.key.keyId}/rotate`,
    );
    expect(res.status).toBe(200);
    expect(res.body.previous).toMatchObject({
      state: 'revoked',
      replacedBy: res.body.replacement.key.keyId,
    });
    expect((await testKey(app, old.secret)).status).toBe(401);
    expect((await testKey(app, res.body.replacement.secret)).status).toBe(200);
  });

  it('rotates with a grace period during which both keys work', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const old = await createKey(owner, projectId);

    const res = await post(
      owner.agent,
      `/api/v1/projects/${projectId}/keys/${old.key.keyId}/rotate`,
      {
        gracePeriodHours: 2,
      },
    );
    expect(res.body.previous.state).toBe('expiring');
    expect(new Date(res.body.previous.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect((await testKey(app, old.secret)).status).toBe(200);
    expect((await testKey(app, res.body.replacement.secret)).status).toBe(200);

    // Rotating a key that is already in its grace period is refused.
    const twice = await post(
      owner.agent,
      `/api/v1/projects/${projectId}/keys/${old.key.keyId}/rotate`,
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('KEY_NOT_ACTIVE');
  });

  it('rejects a grace period above 24 hours', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const { key } = await createKey(owner, projectId);
    const res = await post(owner.agent, `/api/v1/projects/${projectId}/keys/${key.keyId}/rotate`, {
      gracePeriodHours: 48,
    });
    expect(res.status).toBe(400);
  });

  it('caps active keys per project', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_PROJECT; i++) await createKey(owner, projectId);
    const res = await post(owner.agent, `/api/v1/projects/${projectId}/keys`, {
      name: 'one too many',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KEY_LIMIT_REACHED');
  });

  it('revokes every key when the project is deleted', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const a = await createKey(owner, projectId);
    const b = await createKey(owner, projectId);
    expect((await testKey(app, a.secret)).status).toBe(200);

    expect((await del(owner.agent, `/api/v1/projects/${projectId}`)).status).toBe(204);
    expect((await testKey(app, a.secret)).status).toBe(401);
    expect((await testKey(app, b.secret)).status).toBe(401);
  });

  it('lets members list key metadata but not create, revoke, or rotate keys', async () => {
    const owner = await signUp(app, 'owner');
    const projectId = await createProject(owner);
    const { key } = await createKey(owner, projectId);
    const member = await addMember(app, owner.organizationId, 'member');

    const list = await member.agent.get(`/api/v1/projects/${projectId}/keys`);
    expect(list.status).toBe(200);
    expect(list.body.keys).toHaveLength(1);
    expect(
      (await post(member.agent, `/api/v1/projects/${projectId}/keys`, { name: 'x' })).status,
    ).toBe(403);
    expect(
      (await post(member.agent, `/api/v1/projects/${projectId}/keys/${key.keyId}/revoke`)).status,
    ).toBe(403);
    expect(
      (await post(member.agent, `/api/v1/projects/${projectId}/keys/${key.keyId}/rotate`)).status,
    ).toBe(403);
  });

  it('does not accept a browser session in place of an API key (ING-002)', async () => {
    const owner = await signUp(app, 'owner');
    const res = await owner.agent.post('/v1/telemetry/test');
    expect(res.status).toBe(401);
  });
});

describe('key cache TTL across instances', () => {
  it('a key revoked through another instance stops working once the cache TTL elapses', async () => {
    let now = Date.now();
    const clock = () => new Date(now);
    // Two app instances share the database but have separate key caches, as in a
    // multi-instance deployment.
    const writer = buildTestApp({ limiter: unlimited, now: clock });
    const reader = buildTestApp({ limiter: unlimited, now: clock });

    const owner = await signUp(writer.app, 'owner');
    const projectId = await createProject(owner);
    const { secret, key } = await createKey(owner, projectId);

    expect((await testKey(reader.app, secret)).status).toBe(200); // cached in the reader
    await post(owner.agent, `/api/v1/projects/${projectId}/keys/${key.keyId}/revoke`);

    // Within the TTL the reader may still accept it (documented propagation window)…
    expect((await testKey(reader.app, secret)).status).toBe(200);
    // …and after the TTL it re-reads the database and rejects it.
    now += reader.config.apiKeyCacheTtlMs + 1;
    expect((await testKey(reader.app, secret)).status).toBe(401);
  });
});
