import { metricQuerySchema, logQuerySchema } from '@aop/validation';
import { describe, expect, it } from 'vitest';
import { buildLogQuery, escapeRegex } from './logql.js';
import {
  buildRangeExpression,
  buildSummaryExpressions,
  escapeLabelValue,
  labelMatchers,
  rateWindow,
  stepSeconds,
} from './promql.js';

const scope = { organizationId: 'org_A', projectId: 'proj_A' };
const TENANT = 'organization_id="org_A",project_id="proj_A"';

describe('PromQL generation', () => {
  it('puts the tenant matchers first in every expression for every metric key', () => {
    for (const key of [
      'request_rate',
      'error_rate',
      'client_error_rate',
      'p50_latency',
      'p95_latency',
      'p99_latency',
    ] as const) {
      const expr = buildRangeExpression(key, scope, { serviceName: 'svc' }, [], 30);
      const selectors = expr.match(/\{[^}]*\}/g) ?? [];
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) expect(selector.startsWith(`{${TENANT}`)).toBe(true);
    }
  });

  it('builds the documented templates', () => {
    expect(buildRangeExpression('request_rate', scope, {}, ['route'], 30)).toBe(
      `sum by (route) (rate(app_http_requests_total{${TENANT}}[60s]))`,
    );
    expect(buildRangeExpression('p95_latency', scope, {}, ['service'], 300)).toBe(
      `histogram_quantile(0.95, sum by (le, service) (rate(app_http_request_duration_seconds_bucket{${TENANT}}[300s])))`,
    );
  });

  it('expresses error rate so that zero errors is 0 and zero traffic is no data', () => {
    const expr = buildRangeExpression('error_rate', scope, {}, [], 15);
    expect(expr).toBe(
      `(sum (rate(app_http_requests_total{${TENANT},status_class="5xx"}[60s])) or ` +
        `(sum (rate(app_http_requests_total{${TENANT}}[60s])) * 0)) / ` +
        `sum (rate(app_http_requests_total{${TENANT}}[60s]))`,
    );
  });

  it('escapes label values defensively', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    // Even a hostile value cannot close the matcher and add its own tenant.
    const hostile = labelMatchers(scope, { serviceName: 'x",organization_id="org_B' });
    expect(hostile).toBe(`{${TENANT},service="x\\",organization_id=\\"org_B"}`);
  });

  it('uses a rate window of at least four scrapes and at least one step', () => {
    expect(rateWindow(15)).toBe('60s');
    expect(rateWindow(720)).toBe('720s');
    expect(stepSeconds({ range: '24h' })).toBe(720);
    expect(stepSeconds({ range: '1h', interval: '1m' })).toBe(60);
  });

  it('scopes every summary expression', () => {
    for (const expr of Object.values(buildSummaryExpressions(scope, '6h', 'svc'))) {
      expect(expr).toContain(`{${TENANT},service="svc"`);
      expect(expr).toContain('[21600s]');
    }
  });
});

describe('metric query descriptor validation (no raw PromQL)', () => {
  const base = { metricKey: 'p95_latency', range: '1h' };

  it('rejects raw query fields and tenant overrides', () => {
    for (const extra of [
      { promql: 'up' },
      { expr: 'sum(up)' },
      { query: '{__name__=~".+"}' },
      { organizationId: 'org_B' },
    ]) {
      expect(metricQuerySchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(
      metricQuerySchema.safeParse({ ...base, filters: { project_id: 'proj_B' } }).success,
    ).toBe(false);
  });

  it('rejects unknown metrics, ranges, dimensions, and too many points', () => {
    expect(metricQuerySchema.safeParse({ ...base, metricKey: 'up' }).success).toBe(false);
    expect(metricQuerySchema.safeParse({ ...base, range: '30d' }).success).toBe(false);
    expect(metricQuerySchema.safeParse({ ...base, groupBy: ['organization_id'] }).success).toBe(
      false,
    );
    expect(metricQuerySchema.safeParse({ ...base, range: '24h', interval: '15s' }).success).toBe(
      false,
    );
    expect(metricQuerySchema.safeParse({ ...base, range: '24h', interval: '5m' }).success).toBe(
      true,
    );
  });

  it('rejects meaningless error-rate combinations', () => {
    expect(
      metricQuerySchema.safeParse({
        metricKey: 'error_rate',
        range: '1h',
        groupBy: ['status_class'],
      }).success,
    ).toBe(false);
    expect(
      metricQuerySchema.safeParse({
        metricKey: 'error_rate',
        range: '1h',
        filters: { statusClass: '5xx' },
      }).success,
    ).toBe(false);
  });
});

describe('LogQL generation', () => {
  it('always selects the project and adds only validated filters', () => {
    expect(buildLogQuery({ projectId: 'p1' })).toBe('{project="p1"}');
    expect(
      buildLogQuery({
        projectId: 'p1',
        service: 'svc',
        severities: ['ERROR', 'WARN', 'ERROR'],
        requestId: 'req_123',
        contains: 'timeout (db)',
      }),
    ).toBe(
      '{project="p1", service="svc", severity=~"error|warn"} | request_id="req_123" |~ `(?i)timeout \\(db\\)`',
    );
  });

  it('treats search text as a literal, not a regex', () => {
    expect(escapeRegex('a.b*c|d')).toBe('a\\.b\\*c\\|d');
  });

  it('validates log query parameters strictly', () => {
    expect(logQuerySchema.safeParse({ contains: 'x`y' }).success).toBe(false);
    expect(logQuerySchema.safeParse({ query: '{project=~".+"}' }).success).toBe(false);
    expect(logQuerySchema.safeParse({ severity: 'ERROR,WARN' }).data?.severity).toEqual([
      'ERROR',
      'WARN',
    ]);
    expect(logQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});
