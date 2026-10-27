import { describe, expect, it, vi } from 'vitest';
import { HealthService, type DependencyProbe } from './health.service.js';

const up: DependencyProbe = async () => undefined;
const down: DependencyProbe = async () => {
  throw new Error('connection refused at 10.0.0.5:27017');
};
const hang: DependencyProbe = () => new Promise(() => undefined);

describe('HealthService', () => {
  it('is ready when every dependency is up', async () => {
    const service = new HealthService({ mongodb: up, redis: up, prometheus: up, loki: up }, 500);
    const report = await service.checkReadiness();
    expect(report.status).toBe('ready');
    expect(report.dependencies.mongodb.status).toBe('up');
  });

  it('is not ready when one dependency fails, and reports which one', async () => {
    const onFailure = vi.fn();
    const service = new HealthService(
      { mongodb: down, redis: up, prometheus: up, loki: up },
      500,
      onFailure,
    );
    const report = await service.checkReadiness();
    expect(report.status).toBe('not_ready');
    expect(report.dependencies.mongodb.status).toBe('down');
    expect(report.dependencies.redis.status).toBe('up');
    expect(onFailure).toHaveBeenCalledWith('mongodb', expect.any(Error));
    // Internal addresses from the error must not leak into the report.
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
  });

  it('treats a hung dependency as down after the timeout', async () => {
    const service = new HealthService({ mongodb: up, redis: up, prometheus: up, loki: hang }, 50);
    const report = await service.checkReadiness();
    expect(report.dependencies.loki.status).toBe('down');
  });
});
