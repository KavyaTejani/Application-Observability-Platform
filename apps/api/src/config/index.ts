import { z } from 'zod';

/**
 * Central configuration. Every environment variable the API reads is declared and validated
 * here at startup; nothing else in the codebase reads `process.env` directly.
 */
const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // Private listener for Prometheus scrapes; never exposed through the public proxy.
  INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_BASE_URL: z.url().default('http://localhost:4000'),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  TRUST_PROXY: booleanFromString.default(false),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  PROMETHEUS_URL: z.url(),
  LOKI_URL: z.url(),
  OTEL_COLLECTOR_ENDPOINT: z.url().optional(),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TELEMETRY_KEY_PEPPER: z.string().min(32, 'TELEMETRY_KEY_PEPPER must be at least 32 characters'),

  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
});

export type AppConfig = Readonly<{
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  internalPort: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  appBaseUrl: string;
  webOrigin: string;
  trustProxy: boolean;
  mongoUri: string;
  redisUrl: string;
  prometheusUrl: string;
  lokiUrl: string;
  otelCollectorEndpoint: string | undefined;
  sessionSecret: string;
  telemetryKeyPepper: string;
  healthCheckTimeoutMs: number;
}>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDER_PATTERN = /^change-me/i;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names and rules only; never echo the supplied values.
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    const placeholders = (['SESSION_SECRET', 'TELEMETRY_KEY_PEPPER'] as const).filter((name) =>
      PLACEHOLDER_PATTERN.test(env[name]),
    );
    if (placeholders.length > 0) {
      throw new ConfigError(
        placeholders.map(
          (name) => `${name}: placeholder value from .env.example used in production`,
        ),
      );
    }
  }

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    internalPort: env.INTERNAL_PORT,
    logLevel: env.LOG_LEVEL,
    appBaseUrl: env.APP_BASE_URL,
    webOrigin: env.WEB_ORIGIN,
    trustProxy: env.TRUST_PROXY,
    mongoUri: env.MONGODB_URI,
    redisUrl: env.REDIS_URL,
    prometheusUrl: env.PROMETHEUS_URL.replace(/\/+$/, ''),
    lokiUrl: env.LOKI_URL.replace(/\/+$/, ''),
    otelCollectorEndpoint: env.OTEL_COLLECTOR_ENDPOINT,
    sessionSecret: env.SESSION_SECRET,
    telemetryKeyPepper: env.TELEMETRY_KEY_PEPPER,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  });
}
