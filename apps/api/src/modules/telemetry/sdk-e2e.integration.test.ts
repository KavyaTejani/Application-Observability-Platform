import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createClient } from '@aop/node-sdk';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInternalApp } from '../../internal-app.js';
import { createKey, createProject, signUp } from '../../test/fixtures.js';
import { buildTestApp, unlimited } from '../../test/test-app.js';
import { useTestDatabase } from '../../test/test-db.js';
import type { LogWriter, LokiLogEntry, LokiStreamLabels } from './loki-writer.js';

useTestDatabase();

class RecordingWriter implements LogWriter {
  writes: Array<{ tenantId: string; labels: LokiStreamLabels; entries: LokiLogEntry[] }> = [];
  async write(tenantId: string, labels: LokiStreamLabels, entries: LokiLogEntry[]) {
    this.writes.push({ tenantId, labels, entries });
  }
}

/**
 * Workflow B + C end to end: an Express service instrumented with the real SDK sends telemetry
 * over HTTP to the real ingestion API (listening on a port). The metrics registry and the log
 * writer then hold correctly scoped, correlated records.
 */
describe('SDK → ingestion API (end to end)', () => {
  const writer = new RecordingWriter();
  const platform = buildTestApp({ limiter: unlimited, logWriter: writer });
  const internal = createInternalApp(platform.metrics, platform.customerMetrics.registry);
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = platform.app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('delivers request metrics and correlated logs from an instrumented service', async () => {
    const owner = await signUp(platform.app, 'e2e');
    const projectId = await createProject(owner, 'Storefront', 'staging');
    const { secret } = await createKey(owner, projectId);

    const sdk = createClient({
      endpoint,
      apiKey: secret,
      serviceName: 'storefront-api',
      environment: 'staging',
      flushIntervalMs: 60_000,
    });
    expect(await sdk.testConnection()).toMatchObject({ ok: true, project: { id: projectId } });

    const service = express();
    service.use(sdk.middleware());
    service.get('/products/:id', (req, res) => {
      sdk.logger.info('product viewed', { productId: req.params.id });
      res.json({ id: req.params.id });
    });
    service.get('/checkout', (_req, res) => {
      sdk.logger.error('payment provider timeout');
      res.status(502).json({ error: 'upstream' });
    });

    const viewed = await request(service).get('/products/42');
    await request(service).get('/products/43');
    await request(service).get('/checkout');
    await sdk.shutdown();

    expect(sdk.stats()).toMatchObject({
      sent: { metrics: 3, logs: 6 }, // 2 handler logs + 3 access logs + 1 error log
      rejectedByServer: 0,
      dropped: { bufferFull: 0, nonRetryable: 0, retriesExhausted: 0 },
    });

    // Metrics: server-scoped series, route templates only.
    const scraped = (await request(internal).get('/telemetry-metrics')).text;
    const mine = scraped
      .split('\n')
      .filter((l) => l.startsWith('app_http_requests_total{') && l.includes(projectId));
    expect(
      mine.find((l) => l.includes('route="/products/:id"') && l.includes('status_class="2xx"')),
    ).toMatch(/ 2$/);
    expect(
      mine.find((l) => l.includes('route="/checkout"') && l.includes('status_class="5xx"')),
    ).toMatch(/ 1$/);
    expect(mine.every((l) => l.includes(`organization_id="${owner.organizationId}"`))).toBe(true);
    expect(scraped).not.toContain('/products/42');

    // Logs: tenant from the key, correlated to the request that produced them.
    const entries = writer.writes.flatMap((w) => w.entries);
    expect(writer.writes.every((w) => w.tenantId === owner.organizationId)).toBe(true);
    const requestId = viewed.headers['x-request-id'];
    const correlated = entries.filter((e) => e.requestId === requestId).map((e) => e.message);
    expect(correlated).toContain('product viewed');
    expect(correlated.some((m) => m.startsWith('GET /products/:id 200'))).toBe(true);
    expect(entries.find((e) => e.message === 'payment provider timeout')?.severity).toBe('ERROR');
  });
});
