import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './index.js';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017/aop',
  REDIS_URL: 'redis://localhost:6379',
  PROMETHEUS_URL: 'http://localhost:9090/',
  LOKI_URL: 'http://localhost:3100',
  SESSION_SECRET: 'x'.repeat(32),
  TELEMETRY_KEY_PEPPER: 'y'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults and normalizes backend URLs', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(4000);
    expect(config.internalPort).toBe(9464);
    expect(config.env).toBe('development');
    expect(config.prometheusUrl).toBe('http://localhost:9090');
  });

  it('reports every missing variable without echoing values', () => {
    let caught: unknown;
    try {
      loadConfig({ SESSION_SECRET: 'short-secret-value' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain('MONGODB_URI');
    expect(message).toContain('SESSION_SECRET');
    expect(message).not.toContain('short-secret-value');
  });

  it('rejects .env.example placeholder secrets in production', () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        SESSION_SECRET: 'change-me-'.padEnd(40, 'x'),
      }),
    ).toThrow(/placeholder/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(ConfigError);
  });
});
