import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { MembershipModel, OrganizationModel } from '../organizations/organization.model.js';
import { UserModel } from '../users/user.model.js';
import { SessionModel } from './session.model.js';

useTestDatabase();

const PASSWORD = 'correct horse battery staple';
const COOKIE = 'aop_sid';

let counter = 0;
const uniqueEmail = () => `user${++counter}-${Date.now()}@example.com`;

function setup() {
  const { app } = buildTestApp();
  const register = (body: Record<string, unknown>, agent = request.agent(app)) =>
    agent.post('/api/v1/auth/register').set('Origin', TEST_ORIGIN).send(body);
  const login = (body: Record<string, unknown>, agent = request.agent(app)) =>
    agent.post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send(body);
  return { app, register, login };
}

const sessionCookie = (res: request.Response): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((cookie) => cookie.startsWith(`${COOKIE}=`));
};

describe('registration', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates a user, an organization, and an owner membership, and signs the user in', async () => {
    const email = uniqueEmail();
    const agent = request.agent(ctx.app);
    const res = await ctx.register({ name: 'Ada', email, password: PASSWORD }, agent);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Ada', email });
    expect(res.body.organizations[0]).toMatchObject({ name: "Ada's Organization", role: 'owner' });

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.organizations).toHaveLength(1);
  });

  it('stores an Argon2id hash, never the plaintext password', async () => {
    const email = uniqueEmail();
    await ctx.register({ name: 'Ada', email, password: PASSWORD });
    const user = await UserModel.findOne({ emailNormalized: email }).select('+passwordHash').lean();
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
  });

  it('does not expose the password hash through normal queries', async () => {
    const email = uniqueEmail();
    await ctx.register({ name: 'Ada', email, password: PASSWORD });
    const user = await UserModel.findOne({ emailNormalized: email }).lean();
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate email case-insensitively with 409 EMAIL_TAKEN', async () => {
    const email = uniqueEmail();
    await ctx.register({ name: 'Ada', email, password: PASSWORD });
    const res = await ctx.register({ name: 'Eve', email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('lets exactly one of two concurrent signups with the same email succeed, leaving no orphans', async () => {
    const email = uniqueEmail();
    const [a, b] = await Promise.all([
      ctx.register({ name: 'One', email, password: PASSWORD }),
      ctx.register({ name: 'Two', email, password: PASSWORD }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const users = await UserModel.find({ emailNormalized: email }).lean();
    expect(users).toHaveLength(1);
    // The losing request must not leave an organization or membership behind.
    const orgs = await OrganizationModel.find({
      name: { $in: ["One's Organization", "Two's Organization"] },
    }).lean();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.ownerUserId.equals(users[0]!._id)).toBe(true);
    expect(await MembershipModel.countDocuments({ organizationId: orgs[0]!._id })).toBe(1);
  });

  it('returns field-level validation errors', async () => {
    const res = await ctx.register({ name: '', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
  });

  it('ignores client-supplied tenant and role fields', async () => {
    const victimOrgId = new mongoose.Types.ObjectId();
    const res = await ctx.register({
      name: 'Mallory',
      email: uniqueEmail(),
      password: PASSWORD,
      organizationId: victimOrgId.toHexString(),
      role: 'owner',
    });
    expect(res.status).toBe(201);
    expect(res.body.organizations[0].id).not.toBe(victimOrgId.toHexString());
    expect(await MembershipModel.exists({ organizationId: victimOrgId })).toBeNull();
  });
});

describe('login and logout', () => {
  let ctx: ReturnType<typeof setup>;
  let email: string;
  beforeEach(async () => {
    ctx = setup();
    email = uniqueEmail();
    await ctx.register({ name: 'Ada', email, password: PASSWORD });
  });

  it('logs in with valid credentials and normalizes the email', async () => {
    const agent = request.agent(ctx.app);
    const res = await ctx.login({ email: `  ${email.toUpperCase()} `, password: PASSWORD }, agent);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('returns an identical error for a wrong password and an unknown email', async () => {
    const wrong = await ctx.login({ email, password: 'wrong password here' });
    const unknown = await ctx.login({ email: uniqueEmail(), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rejects a disabled account with the same generic error', async () => {
    await UserModel.updateOne({ emailNormalized: email }, { status: 'disabled' });
    const res = await ctx.login({ email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('issues a fresh session ID on login and revokes the previous one (fixation defence)', async () => {
    const agent = request.agent(ctx.app);
    const first = sessionCookie(await ctx.login({ email, password: PASSWORD }, agent));
    const second = sessionCookie(await ctx.login({ email, password: PASSWORD }, agent));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.split(';')[0]).not.toBe(second?.split(';')[0]);

    const stale = await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Cookie', first!.split(';')[0]!);
    expect(stale.status).toBe(401);
  });

  it('logout invalidates the session server-side, not just the cookie', async () => {
    const agent = request.agent(ctx.app);
    const cookie = sessionCookie(await ctx.login({ email, password: PASSWORD }, agent))!.split(
      ';',
    )[0]!;
    const out = await agent.post('/api/v1/auth/logout').set('Origin', TEST_ORIGIN);
    expect(out.status).toBe(204);

    // Replaying the old cookie after logout must fail.
    const replay = await request(ctx.app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const res = await ctx.login({ email, password: PASSWORD });
    const token = decodeURIComponent(sessionCookie(res)!.split(';')[0]!.split('=')[1]!);
    expect(await SessionModel.exists({ sessionIdHash: token })).toBeNull();
    expect(JSON.stringify(await SessionModel.find().lean())).not.toContain(token);
  });

  it('rejects /me without a session with 401 UNAUTHENTICATED', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session cookie', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me').set('Cookie', `${COOKIE}=forged`);
    expect(res.status).toBe(401);
  });
});

describe('CSRF origin protection', () => {
  it('rejects state-changing requests without an Origin or Referer', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('rejects a cross-site Origin', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin Referer when Origin is absent', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Referer', `${TEST_ORIGIN}/settings`);
    expect(res.status).toBe(204);
  });

  it('does not origin-check safe methods', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/v1/auth/me').set('Origin', 'https://evil.example');
    expect(res.status).toBe(401); // unauthenticated, but not blocked as CSRF
  });
});

describe('auth rate limiting', () => {
  it('limits signups per IP and returns Retry-After', async () => {
    const { register } = setup();
    for (let i = 0; i < 10; i++) {
      const res = await register({ name: '', email: 'bad', password: 'x' });
      expect(res.status).toBe(400);
    }
    const limited = await register({ name: 'Ada', email: uniqueEmail(), password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits repeated login attempts for one email', async () => {
    const { login } = setup();
    const email = uniqueEmail();
    for (let i = 0; i < 10; i++) {
      expect((await login({ email, password: 'wrong password' })).status).toBe(401);
    }
    expect((await login({ email, password: 'wrong password' })).status).toBe(429);
  });
});
