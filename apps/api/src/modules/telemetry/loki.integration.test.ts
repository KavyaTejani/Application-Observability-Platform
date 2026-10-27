import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LokiWriter } from './loki-writer.js';

const LOKI_URL = process.env.TEST_LOKI_URL ?? 'http://localhost:3100';

async function queryLines(tenantId: string, projectId: string): Promise<string[]> {
  const params = new URLSearchParams({
    query: `{project="${projectId}"}`,
    start: String((Date.now() - 60_000) * 1_000_000),
    end: String((Date.now() + 60_000) * 1_000_000),
    limit: '100',
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`, {
    headers: { 'X-Scope-OrgID': tenantId },
  });
  if (!res.ok) throw new Error(`Loki query failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data: { result: Array<{ values: Array<[string, string]> }> };
  };
  return body.data.result.flatMap((stream) => stream.values.map(([, line]) => line));
}

/** Polls until `predicate` holds; Loki makes pushed data queryable within a moment. */
async function eventually<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let last: T = await fn();
  for (let i = 0; i < 20 && !predicate(last); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await fn();
  }
  return last;
}

/**
 * Backend-level tenant isolation against the real Loki in Docker (PRD §14.2 item 3, storage side).
 * The query API in M5 builds on this guarantee.
 */
describe('Loki multi-tenancy (integration)', () => {
  const writer = new LokiWriter(LOKI_URL, 5000);

  it('stores logs under the writer-chosen tenant and hides them from every other tenant', async () => {
    const tenantA = `test-org-a-${randomBytes(4).toString('hex')}`;
    const tenantB = `test-org-b-${randomBytes(4).toString('hex')}`;
    const projectId = `p-${randomBytes(4).toString('hex')}`;
    const marker = `marker-${randomBytes(6).toString('hex')}`;

    try {
      await writer.write(tenantA, { projectId, service: 'svc', environment: 'development' }, [
        { timestampMs: Date.now(), severity: 'ERROR', message: marker, requestId: 'req_x' },
      ]);
    } catch (error) {
      throw new Error(`Integration tests need Loki at ${LOKI_URL}. Run "npm run infra:up".`, {
        cause: error,
      });
    }

    const own = await eventually(
      () => queryLines(tenantA, projectId),
      (lines) => lines.length > 0,
    );
    expect(own.some((line) => line.includes(marker))).toBe(true);
    expect(JSON.parse(own[0]!)).toMatchObject({ message: marker, requestId: 'req_x' });

    // Same project label, different tenant: nothing.
    expect(await queryLines(tenantB, projectId)).toEqual([]);
  });

  it('rejects requests without a tenant header (multi-tenant mode is on)', async () => {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/labels`);
    expect(res.status).toBe(401);
  });
});
