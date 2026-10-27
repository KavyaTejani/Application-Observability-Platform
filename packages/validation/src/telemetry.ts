import { z } from 'zod';
import { ENVIRONMENTS } from './projects.js';

/**
 * Telemetry ingestion protocol, schema version 1 (documented in docs/ingestion-api.md).
 *
 * The envelope is validated as a whole: any error rejects the request. Each record is then
 * validated on its own, so one bad record does not discard a batch of good ones.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;
export const MAX_RECORDS_PER_BATCH = 500;
export const MAX_LOG_MESSAGE_LENGTH = 8192;
export const MAX_ATTRIBUTES = 32;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;
/** Accepted client timestamp window (PRD ING-012). */
export const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_RECORD_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Service names become metric and log labels, so they are short and from a safe alphabet. */
export const serviceNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'Service name: 1–63 chars of letters, digits, . _ -');

export const batchEnvelopeSchema = z.object({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION, { error: 'schemaVersion must be 1' }),
  service: z.object({
    name: serviceNameSchema,
    environment: z.enum(ENVIRONMENTS).optional(),
  }),
  metrics: z.array(z.unknown()).default([]),
  logs: z.array(z.unknown()).default([]),
});
export type BatchEnvelope = z.output<typeof batchEnvelopeSchema>;

const timestampSchema = z.iso.datetime({ offset: true, error: 'timestamp must be ISO 8601' });

export const httpRequestMetricSchema = z.object({
  kind: z.literal('http_request'),
  timestamp: timestampSchema,
  method: z.string().transform((m) => m.toUpperCase()),
  /** Route *template* such as `/products/:id`. Raw paths are normalized server-side. */
  route: z
    .string()
    .min(1)
    .max(200)
    .regex(/^\/[^\s?#]*$/, 'route must be a path template starting with "/" without query string'),
  statusCode: z.number().int().min(100).max(599),
  durationMs: z.number().min(0).max(3_600_000),
});
export type HttpRequestMetric = z.output<typeof httpRequestMetricSchema>;

const attributeKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const attributeValue = z.union([
  z.string().max(MAX_ATTRIBUTE_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const logRecordSchema = z.object({
  timestamp: timestampSchema,
  severity: z.enum(SEVERITIES),
  message: z.string().min(1).max(MAX_LOG_MESSAGE_LENGTH),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  attributes: z
    .record(z.string().regex(attributeKey, 'invalid attribute name'), attributeValue)
    .refine((attrs) => Object.keys(attrs).length <= MAX_ATTRIBUTES, {
      message: `at most ${MAX_ATTRIBUTES} attributes`,
    })
    .optional(),
});
export type LogRecord = z.output<typeof logRecordSchema>;
