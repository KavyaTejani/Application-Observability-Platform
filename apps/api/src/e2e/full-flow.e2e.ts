/**
 * End-to-end test of the main workflow against a RUNNING stack (PRD §14.1 "End-to-end tests"):
 *
 *   register → create project → create key → run the sample app (real SDK) → send requests →
 *   metrics and logs appear → alert fires → one incident + signed webhook → traffic stops →
 *   incident resolves → a fresh sign-in still sees everything (state is persisted) → invalid
 *   credentials, a foreign organization, and a revoked key are refused.
 *
 *   npm run infra:up && npm run dev:api        # the stack under test
 *   npm run e2e                                # E2E_BASE_URL defaults to http://localhost:4000
 *
 * The webhook step needs WEBHOOK_ALLOW_PRIVATE_NETWORKS=true on the API (a local receiver is a
 * private address); without it that step is reported as skipped. The run takes 3–5 minutes,
 * mostly waiting for Prometheus scrapes and the alert window to fill and then clear.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const SAMPLE_PORT = Number(process.env.E2E_SAMPLE_PORT ?? 3199);
const demoDir = fileURLToPath(new URL('../../../demo-node-service/', import.meta.url));
const runId = randomBytes(4).toString('hex');

// ---- tiny harness --------------------------------------------------------------------------

const say = (text: string) =>
  process.stdout.write(`${text}
`);
// Responses are checked field by field below; a full type per endpoint adds nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s`;
let step = 0;
let skipped = 0;
const pass = (text: string) => say(`${elapsed()} ✔ ${++step}. ${text}`);
const skip = (text: string) => {
  skipped += 1;
  say(`${elapsed()} – ${++step}. SKIPPED: ${text}`);
};
const info = (text: string) => say(`${elapsed()}     ${text}`);

class E2EFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new E2EFailure(message);
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline)
      throw new E2EFailure(`Timed out after ${timeoutMs / 1000}s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/** A browser-like client: keeps the session cookie and sends the app's Origin. */
class Client {
  private cookie = '';

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0] ?? '';
      if (pair.includes('aop_sid=')) this.cookie = pair;
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      // not JSON
    }
    return { status: res.status, body: json };
  }
  get = (path: string) => this.call('GET', path);
  post = (path: string, body: unknown = {}) => this.call('POST', path, body);
}

// ---- webhook receiver ----------------------------------------------------------------------

interface ReceivedWebhook {
  event: string;
  validSignature: boolean;
}

function startReceiver(): Promise<{
  url: string;
  received: ReceivedWebhook[];
  close: () => void;
  setSecret: (s: string) => void;
}> {
  const received: ReceivedWebhook[] = [];
  let secret = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(
        String(req.headers['x-aop-signature'] ?? ''),
      );
      let valid = false;
      if (match?.[1] && match[2] && secret) {
        const expected = createHmac('sha256', secret).update(`${match[1]}.${raw}`).digest();
        const got = Buffer.from(match[2], 'hex');
        valid = expected.length === got.length && timingSafeEqual(expected, got);
      }
      let event = 'unknown';
      try {
        event = (JSON.parse(raw) as { event?: string }).event ?? 'unknown';
      } catch {
        // ignore
      }
      received.push({ event, validSignature: valid });
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => server.close(),
        setSecret: (s) => (secret = s),
      });
    }),
  );
}

// ---- sample app ----------------------------------------------------------------------------

function startSampleApp(apiKey: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=source', 'src/server.ts'],
    {
      cwd: demoDir,
      env: {
        ...process.env,
        AOP_ENDPOINT: BASE,
        AOP_API_KEY: apiKey,
        AOP_SERVICE_NAME: 'e2e-store',
        AOP_ENVIRONMENT: 'development',
        PORT: String(SAMPLE_PORT),
        DEMO_ERROR_RATE: '1', // every checkout fails with 500
        DEMO_EXTRA_LATENCY_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`    [sample] ${d}`));
  return child;
}

/** Mixed traffic: half catalogue reads (2xx), half checkouts (500 at DEMO_ERROR_RATE=1). */
function startTraffic(): () => void {
  const target = `http://localhost:${SAMPLE_PORT}`;
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    const req =
      n % 2 === 0
        ? fetch(`${target}/checkout`, { method: 'POST' })
        : fetch(`${target}/products/${1 + (n % 20)}?run=${runId}`);
    req.catch(() => undefined);
  }, 100);
  return () => clearInterval(timer);
}

// ---- the flow ------------------------------------------------------------------------------

async function main(): Promise<void> {
  say(`E2E against ${BASE} (run ${runId})\n`);
  const live = await fetch(`${BASE}/health/live`).catch(() => null);
  check(live?.ok, `API not reachable at ${BASE}. Start it with "npm run dev:api".`);

  const owner = new Client();
  const email = `e2e-${runId}@test.example`;
  const password = `e2e-password-${runId}`;
  const reg = await owner.post('/api/v1/auth/register', {
    name: 'E2E Owner',
    email,
    password,
    organizationName: `E2E ${runId}`,
  });
  check(reg.status === 201, `register → ${reg.status} ${JSON.stringify(reg.body)}`);
  const orgId: string = reg.body.organizations[0].id;
  pass('registered and signed in (session cookie issued)');

  const proj = await owner.post(`/api/v1/organizations/${orgId}/projects`, {
    name: `Shop ${runId}`,
    environment: 'development',
  });
  check(proj.status === 201, `create project → ${proj.status}`);
  const projectId: string = proj.body.project.id;
  const keyRes = await owner.post(`/api/v1/projects/${projectId}/keys`, { name: 'e2e' });
  check(keyRes.status === 201 && keyRes.body.secret, `create key → ${keyRes.status}`);
  const apiKey: string = keyRes.body.secret;
  const keyList = await owner.get(`/api/v1/projects/${projectId}/keys`);
  check(!JSON.stringify(keyList.body).includes(apiKey), 'key listing exposed the secret');
  pass('created a project and an ingestion key (the secret is not listed afterwards)');

  const receiver = await startReceiver();
  const dest = await owner.post(`/api/v1/organizations/${orgId}/notification-destinations`, {
    name: 'E2E receiver',
    url: receiver.url,
  });
  const webhooks = dest.status === 201;
  if (webhooks) {
    receiver.setSecret(dest.body.signingSecret);
    pass('added a webhook destination (signing secret shown once)');
  } else {
    skip(
      `webhook destination refused (${dest.body.error?.code}); set WEBHOOK_ALLOW_PRIVATE_NETWORKS=true on the API for a local receiver`,
    );
  }

  const rule = await owner.post(`/api/v1/projects/${projectId}/alert-rules`, {
    name: 'E2E error rate',
    metricKey: 'error_rate',
    operator: 'gt',
    threshold: 0.2,
    windowSeconds: 60,
    evaluationIntervalSeconds: 30,
    forEvaluations: 1,
    resolveAfterEvaluations: 1,
    ...(webhooks ? { notificationDestinationId: dest.body.destination.id } : {}),
  });
  check(rule.status === 201, `create rule → ${rule.status} ${JSON.stringify(rule.body)}`);
  pass('created an alert rule: 5xx rate > 20% over 1 min, checked every 30 s');

  const sample = startSampleApp(apiKey);
  let stopTraffic: (() => void) | null = null;
  try {
    await waitFor('sample app to start', 30_000, async () => {
      const r = await fetch(`http://localhost:${SAMPLE_PORT}/products`);
      return r.ok;
    });
    const conn = await fetch(`${BASE}/v1/telemetry/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    check(conn.ok, `connection check → ${conn.status}`);
    pass(`sample app (real SDK) running on :${SAMPLE_PORT}; key verified`);

    stopTraffic = startTraffic();
    info('sending ~10 req/s (half of them failing checkouts)…');

    const summary = await waitFor('request metrics in the dashboard', 120_000, async () => {
      const r = await owner.get(`/api/v1/projects/${projectId}/metrics/summary?range=15m`);
      const s = r.body.summary;
      return r.status === 200 && s?.requests > 0 && s.serverErrorRate > 0 ? s : null;
    });
    pass(
      `metrics visible: ≈${summary.requests} requests, 5xx rate ${(summary.serverErrorRate * 100).toFixed(0)}%`,
    );

    const logs = await waitFor('sample-app logs in the explorer', 60_000, async () => {
      const r = await owner.get(
        `/api/v1/projects/${projectId}/logs?service=e2e-store&severity=ERROR&limit=20`,
      );
      return r.status === 200 && r.body.entries.length > 0 ? r.body.entries : null;
    });
    pass(`logs searchable: ${logs.length} ERROR entries, e.g. "${logs[0].message}"`);

    const incident = await waitFor('the rule to fire and open an incident', 180_000, async () => {
      const r = await owner.get(`/api/v1/projects/${projectId}/incidents`);
      return r.body.incidents?.find((i: { status: string }) => i.status === 'firing');
    });
    pass(`alert fired → incident "${incident.title}"`);

    if (webhooks) {
      await waitFor('the firing webhook', 60_000, async () =>
        receiver.received.some((w) => w.event === 'incident_firing'),
      );
      check(
        receiver.received.every((w) => w.validSignature),
        'a webhook had an invalid signature',
      );
      const deliveries = await owner.get(`/api/v1/incidents/${incident.id}/deliveries`);
      check(
        deliveries.body.deliveries.some((d: { status: string }) => d.status === 'success'),
        'no successful delivery recorded',
      );
      pass('signed webhook received (signature verified) and recorded on the incident');
    }

    // Keep breaching for a while: still exactly one incident, no duplicate notifications.
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    const during = await owner.get(`/api/v1/projects/${projectId}/incidents`);
    check(
      during.body.incidents.length === 1,
      `expected 1 incident, got ${during.body.incidents.length}`,
    );
    if (webhooks) {
      const firing = receiver.received.filter((w) => w.event === 'incident_firing').length;
      check(firing === 1, `expected 1 firing webhook, got ${firing}`);
    }
    pass('continued breaching: still one incident and one notification (deduplicated)');

    stopTraffic();
    stopTraffic = null;
    info('traffic stopped; waiting for the window to clear…');
    const resolved = await waitFor('the incident to resolve', 240_000, async () => {
      const r = await owner.get(`/api/v1/incidents/${incident.id}`);
      return r.body.incident?.status === 'resolved' ? r.body.incident : null;
    });
    pass(`incident resolved at ${resolved.resolvedAt}`);
    if (webhooks) {
      await waitFor('the resolved webhook', 60_000, async () =>
        receiver.received.some((w) => w.event === 'incident_resolved'),
      );
      pass('resolved webhook received');
    }
  } finally {
    stopTraffic?.();
    sample.kill();
    receiver.close();
  }

  // A fresh session (as after reloading the app or restarting the browser) sees the same state.
  const again = new Client();
  check(
    (await again.post('/api/v1/auth/login', { email, password })).status === 200,
    'login with the same account failed',
  );
  const projects = await again.get(`/api/v1/organizations/${orgId}/projects`);
  const incidents = await again.get(`/api/v1/projects/${projectId}/incidents`);
  const usage = await again.get(`/api/v1/organizations/${orgId}/usage`);
  check(
    projects.body.projects?.some((p: { id: string }) => p.id === projectId),
    'project missing',
  );
  check(incidents.body.incidents?.length === 1, 'incident history missing');
  check(usage.body.usage?.quota.records.used > 0, 'usage not recorded');
  pass(
    `new session sees the project, the incident, and usage (${usage.body.usage.quota.records.used} records today)`,
  );

  const wrong = await new Client().post('/api/v1/auth/login', {
    email,
    password: 'wrong-password',
  });
  check(wrong.status === 401 && wrong.body.error?.code === 'INVALID_CREDENTIALS', 'bad password');
  const stranger = new Client();
  await stranger.post('/api/v1/auth/register', {
    name: 'Stranger',
    email: `e2e-stranger-${runId}@test.example`,
    password,
  });
  const foreign = await stranger.get(`/api/v1/projects/${projectId}`);
  const foreignOrg = await stranger.get(`/api/v1/organizations/${orgId}/usage`);
  check(foreign.status === 404 && foreignOrg.status === 404, 'foreign access not refused');
  const anonymous = await new Client().get(`/api/v1/organizations/${orgId}`);
  check(anonymous.status === 401, 'anonymous access not refused');
  pass('wrong password → 401, another user → 404 on this org and project, anonymous → 401');

  await owner.post(`/api/v1/projects/${projectId}/keys/${keyRes.body.key.keyId}/revoke`);
  const revoked = await fetch(`${BASE}/v1/telemetry/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  check(revoked.status === 401, `revoked key → ${revoked.status}`);
  pass('revoked key is refused');

  say(`\nE2E passed in ${elapsed().trim()}${skipped ? ` (${skipped} step(s) skipped)` : ''}.`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    say(`\n${elapsed()} ✖ FAILED: ${(error as Error).message}`);
    process.exit(1);
  },
);
