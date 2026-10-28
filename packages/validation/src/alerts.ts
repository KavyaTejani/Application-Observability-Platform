import { z } from 'zod';
import { serviceNameSchema } from './telemetry.js';

/**
 * Alert rules (PRD ALERT-001 to ALERT-003, ALERT-011). Structured only, with no query text. The
 * operator enum keeps the later-phase values for schema stability, but the MVP accepts only
 * "above" semantics (gt, gte).
 */
export const ALERT_METRIC_KEYS = ['error_rate', 'p95_latency'] as const;
export type AlertMetricKey = (typeof ALERT_METRIC_KEYS)[number];
export const ALERT_OPERATORS_ALL = ['gt', 'gte', 'lt', 'lte'] as const;
export const ALERT_OPERATORS_MVP = ['gt', 'gte'] as const;

/** Scrape interval of the deployment. Windows must cover at least two scrapes (ALERT-003). */
export const SCRAPE_INTERVAL_SECONDS = 15;
export const ALERT_WINDOW_SECONDS = [60, 120, 300, 600, 900, 1800, 3600] as const;
export const ALERT_INTERVAL_SECONDS = [30, 60, 120, 300] as const;

/** Safe threshold bounds per metric: error rate is a ratio, latency is in milliseconds. */
export const ALERT_THRESHOLD_BOUNDS: Record<AlertMetricKey, { min: number; max: number }> = {
  error_rate: { min: 0, max: 1 },
  p95_latency: { min: 1, max: 60_000 },
};

const ruleName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(80, 'Name must be at most 80 characters');
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid ID');
const oneOf = (allowed: readonly number[], message: string) =>
  z
    .number()
    .int()
    .refine((v) => allowed.includes(v), { message });

const ruleFields = {
  name: ruleName,
  metricKey: z.enum(ALERT_METRIC_KEYS),
  operator: z
    .enum(ALERT_OPERATORS_ALL)
    .refine((op) => (ALERT_OPERATORS_MVP as readonly string[]).includes(op), {
      message: 'Only "above" conditions (gt, gte) are supported',
    }),
  threshold: z.number().finite(),
  windowSeconds: oneOf(ALERT_WINDOW_SECONDS, 'Window must be 1, 2, 5, 10, 15, 30, or 60 minutes'),
  evaluationIntervalSeconds: oneOf(ALERT_INTERVAL_SECONDS, 'Interval must be 30 s, 1, 2, or 5 min'),
  /** Consecutive breaching evaluations before firing (normal → pending → firing). */
  forEvaluations: z.number().int().min(1).max(10),
  /** Consecutive non-breaching evaluations before an incident resolves (anti-flapping). */
  resolveAfterEvaluations: z.number().int().min(1).max(10),
  serviceName: serviceNameSchema.optional(),
  notificationDestinationId: objectId.optional(),
  enabled: z.boolean(),
};

const thresholdInBounds = (rule: { metricKey?: AlertMetricKey; threshold?: number }) =>
  !rule.metricKey ||
  rule.threshold === undefined ||
  (rule.threshold >= ALERT_THRESHOLD_BOUNDS[rule.metricKey].min &&
    rule.threshold <= ALERT_THRESHOLD_BOUNDS[rule.metricKey].max);

const thresholdMessage = {
  message: 'Threshold out of range (error rate 0–1 as a ratio; p95 latency 1–60000 ms)',
  path: ['threshold'],
};

export const createAlertRuleSchema = z
  .object({
    ...ruleFields,
    windowSeconds: ruleFields.windowSeconds.default(300),
    evaluationIntervalSeconds: ruleFields.evaluationIntervalSeconds.default(60),
    forEvaluations: ruleFields.forEvaluations.default(2),
    resolveAfterEvaluations: ruleFields.resolveAfterEvaluations.default(2),
    enabled: ruleFields.enabled.default(true),
  })
  .strict()
  .refine(thresholdInBounds, thresholdMessage)
  // ALERT-003: the window must exceed the interval and span at least two scrapes.
  .refine(
    (r) => r.windowSeconds >= Math.max(2 * SCRAPE_INTERVAL_SECONDS, r.evaluationIntervalSeconds),
    {
      message: 'Window must be at least as long as the evaluation interval',
      path: ['windowSeconds'],
    },
  );
export type CreateAlertRuleInput = z.input<typeof createAlertRuleSchema>;

export const updateAlertRuleSchema = z
  .object({
    name: ruleFields.name.optional(),
    threshold: ruleFields.threshold.optional(),
    windowSeconds: ruleFields.windowSeconds.optional(),
    evaluationIntervalSeconds: ruleFields.evaluationIntervalSeconds.optional(),
    forEvaluations: ruleFields.forEvaluations.optional(),
    resolveAfterEvaluations: ruleFields.resolveAfterEvaluations.optional(),
    serviceName: ruleFields.serviceName.nullable().optional(),
    notificationDestinationId: ruleFields.notificationDestinationId.nullable().optional(),
    enabled: ruleFields.enabled.optional(),
  })
  .strict()
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
export type UpdateAlertRuleInput = z.input<typeof updateAlertRuleSchema>;

export const incidentListSchema = z
  .object({
    status: z.enum(['firing', 'resolved']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Webhook destinations (PRD §12.7.1). The URL is checked again before every delivery. */
export const createDestinationSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(80),
    url: z.url({ protocol: /^https?$/, error: 'Enter an http(s) URL' }).max(2048),
    /** Omit for an organization-wide destination. */
    projectId: objectId.optional(),
  })
  .strict();
export type CreateDestinationInput = z.input<typeof createDestinationSchema>;

export const updateDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z
      .url({ protocol: /^https?$/, error: 'Enter an http(s) URL' })
      .max(2048)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
