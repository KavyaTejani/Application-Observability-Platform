import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInternalApp } from '../../internal-app.js';
import { addMember, createKey, createProject, signUp, type TestUser } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { OrganizationModel } from '../organizations/organization.model.js';
import { PlanModel, type PlanLimits } from '../plans/plan.model.js';
import { LokiWriteError, type LogWriter } from '../telemetry/loki-writer.js';
import { secondsUntilReset, utcDay } from './quota.service.js';
import { OrgUsageDailyModel, UsageDailyModel } from './usage.models.js';

useTestDatabase();

class FakeLogWriter implements LogWriter {
  failWith: LokiWriteError | null = null;
  async write() {
    if (this.failWith) throw this.failWith;
  }
}

const metric = () => ({
  kind: 'http_request',
  timestamp: new Date().toISOString(),
  method: 'GET',
  route: '/products/:id',
  statusCode: 200,
  durationMs: 12,
});
const log = () => ({
  timestamp: new Date().toISOString(),
  severity: 'INFO',
  message: 'ok',
});
const batch = (metrics: number, logs = 0) => ({
  schemaVersion: 1,
  service: { name: 'quota-test' },
  metrics: Array.from({ length: metrics }, metric),
  logs: Array.from({ length: logs }, log),
});

let planSeq = 0;
/** Moves an organization to a fresh plan with the given limits. */
async function setPlan(organizationId: string, limits: Partial<PlanLimits>) {
  const plan = await PlanModel.create({
    code: `test-${++planSeq}-${Date.now()}`,
    name: 'Test',
    limits: {
      eventsPerDay: 1_000,
      bytesPerDay: 10_000_000,
      maxProjects: 3,
      maxDashboards: 5,
      maxAlertRules: 10,
      ...limits,
    },
  });
  await OrganizationModel.updateOne({ _id: organizationId }, { planId: plan._id });
}

const orgCounter = (organizationId: string, now = new Date()) =>
  OrgUsageDailyModel.findOne({
    organizationId: new Types.ObjectId(organizationId),
    dayUtc: utcDay(now),
  }).lean();

describe('daily ingestion quota', () => {
  const writer = new FakeLogWriter();
  const ctx = buildTestApp({
    limiter: unlimited,
    logWriter: writer,
    config: { planCacheTtlMs: 0 },
  });
  const { app } = ctx;

  async function tenant(label: string) {
    const owner = await signUp(app, label);
    const projectId = await createProject(owner, 'Shop');
    const { secret } = await createKey(owner, projectId);
    const send = (body: unknown) =>
      request(app)
        .post('/v1/telemetry/batch')
        .set('Authorization', `Bearer ${secret}`)
        .send(body as object);
    return { owner, projectId, send };
  }

  it('rejects a batch that would exceed the limit with 429, Retry-After, and reset details', async () => {
    const { owner, send } = await tenant('quota-basic');
    await setPlan(owner.organizationId, { eventsPerDay: 10 });

    expect((await send(batch(6))).status).toBe(202);
    const over = await send(batch(6));
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(over.body.error.details).toMatchObject({
      limit: 'records',
      used: 6,
      allowed: 10,
      batch: 6,
      retryable: false,
    });
    const retryAfter = Number(over.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(secondsUntilReset(new Date()) + 1);
    expect(Date.parse(over.body.error.details.resetsAt)).toBeGreaterThan(Date.now());

    // A batch that fits exactly is still accepted; after that, even one record is refused.
    expect((await send(batch(4))).status).toBe(202);
    expect((await send(batch(1))).status).toBe(429);
    expect((await orgCounter(owner.organizationId))?.records).toBe(10);
  });

  it('enforces the byte limit as well as the record limit', async () => {
    const { owner, send } = await tenant('quota-bytes');
    await setPlan(owner.organizationId, { bytesPerDay: 500 });
    const res = await send(batch(10)); // ~10 x 120 bytes
    expect(res.status).toBe(429);
    expect(res.body.error.details.limit).toBe('bytes');
    expect((await send(batch(1))).status).toBe(202);
    const counter = await orgCounter(owner.organizationId);
    expect(counter?.bytes).toBeGreaterThan(50);
    expect(counter?.bytes).toBeLessThanOrEqual(500);
  });

  it('cannot be overrun by concurrent batches', async () => {
    const { owner, send } = await tenant('quota-race');
    await setPlan(owner.organizationId, { eventsPerDay: 50 });

    const results = await Promise.all(Array.from({ length: 20 }, () => send(batch(5))));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    expect((await orgCounter(owner.organizationId))?.records).toBe(50);
  });

  it('releases the reservation when the log backend fails, so failed batches use no quota', async () => {
    const { owner, projectId, send } = await tenant('quota-release');
    await setPlan(owner.organizationId, { eventsPerDay: 10 });

    writer.failWith = new LokiWriteError('down', true);
    try {
      expect((await send(batch(2, 5))).status).toBe(503);
    } finally {
      writer.failWith = null;
    }
    expect((await orgCounter(owner.organizationId))?.records).toBe(0);
    expect((await send(batch(5, 5))).status).toBe(202); // the full quota is still available
    const usage = await UsageDailyModel.findOne({ projectId }).lean();
    expect(usage).toMatchObject({ acceptedRecords: 10, rejectedRecords: 0 });
  });

  it('counts only valid records against the quota and records rejections per project', async () => {
    const { owner, projectId, send } = await tenant('quota-valid');
    await setPlan(owner.organizationId, { eventsPerDay: 3 });
    const body = batch(3);
    body.metrics.push({ ...metric(), statusCode: 99 }); // invalid: not counted
    expect((await send(body)).status).toBe(202);
    expect((await send(batch(2))).status).toBe(429);
    const usage = await UsageDailyModel.findOne({ projectId }).lean();
    expect(usage).toMatchObject({
      acceptedRecords: 3,
      rejectedRecords: 3, // one invalid record + two refused by the quota
      quotaRejectedRecords: 2,
    });
    expect(usage?.acceptedBytes).toBeGreaterThan(0);
  });

  it('counts quota rejections in the platform metrics', async () => {
    const internal = createInternalApp(ctx.metrics);
    const res = await request(internal).get('/metrics');
    expect(res.text).toMatch(
      /aop_quota_rejections_total\{limit="records",service="aop-api"\} [1-9]/,
    );
    expect(res.text).toMatch(/aop_ingest_bytes_total\{signal="metrics",service="aop-api"\} [1-9]/);
  });
});

describe('quota day rollover', () => {
  it('starts a fresh allowance at 00:00 UTC', async () => {
    let offsetMs = 0;
    const ctx = buildTestApp({
      limiter: unlimited,
      config: { planCacheTtlMs: 0 },
      now: () => new Date(Date.now() + offsetMs),
    });
    const owner = await signUp(ctx.app, 'quota-rollover');
    const projectId = await createProject(owner);
    const { secret } = await createKey(owner, projectId);
    await setPlan(owner.organizationId, { eventsPerDay: 2 });
    const send = () =>
      request(ctx.app)
        .post('/v1/telemetry/batch')
        .set('Authorization', `Bearer ${secret}`)
        .send(batch(2));

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
    // Move the clock just past midnight UTC (records stay within the 24 h timestamp window).
    offsetMs = secondsUntilReset(new Date()) * 1000 + 1000;
    expect((await send()).status).toBe(202);
  });
});

describe('GET /api/v1/organizations/:id/usage', () => {
  const ctx = buildTestApp({ limiter: unlimited, logWriter: new FakeLogWriter() });
  const { app } = ctx;
  let owner: TestUser;
  let shop: string;

  beforeAll(async () => {
    owner = await signUp(app, 'usage-api');
    shop = await createProject(owner, 'Shop');
    await createProject(owner, 'Idle');
    const { secret } = await createKey(owner, shop);
    await request(app)
      .post('/v1/telemetry/batch')
      .set('Authorization', `Bearer ${secret}`)
      .send(batch(4, 2));
  });

  it('shows used and allowed values, the reset time, and a per-project breakdown', async () => {
    const res = await owner.agent.get(`/api/v1/organizations/${owner.organizationId}/usage`);
    expect(res.status).toBe(200);
    const { usage } = res.body;
    expect(usage.dayUtc).toBe(utcDay(new Date()));
    expect(Date.parse(usage.resetsAt)).toBeGreaterThan(Date.now());
    expect(usage.plan).toEqual({ code: 'developer', name: 'Developer' });
    expect(usage.quota.records).toEqual({ used: 6, limit: 250_000 });
    expect(usage.quota.bytes.used).toBeGreaterThan(0);
    expect(usage.resources.projects).toEqual({ used: 2, limit: 3 });
    expect(usage.retention).toEqual({ metricsDays: 15, logsDays: 7 });
    expect(usage.projects.map((p: { name: string }) => p.name)).toEqual(['Shop', 'Idle']);
    expect(usage.projects[0]).toMatchObject({ id: shop, acceptedRecords: 6 });
    expect(usage.history).toEqual([expect.objectContaining({ dayUtc: usage.dayUtc, records: 6 })]);
  });

  it('is readable by members, and hidden from non-members and anonymous callers', async () => {
    const member = await addMember(app, owner.organizationId, 'usage-member');
    expect(
      (await member.agent.get(`/api/v1/organizations/${owner.organizationId}/usage`)).status,
    ).toBe(200);
    const stranger = await signUp(app, 'usage-stranger');
    expect(
      (await stranger.agent.get(`/api/v1/organizations/${owner.organizationId}/usage`)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/organizations/${owner.organizationId}/usage`)).status,
    ).toBe(401);
  });
});
