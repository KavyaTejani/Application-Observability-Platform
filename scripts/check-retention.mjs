#!/usr/bin/env node
/**
 * Verifies that Loki actually deletes expired logs (PRD RET-003, AC-11), instead of trusting the
 * configuration value. It starts a throwaway Loki with the short-duration profile
 * (infra/retention-test), writes records older than the retention period plus fresh ones, flushes
 * them to storage, and waits for the compactor to delete the expired ones while the fresh ones
 * remain.
 *
 *   npm run check:retention          # needs Docker; takes about 2–6 minutes
 *
 * Prometheus is not checked this way: it deletes whole TSDB blocks (about two hours each) once
 * they are older than --storage.tsdb.retention.time, so a short test cannot observe it. See
 * docs/architecture.md (Retention).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const compose = fileURLToPath(new URL('../infra/retention-test/compose.yaml', import.meta.url));
const LOKI = 'http://localhost:3101';
const TENANT = `retention-${randomBytes(4).toString('hex')}`;
const HOUR_NS = 3_600_000_000_000n;
const TIMEOUT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => process.stdout.write(`${text}\n`);
const docker = (...args) =>
  execFileSync('docker', ['compose', '-f', compose, ...args], { stdio: 'ignore' });

async function lokiFetch(path, init = {}) {
  return fetch(`${LOKI}${path}`, {
    ...init,
    headers: { 'X-Scope-OrgID': TENANT, ...(init.headers ?? {}) },
  });
}

/** Number of entries in [now - fromH, now - toH]. */
async function countEntries(fromH, toH, attempt) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const params = new URLSearchParams({
    query: '{project="retention-check"}',
    start: String(now - BigInt(fromH) * HOUR_NS),
    end: String(now - BigInt(toH) * HOUR_NS),
    limit: String(1000 + attempt),
    direction: 'forward',
  });
  const res = await lokiFetch(`/loki/api/v1/query_range?${params}`);
  if (!res.ok) throw new Error(`query failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.data.result.reduce((n, stream) => n + stream.values.length, 0);
}

async function waitReady() {
  const readyBy = Date.now() + 120_000;
  while (
    !(await fetch(`${LOKI}/ready`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (Date.now() > readyBy) throw new Error('Loki did not become ready');
    await sleep(2000);
  }
}

async function main() {
  say('Starting a throwaway Loki with the short retention profile (24 h)…');
  docker('up', '-d');
  await waitReady();

  const now = BigInt(Date.now()) * 1_000_000n;
  const expired = Array.from({ length: 20 }, (_, i) => [
    String(now - 50n * HOUR_NS + BigInt(i) * 1_000_000_000n),
    `expired record ${i}`,
  ]);
  const fresh = Array.from({ length: 5 }, (_, i) => [
    String(now - 60_000_000_000n + BigInt(i) * 1_000_000_000n),
    `fresh record ${i}`,
  ]);
  const push = await lokiFetch('/loki/api/v1/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streams: [
        { stream: { project: 'retention-check', age: 'expired' }, values: expired },
        { stream: { project: 'retention-check', age: 'fresh' }, values: fresh },
      ],
    }),
  });
  if (push.status !== 204) throw new Error(`push failed: ${push.status} ${await push.text()}`);

  // Retention applies to chunks in storage, and queries older than 3 h read only storage, so
  // flush the ingester's in-memory chunks there first.
  await fetch(`${LOKI}/flush`, { method: 'POST' });
  let before = { expired: 0, fresh: 0 };
  for (let i = 0; i < 20 && (before.expired !== 20 || before.fresh !== 5); i++) {
    await sleep(3000);
    before = { expired: await countEntries(51, 49, i), fresh: await countEntries(1, 0, i) };
  }
  say(`Stored: ${before.expired} records 50 h old, ${before.fresh} fresh records.`);
  if (before.expired !== 20 || before.fresh !== 5)
    throw new Error('records not readable after flush');
  // The ingester ships its in-memory index to storage only every 15 minutes or on shutdown, and
  // the compactor applies retention only to shipped index tables. A graceful restart ships it.
  say('Restarting Loki so the ingester ships its index to storage…');
  docker('restart');
  await waitReady();
  say('Waiting for the compactor to apply retention…');

  const started = Date.now();
  for (let attempt = 1; Date.now() - started < TIMEOUT_MS; attempt++) {
    await sleep(15_000);
    const left = await countEntries(51, 49, attempt);
    const freshLeft = await countEntries(1, 0, attempt);
    const seconds = Math.round((Date.now() - started) / 1000);
    say(
      `  ${String(seconds).padStart(4)} s: expired records left ${left}, fresh records ${freshLeft}`,
    );
    if (freshLeft !== 5) throw new Error('fresh records were deleted: retention is too aggressive');
    if (left === 0) {
      say(`\n✔ Expired logs were deleted after ${seconds} s; fresh logs were kept.`);
      return;
    }
  }
  throw new Error('expired records were not deleted within 10 minutes');
}

main()
  .then(() => {
    docker('down', '-v');
    process.exit(0);
  })
  .catch((error) => {
    say(`\n✖ ${error.message}`);
    try {
      docker('down', '-v');
    } catch {
      // ignore
    }
    process.exit(1);
  });
