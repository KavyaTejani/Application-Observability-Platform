import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';

/** Paths redacted from every log line so credentials never reach log storage. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.apiKey',
  '*.token',
  '*.secret',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'isProduction'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'aop-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.isProduction
      ? {}
      : { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  });
}
