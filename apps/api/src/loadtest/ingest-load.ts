/**
 * Ingestion benchmark (PRD §9.3). Open-loop load generator: batches are sent on a fixed
 * schedule whatever the response time, so a slow server shows up as latency and backlog rather
 * than being hidden by the client slowing down.
 *
 *   npm run loadtest -w @aop/api -- [options]
 *
 * Options (defaults in brackets):
 *   --base URL            API under test [http://localhost:4000]
 *   --prometheus URL      Prometheus that scrapes that API, for verification [http://localhost:9090]
 *   --loki URL            Loki, for verification [http://localhost:3100]
 *   --mongo URI           The API's MongoDB, to give the test org a raised-quota plan [MONGODB_URI]
 *   --profile NAME        full | smoke [full]
 *   --mix NAME            mixed | logs | metrics [mixed]
 *   --clients N           concurrent SDK-like clients, one key each [4]
 *   --batch N             records per request [200]
 *   --out FILE            write the JSON result here
 *
 * Profiles: full = ramp 30 s → sustained 1000 rec/s × 300 s → burst 5000 rec/s × 30 s →
 * recovery 500 rec/s × 60 s. smoke = the same shape at 60/10/20 s.
 *
 * Correctness, not just throughput: every response's accepted/rejected counts are summed, and at
 * the end the stored data is counted in Loki (log lines) and Prometheus (request counter) for the
 * test project and compared with what the API acknowledged. During the sustained phase a probe
 * measures the ingest → searchable delay through the product's log API, and a dashboard query
 * (15-minute summary) is timed.
 *
 * Quota: the run uses a fresh organization moved to a dedicated "benchmark" plan with raised
 * daily limits (PRD §9.3). Production quota enforcement stays on; the limits are just higher.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { OrganizationModel } from '../modules/organizations/organization.model.js';
import { PlanModel } from '../modules/plans/plan.model.js';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4000' },
    prometheus: { type: 'string', default: 'http://localhost:9090' },
    loki: { type: 'string', default: 'http://localhost:3100' },
    mongo: { type: 'string', default: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/aop' },
    internal: { type: 'string', default: '' },
    profile: { type: 'string', default: 'full' },
    mix: { type: 'string', default: 'mixed' },
    clients: { type: 'string', default: '4' },
    batch: { type: 'string', default: '200' },
    out: { type: 'string', default: '' },
  },
});

const BASE = args.base.replace(/\/+$/, '');
const CLIENTS = Number(args.clients);
const BATCH = Number(args.batch);
const MIX = args.mix as 'mixed' | 'logs' | 'metrics';
const LOG_SHARE = MIX === 'logs' ? 1 : MIX === 'metrics' ? 0 : 0.5;
const runId = randomBytes(4).toString('hex');

interface Phase {
  name: string;
  /** Records per second; a [from, to] pair ramps linearly. */
  rate: number | [number, number];
  seconds: number;
}
const PROFILES: Record<string, Phase[]> = {
  full: [
    { name: 'ramp', rate: [100, 1000], seconds: 30 },
    { name: 'sustained', rate: 1000, seconds: 300 },
    { name: 'burst', rate: 5000, seconds: 30 },
    { name: 'recovery', rate: 500, seconds: 60 },
  ],
  smoke: [
    { name: 'ramp', rate: [100, 1000], seconds: 10 },
    { name: 'sustained', rate: 1000, seconds: 60 },
    { name: 'burst', rate: 5000, seconds: 10 },
    { name: 'recovery', rate: 500, seconds: 20 },
  ],
};
const phases = PROFILES[args.profile];
if (!phases) throw new Error(`Unknown profile ${args.profile}`);

const say = (text: string) => process.stdout.write(`${text}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- seeded dataset (fixed, so runs are comparable) -----------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
const WORDS =
  'order payment cart checkout inventory warehouse shipment customer invoice refund catalog price discount coupon session cache database query timeout retry upstream gateway latency queue worker'.split(
    ' ',
  );
const ROUTES = ['/products', '/products/:id', '/cart/items', '/checkout', '/orders/:id', '/search'];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const SEVERITIES = ['INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as const;

/** ~1 KiB per log record serialized (PRD §9.3 suggested size). */
const LOG_TEMPLATES = Array.from({ length: 500 }, (_, i) => {
  const words = Array.from({ length: 95 }, () => pick(WORDS)).join(' ');
  return {
    severity: pick(SEVERITIES),
    message: `bench ${runId} #${i}: ${words}`.slice(0, 700),
    attributes: {
      route: pick(ROUTES),
      statusCode: pick([200, 200, 201, 404, 500]),
      region: pick(['eu-west', 'us-east', 'ap-south']),
      tier: pick(['free', 'pro', 'team']),
      durationMs: Math.round(rand() * 900),
      cache: pick(['hit', 'miss']),
      attempt: 1 + Math.floor(rand() * 3),
      worker: `w-${Math.floor(rand() * 16)}`,
    },
  };
});
const METRIC_TEMPLATES = Array.from({ length: 500 }, () => ({
  method: pick(METHODS),
  route: pick(ROUTES),
  statusCode: pick([200, 200, 200, 201, 204, 400, 404, 500, 503]),
  durationMs: Math.round(5 + rand() ** 3 * 1500),
}));
let cursor = 0;

function makeBatch(size: number) {
  const now = new Date().toISOString();
  const logs = [];
  const metrics = [];
  for (let i = 0; i < size; i++) {
    cursor += 1;
    if (rand() < LOG_SHARE) {
      const t = LOG_TEMPLATES[cursor % LOG_TEMPLATES.length]!;
      logs.push({ timestamp: now, ...t, requestId: `req_${runId}_${cursor}` });
    } else {
      const t = METRIC_TEMPLATES[cursor % METRIC_TEMPLATES.length]!;
      metrics.push({ kind: 'http_request', timestamp: now, ...t });
    }
  }
  return { schemaVersion: 1, service: { name: 'bench' }, metrics, logs };
}

// ---- API helpers ---------------------------------------------------------------------------

let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0] ?? '';
    if (pair.includes('aop_sid=')) cookie = pair;
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function setup() {
  const email = `bench-${runId}@test.example`;
  const reg = await api('POST', '/api/v1/auth/register', {
    name: 'Bench',
    email,
    password: `bench-password-${runId}`,
    organizationName: `Benchmark ${runId}`,
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const orgId: string = reg.body.organizations[0].id;

  await mongoose.connect(args.mongo, { serverSelectionTimeoutMS: 5000 });
  const plan = await PlanModel.findOneAndUpdate(
    { code: 'benchmark' },
    {
      $set: {
        name: 'Benchmark (raised quota)',
        limits: {
          eventsPerDay: 50_000_000,
          bytesPerDay: 50 * 1024 ** 3,
          maxProjects: 3,
          maxDashboards: 5,
          maxAlertRules: 10,
        },
        active: true,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  await OrganizationModel.updateOne({ _id: orgId }, { planId: plan!._id });
  await mongoose.disconnect();

  const proj = await api('POST', `/api/v1/organizations/${orgId}/projects`, {
    name: `Bench ${runId}`,
    environment: 'development',
  });
  const projectId: string = proj.body.project.id;
  const keys: string[] = [];
  for (let i = 0; i < CLIENTS; i++) {
    keys.push(
      (await api('POST', `/api/v1/projects/${projectId}/keys`, { name: `c${i}` })).body.secret,
    );
  }
  // Plan limits are cached by the API for up to PLAN_CACHE_TTL_SECONDS; a first request warms it.
  return { orgId, projectId, keys };
}

// ---- measurement ---------------------------------------------------------------------------

interface PhaseStats {
  name: string;
  targetRate: string;
  seconds: number;
  requests: number;
  status: Record<string, number>;
  codes: Record<string, number>;
  sent: { metrics: number; logs: number };
  accepted: { metrics: number; logs: number };
  rejected: number;
  networkErrors: number;
  latencies: number[];
  maxInFlight: number;
  wallSeconds: number;
  cpuSeconds?: number;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function processCpuSeconds(): Promise<number | undefined> {
  if (!args.internal) return undefined;
  const text = await fetch(`${args.internal}/metrics`)
    .then((r) => r.text())
    .catch(() => '');
  const line = text.split('\n').find((l) => l.startsWith('aop_process_cpu_seconds_total'));
  return line ? Number(line.split(' ').pop()) : undefined;
}

async function runPhase(phase: Phase, keys: string[]): Promise<PhaseStats> {
  const stats: PhaseStats = {
    name: phase.name,
    targetRate: Array.isArray(phase.rate)
      ? `${phase.rate[0]}→${phase.rate[1]}`
      : String(phase.rate),
    seconds: phase.seconds,
    requests: 0,
    status: {},
    codes: {},
    sent: { metrics: 0, logs: 0 },
    accepted: { metrics: 0, logs: 0 },
    rejected: 0,
    networkErrors: 0,
    latencies: [],
    maxInFlight: 0,
    wallSeconds: 0,
  };
  const cpuBefore = await processCpuSeconds();
  const start = performance.now();
  const end = start + phase.seconds * 1000;
  const rateAt = (t: number) =>
    Array.isArray(phase.rate)
      ? phase.rate[0] + ((phase.rate[1] - phase.rate[0]) * (t - start)) / (end - start)
      : phase.rate;
  let due = 0; // records owed by the schedule
  let last = start;
  let inFlight = 0;
  let k = 0;
  const pending: Promise<void>[] = [];

  while (performance.now() < end) {
    const now = performance.now();
    due += (rateAt(now) * (now - last)) / 1000;
    last = now;
    while (due >= BATCH) {
      due -= BATCH;
      const body = makeBatch(BATCH);
      stats.sent.metrics += body.metrics.length;
      stats.sent.logs += body.logs.length;
      const key = keys[k++ % keys.length]!;
      inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      const t0 = performance.now();
      pending.push(
        fetch(`${BASE}/v1/telemetry/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            stats.latencies.push(performance.now() - t0);
            stats.status[res.status] = (stats.status[res.status] ?? 0) + 1;
            const json = (await res.json().catch(() => ({}))) as {
              accepted?: { metrics: number; logs: number };
              rejected?: { metrics: number; logs: number };
              error?: { code: string };
            };
            if (res.status === 202 && json.accepted) {
              stats.accepted.metrics += json.accepted.metrics;
              stats.accepted.logs += json.accepted.logs;
              stats.rejected += (json.rejected?.metrics ?? 0) + (json.rejected?.logs ?? 0);
            } else {
              const code = json.error?.code ?? `HTTP_${res.status}`;
              stats.codes[code] = (stats.codes[code] ?? 0) + 1;
              stats.rejected += body.metrics.length + body.logs.length;
            }
          })
          .catch(() => {
            stats.networkErrors += 1;
          })
          .finally(() => {
            inFlight -= 1;
            stats.requests += 1;
          }),
      );
    }
    await sleep(5);
  }
  await Promise.all(pending);
  stats.wallSeconds = (performance.now() - start) / 1000;
  const cpuAfter = await processCpuSeconds();
  if (cpuBefore !== undefined && cpuAfter !== undefined) stats.cpuSeconds = cpuAfter - cpuBefore;
  return stats;
}

/** Ingest → searchable delay: write one marked log, poll the product log API until it appears. */
async function logVisibilityProbe(projectId: string, key: string): Promise<number | null> {
  const requestId = `probe_${runId}_${Date.now()}`;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/telemetry/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      schemaVersion: 1,
      service: { name: 'bench' },
      logs: [
        { timestamp: new Date().toISOString(), severity: 'INFO', message: 'probe', requestId },
      ],
    }),
  });
  if (res.status !== 202) return null;
  while (Date.now() - t0 < 30_000) {
    const r = await api('GET', `/api/v1/projects/${projectId}/logs?requestId=${requestId}&limit=1`);
    if (r.body.entries?.length) return Date.now() - t0;
    await sleep(500);
  }
  return null;
}

async function dashboardQueryMs(projectId: string): Promise<number | null> {
  const t0 = performance.now();
  const r = await api('GET', `/api/v1/projects/${projectId}/metrics/summary?range=15m`);
  return r.status === 200 ? performance.now() - t0 : null;
}

// ---- verification against storage ---------------------------------------------------------

async function lokiCount(orgId: string, projectId: string, sinceMs: number): Promise<number> {
  const seconds = Math.ceil((Date.now() - sinceMs) / 1000) + 60;
  const params = new URLSearchParams({
    query: `sum(count_over_time({project="${projectId}", service="bench"} != "probe" [${seconds}s]))`,
    time: String(Date.now() * 1_000_000),
  });
  const res = await fetch(`${args.loki}/loki/api/v1/query?${params}`, {
    headers: { 'X-Scope-OrgID': orgId },
  });
  const body = (await res.json()) as { data: { result: Array<{ value: [number, string] }> } };
  return Number(body.data.result[0]?.value[1] ?? 0);
}

async function prometheusCount(projectId: string): Promise<number> {
  const params = new URLSearchParams({
    query: `sum(app_http_requests_total{project_id="${projectId}", service="bench"})`,
  });
  const res = await fetch(`${args.prometheus}/api/v1/query?${params}`);
  const body = (await res.json()) as { data: { result: Array<{ value: [number, string] }> } };
  return Number(body.data.result[0]?.value[1] ?? 0);
}

// ---- main ----------------------------------------------------------------------------------

async function main() {
  say(`Benchmark ${runId}: profile=${args.profile} mix=${MIX} clients=${CLIENTS} batch=${BATCH}`);
  say(`Target ${BASE}\n`);
  const { orgId, projectId, keys } = await setup();
  const runStart = Date.now();

  const probes: number[] = [];
  const dashboard: number[] = [];
  let probing = false;
  const results: PhaseStats[] = [];
  for (const phase of phases!) {
    say(
      `→ ${phase.name}: ${Array.isArray(phase.rate) ? phase.rate.join('→') : phase.rate} rec/s for ${phase.seconds}s`,
    );
    probing = phase.name === 'sustained';
    const probeLoop = (async () => {
      while (probing) {
        const [p, d] = await Promise.all([
          logVisibilityProbe(projectId, keys[0]!),
          dashboardQueryMs(projectId),
        ]);
        if (p !== null) probes.push(p);
        if (d !== null) dashboard.push(d);
        await sleep(5000);
      }
    })();
    const stats = await runPhase(phase, keys);
    probing = false;
    await probeLoop;
    results.push(stats);
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    const accepted = stats.accepted.metrics + stats.accepted.logs;
    say(
      `   ${stats.requests} requests, accepted ${accepted} (${(accepted / stats.wallSeconds).toFixed(0)} rec/s), ` +
        `rejected ${stats.rejected}, p50 ${percentile(sorted, 50).toFixed(0)} ms, p95 ${percentile(sorted, 95).toFixed(0)} ms, ` +
        `p99 ${percentile(sorted, 99).toFixed(0)} ms, status ${JSON.stringify(stats.status)}`,
    );
  }

  const ack = results.reduce(
    (t, s) => ({ metrics: t.metrics + s.accepted.metrics, logs: t.logs + s.accepted.logs }),
    { metrics: 0, logs: 0 },
  );
  say('\nVerifying stored data against acknowledged counts…');
  const verifyStart = Date.now();
  let stored = { logs: 0, metrics: 0 };
  while (Date.now() - verifyStart < 120_000) {
    stored = {
      logs: ack.logs > 0 ? await lokiCount(orgId, projectId, runStart) : 0,
      metrics: ack.metrics > 0 ? await prometheusCount(projectId) : 0,
    };
    if (stored.logs >= ack.logs && stored.metrics >= ack.metrics) break;
    await sleep(5000);
  }
  const visibleAfterSeconds = (Date.now() - verifyStart) / 1000;
  say(`   logs:    acknowledged ${ack.logs}, stored in Loki ${stored.logs}`);
  say(`   metrics: acknowledged ${ack.metrics}, counted by Prometheus ${stored.metrics}`);

  const probeSorted = [...probes].sort((a, b) => a - b);
  const dashSorted = [...dashboard].sort((a, b) => a - b);
  const summary = {
    runId,
    date: new Date().toISOString(),
    profile: args.profile,
    mix: MIX,
    clients: CLIENTS,
    batchSize: BATCH,
    environment: {
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      ramGiB: Math.round(os.totalmem() / 1024 ** 3),
      os: `${os.type()} ${os.release()}`,
      node: process.version,
    },
    payloadBytes: {
      log: Buffer.byteLength(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...LOG_TEMPLATES[0],
          requestId: 'req_x_1',
        }),
      ),
      metric: Buffer.byteLength(
        JSON.stringify({
          kind: 'http_request',
          timestamp: new Date().toISOString(),
          ...METRIC_TEMPLATES[0],
        }),
      ),
    },
    phases: results.map((s) => {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      const accepted = s.accepted.metrics + s.accepted.logs;
      const sent = s.sent.metrics + s.sent.logs;
      return {
        name: s.name,
        targetRecordsPerSecond: s.targetRate,
        seconds: s.seconds,
        requests: s.requests,
        recordsSent: s.sent,
        recordsAccepted: s.accepted,
        acceptedPerSecond: Math.round(accepted / s.wallSeconds),
        rejectionRate: sent ? s.rejected / sent : 0,
        networkErrors: s.networkErrors,
        status: s.status,
        errorCodes: s.codes,
        latencyMs: {
          p50: Math.round(percentile(sorted, 50)),
          p95: Math.round(percentile(sorted, 95)),
          p99: Math.round(percentile(sorted, 99)),
          max: Math.round(sorted.at(-1) ?? 0),
        },
        maxInFlight: s.maxInFlight,
        apiCpuCoresAvg:
          s.cpuSeconds !== undefined ? +(s.cpuSeconds / s.wallSeconds).toFixed(2) : null,
      };
    }),
    verification: {
      acknowledged: ack,
      stored,
      complete: stored.logs === ack.logs && stored.metrics === ack.metrics,
      visibleWithinSecondsAfterRun: Math.round(visibleAfterSeconds),
    },
    logVisibilityDelayMs: {
      samples: probes.length,
      p50: Math.round(percentile(probeSorted, 50)),
      p95: Math.round(percentile(probeSorted, 95)),
      max: Math.round(probeSorted.at(-1) ?? 0),
    },
    dashboardQueryMs: {
      samples: dashboard.length,
      p50: Math.round(percentile(dashSorted, 50)),
      p95: Math.round(percentile(dashSorted, 95)),
    },
  };
  say(`\n${JSON.stringify(summary.verification)}`);
  say(`log visibility delay: ${JSON.stringify(summary.logVisibilityDelayMs)}`);
  say(`dashboard query: ${JSON.stringify(summary.dashboardQueryMs)}`);
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
    say(`\nWrote ${args.out}`);
  }
  if (!summary.verification.complete) process.exitCode = 1;
}

main().catch((error: unknown) => {
  say(`✖ ${(error as Error).message}`);
  process.exit(1);
});
