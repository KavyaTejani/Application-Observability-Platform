import { z } from 'zod';

/**
 * Central configuration. Every environment variable the API reads is declared and validated
 * here at startup; nothing else in the codebase reads `process.env` directly.
 */
const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** An optional URL where an empty string (common in hosting dashboards) means "not set". */
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());

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
  // Telemetry backends are optional so the product can run where they are not deployed (for
  // example a free hosting tier). Readiness then reports them as "not_configured".
  PROMETHEUS_URL: optionalUrl,
  LOKI_URL: optionalUrl,
  OTEL_COLLECTOR_ENDPOINT: optionalUrl,

  // Directory of the built web app. When set, the API also serves the UI from the same origin.
  WEB_DIST_DIR: z.string().min(1).optional(),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TELEMETRY_KEY_PEPPER: z.string().min(32, 'TELEMETRY_KEY_PEPPER must be at least 32 characters'),

  // A session ends after this much inactivity, and in any case after the absolute lifetime.
  SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(720),
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),

  // How long a verified ingestion key is cached. Bounds how long a key revoked through another
  // API instance keeps working (PRD KEY-003). The revoking instance invalidates immediately.
  API_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

  // Per-project caps on distinct metric label values (PRD ING-014); extra values become __other__.
  MAX_ROUTES_PER_PROJECT: z.coerce.number().int().min(1).max(1000).default(100),
  MAX_SERVICES_PER_PROJECT: z.coerce.number().int().min(1).max(200).default(20),
  // Deadline for every call to Loki/Prometheus.
  BACKEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),

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
  prometheusUrl: string | undefined;
  lokiUrl: string | undefined;
  otelCollectorEndpoint: string | undefined;
  webDistDir: string | undefined;
  sessionSecret: string;
  telemetryKeyPepper: string;
  healthCheckTimeoutMs: number;
  apiKeyCacheTtlMs: number;
  cardinality: Readonly<{ maxRoutesPerProject: number; maxServicesPerProject: number }>;
  backendTimeoutMs: number;
  session: Readonly<{ idleTtlMs: number; absoluteTtlMs: number; cookieName: string }>;
  /** Origins allowed to send state-changing, cookie-authenticated requests (CSRF defence). */
  allowedOrigins: readonly string[];
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
    prometheusUrl: env.PROMETHEUS_URL?.replace(/\/+$/, ''),
    lokiUrl: env.LOKI_URL?.replace(/\/+$/, ''),
    otelCollectorEndpoint: env.OTEL_COLLECTOR_ENDPOINT,
    webDistDir: env.WEB_DIST_DIR,
    sessionSecret: env.SESSION_SECRET,
    telemetryKeyPepper: env.TELEMETRY_KEY_PEPPER,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    apiKeyCacheTtlMs: env.API_KEY_CACHE_TTL_SECONDS * 1000,
    cardinality: Object.freeze({
      maxRoutesPerProject: env.MAX_ROUTES_PER_PROJECT,
      maxServicesPerProject: env.MAX_SERVICES_PER_PROJECT,
    }),
    backendTimeoutMs: env.BACKEND_TIMEOUT_MS,
    session: Object.freeze({
      idleTtlMs: env.SESSION_IDLE_TTL_MINUTES * 60_000,
      absoluteTtlMs: env.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000,
      // The __Host- prefix makes browsers enforce Secure, Path=/ and no Domain attribute. It
      // requires HTTPS, so plain-HTTP local development uses an unprefixed name.
      cookieName: env.NODE_ENV === 'production' ? '__Host-aop_sid' : 'aop_sid',
    }),
    allowedOrigins: Object.freeze([
      ...new Set([new URL(env.WEB_ORIGIN).origin, new URL(env.APP_BASE_URL).origin]),
    ]),
  });
}
