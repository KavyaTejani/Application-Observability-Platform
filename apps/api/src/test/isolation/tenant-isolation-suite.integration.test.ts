import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInternalApp } from '../../internal-app.js';
import { IncidentModel } from '../../modules/alerts/alert.models.js';
import {
  LokiQueryClient,
  type PromInstantSample,
  type PromRangeSeries,
  type PrometheusQueryApi,
} from '../../modules/query/backend-clients.js';
import { LokiWriter } from '../../modules/telemetry/loki-writer.js';
import { createPlatformMetrics } from '../../observability/platform-metrics.js';
import { createKey, createProject, del, patch, post, signUp, type TestUser } from '../fixtures.js';
import { buildTestApp, TEST_ORIGIN, unlimited } from '../test-app.js';
import { useTestDatabase } from '../test-db.js';

useTestDatabase();

const LOKI_URL = process.env.TEST_LOKI_URL ?? 'http://localhost:3100';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

/** Records every PromQL expression the API generates, so tenant matchers can be asserted. */
class RecordingPrometheus implements PrometheusQueryApi {
  expressions: string[] = [];
  async queryRange(expr: string): Promise<PromRangeSeries[]> {
    this.expressions.push(expr);
    return [];
  }
  async query(expr: string): Promise<PromInstantSample[]> {
    this.expressions.push(expr);
    return [];
  }
  async labelValues(_label: string, match: string): Promise<string[]> {
    this.expressions.push(match);
    return [];
  }
}

interface Tenant {
  user: TestUser;
  projectId: string;
  keyId: string;
  secret: string;
  destinationId: string;
  ruleId: string;
  incidentId: string;
  marker: string;
}

/**
 * The mandatory tenant-isolation suite (PRD §14.2). Organizations A and B each get their own
 * user, project, key, destination, alert rule, incident, and unique synthetic telemetry written
 * through the real ingestion path into the real Loki. Each numbered test is one item of §14.2;
 * all of them are release blockers.
 *
 * Narrower isolation tests also live next to each module; this file is the single place that
 * demonstrates the whole boundary end to end.
 */
describe('tenant isolation suite (PRD §14.2)', () => {
  const prometheus = new RecordingPrometheus();
  const lokiQuery = new LokiQueryClient(
    LOKI_URL,
    5000,
    createPlatformMetrics(),
    pino({ level: 'silent' }),
  );
  const ctx = buildTestApp({
    limiter: unlimited,
    logWriter: new LokiWriter(LOKI_URL, 5000),
    lokiQuery,
    prometheusQuery: prometheus,
    webhookResolve: publicDns,
  });
  const { app } = ctx;
  let A: Tenant;
  let B: Tenant;

  const ingest = (secret: string, body: object, headers: Record<string, string> = {}) =>
    request(app)
      .post('/v1/telemetry/batch')
      .set('Authorization', `Bearer ${secret}`)
      .set(headers)
      .send(body);

  async function makeTenant(label: string): Promise<Tenant> {
    const user = await signUp(app, label);
    const projectId = await createProject(user, `${label} project`);
    const { key, secret } = await createKey(user, projectId);
    const destinationId = (
      await post(
        user.agent,
        `/api/v1/organizations/${user.organizationId}/notification-destinations`,
        { name: `${label} hook`, url: `https://hooks.example.com/${label}` },
      )
    ).body.destination.id as string;
    const ruleId = (
      await post(user.agent, `/api/v1/projects/${projectId}/alert-rules`, {
        name: `${label} errors`,
        metricKey: 'error_rate',
        operator: 'gt',
        threshold: 0.05,
        notificationDestinationId: destinationId,
      })
    ).body.rule.id as string;
    const incident = await IncidentModel.create({
      organizationId: user.organizationId,
      projectId,
      alertRuleId: ruleId,
      fingerprint: `rule:${ruleId}`,
      status: 'firing',
      title: `${label} incident`,
      startedAt: new Date(),
      lastTriggeredAt: new Date(),
      ruleSnapshot: {
        metricKey: 'error_rate',
        operator: 'gt',
        threshold: 0.05,
        windowSeconds: 300,
      },
    });
    const marker = `${label}-${randomBytes(6).toString('hex')}`;
    return {
      user,
      projectId,
      keyId: key.keyId,
      secret,
      destinationId,
      ruleId,
      incidentId: incident._id.toHexString(),
      marker,
    };
  }

  const batch = (marker: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    service: { name: 'isolation' },
    metrics: [
      {
        kind: 'http_request',
        timestamp: new Date().toISOString(),
        method: 'GET',
        route: '/orders',
        statusCode: 200,
        durationMs: 10,
      },
    ],
    logs: [{ timestamp: new Date().toISOString(), severity: 'INFO', message: `hello ${marker}` }],
    ...extra,
  });

  const searchLogs = (t: Tenant, projectId: string, headers: Record<string, string> = {}) =>
    t.user.agent
      .get(`/api/v1/projects/${projectId}/logs`)
      .query({ contains: 'hello', limit: '200' })
      .set(headers);

  beforeAll(async () => {
    A = await makeTenant('tenant-a');
    B = await makeTenant('tenant-b');
    // Unique synthetic telemetry in each tenant, through the real ingestion path.
    expect((await ingest(A.secret, batch(A.marker))).status).toBe(202);
    expect((await ingest(B.secret, batch(B.marker))).status).toBe(202);
  });

  it('1. A’s session cannot list or read B’s projects, keys, rules, incidents, destinations, or usage', async () => {
    const a = A.user.agent;
    const orgB = B.user.organizationId;

    const ownProjects = await a.get(`/api/v1/organizations/${A.user.organizationId}/projects`);
    expect(ownProjects.body.projects.map((p: { id: string }) => p.id)).toEqual([A.projectId]);

    const reads = [
      `/api/v1/organizations/${orgB}`,
      `/api/v1/organizations/${orgB}/members`,
      `/api/v1/organizations/${orgB}/projects`,
      `/api/v1/organizations/${orgB}/notification-destinations`,
      `/api/v1/organizations/${orgB}/usage`,
      `/api/v1/projects/${B.projectId}`,
      `/api/v1/projects/${B.projectId}/keys`,
      `/api/v1/projects/${B.projectId}/alert-rules`,
      `/api/v1/projects/${B.projectId}/incidents`,
      `/api/v1/incidents/${B.incidentId}`,
      `/api/v1/incidents/${B.incidentId}/deliveries`,
    ];
    for (const path of reads) {
      const res = await a.get(path);
      expect(res.status, path).toBe(404); // 404, not 403: no existence oracle
      expect(JSON.stringify(res.body), path).not.toContain(B.marker);
    }

    const writes = [
      post(a, `/api/v1/projects/${B.projectId}/keys`, { name: 'stolen' }),
      post(a, `/api/v1/projects/${B.projectId}/keys/${B.keyId}/revoke`),
      patch(a, `/api/v1/projects/${B.projectId}`, { name: 'hijacked' }),
      patch(a, `/api/v1/alert-rules/${B.ruleId}`, { enabled: false }),
      del(a, `/api/v1/alert-rules/${B.ruleId}`),
      patch(a, `/api/v1/notification-destinations/${B.destinationId}`, { enabled: false }),
      post(a, `/api/v1/notification-destinations/${B.destinationId}/test`),
      // A's own project, but B's destination: must not be usable.
      post(a, `/api/v1/projects/${A.projectId}/alert-rules`, {
        name: 'borrowed hook',
        metricKey: 'error_rate',
        operator: 'gt',
        threshold: 0.05,
        notificationDestinationId: B.destinationId,
      }),
    ];
    for (const [i, res] of (await Promise.all(writes)).entries()) {
      expect([400, 404], `write #${i}`).toContain(res.status);
    }
    // B's resources are untouched.
    const bRules = await B.user.agent.get(`/api/v1/projects/${B.projectId}/alert-rules`);
    expect(bRules.body.rules[0]).toMatchObject({ id: B.ruleId, enabled: true });
    expect((await B.user.agent.get(`/api/v1/projects/${B.projectId}`)).body.project.name).toBe(
      'tenant-b project',
    );
  });

  it('2. A cannot query B’s metrics with a forged projectId, and A’s queries carry only A’s scope', async () => {
    prometheus.expressions = [];
    const forged = await post(A.user.agent, `/api/v1/projects/${B.projectId}/metrics/query`, {
      metricKey: 'request_rate',
      range: '1h',
    });
    expect(forged.status).toBe(404);
    expect(
      (await A.user.agent.get(`/api/v1/projects/${B.projectId}/metrics/summary?range=1h`)).status,
    ).toBe(404);
    expect(prometheus.expressions).toEqual([]); // rejected before any backend call

    const own = await post(A.user.agent, `/api/v1/projects/${A.projectId}/metrics/query`, {
      metricKey: 'error_rate',
      range: '1h',
    });
    expect(own.status).toBe(200);
    expect(prometheus.expressions.length).toBeGreaterThan(0);
    for (const expr of prometheus.expressions) {
      expect(expr).toContain(`organization_id="${A.user.organizationId}"`);
      expect(expr).toContain(`project_id="${A.projectId}"`);
      expect(expr).not.toContain(B.user.organizationId);
      expect(expr).not.toContain(B.projectId);
    }
  });

  it('3. A cannot read B’s logs by changing a client-side tenant ID or header', async () => {
    const own = await searchLogs(A, A.projectId);
    expect(own.status).toBe(200);
    const ownText = JSON.stringify(own.body);
    expect(ownText).toContain(A.marker);
    expect(ownText).not.toContain(B.marker);

    // A forged Loki tenant header is ignored: the tenant comes from the server-side scope.
    const forgedHeader = await searchLogs(A, A.projectId, {
      'X-Scope-OrgID': B.user.organizationId,
    });
    expect(forgedHeader.status).toBe(200);
    expect(JSON.stringify(forgedHeader.body)).not.toContain(B.marker);

    expect((await searchLogs(A, B.projectId)).status).toBe(404);
    const forgedParam = await A.user.agent
      .get(`/api/v1/projects/${A.projectId}/logs`)
      .query({ organizationId: B.user.organizationId });
    expect(forgedParam.status).toBe(400);

    // And B, through the same API, sees only its own data.
    const bView = JSON.stringify((await searchLogs(B, B.projectId)).body);
    expect(bView).toContain(B.marker);
    expect(bView).not.toContain(A.marker);
  });

  it('4. A’s API key cannot ingest into B’s project, whatever tenant fields it sends', async () => {
    const marker = `forged-${randomBytes(6).toString('hex')}`;
    const res = await ingest(
      A.secret,
      batch(marker, {
        organizationId: B.user.organizationId,
        projectId: B.projectId,
        tenantId: B.user.organizationId,
      }),
      { 'X-Scope-OrgID': B.user.organizationId },
    );
    // Tenant fields in the body and the Loki header are ignored: the key alone decides.
    expect(res.status).toBe(202);
    expect(JSON.stringify((await searchLogs(A, A.projectId)).body)).toContain(marker);
    expect(JSON.stringify((await searchLogs(B, B.projectId)).body)).not.toContain(marker);

    const series = await request(createInternalApp(ctx.metrics, ctx.customerMetrics)).get(
      '/telemetry-metrics',
    );
    const routeLines = series.text.split('\n').filter((l) => l.includes('service="isolation"'));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) {
      const org = /organization_id="([a-f0-9]+)"/.exec(line)?.[1];
      const project = /project_id="([a-f0-9]+)"/.exec(line)?.[1];
      expect([
        `${A.user.organizationId}/${A.projectId}`,
        `${B.user.organizationId}/${B.projectId}`,
      ]).toContain(`${org}/${project}`);
    }
  });

  it('5. a revoked key cannot ingest after the documented propagation window', async () => {
    const { key, secret } = await createKey(A.user, A.projectId, 'to revoke');
    // A second API instance (same database), with its own key cache and a controllable clock.
    let offsetMs = 0;
    const other = buildTestApp({
      limiter: unlimited,
      logWriter: new LokiWriter(LOKI_URL, 5000),
      now: () => new Date(Date.now() + offsetMs),
    });
    const send = (target: typeof app) =>
      request(target)
        .post('/v1/telemetry/batch')
        .set('Authorization', `Bearer ${secret}`)
        .send(batch('revocation'));
    expect((await send(other.app)).status).toBe(202); // cached on the other instance

    await post(A.user.agent, `/api/v1/projects/${A.projectId}/keys/${key.keyId}/revoke`);
    expect((await send(app)).status).toBe(401); // the revoking instance: immediately

    // The other instance may accept it until its cache entry expires (API_KEY_CACHE_TTL_SECONDS),
    // and must refuse it afterwards.
    offsetMs = ctx.config.apiKeyCacheTtlMs + 1000;
    expect((await send(other.app)).status).toBe(401);
  });

  it('6. backends and internal endpoints are not reachable through public routes', async () => {
    const internalPaths = [
      '/metrics',
      '/telemetry-metrics',
      '/operator/health',
      '/api/v1/query?query=up',
      '/loki/api/v1/query_range',
      '/loki/api/v1/push',
      '/api/v1/operator/health', // exists only when OPERATOR_TOKEN is configured
    ];
    for (const path of internalPaths) {
      const res = await request(app).get(path).set('X-Scope-OrgID', B.user.organizationId);
      expect(res.status, path).toBe(404);
    }
    // Container port exposure is checked against the compose files in infra/exposure.test.ts.
  });

  it('7. raw PromQL/LogQL and unsupported query fields are rejected', async () => {
    const cases = [
      { metricKey: 'request_rate', range: '1h', promql: 'up' },
      { metricKey: 'request_rate', range: '1h', expr: 'sum(rate(x[5m]))' },
      { metricKey: 'up', range: '1h' },
      { metricKey: 'request_rate', range: '1h', filters: { project_id: B.projectId } },
      { metricKey: 'request_rate', range: '1h', organizationId: B.user.organizationId },
    ];
    for (const body of cases) {
      const res = await post(A.user.agent, `/api/v1/projects/${A.projectId}/metrics/query`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    for (const query of [{ query: '{project=~".+"}' }, { logql: '{job="x"}' }, { tenant: 'b' }]) {
      const res = await A.user.agent.get(`/api/v1/projects/${A.projectId}/logs`).query(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
    // A backtick would break out of the generated LogQL raw string.
    const breakout = await A.user.agent
      .get(`/api/v1/projects/${A.projectId}/logs`)
      .query({ contains: '` or {project=~".+"} |= `' })
      .set('Origin', TEST_ORIGIN);
    expect(breakout.status).toBe(400);
  });
});
