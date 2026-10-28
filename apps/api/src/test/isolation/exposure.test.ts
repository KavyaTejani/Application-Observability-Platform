import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PRD §14.2 item 6 and AC-08: customers cannot reach Prometheus, Loki, MongoDB, Redis, or the
 * Collector through public network routes. The deployment files are the source of truth for what
 * is published, so they are checked here. `docker compose config` resolves them exactly as
 * Docker would; the checks are skipped where Docker is not installed.
 */
const infra = (file: string) =>
  fileURLToPath(new URL(`../../../../../infra/${file}`, import.meta.url));

interface ComposePort {
  target: number;
  published?: string;
  host_ip?: string;
}
interface ComposeConfig {
  services: Record<string, { ports?: ComposePort[]; networks?: Record<string, unknown> }>;
  networks: Record<string, { internal?: boolean }>;
}

function composeConfig(file: string): ComposeConfig | null {
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', infra(file), 'config', '--format', 'json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          APP_BASE_URL: 'https://aop.example.com',
          WEB_ORIGIN: 'https://aop.example.com',
          SESSION_SECRET: 'x'.repeat(32),
          TELEMETRY_KEY_PEPPER: 'y'.repeat(32),
        },
      },
    );
    return JSON.parse(out) as ComposeConfig;
  } catch {
    return null;
  }
}

const prod = composeConfig('compose.prod.yaml');
const dev = composeConfig('compose.yaml');

describe.skipIf(!prod || !dev)('backend exposure (deployment files)', () => {
  it('production publishes only the app port; no backend or internal metrics port', () => {
    const published = Object.entries(prod!.services).flatMap(([name, service]) =>
      (service.ports ?? []).map((port) => ({ name, target: port.target })),
    );
    expect(published).toEqual([{ name: 'api', target: 4000 }]);
  });

  it('production backends sit on an internal network with no outside route', () => {
    expect(prod!.networks.backend?.internal).toBe(true);
    for (const name of ['mongodb', 'redis', 'prometheus', 'loki', 'otel-collector']) {
      expect(Object.keys(prod!.services[name]?.networks ?? {}), name).toEqual(['backend']);
    }
  });

  it('development publishes backend ports on 127.0.0.1 only', () => {
    for (const [name, service] of Object.entries(dev!.services)) {
      for (const port of service.ports ?? []) {
        expect(port.host_ip, `${name}:${port.target}`).toBe('127.0.0.1');
      }
    }
  });
});

describe('container image', () => {
  it('exposes only the public HTTP port', () => {
    const dockerfile = readFileSync(infra('../Dockerfile'), 'utf8');
    expect(dockerfile.match(/^EXPOSE .*/gm)).toEqual(['EXPOSE 4000']);
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});
