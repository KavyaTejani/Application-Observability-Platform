#!/usr/bin/env node
/**
 * Probes a running deployment from the outside, as a customer would, and fails if any private
 * backend or internal endpoint answers (PRD §14.2 item 6, AC-08).
 *
 *   node scripts/check-exposure.mjs https://aop-app-fbtl.onrender.com
 *
 * Checks: TCP connections to the backend ports on the public host, and HTTP requests for
 * internal paths through the public URL. Run it against a deployment you own.
 */
import net from 'node:net';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/check-exposure.mjs <public base URL>');
  process.exit(2);
}
const base = new URL(target);

const PORTS = {
  27017: 'MongoDB',
  6379: 'Redis',
  9090: 'Prometheus',
  3100: 'Loki',
  4317: 'OTel Collector (gRPC)',
  4318: 'OTel Collector (HTTP)',
  9464: 'API internal metrics',
};
const PATHS = [
  '/metrics',
  '/telemetry-metrics',
  '/operator/health',
  '/api/v1/query?query=up',
  '/loki/api/v1/labels',
  '/loki/api/v1/push',
];

function tcpOpen(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

let failures = 0;
const report = (ok, text) => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${text}`);
};

const live = await fetch(new URL('/health/live', base), { signal: AbortSignal.timeout(60_000) })
  .then((r) => r.ok)
  .catch(() => false);
report(live, `public app answers at ${base.origin}/health/live`);

for (const [port, name] of Object.entries(PORTS)) {
  const open = await tcpOpen(base.hostname, Number(port));
  report(!open, `${name} port ${port} is ${open ? 'OPEN to the internet' : 'not reachable'}`);
}

for (const path of PATHS) {
  const res = await fetch(new URL(path, base), {
    // What a Prometheus scraper or Loki client sends. A browser-style `Accept: text/html` would
    // get the web app's index.html (client-side routing), which is not a leak.
    headers: { 'X-Scope-OrgID': 'probe', Accept: 'text/plain, application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const status = res?.status ?? 'no response';
  // 404 (no such route) is the expected answer; a non-HTML 2xx means an internal endpoint leaked.
  const html = res?.headers.get('content-type')?.startsWith('text/html') ?? false;
  const leaked = res !== null && res.status >= 200 && res.status < 300 && !html;
  report(!leaked, `GET ${path} → ${status}`);
}

console.log(
  failures === 0 ? '\nNo private endpoint is exposed.' : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
