import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInternalApp } from '../../internal-app.js';
import { createKey, createProject, signUp } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import {
  LokiWriteError,
  type LogWriter,
  type LokiLogEntry,
  type LokiStreamLabels,
} from './loki-writer.js';

useTestDatabase();

/** Records writes instead of calling Loki; can be told to fail. */
class FakeLogWriter implements LogWriter {
  writes: Array<{ tenantId: string; labels: LokiStreamLabels; entries: LokiLogEntry[] }> = [];
  failWith: LokiWriteError | null = null;
  async write(tenantId: string, labels: LokiStreamLabels, entries: LokiLogEntry[]) {
    if (this.failWith) throw this.failWith;
    this.writes.push({ tenantId, labels, entries });
  }
}

const now = () => new Date().toISOString();
const metric = (overrides: Record<string, unknown> = {}) => ({
  kind: 'http_request',
  timestamp: now(),
  method: 'GET',
  route: '/products/:id',
  statusCode: 200,
  durationMs: 42,
  ...overrides,
});
const log = (overrides: Record<string, unknown> = {}) => ({
  timestamp: now(),
  severity: 'INFO',
  message: 'Request completed',
  requestId: 'req_demo_1',
  attributes: { route: '/products/:id', statusCode: 200 },
  ...overrides,
});

describe('POST /v1/telemetry/batch', () => {
  const writer = new FakeLogWriter();
  const ctx = buildTestApp({ limiter: unlimited, logWriter: writer });
  const { app } = ctx;
  const internal = createInternalApp(ctx.metrics, ctx.customerMetrics);

  let secret: string;
  let organizationId: string;
  let projectId: string;
  const send = (body: unknown, key = secret) =>
    request(app)
      .post('/v1/telemetry/batch')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);

  beforeAll(async () => {
    const owner = await signUp(app, 'ingest');
    organizationId = owner.organizationId;
    projectId = await createProject(owner, 'Shop', 'production');
    secret = (await createKey(owner, projectId)).secret;
  });

  it('accepts metrics and logs, writes logs under the key’s tenant, and reports exact counts', async () => {
    writer.writes = [];
    const res = await send({
      schemaVersion: 1,
      service: { name: 'demo-api', environment: 'production' },
      metrics: [metric(), metric({ statusCode: 503, durationMs: 900 })],
      logs: [log()],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      accepted: { metrics: 2, logs: 1 },
      rejected: { metrics: 0, logs: 0 },
      errors: [],
    });
    expect(res.body.requestId).toMatch(/^req_/);

    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]!.tenantId).toBe(organizationId);
    expect(writer.writes[0]!.labels).toEqual({
      projectId,
      service: 'demo-api',
      environment: 'production',
    });
  });

  it('exposes server-labelled series on the internal scrape endpoint', async () => {
    await send({
      schemaVersion: 1,
      service: { name: 'labels-svc' },
      metrics: [metric({ route: '/users/991' })],
    });
    const res = await request(internal).get('/telemetry-metrics');
    expect(res.status).toBe(200);
    const series = res.text
      .split('\n')
      .find((line) => line.startsWith('app_http_requests_total{') && line.includes('labels-svc'));
    expect(series).toContain(`organization_id="${organizationId}"`);
    expect(series).toContain(`project_id="${projectId}"`);
    expect(series).toContain('environment="production"');
    expect(series).toContain('route="/users/:id"'); // raw ID normalized
    expect(series).toContain('status_class="2xx"');
    expect(res.text).toContain('app_http_request_duration_seconds_bucket');
  });

  it('ignores client-supplied tenant fields in the body and headers', async () => {
    writer.writes = [];
    const res = await request(app)
      .post('/v1/telemetry/batch')
      .set('Authorization', `Bearer ${secret}`)
      .set('X-Scope-OrgID', 'attacker-org')
      .send({
        schemaVersion: 1,
        organizationId: 'attacker-org',
        projectId: 'attacker-project',
        service: { name: 'svc', organizationId: 'attacker-org' },
        logs: [log({ organizationId: 'attacker-org' })],
      });
    expect(res.status).toBe(202);
    expect(writer.writes[0]!.tenantId).toBe(organizationId);
    expect(writer.writes[0]!.labels.projectId).toBe(projectId);
  });

  it('rejects bad records individually and accepts the rest', async () => {
    const res = await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      metrics: [
        metric(),
        metric({ statusCode: 42 }),
        metric({ timestamp: '2000-01-01T00:00:00Z' }),
      ],
      logs: [log(), log({ severity: 'LOUD' })],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual({ metrics: 1, logs: 1 });
    expect(res.body.rejected).toEqual({ metrics: 2, logs: 1 });
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: 'metrics', index: 1, code: 'INVALID_RECORD' }),
        expect.objectContaining({ signal: 'metrics', index: 2, code: 'TIMESTAMP_OUT_OF_RANGE' }),
        expect.objectContaining({ signal: 'logs', index: 1, code: 'INVALID_RECORD' }),
      ]),
    );
  });

  it('rejects timestamps too far in the future', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      logs: [log({ timestamp: future })],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_VALID_RECORDS');
  });

  it('returns 400 when every record is invalid', async () => {
    const res = await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      metrics: [{ kind: 'nope' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_VALID_RECORDS');
    expect(res.body.error.details.rejected).toEqual({ metrics: 1, logs: 0 });
  });

  it('rejects an invalid envelope, an empty batch, and an environment mismatch', async () => {
    expect((await send({ schemaVersion: 9, service: { name: 'svc' } })).body.error.code).toBe(
      'INVALID_BATCH',
    );
    expect((await send({ schemaVersion: 1, service: { name: 'svc' } })).body.error.code).toBe(
      'EMPTY_BATCH',
    );
    const mismatch = await send({
      schemaVersion: 1,
      service: { name: 'svc', environment: 'development' },
      metrics: [metric()],
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('ENVIRONMENT_MISMATCH');
  });

  it('rejects more than 500 records with 413', async () => {
    const res = await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      metrics: Array.from({ length: 501 }, () => metric()),
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BATCH_TOO_LARGE');
  });

  it('rejects bodies over 1 MiB with 413', async () => {
    const res = await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      logs: [log({ message: 'x'.repeat(1_100_000) })],
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires a valid key', async () => {
    const res = await send(
      { schemaVersion: 1, service: { name: 'svc' }, metrics: [metric()] },
      'bad',
    );
    expect(res.status).toBe(401);
  });

  it('redacts secrets in log messages and attributes before storage', async () => {
    writer.writes = [];
    await send({
      schemaVersion: 1,
      service: { name: 'svc' },
      logs: [
        log({
          message: `token=${secret}`,
          attributes: { password: 'hunter2', authorization: 'Bearer abcdefghijk' },
        }),
      ],
    });
    const stored = JSON.stringify(writer.writes);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('abcdefghijk');
  });

  it('on log-backend failure returns 503 + Retry-After and records nothing from the batch', async () => {
    const before = await request(internal).get('/telemetry-metrics');
    const countBefore = (before.text.match(/service="failure-svc"/g) ?? []).length;

    writer.failWith = new LokiWriteError('connection refused', true);
    const res = await send({
      schemaVersion: 1,
      service: { name: 'failure-svc' },
      metrics: [metric()],
      logs: [log()],
    });
    writer.failWith = null;

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toMatchObject({
      code: 'BACKEND_WRITE_FAILED',
      details: { retryable: true },
    });
    const after = await request(internal).get('/telemetry-metrics');
    expect((after.text.match(/service="failure-svc"/g) ?? []).length).toBe(countBefore);
  });

  it('counts accepted and rejected records in platform metrics', async () => {
    const res = await request(internal).get('/metrics');
    expect(res.text).toMatch(
      /aop_ingest_records_total\{signal="metrics",outcome="accepted"[^}]*\} [1-9]/,
    );
    expect(res.text).toMatch(
      /aop_ingest_records_total\{signal="logs",outcome="rejected"[^}]*\} [1-9]/,
    );
    expect(res.text).toMatch(/aop_backend_requests_total\{backend="loki",outcome="failure"/);
  });
});

describe('deployment without telemetry backends', () => {
  it('refuses to acknowledge signals it cannot store', async () => {
    const { app } = buildTestApp({
      limiter: unlimited,
      logWriter: null,
      config: { prometheusUrl: undefined },
    });
    const owner = await signUp(app, 'nobackend');
    const { secret } = await createKey(owner, await createProject(owner));
    const res = await request(app)
      .post('/v1/telemetry/batch')
      .set('Authorization', `Bearer ${secret}`)
      .send({ schemaVersion: 1, service: { name: 'svc' }, metrics: [metric()] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BACKEND_NOT_CONFIGURED');
  });
});
