import { describe, expect, it, vi } from 'vitest';
import { CustomerMetrics, OVERFLOW_LABEL } from './customer-metrics.js';
import { LokiWriteError, LokiWriter } from './loki-writer.js';
import { methodLabel, normalizeRoute, statusClassLabel } from './normalize.js';
import { REDACTED, redactAttributes, redactText } from './redact.js';

describe('normalizeRoute', () => {
  it.each([
    ['/products/:id', '/products/:id'],
    ['/users/8812/orders', '/users/:id/orders'],
    ['/o/507f1f77bcf86cd799439011', '/o/:id'],
    ['/s/123e4567-e89b-12d3-a456-426614174000', '/s/:uuid'],
    ['/files/d41d8cd98f00b204e9800998ecf8427e', '/files/:hash'],
    ['/', '/'],
    ['/v2/health', '/v2/health'],
  ])('%s → %s', (input, expected) => expect(normalizeRoute(input)).toBe(expected));
});

describe('label helpers', () => {
  it('folds unknown methods and computes status classes', () => {
    expect(methodLabel('GET')).toBe('GET');
    expect(methodLabel('PROPFIND')).toBe('OTHER');
    expect(statusClassLabel(503)).toBe('5xx');
    expect(statusClassLabel(204)).toBe('2xx');
  });
});

describe('redaction', () => {
  it('removes API keys, bearer tokens, and key=value secrets from text', () => {
    const key = `aop_${'a'.repeat(16)}.${'B'.repeat(43)}`;
    const out = redactText(
      `using ${key} with Authorization: Bearer abc.def.ghi123 password=hunter22`,
    );
    expect(out).not.toContain(key);
    expect(out).not.toContain('abc.def.ghi123');
    expect(out).not.toContain('hunter22');
    expect(out).toContain('[REDACTED_API_KEY]');
  });

  it('redacts secret-named attributes regardless of value', () => {
    expect(
      redactAttributes({
        password: 'x',
        'user.api_key': 'y',
        authorization: 'z',
        route: '/a',
        n: 1,
      }),
    ).toEqual({
      password: REDACTED,
      'user.api_key': REDACTED,
      authorization: REDACTED,
      route: '/a',
      n: 1,
    });
  });

  it('leaves ordinary text untouched', () => {
    expect(redactText('GET /products took 42ms')).toBe('GET /products took 42ms');
  });
});

describe('CustomerMetrics cardinality caps', () => {
  const base = {
    organizationId: 'o1',
    projectId: 'p1',
    environment: 'development',
    service: 'svc',
    method: 'GET',
    statusClass: '2xx',
    durationSeconds: 0.01,
  };

  it('folds routes beyond the per-project cap into __other__ and reports overflow', async () => {
    const onOverflow = vi.fn();
    const metrics = new CustomerMetrics(
      { maxRoutesPerProject: 2, maxServicesPerProject: 5 },
      onOverflow,
    );
    for (const route of ['/a', '/b', '/c', '/d', '/a']) metrics.observe({ ...base, route });
    const text = await metrics.registry.metrics();
    expect(text).toContain('route="/a"');
    expect(text).toContain('route="/b"');
    expect(text).not.toContain('route="/c"');
    expect(text).toContain(`route="${OVERFLOW_LABEL}"`);
    expect(onOverflow).toHaveBeenCalledTimes(2);
    expect(onOverflow).toHaveBeenCalledWith('route');
  });

  it('applies caps per project, not globally', async () => {
    const metrics = new CustomerMetrics({ maxRoutesPerProject: 1, maxServicesPerProject: 5 });
    metrics.observe({ ...base, projectId: 'p1', route: '/x' });
    metrics.observe({ ...base, projectId: 'p2', route: '/y' });
    const text = await metrics.registry.metrics();
    expect(text).toContain('route="/x"');
    expect(text).toContain('route="/y"');
    expect(text).not.toContain(OVERFLOW_LABEL);
  });
});

describe('LokiWriter', () => {
  const entries = [
    {
      timestampMs: 1_761_559_200_123,
      severity: 'INFO' as const,
      message: 'ok',
      requestId: 'req_1',
    },
    {
      timestampMs: 1_761_559_200_456,
      severity: 'ERROR' as const,
      message: 'boom',
      attributes: { code: 500 },
    },
  ];
  const labels = { projectId: 'p1', service: 'svc', environment: 'production' };

  it('sets the tenant header itself and uses low-cardinality labels', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await new LokiWriter('http://loki:3100', 1000, fetchImpl as unknown as typeof fetch).write(
      'org-123',
      labels,
      entries,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://loki:3100/loki/api/v1/push');
    expect((init.headers as Record<string, string>)['X-Scope-OrgID']).toBe('org-123');

    const body = JSON.parse(String(init.body));
    expect(body.streams).toHaveLength(2);
    for (const stream of body.streams) {
      expect(Object.keys(stream.stream).sort()).toEqual([
        'environment',
        'project',
        'service',
        'severity',
      ]);
    }
    const info = body.streams.find(
      (s: { stream: { severity: string } }) => s.stream.severity === 'info',
    );
    // Nanosecond timestamp string, the JSON line, and the request ID as structured metadata.
    expect(info.values[0][0]).toBe('1761559200123000000');
    expect(JSON.parse(info.values[0][1])).toEqual({ message: 'ok', requestId: 'req_1' });
    expect(info.values[0][2]).toEqual({ request_id: 'req_1' });
  });

  it('classifies failures as retryable or not', async () => {
    const fail = (status: number) =>
      new LokiWriter(
        'http://l',
        1000,
        (async () => new Response('x', { status })) as unknown as typeof fetch,
      );
    await expect(fail(503).write('t', labels, entries)).rejects.toMatchObject({ retryable: true });
    await expect(fail(400).write('t', labels, entries)).rejects.toMatchObject({ retryable: false });

    const network = new LokiWriter('http://l', 1000, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(network.write('t', labels, entries)).rejects.toBeInstanceOf(LokiWriteError);
  });
});
