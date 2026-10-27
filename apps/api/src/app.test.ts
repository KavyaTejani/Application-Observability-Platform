import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createInternalApp } from './internal-app.js';
import { buildTestApp } from './test/test-app.js';

const failing = (message: string) => async () => Promise.reject(new Error(message));

describe('health endpoints', () => {
  it('GET /health/live responds without checking dependencies', async () => {
    const { app } = buildTestApp({ mongodb: failing('down') });
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('live');
  });

  it('GET /health/ready returns 200 when dependencies are up', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('GET /health/ready returns 200 with status "degraded" when a backend is not configured', async () => {
    const { app } = buildTestApp({ prometheus: null, loki: null });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.loki.status).toBe('not_configured');
  });

  it('GET /health/ready returns 503 when a dependency is down', async () => {
    const { app } = buildTestApp({ redis: failing('ECONNREFUSED') });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.dependencies.redis.status).toBe('down');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});

describe('browser status endpoint', () => {
  it('GET /api/v1/status returns the same readiness report as /health/ready', async () => {
    const { app } = buildTestApp({ loki: null });
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.mongodb.status).toBe('up');
  });

  it('GET /api/v1/status returns 503 when a dependency is down', async () => {
    const { app } = buildTestApp({ mongodb: failing('down') });
    expect((await request(app).get('/api/v1/status')).status).toBe(503);
  });
});

describe('error envelope', () => {
  it('returns the documented 404 shape with a request ID', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });

  it('rejects malformed JSON with INVALID_JSON', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('replaces an unsafe inbound request ID', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health/live').set('X-Request-Id', '<script>');
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('platform metrics', () => {
  it('labels requests by route template and status class, not raw path', async () => {
    const { app, metrics } = buildTestApp();
    await request(app).get('/health/live');
    await request(app).get('/random/probe/path/123');
    const res = await request(createInternalApp(metrics)).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('route="/health/live"');
    expect(res.text).toContain('route="__unmatched__"');
    expect(res.text).not.toContain('/random/probe');
  });

  it('is not served on the public app', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });
});
