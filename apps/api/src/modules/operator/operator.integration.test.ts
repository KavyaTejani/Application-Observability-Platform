import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createInternalApp } from '../../internal-app.js';
import { signUp } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';

useTestDatabase();

const TOKEN = 'operator-token-for-tests-0123456789abcdef';

describe('operator health view', () => {
  it('does not exist on the public port when no operator token is configured', async () => {
    const { app } = buildTestApp({ limiter: unlimited });
    const res = await request(app)
      .get('/api/v1/operator/health')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
  });

  describe('with a token configured', () => {
    const ctx = buildTestApp({
      limiter: unlimited,
      config: { operatorToken: TOKEN },
      probes: { loki: async () => Promise.reject(new Error('connection refused')) },
    });
    const { app } = ctx;

    it('requires the operator token; a customer session grants nothing', async () => {
      const none = await request(app).get('/api/v1/operator/health');
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toContain('operator');
      const wrong = await request(app)
        .get('/api/v1/operator/health')
        .set('Authorization', `Bearer ${TOKEN}x`);
      expect(wrong.status).toBe(401);
      const owner = await signUp(app, 'operator-session');
      expect((await owner.agent.get('/api/v1/operator/health')).status).toBe(401);
    });

    it('reports dependencies (including a stopped backend), pipeline counters, and state', async () => {
      const owner = await signUp(app, 'operator-report');
      for (const path of ['/api/v1/operator/health', '/api/v1/operator/status']) {
        const res = await request(app).get(path).set('Authorization', `Bearer ${TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const { report } = res.body;
        expect(report.readiness.status).toBe('not_ready');
        expect(report.readiness.dependencies.loki.status).toBe('down');
        expect(report.readiness.dependencies.mongodb.status).toBe('up');
        expect(report.pipeline.ingest).toHaveProperty('quotaRejections');
        expect(report.instance.alertWorker).toMatchObject({ running: false });
        expect(report.state.organizations).toBeGreaterThanOrEqual(1);
        // Aggregates only: no tenant identities in the report.
        expect(JSON.stringify(report)).not.toContain(owner.email);
        expect(JSON.stringify(report)).not.toContain(owner.organizationId);
      }
    });

    it('is served without a token on the internal listener', async () => {
      const internal = createInternalApp(ctx.metrics, ctx.customerMetrics, ctx.operator);
      const res = await request(internal).get('/operator/health');
      expect(res.status).toBe(200);
      expect(res.body.report.readiness.dependencies.loki.status).toBe('down');
    });
  });
});
