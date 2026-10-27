import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPlatformMetrics } from '../../observability/platform-metrics.js';
import { createProject, signUp, type TestUser } from '../../test/fixtures.js';
import { buildTestApp, TEST_ORIGIN, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import { LokiWriter, type LokiLogEntry } from '../telemetry/loki-writer.js';
import { LokiQueryClient } from './backend-clients.js';

useTestDatabase();

const LOKI_URL = process.env.TEST_LOKI_URL ?? 'http://localhost:3100';

/**
 * Log exploration against the REAL Loki (multi-tenant). Two organizations each get distinct logs.
 * This proves the query API returns only the caller's logs (PRD §14.2 item 3, AC-05) and that
 * filters and pagination behave correctly on real data.
 */
describe('log exploration API (real Loki)', () => {
  const lokiQuery = new LokiQueryClient(
    LOKI_URL,
    5000,
    createPlatformMetrics(),
    pino({ level: 'silent' }),
  );
  const { app } = buildTestApp({ limiter: unlimited, lokiQuery });
  const writer = new LokiWriter(LOKI_URL, 5000);
  const marker = randomBytes(4).toString('hex');
  const base = Date.now() - 60_000;

  let a: TestUser;
  let b: TestUser;
  let projectA: string;
  let projectB: string;

  const search = (user: TestUser, projectId: string, params: Record<string, string> = {}) =>
    user.agent.get(`/api/v1/projects/${projectId}/logs`).query({ limit: '50', ...params });

  beforeAll(async () => {
    a = await signUp(app, 'alice');
    b = await signUp(app, 'bob');
    projectA = await createProject(a, 'Alpha');
    projectB = await createProject(b, 'Bravo');

    const entriesA: LokiLogEntry[] = [
      {
        timestampMs: base + 1000,
        severity: 'INFO',
        message: `A started ${marker}`,
        requestId: 'req_a_1',
      },
      {
        timestampMs: base + 2000,
        severity: 'WARN',
        message: `A slow query ${marker}`,
        requestId: 'req_a_1',
      },
      {
        timestampMs: base + 3000,
        severity: 'ERROR',
        message: `A Payment TIMEOUT ${marker}`,
        requestId: 'req_a_2',
        attributes: { code: 504 },
      },
      // Two entries with the very same timestamp, to test the page boundary.
      { timestampMs: base + 4000, severity: 'INFO', message: `A twin one ${marker}` },
      { timestampMs: base + 4000, severity: 'INFO', message: `A twin two ${marker}` },
      { timestampMs: base + 5000, severity: 'INFO', message: `A done ${marker}` },
    ];
    try {
      await writer.write(
        a.organizationId,
        { projectId: projectA, service: 'shop', environment: 'development' },
        entriesA,
      );
      await writer.write(
        a.organizationId,
        { projectId: projectA, service: 'worker', environment: 'development' },
        [{ timestampMs: base + 2500, severity: 'DEBUG', message: `A worker tick ${marker}` }],
      );
      await writer.write(
        b.organizationId,
        { projectId: projectB, service: 'shop', environment: 'development' },
        [{ timestampMs: base + 1500, severity: 'ERROR', message: `B secret business ${marker}` }],
      );
    } catch (error) {
      throw new Error(`Integration tests need Loki at ${LOKI_URL}. Run "npm run infra:up".`, {
        cause: error,
      });
    }

    // Wait until Loki serves A's 7 entries.
    for (let i = 0; i < 20; i++) {
      const res = await search(a, projectA);
      if (res.body.entries?.length === 7) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });

  it('returns the caller’s project logs, newest first, parsed into fields', async () => {
    const res = await search(a, projectA);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(7);
    const messages = res.body.entries.map((e: { message: string }) => e.message);
    expect(messages[0]).toBe(`A done ${marker}`);
    expect(messages.at(-1)).toBe(`A started ${marker}`);
    const error = res.body.entries.find((e: { severity: string }) => e.severity === 'ERROR');
    expect(error).toMatchObject({
      service: 'shop',
      environment: 'development',
      requestId: 'req_a_2',
      attributes: { code: 504 },
    });
    expect(JSON.stringify(res.body)).not.toContain('B secret');
  });

  it('never returns another tenant’s logs, even with a forged tenant header (§14.2 item 3)', async () => {
    const forged = await a.agent
      .get(`/api/v1/projects/${projectA}/logs`)
      .set('X-Scope-OrgID', b.organizationId)
      .query({ limit: '50' });
    expect(forged.status).toBe(200);
    expect(JSON.stringify(forged.body)).not.toContain('B secret');

    const foreignProject = await search(a, projectB);
    expect(foreignProject.status).toBe(404);

    // B sees only its own entry.
    const own = await search(b, projectB);
    expect(own.body.entries.map((e: { message: string }) => e.message)).toEqual([
      `B secret business ${marker}`,
    ]);
  });

  it('filters by severity, service, request ID, and case-insensitive text', async () => {
    const bySeverity = await search(a, projectA, { severity: 'ERROR,WARN' });
    expect(bySeverity.body.entries.map((e: { severity: string }) => e.severity).sort()).toEqual([
      'ERROR',
      'WARN',
    ]);

    const byService = await search(a, projectA, { service: 'worker' });
    expect(byService.body.entries).toHaveLength(1);

    const byRequest = await search(a, projectA, { requestId: 'req_a_1' });
    expect(byRequest.body.entries).toHaveLength(2);

    const byText = await search(a, projectA, { contains: 'payment timeout' });
    expect(byText.body.entries.map((e: { message: string }) => e.message)).toEqual([
      `A Payment TIMEOUT ${marker}`,
    ]);

    // Regex metacharacters are matched literally.
    expect((await search(a, projectA, { contains: '.*' })).body.entries).toHaveLength(0);
  });

  it('paginates without losing or duplicating entries that share a timestamp', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await search(a, projectA, { limit: '2', ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.entries.map((e: { message: string }) => e.message));
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(expect.arrayContaining([`A twin one ${marker}`, `A twin two ${marker}`]));
  });

  it('bounds queries: span, lookback, limit, bad cursors, and raw LogQL', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const tooLong = await search(a, projectA, { from: iso(now - 25 * 3_600_000), to: iso(now) });
    expect(tooLong.body.error.code).toBe('INVALID_TIME_RANGE');
    const tooOld = await search(a, projectA, {
      from: iso(now - 8 * 86_400_000),
      to: iso(now - 8 * 86_400_000 + 1000),
    });
    expect(tooOld.body.error.code).toBe('INVALID_TIME_RANGE');
    expect((await search(a, projectA, { limit: '1000' })).status).toBe(400);
    expect((await search(a, projectA, { cursor: 'not-a-cursor' })).body.error.code).toBe(
      'INVALID_CURSOR',
    );
    expect((await search(a, projectA, { query: '{project=~".+"}' })).status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${projectA}/logs`)
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('lists services from logs for filter options', async () => {
    const res = await a.agent.get(`/api/v1/projects/${projectA}/services`);
    expect(res.status).toBe(200);
    expect(res.body.services).toEqual(['shop', 'worker']);
  });
});
