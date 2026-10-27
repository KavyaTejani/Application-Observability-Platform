import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RedisRateLimiter } from './rate-limiter.js';

describe('MemoryRateLimiter', () => {
  it('allows up to the limit, then blocks until the window resets', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i++) expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
    const blocked = await limiter.hit('k', 3, 60);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now += 60_000;
    expect((await limiter.hit('k', 3, 60)).allowed).toBe(true);
  });
});

describe('RedisRateLimiter (integration)', () => {
  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const prefix = `test:rl:${randomBytes(4).toString('hex')}:`;

  beforeAll(async () => {
    try {
      await redis.connect();
    } catch (error) {
      throw new Error('Integration tests need Redis. Run "npm run infra:up".', { cause: error });
    }
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('never admits more than the limit under concurrent hits', async () => {
    const limiter = new RedisRateLimiter(redis, prefix);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.hit('burst', 10, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.every((r) => r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 60)).toBe(true);
  });

  it('sets the expiry only on the first hit of a window', async () => {
    const limiter = new RedisRateLimiter(redis, prefix);
    await limiter.hit('window', 100, 30);
    await redis.expire(`${prefix}window`, 5);
    await limiter.hit('window', 100, 30); // must not push the expiry back to 30 s
    expect(await redis.ttl(`${prefix}window`)).toBeLessThanOrEqual(5);
  });
});
