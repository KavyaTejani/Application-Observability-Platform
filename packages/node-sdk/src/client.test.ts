import { inspect } from 'node:util';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityClient } from './client.js';
import type { BatchRequest, ClientOptions, SdkError } from './types.js';

const API_KEY = `aop_${'1a'.repeat(8)}.${'K'.repeat(43)}`;

type Call = { url: string; init: RequestInit; body?: BatchRequest };

/** A scripted fetch: each call takes the next response (or throws), repeating the last. */
function fakeFetch(...responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const accepted = (metrics = 0, logs = 0, rejected = { metrics: 0, logs: 0 }) =>
  new Response(
    JSON.stringify({ requestId: 'req_x', accepted: { metrics, logs }, rejected, errors: [] }),
    {
      status: 202,
    },
  );
const failure = (status: number, code: string, details?: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { code, message: code.toLowerCase(), details } }), {
    status,
  });

const clients: ObservabilityClient[] = [];
function makeClient(overrides: Partial<ClientOptions> & { fetch: typeof fetch }) {
  const client = new ObservabilityClient({
    endpoint: 'http://platform.test/',
    apiKey: API_KEY,
    serviceName: 'demo-api',
    environment: 'development',
    flushIntervalMs: 60_000,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    logRequests: false,
    ...overrides,
  });
  clients.push(client);
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.shutdown(100)));
});

const sampleRequest = {
  method: 'get',
  route: '/products/:id',
  statusCode: 200,
  durationMs: 12.3456,
};

describe('configuration', () => {
  it('rejects a malformed key without echoing it', () => {
    const secretLooking = 'sk_live_super_secret_value';
    let message = '';
    try {
      new ObservabilityClient({ endpoint: 'http://x', apiKey: secretLooking, serviceName: 'svc' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/apiKey/);
    expect(message).not.toContain(secretLooking);
  });

  it('rejects invalid endpoints and service names', () => {
    expect(
      () => new ObservabilityClient({ endpoint: 'nope', apiKey: API_KEY, serviceName: 'svc' }),
    ).toThrow(/endpoint/);
    expect(
      () =>
        new ObservabilityClient({ endpoint: 'http://x', apiKey: API_KEY, serviceName: 'bad name' }),
    ).toThrow(/serviceName/);
  });

  it('never exposes the key through inspection', () => {
    const { fetch } = fakeFetch(accepted());
    expect(inspect(makeClient({ fetch }), { depth: 5 })).not.toContain(API_KEY);
  });
});

describe('batching', () => {
  it('sends buffered metrics and logs in one protocol-v1 batch with the bearer key', async () => {
    const { fetch, calls } = fakeFetch(accepted(2, 1));
    const client = makeClient({ fetch });
    client.recordRequest(sampleRequest);
    client.recordRequest({ ...sampleRequest, statusCode: 500 });
    client.logger.warn('slow query', { table: 'orders', ms: 812 });
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://platform.test/v1/telemetry/batch');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    const body = calls[0]!.body!;
    expect(body).toMatchObject({
      schemaVersion: 1,
      service: { name: 'demo-api', environment: 'development' },
    });
    expect(body.metrics).toHaveLength(2);
    expect(body.metrics[0]).toMatchObject({
      kind: 'http_request',
      method: 'GET',
      route: '/products/:id',
      durationMs: 12.346,
    });
    expect(body.logs[0]).toMatchObject({
      severity: 'WARN',
      message: 'slow query',
      attributes: { table: 'orders', ms: 812 },
    });
    expect(client.stats()).toMatchObject({ buffered: 0, sent: { metrics: 2, logs: 1 } });
  });

  it('flushes automatically once a full batch is buffered', async () => {
    const { fetch, calls } = fakeFetch(accepted(3));
    const client = makeClient({ fetch, maxBatchSize: 3 });
    for (let i = 0; i < 3; i++) client.recordRequest(sampleRequest);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('splits large buffers into batches of at most maxBatchSize', async () => {
    const { fetch, calls } = fakeFetch(accepted(2));
    const client = makeClient({ fetch, maxBatchSize: 2, maxBufferSize: 100 });
    for (let i = 0; i < 5; i++) client.logger.info(`m${i}`);
    await client.flush();
    expect(calls.map((c) => c.body!.logs.length)).toEqual([2, 2, 1]);
  });

  it('does nothing when the buffer is empty', async () => {
    const { fetch, calls } = fakeFetch(accepted());
    await makeClient({ fetch }).flush();
    expect(calls).toHaveLength(0);
  });
});

describe('failure handling', () => {
  it('retries transient failures (503, network) and then succeeds', async () => {
    const { fetch, calls } = fakeFetch(
      failure(503, 'BACKEND_WRITE_FAILED', { retryable: true }),
      new TypeError('fetch failed'),
      accepted(1),
    );
    const client = makeClient({ fetch });
    client.recordRequest(sampleRequest);
    await client.flush();
    expect(calls).toHaveLength(3);
    expect(client.stats().sent.metrics).toBe(1);
    expect(client.stats().dropped.retriesExhausted).toBe(0);
  });

  it('drops a batch after maxRetries and reports it', async () => {
    const errors: SdkError[] = [];
    const { fetch, calls } = fakeFetch(failure(500, 'INTERNAL_ERROR'));
    const client = makeClient({ fetch, maxRetries: 2, onError: (e) => errors.push(e) });
    client.recordRequest(sampleRequest);
    await client.flush();
    expect(calls).toHaveLength(3); // 1 attempt + 2 retries
    expect(client.stats().dropped.retriesExhausted).toBe(1);
    expect(errors.at(-1)).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });

  it('does not retry permanent failures', async () => {
    for (const response of [
      failure(401, 'INVALID_API_KEY'),
      failure(400, 'INVALID_BATCH'),
      failure(413, 'BATCH_TOO_LARGE'),
      failure(503, 'BACKEND_NOT_CONFIGURED', { retryable: false }),
    ]) {
      const { fetch, calls } = fakeFetch(response);
      const client = makeClient({ fetch });
      client.logger.info('x');
      await client.flush();
      expect(calls).toHaveLength(1);
      expect(client.stats().dropped.nonRetryable).toBe(1);
    }
  });

  it('counts records the server rejected individually', async () => {
    const errors: SdkError[] = [];
    const { fetch } = fakeFetch(accepted(1, 0, { metrics: 1, logs: 0 }));
    const client = makeClient({ fetch, onError: (e) => errors.push(e) });
    client.recordRequest(sampleRequest);
    client.recordRequest(sampleRequest);
    await client.flush();
    expect(client.stats().rejectedByServer).toBe(1);
    expect(errors[0]?.code).toBe('RECORDS_REJECTED');
  });

  it('bounds memory: drops new records once the buffer is full and reports once', async () => {
    const errors: SdkError[] = [];
    const { fetch } = fakeFetch(accepted(2));
    const client = makeClient({
      fetch,
      maxBufferSize: 2,
      maxBatchSize: 500,
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 5; i++) client.logger.info(`m${i}`);
    expect(client.stats()).toMatchObject({ buffered: 2, dropped: { bufferFull: 3 } });
    expect(errors.filter((e) => e.code === 'BUFFER_FULL')).toHaveLength(1);
  });

  it('never leaks the API key into errors or debug output', async () => {
    const output: string[] = [];
    const { fetch } = fakeFetch(
      new TypeError(`connect ECONNREFUSED`),
      failure(401, 'INVALID_API_KEY'),
    );
    const client = makeClient({
      fetch,
      maxRetries: 1,
      debug: (m) => output.push(m),
      onError: (e) => output.push(`${e.code} ${e.message} ${JSON.stringify(e)}`),
    });
    client.logger.info('x');
    await client.flush();
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).not.toContain(API_KEY);
    expect(output.join('\n')).not.toContain(API_KEY.split('.')[1]);
  });
});

describe('shutdown', () => {
  it('flushes pending telemetry and drops (counts) anything recorded afterwards', async () => {
    const { fetch, calls } = fakeFetch(accepted(1));
    const client = makeClient({ fetch });
    client.recordRequest(sampleRequest);
    await client.shutdown();
    expect(calls).toHaveLength(1);
    client.recordRequest(sampleRequest);
    expect(client.stats().dropped.shutdown).toBe(1);
  });

  it('gives up at the deadline instead of hanging the process', async () => {
    const { fetch } = fakeFetch(() => new Promise<Response>(() => undefined));
    const client = makeClient({ fetch, maxBatchSize: 1, maxBufferSize: 10 });
    client.logger.info('a');
    client.logger.info('b');
    const started = Date.now();
    await client.shutdown(50);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('testConnection', () => {
  it('reports the project on success and the error code on failure', async () => {
    const ok = fakeFetch(
      new Response(
        JSON.stringify({
          ok: true,
          project: { id: 'p', name: 'Shop', environment: 'development' },
        }),
      ),
    );
    expect(await makeClient({ fetch: ok.fetch }).testConnection()).toMatchObject({
      ok: true,
      project: { name: 'Shop' },
    });
    expect(ok.calls[0]!.url).toBe('http://platform.test/v1/telemetry/test');

    const bad = fakeFetch(failure(401, 'INVALID_API_KEY'));
    expect(await makeClient({ fetch: bad.fetch }).testConnection()).toMatchObject({
      ok: false,
      status: 401,
      error: { code: 'INVALID_API_KEY' },
    });

    const down = fakeFetch(new TypeError('fetch failed'));
    expect((await makeClient({ fetch: down.fetch }).testConnection()).error?.code).toBe(
      'NETWORK_ERROR',
    );
  });
});

describe('Express middleware', () => {
  function appWith(client: ObservabilityClient) {
    const app = express();
    app.use(client.middleware());
    app.get('/products/:id', (_req, res) => {
      client.logger.info('loading product');
      res.json({ ok: true });
    });
    const router = express.Router();
    router.get('/:orderId', (_req, res) => {
      res.status(500).json({ ok: false });
    });
    app.use('/orders', router);
    return app;
  }

  it('records the route template, not the raw URL, and correlates logs by request ID', async () => {
    const { fetch, calls } = fakeFetch(accepted());
    const client = makeClient({ fetch, logRequests: true });
    const res = await request(appWith(client))
      .get('/products/8812')
      .set('X-Request-Id', 'req_client_supplied_1');
    expect(res.headers['x-request-id']).toBe('req_client_supplied_1');

    await client.flush();
    const body = calls[0]!.body!;
    expect(body.metrics[0]).toMatchObject({
      method: 'GET',
      route: '/products/:id',
      statusCode: 200,
    });
    expect(JSON.stringify(body)).not.toContain('8812');
    const handlerLog = body.logs.find((l) => l.message === 'loading product');
    expect(handlerLog?.requestId).toBe('req_client_supplied_1');
    const accessLog = body.logs.find((l) => l.message.startsWith('GET /products/:id 200'));
    expect(accessLog).toMatchObject({ severity: 'INFO', requestId: 'req_client_supplied_1' });
  });

  it('includes router base paths, logs 5xx at ERROR, and labels unmatched routes', async () => {
    const { fetch, calls } = fakeFetch(accepted());
    const client = makeClient({ fetch, logRequests: true });
    const app = appWith(client);
    await request(app).get('/orders/77');
    await request(app).get('/nope/123');
    await client.flush();
    const body = calls[0]!.body!;
    expect(body.metrics.map((m) => m.route)).toEqual(['/orders/:orderId', '/__unmatched__']);
    expect(body.logs.find((l) => l.message.startsWith('GET /orders/:orderId 500'))?.severity).toBe(
      'ERROR',
    );
  });

  it('generates a request ID when the inbound one is missing or unsafe', async () => {
    const { fetch } = fakeFetch(accepted());
    const client = makeClient({ fetch });
    const res = await request(appWith(client)).get('/products/1').set('X-Request-Id', '<bad>');
    expect(res.headers['x-request-id']).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
  });
});
