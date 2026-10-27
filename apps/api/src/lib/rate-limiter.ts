import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

/** Fixed-window counter: at most `limit` hits per `windowSeconds` for a key. */
export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

/**
 * Redis-backed limiter, shared by every API instance. INCR and EXPIRE NX run in one MULTI, so
 * concurrent requests cannot both see "under limit", and the window starts at the first hit.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'rl:',
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `${this.prefix}${key}`;
    const results = await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .ttl(redisKey)
      .exec();
    if (!results) throw new Error('Rate limit transaction aborted');
    const [[incrErr, count], , [ttlErr, ttl]] = results as [
      [Error | null, number],
      unknown,
      [Error | null, number],
    ];
    if (incrErr ?? ttlErr) throw incrErr ?? ttlErr;
    return { allowed: count <= limit, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  }
}

/** In-process limiter for tests and single-process tools. Not shared across instances. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= limit,
      retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000),
    };
  }
}
