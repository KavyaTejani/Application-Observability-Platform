/**
 * Minimal webhook receiver for demos: prints incident notifications and verifies their signature
 * exactly as the Notifications page documents.
 *
 *   WEBHOOK_SIGNING_SECRET=whsec_… npm run webhook-receiver -w @aop/demo-node-service
 *
 * Locally the API must run with WEBHOOK_ALLOW_PRIVATE_NETWORKS=true (development only), because
 * http://localhost is a private address that the SSRF protection otherwise blocks.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const port = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 5050);
const secret = process.env.WEBHOOK_SIGNING_SECRET ?? '';
const MAX_SKEW_SECONDS = 300;

function verify(header: string | undefined, body: string): string {
  if (!secret) return 'not checked (WEBHOOK_SIGNING_SECRET unset)';
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? '');
  if (!match?.[1] || !match[2]) return 'INVALID (missing or malformed header)';
  if (Math.abs(Date.now() / 1000 - Number(match[1])) > MAX_SKEW_SECONDS)
    return 'INVALID (stale timestamp)';
  const expected = createHmac('sha256', secret).update(`${match[1]}.${body}`).digest();
  const received = Buffer.from(match[2], 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? 'valid ✔'
    : 'INVALID (mismatch)';
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      const signature = verify(req.headers['x-aop-signature'] as string | undefined, body);
      let summary = body;
      try {
        const payload = JSON.parse(body) as {
          event?: string;
          incident?: { title?: string; status?: string };
        };
        summary = `${payload.event}${payload.incident ? `: ${payload.incident.title} [${payload.incident.status}]` : ''}`;
      } catch {
        // Not JSON; print as is.
      }
      process.stdout.write(
        `${new Date().toISOString()}  ${summary}\n    signature: ${signature}\n`,
      );
      res.writeHead(signature.startsWith('INVALID') ? 401 : 200).end();
    });
  })
  .listen(port, () =>
    process.stdout.write(`Webhook receiver listening on http://localhost:${port}/hook\n`),
  );
