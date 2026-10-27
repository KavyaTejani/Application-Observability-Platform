import { z } from 'zod';
import { HTTP_METHODS, SEVERITIES, serviceNameSchema } from './telemetry.js';

/**
 * Structured query descriptors. The browser never sends PromQL or LogQL (PRD §2.3, MET-003):
 * it picks from these allow-lists, and the server generates the backend query. Objects are
 * `.strict()`, so an unexpected field such as `promql`, `expr`, or `organizationId` is rejected,
 * not silently ignored.
 */

export const METRIC_KEYS = [
  'request_rate',
  'error_rate',
  'client_error_rate',
  'p50_latency',
  'p95_latency',
  'p99_latency',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
const isErrorRate = (key: MetricKey) => key === 'error_rate' || key === 'client_error_rate';

export const TIME_RANGES = ['15m', '1h', '6h', '24h'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
export const TIME_RANGE_SECONDS: Record<TimeRange, number> = {
  '15m': 900,
  '1h': 3600,
  '6h': 21_600,
  '24h': 86_400,
};

export const INTERVALS = ['15s', '30s', '1m', '5m', '15m', '1h'] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
};
/** Bound on points per series in a range query (PRD MET-003). */
export const MAX_POINTS_PER_SERIES = 1000;

/** Low-cardinality dimensions only (MET-005); tenant labels are never groupable. */
export const GROUP_BY_DIMENSIONS = ['service', 'route', 'method', 'status_class'] as const;
export type GroupByDimension = (typeof GROUP_BY_DIMENSIONS)[number];

export const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;

const routeFilter = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/:_.*{}-]*$/, 'route must be a route template such as /products/:id');

export const metricFiltersSchema = z
  .object({
    serviceName: serviceNameSchema.optional(),
    route: routeFilter.optional(),
    method: z.enum([...HTTP_METHODS, 'OTHER']).optional(),
    statusClass: z.enum(STATUS_CLASSES).optional(),
  })
  .strict();

export const metricQuerySchema = z
  .object({
    metricKey: z.enum(METRIC_KEYS),
    range: z.enum(TIME_RANGES),
    interval: z.enum(INTERVALS).optional(),
    filters: metricFiltersSchema.default({}),
    groupBy: z
      .array(z.enum(GROUP_BY_DIMENSIONS))
      .max(2)
      .refine((dims) => new Set(dims).size === dims.length, 'groupBy dimensions must be unique')
      .default([]),
  })
  .strict()
  .refine(
    (q) =>
      !q.interval ||
      TIME_RANGE_SECONDS[q.range] / INTERVAL_SECONDS[q.interval] <= MAX_POINTS_PER_SERIES,
    {
      message: `interval too small for this range (max ${MAX_POINTS_PER_SERIES} points)`,
      path: ['interval'],
    },
  )
  // An error rate is already a ratio *of* status classes, so filtering or grouping it by status
  // class is meaningless.
  .refine((q) => !(isErrorRate(q.metricKey) && q.filters.statusClass), {
    message: 'statusClass cannot filter an error-rate metric',
    path: ['filters', 'statusClass'],
  })
  .refine((q) => !(isErrorRate(q.metricKey) && q.groupBy.includes('status_class')), {
    message: 'error rates cannot be grouped by status_class',
    path: ['groupBy'],
  });
export type MetricQueryInput = z.input<typeof metricQuerySchema>;
export type MetricQuery = z.output<typeof metricQuerySchema>;

export const metricSummarySchema = z
  .object({ range: z.enum(TIME_RANGES).default('1h'), serviceName: serviceNameSchema.optional() })
  .strict();

/** Logs: maximum span of one query, and how far back queries may start (log retention). */
export const MAX_LOG_QUERY_SPAN_MS = 24 * 60 * 60 * 1000;
export const MAX_LOG_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LOG_LIMIT = 200;

const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value,
    z.array(item).max(SEVERITIES.length),
  );

export const logQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    severity: csv(z.enum(SEVERITIES)).optional(),
    service: serviceNameSchema.optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid request ID')
      .optional(),
    contains: z
      .string()
      .min(1)
      .max(200)
      // Backticks delimit the generated LogQL raw string; they are the one character refused.
      .refine((s) => !s.includes('`'), 'contains may not include a backtick')
      .optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LOG_LIMIT).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
export type LogQueryInput = z.input<typeof logQuerySchema>;
export type LogQuery = z.output<typeof logQuerySchema>;
