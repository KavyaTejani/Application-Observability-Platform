import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createProject, post, signUp, type TestUser } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { pino } from 'pino';
import { createPlatformMetrics } from '../../observability/platform-metrics.js';
import {
  PrometheusQueryClient,
  type PromInstantSample,
  type PromRangeSeries,
  type PrometheusQueryApi,
} from './backend-clients.js';

useTestDatabase();

/** Records every generated expression and answers with scripted data. */
class FakePrometheus implements PrometheusQueryApi {
  calls: Array<{ kind: string; expr: string; start?: number; end?: number; step?: number }> = [];
  rangeResult: (expr: string, start: number, step: number) => PromRangeSeries[] = () => [];
  instantResult: (expr: string) => PromInstantSample[] = () => [];

  async queryRange(expr: string, start: number, end: number, step: number) {
    this.calls.push({ kind: 'range', expr, start, end, step });
    return this.rangeResult(expr, start, step);
  }
  async query(expr: string) {
    this.calls.push({ kind: 'instant', expr });
    return this.instantResult(expr);
  }
  async labelValues(_label: string, match: string) {
    this.calls.push({ kind: 'labels', expr: match });
    return ['demo-store'];
  }
}

describe('metrics exploration API', () => {
  const prometheus = new FakePrometheus();
  const { app } = buildTestApp({ limiter: unlimited, prometheusQuery: prometheus });
  let a: TestUser;
  let b: TestUser;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    a = await signUp(app, 'alice');
    b = await signUp(app, 'bob');
    projectA = await createProject(a, 'Alpha');
    projectB = await createProject(b, 'Bravo');
  });

  const query = (user: TestUser, projectId: string, body: unknown) =>
    post(user.agent, `/api/v1/projects/${projectId}/metrics/query`, body);

  it('generates PromQL scoped to the caller’s own organization and project', async () => {
    prometheus.calls = [];
    const res = await query(a, projectA, {
      metricKey: 'request_rate',
      range: '1h',
      groupBy: ['route'],
    });
    expect(res.status).toBe(200);
    expect(prometheus.calls).toHaveLength(1);
    const { expr } = prometheus.calls[0]!;
    expect(expr).toContain(`organization_id="${a.organizationId}"`);
    expect(expr).toContain(`project_id="${projectA}"`);
    expect(expr).not.toContain(b.organizationId);
  });

  it('returns 404 for another tenant’s project without ever querying Prometheus (§14.2 item 2)', async () => {
    prometheus.calls = [];
    const res = await query(a, projectB, { metricKey: 'request_rate', range: '1h' });
    expect(res.status).toBe(404);
    expect((await a.agent.get(`/api/v1/projects/${projectB}/metrics/summary`)).status).toBe(404);
    expect(prometheus.calls).toHaveLength(0);
  });

  it('rejects raw PromQL and unsupported fields with 400 (§14.2 item 7)', async () => {
    prometheus.calls = [];
    for (const body of [
      { metricKey: 'request_rate', range: '1h', promql: 'up' },
      { metricKey: 'request_rate', range: '1h', filters: { organization_id: b.organizationId } },
      { metricKey: 'up', range: '1h' },
      { metricKey: 'request_rate', range: '7d' },
      { metricKey: 'request_rate', range: '24h', interval: '15s' },
    ]) {
      const res = await query(a, projectA, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(prometheus.calls).toHaveLength(0);
  });

  it('maps results to a full timeline with null gaps, latency in ms, and only group-by labels', async () => {
    prometheus.rangeResult = (_expr, start, step) => [
      {
        metric: { route: '/products/:id', organization_id: 'leak?', project_id: 'leak?' },
        values: [
          [start, '0.042'],
          [start + step * 2, 'NaN'], // no data
          [start + step * 3, '0.120'],
        ],
      },
    ];
    const res = await query(a, projectA, {
      metricKey: 'p95_latency',
      range: '15m',
      groupBy: ['route'],
    });
    prometheus.rangeResult = () => [];

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      metricKey: 'p95_latency',
      unit: 'milliseconds',
      stepSeconds: 15,
      noData: false,
    });
    const [series] = res.body.series;
    expect(series.labels).toEqual({ route: '/products/:id' }); // tenant labels stripped
    expect(series.points).toHaveLength(61); // 15 min / 15 s, inclusive
    expect(series.points[0][1]).toBeCloseTo(42);
    expect(series.points[1][1]).toBeNull(); // missing sample
    expect(series.points[2][1]).toBeNull(); // NaN
    expect(series.points[3][1]).toBeCloseTo(120);
  });

  it('reports noData for an empty project instead of zeros (AC-04, MET-006)', async () => {
    const res = await query(a, projectA, { metricKey: 'error_rate', range: '1h' });
    expect(res.body).toMatchObject({ noData: true, series: [] });
  });

  it('summarizes a window, treating zero traffic as no data rather than 0% errors', async () => {
    prometheus.instantResult = () => [];
    const empty = await a.agent.get(`/api/v1/projects/${projectA}/metrics/summary?range=1h`);
    expect(empty.status).toBe(200);
    expect(empty.body.summary).toMatchObject({
      requests: null,
      serverErrorRate: null,
      latencyMs: { p95: null },
    });

    const values: Record<string, string> = { '5xx': '6', '4xx': '30', p95: '0.25' };
    prometheus.instantResult = (expr) => {
      const v = expr.includes('status_class="5xx"')
        ? values['5xx']
        : expr.includes('status_class="4xx"')
          ? values['4xx']
          : expr.includes('histogram_quantile(0.95')
            ? values.p95
            : expr.includes('histogram_quantile')
              ? 'NaN'
              : '600';
      return [{ metric: {}, value: [0, v!] }];
    };
    const busy = await a.agent.get(`/api/v1/projects/${projectA}/metrics/summary?range=1h`);
    prometheus.instantResult = () => [];
    expect(busy.body.summary).toMatchObject({
      requests: 600,
      serverErrorRate: 0.01,
      clientErrorRate: 0.05,
      latencyMs: { p95: 250, p50: null },
    });
    expect(busy.body.summary.requestRate).toBeCloseTo(600 / 3600);
  });

  it('lets members read telemetry', async () => {
    const member = await addMember(app, a.organizationId, 'member');
    const res = await post(member.agent, `/api/v1/projects/${projectA}/metrics/query`, {
      metricKey: 'request_rate',
      range: '15m',
    });
    expect(res.status).toBe(200);
  });

  it('returns 503 when Prometheus is unreachable, without leaking backend details', async () => {
    // The real client pointed at a closed port, which exercises its error mapping.
    const unreachable = new PrometheusQueryClient(
      'http://127.0.0.1:9',
      1000,
      createPlatformMetrics(),
      pino({ level: 'silent' }),
    );
    const down = buildTestApp({ limiter: unlimited, prometheusQuery: unreachable });
    const owner = await signUp(down.app, 'down');
    const pid = await createProject(owner);
    const res = await post(owner.agent, `/api/v1/projects/${pid}/metrics/query`, {
      metricKey: 'request_rate',
      range: '1h',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUERY_BACKEND_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });

  it('returns 503 BACKEND_NOT_CONFIGURED in a deployment without Prometheus', async () => {
    const bare = buildTestApp({ limiter: unlimited });
    const owner = await signUp(bare.app, 'bare');
    const pid = await createProject(owner);
    const res = await post(owner.agent, `/api/v1/projects/${pid}/metrics/query`, {
      metricKey: 'request_rate',
      range: '1h',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BACKEND_NOT_CONFIGURED');
  });
});
