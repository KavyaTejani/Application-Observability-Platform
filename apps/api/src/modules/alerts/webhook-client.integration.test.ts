import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload } from './secret-box.js';
import { WebhookClient } from './webhook-client.js';

/** Local receiver with a few behaviours, selected by path. */
function startReceiver() {
  const hits: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/ok') res.writeHead(204).end();
      else if (req.url === '/redirect') res.writeHead(302, { Location: '/internal-target' }).end();
      else if (req.url === '/error') res.writeHead(503).end('down');
      else if (req.url === '/huge') res.writeHead(200).end('x'.repeat(100_000));
      else if (req.url === '/slow') setTimeout(() => res.writeHead(200).end(), 2000);
      else res.writeHead(404).end();
    });
  });
  return { server, hits };
}

describe('WebhookClient (real HTTP)', () => {
  const { server, hits } = startReceiver();
  let base: string;

  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  // A local receiver is a private address, so private networks are explicitly allowed here, as in
  // development.
  const devClient = new WebhookClient({ allowPrivateNetworks: true, timeoutMs: 500 });

  it('delivers a signed JSON payload that the receiver can verify', async () => {
    const body = JSON.stringify({ event: 'incident_firing', incident: { id: 'i1' } });
    const secret = 'whsec_test';
    const t = Math.floor(Date.now() / 1000);
    const result = await devClient.send(`${base}/ok`, body, {
      'X-AOP-Event': 'incident_firing',
      'X-AOP-Signature': signPayload(secret, body, t),
    });
    expect(result).toEqual({ status: 'success', responseStatus: 204 });

    const hit = hits.at(-1)!;
    expect(hit.body).toBe(body);
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['user-agent']).toBe('AOP-Webhooks/1.0');
    // Receiver-side verification: recompute the HMAC over "t.body".
    const [, ts, mac] = /^t=(\d+),v1=([a-f0-9]+)$/.exec(String(hit.headers['x-aop-signature']))!;
    expect(createHmac('sha256', secret).update(`${ts}.${hit.body}`).digest('hex')).toBe(mac);
  });

  it('never follows redirects (a redirect could point at an internal service)', async () => {
    const before = hits.length;
    const result = await devClient.send(`${base}/redirect`, '{}', {});
    expect(result).toMatchObject({ status: 'failed', responseStatus: 302, retryable: false });
    expect(hits.slice(before).map((h) => h.path)).toEqual(['/redirect']);
  });

  it('classifies 5xx as retryable and 4xx as permanent', async () => {
    expect(await devClient.send(`${base}/error`, '{}', {})).toMatchObject({
      status: 'failed',
      responseStatus: 503,
      retryable: true,
    });
    expect(await devClient.send(`${base}/missing`, '{}', {})).toMatchObject({
      status: 'failed',
      responseStatus: 404,
      retryable: false,
    });
  });

  it('bounds the exchange with a timeout and caps the response size', async () => {
    const started = Date.now();
    expect(await devClient.send(`${base}/slow`, '{}', {})).toMatchObject({
      status: 'failed',
      errorSummary: 'Timed out',
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await devClient.send(`${base}/huge`, '{}', {})).status).toBe('success');
  });

  it('refuses oversized payloads before connecting', async () => {
    expect(await devClient.send(`${base}/ok`, 'x'.repeat(20_000), {})).toMatchObject({
      status: 'failed',
      retryable: false,
    });
  });

  it('with production policy, blocks loopback targets without sending anything', async () => {
    const prod = new WebhookClient({ allowPrivateNetworks: false, timeoutMs: 500 });
    const before = hits.length;
    expect(await prod.send(`${base}/ok`, '{}', {})).toMatchObject({ status: 'blocked' });
    expect(hits.length).toBe(before);
  });

  it('blocks DNS rebinding: a host that resolved publicly at save time but now resolves to loopback', async () => {
    let calls = 0;
    const rebinding = new WebhookClient({
      allowPrivateNetworks: false,
      timeoutMs: 500,
      // The first lookup (at save time) is public; every later one points at 127.0.0.1.
      resolve: async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    });
    await rebinding.send('http://hooks.example.test/x', '{}', {}).catch(() => undefined); // "save time"
    const before = hits.length;
    expect(
      await rebinding.send(`http://hooks.example.test:${new URL(base).port}/ok`, '{}', {}),
    ).toMatchObject({
      status: 'blocked',
    });
    expect(hits.length).toBe(before);
  });

  it('connects to the validated (pinned) address, not whatever DNS says later', async () => {
    // The resolver maps an arbitrary hostname to our receiver; the request must land there,
    // carrying the original Host header.
    const pinned = new WebhookClient({
      allowPrivateNetworks: true,
      timeoutMs: 500,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const port = new URL(base).port;
    expect(await pinned.send(`http://receiver.example.test:${port}/ok`, '{}', {})).toMatchObject({
      status: 'success',
    });
    expect(hits.at(-1)!.headers.host).toBe(`receiver.example.test:${port}`);
  });
});
