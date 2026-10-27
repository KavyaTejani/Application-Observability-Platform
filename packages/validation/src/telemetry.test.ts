import { describe, expect, it } from 'vitest';
import { batchEnvelopeSchema, httpRequestMetricSchema, logRecordSchema } from './telemetry.js';

const ts = '2026-10-27T10:00:00.000Z';

describe('batchEnvelopeSchema', () => {
  it('accepts a minimal envelope and defaults the arrays', () => {
    const parsed = batchEnvelopeSchema.parse({ schemaVersion: 1, service: { name: 'demo-api' } });
    expect(parsed.metrics).toEqual([]);
    expect(parsed.logs).toEqual([]);
  });

  it('rejects other schema versions and unsafe service names', () => {
    expect(
      batchEnvelopeSchema.safeParse({ schemaVersion: 2, service: { name: 'a' } }).success,
    ).toBe(false);
    expect(
      batchEnvelopeSchema.safeParse({ schemaVersion: 1, service: { name: 'a b"}' } }).success,
    ).toBe(false);
  });

  it('strips client-supplied tenant fields', () => {
    const parsed = batchEnvelopeSchema.parse({
      schemaVersion: 1,
      service: { name: 'x' },
      organizationId: 'evil',
      tenantId: 'evil',
    });
    expect(parsed).not.toHaveProperty('organizationId');
    expect(parsed).not.toHaveProperty('tenantId');
  });
});

describe('httpRequestMetricSchema', () => {
  const valid = {
    kind: 'http_request',
    timestamp: ts,
    method: 'get',
    route: '/p/:id',
    statusCode: 200,
    durationMs: 4,
  };

  it('accepts a valid metric and upper-cases the method', () => {
    expect(httpRequestMetricSchema.parse(valid).method).toBe('GET');
  });

  it('rejects query strings, bad status codes, and negative durations', () => {
    expect(httpRequestMetricSchema.safeParse({ ...valid, route: '/p?id=1' }).success).toBe(false);
    expect(httpRequestMetricSchema.safeParse({ ...valid, statusCode: 99 }).success).toBe(false);
    expect(httpRequestMetricSchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
  });
});

describe('logRecordSchema', () => {
  const valid = { timestamp: ts, severity: 'INFO', message: 'hi' };

  it('accepts flat primitive attributes', () => {
    expect(
      logRecordSchema.safeParse({ ...valid, attributes: { route: '/x', ok: true, n: 1, z: null } })
        .success,
    ).toBe(true);
  });

  it('rejects nested attributes, too many attributes, and unknown severities', () => {
    expect(logRecordSchema.safeParse({ ...valid, attributes: { a: { b: 1 } } }).success).toBe(
      false,
    );
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect(logRecordSchema.safeParse({ ...valid, attributes: many }).success).toBe(false);
    expect(logRecordSchema.safeParse({ ...valid, severity: 'NOTICE' }).success).toBe(false);
  });
});
