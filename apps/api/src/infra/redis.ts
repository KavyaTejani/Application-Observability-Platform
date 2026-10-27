import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export function createRedis(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5000,
    // Commands fail quickly while Redis is unreachable instead of queueing without bound.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  client.on('error', (err: Error) => logger.warn({ err: err.message }, 'Redis error'));
  client.on('ready', () => logger.info('Redis ready'));
  return client;
}
