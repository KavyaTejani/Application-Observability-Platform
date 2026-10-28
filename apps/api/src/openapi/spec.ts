import {
  batchEnvelopeSchema,
  createAlertRuleSchema,
  createApiKeySchema,
  createDestinationSchema,
  createProjectSchema,
  httpRequestMetricSchema,
  incidentListSchema,
  logQuerySchema,
  logRecordSchema,
  loginSchema,
  metricQuerySchema,
  metricSummarySchema,
  registerSchema,
  rotateApiKeySchema,
  updateAlertRuleSchema,
  updateDestinationSchema,
  updateProjectSchema,
} from '@aop/validation';
import { z } from 'zod';

/**
 * OpenAPI 3.1 description of the product API and the ingestion API (PRD §12.9).
 *
 * Request schemas are generated from the same Zod schemas the server validates with, so the
 * document cannot drift from the validation rules. Response schemas are written by hand from the
 * route serializers. `npm run openapi -w @aop/api` writes it to docs/openapi.json, and a test
 * fails if the committed file is out of date.
 */

type JsonSchema = Record<string, unknown>;

/** Zod → JSON Schema (draft 2020-12, which OpenAPI 3.1 uses), minus generator noise. */
function schemaOf(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return clean(json) as JsonSchema;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    // `format: date-time` says it; the generated ISO regex is unreadable.
    if (key === 'pattern' && (node as JsonSchema).format === 'date-time') continue;
    // Safe-integer bounds added by z.int() carry no information.
    if (
      (key === 'minimum' || key === 'maximum') &&
      Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER
    )
      continue;
    out[key] = clean(value);
  }
  return out;
}

/** Query-string parameters from an object schema. */
function queryParams(schema: z.ZodType): unknown[] {
  const json = schemaOf(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
  }));
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const body = (schema: z.ZodType) => ({ required: true, content: json(schemaOf(schema)) });
const ok = (description: string, schema: unknown) => ({ description, content: json(schema) });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});
const arrayOf = (schema: unknown) => ({ type: 'array', items: schema });
const str = { type: 'string' };
const nullableStr = { type: ['string', 'null'] };
const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };

const errorResponse = (description: string) => ({
  description,
  content: json(ref('ErrorEnvelope')),
});
const errors = (...codes: number[]) => {
  const text: Record<number, string> = {
    400: 'Validation failed (`details.fields` holds per-field messages)',
    401: 'Not signed in / invalid credentials',
    403: 'Signed in, but the role does not allow this action',
    404: 'Not found, or not visible to the caller (no existence oracle)',
    409: 'Conflict (duplicate name, plan limit reached)',
    413: 'Payload too large',
    429: 'Rate limit or quota exceeded (`Retry-After` header)',
    502: 'Backend rejected the request',
    503: 'A backend is unavailable or not configured',
  };
  return Object.fromEntries(codes.map((code) => [String(code), errorResponse(text[code] ?? '')]));
};

const pathId = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-f0-9]{24}$' },
});

const session = [{ session: [] }];
const sessionTags = (tag: string) => ({ tags: [tag], security: session });
const csrfNote =
  'State-changing request: the `Origin` (or `Referer`) header must be the app’s own origin.';

const schemas = {
  ErrorEnvelope: obj(
    {
      error: obj(
        {
          code: { ...str, description: 'Stable machine-readable code, e.g. `NOT_FOUND`.' },
          message: { ...str, description: 'Human-readable message.' },
          requestId: { ...str, description: 'Correlation ID; also logged server-side.' },
          details: { type: 'object', additionalProperties: true },
        },
        ['code', 'message', 'requestId'],
      ),
    },
    ['error'],
  ),
  User: obj({ id: str, name: str, email: str }),
  OrganizationSummary: obj({
    id: str,
    name: str,
    slug: str,
    role: { type: 'string', enum: ['owner', 'member'] },
  }),
  Project: obj({
    id: str,
    organizationId: str,
    name: str,
    slug: str,
    environment: { type: 'string', enum: ['development', 'staging', 'production'] },
    lastTelemetryAt: nullableDateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  ApiKey: obj({
    keyId: str,
    name: str,
    prefix: { ...str, description: 'Non-secret display prefix.' },
    scopes: arrayOf({ type: 'string', enum: ['telemetry:write'] }),
    state: { type: 'string', enum: ['active', 'expiring', 'revoked'] },
    createdAt: dateTime,
    lastUsedAt: nullableDateTime,
    revokedAt: nullableDateTime,
    expiresAt: nullableDateTime,
    replacedBy: nullableStr,
  }),
  CreatedApiKey: obj({
    key: ref('ApiKey'),
    secret: { ...str, description: 'Full key `aop_<keyId>.<secret>`. Shown once, never again.' },
  }),
  Readiness: obj({
    status: { type: 'string', enum: ['ready', 'degraded', 'not_ready'] },
    checkedAt: dateTime,
    dependencies: {
      type: 'object',
      additionalProperties: obj(
        {
          status: { type: 'string', enum: ['up', 'down', 'not_configured'] },
          latencyMs: int,
        },
        ['status'],
      ),
    },
  }),
  AlertRule: obj({
    id: str,
    projectId: str,
    name: str,
    metricKey: { type: 'string', enum: ['error_rate', 'p95_latency'] },
    operator: { type: 'string', enum: ['gt', 'gte'] },
    threshold: { ...num, description: 'Ratio (0–1) for error_rate; milliseconds for p95_latency.' },
    windowSeconds: int,
    evaluationIntervalSeconds: int,
    forEvaluations: int,
    resolveAfterEvaluations: int,
    serviceName: nullableStr,
    notificationDestinationId: nullableStr,
    enabled: bool,
    createdBy: str,
    lastState: { type: 'string', enum: ['normal', 'pending', 'firing', 'error'] },
    lastEvaluatedAt: nullableDateTime,
    lastValue: { type: ['number', 'null'], description: 'null = no data in the window.' },
    lastError: nullableStr,
    createdAt: dateTime,
  }),
  Incident: obj({
    id: str,
    projectId: str,
    alertRuleId: str,
    status: { type: 'string', enum: ['firing', 'resolved'] },
    title: str,
    startedAt: dateTime,
    resolvedAt: nullableDateTime,
    lastTriggeredAt: dateTime,
    lastValue: { type: ['number', 'null'] },
    ruleSnapshot: obj({ metricKey: str, operator: str, threshold: num, windowSeconds: int }),
  }),
  Delivery: obj({
    id: str,
    destinationId: str,
    event: { type: 'string', enum: ['incident_firing', 'incident_resolved'] },
    attempt: int,
    status: { type: 'string', enum: ['success', 'failed', 'blocked'] },
    responseStatus: { type: ['integer', 'null'] },
    startedAt: dateTime,
    finishedAt: dateTime,
    errorSummary: { ...nullableStr, description: 'Safe summary; response bodies are never kept.' },
  }),
  Destination: obj({
    id: str,
    name: str,
    type: { type: 'string', enum: ['webhook'] },
    urlPreview: { ...str, description: 'Scheme and host only; the full URL is never returned.' },
    projectId: nullableStr,
    enabled: bool,
    createdAt: dateTime,
  }),
  Meter: obj({ used: num, limit: num }),
  Usage: obj({
    dayUtc: { ...str, description: 'YYYY-MM-DD (UTC)' },
    resetsAt: dateTime,
    plan: obj({ code: str, name: str }),
    quota: obj({ records: ref('Meter'), bytes: ref('Meter') }),
    rejected: obj({ records: int, quotaRecords: int }),
    resources: obj({ projects: ref('Meter'), alertRules: ref('Meter') }),
    retention: obj({ metricsDays: int, logsDays: int }),
    projects: arrayOf(
      obj({
        id: str,
        name: str,
        environment: str,
        deleted: bool,
        acceptedRecords: int,
        acceptedBytes: int,
        rejectedRecords: int,
        quotaRejectedRecords: int,
      }),
    ),
    history: arrayOf(obj({ dayUtc: str, records: int, bytes: int })),
  }),
  MetricSummary: obj({
    range: str,
    requests: { type: ['number', 'null'], description: 'Approximate (`increase()` extrapolates).' },
    requestRate: { type: ['number', 'null'], description: 'Requests per second.' },
    serverErrorRate: { type: ['number', 'null'], description: 'Ratio of 5xx responses.' },
    clientErrorRate: { type: ['number', 'null'], description: 'Ratio of 4xx responses.' },
    latencyMs: obj({
      p50: { type: ['number', 'null'] },
      p95: { type: ['number', 'null'] },
      p99: { type: ['number', 'null'] },
    }),
    lastTelemetryAt: nullableDateTime,
  }),
  MetricSeries: obj({
    metricKey: str,
    unit: str,
    range: str,
    stepSeconds: int,
    start: dateTime,
    end: dateTime,
    noData: bool,
    series: arrayOf(
      obj({
        labels: { type: 'object', additionalProperties: { type: 'string' } },
        points: arrayOf({
          type: 'array',
          prefixItems: [{ ...num, description: 'Unix ms' }, { type: ['number', 'null'] }],
          description: '`null` = no data (a gap, not zero).',
        }),
      }),
    ),
  }),
  LogEntry: obj(
    {
      id: { ...str, description: 'Stable entry ID within the result set.' },
      timestamp: dateTime,
      severity: str,
      service: str,
      environment: str,
      message: str,
      requestId: nullableStr,
      attributes: { type: 'object', additionalProperties: true },
    },
    ['id', 'timestamp', 'severity', 'service', 'environment', 'message', 'requestId', 'attributes'],
  ),
  IngestResult: obj({
    requestId: str,
    accepted: obj({ metrics: int, logs: int }),
    rejected: obj({ metrics: int, logs: int }),
    errors: arrayOf(
      obj({
        signal: { type: 'string', enum: ['metrics', 'logs'] },
        index: int,
        code: { type: 'string', enum: ['INVALID_RECORD', 'TIMESTAMP_OUT_OF_RANGE'] },
        message: str,
      }),
    ),
  }),
  TelemetryBatch: {
    ...schemaOf(batchEnvelopeSchema),
    properties: {
      ...(schemaOf(batchEnvelopeSchema).properties as JsonSchema),
      metrics: { ...arrayOf(schemaOf(httpRequestMetricSchema)), default: [] },
      logs: { ...arrayOf(schemaOf(logRecordSchema)), default: [] },
    },
    description: 'At most 500 records in total and 1 MiB per request.',
  },
};

export function buildOpenApiSpec() {
  const org = pathId('organizationId');
  const project = pathId('projectId');

  const paths = {
    '/health/live': {
      get: {
        operationId: 'liveness',
        tags: ['Health'],
        summary: 'Process liveness (no dependency checks)',
        responses: { '200': ok('Alive', obj({ status: str, uptimeSeconds: int })) },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'readiness',
        tags: ['Health'],
        summary: 'Dependency readiness',
        responses: {
          '200': ok('Ready or degraded (some backends not configured)', ref('Readiness')),
          '503': ok('A configured dependency is down', ref('Readiness')),
        },
      },
    },
    '/api/v1/status': {
      get: {
        operationId: 'status',
        tags: ['Health'],
        summary: 'Readiness report for the browser status page',
        description: 'Same as /health/ready under a path content blockers do not filter.',
        responses: {
          '200': ok('Ready or degraded', ref('Readiness')),
          '503': ok('Not ready', ref('Readiness')),
        },
      },
    },

    '/api/v1/auth/register': {
      post: {
        operationId: 'register',
        tags: ['Auth'],
        summary: 'Create an account and its organization, and sign in',
        description: `${csrfNote} Rate-limited per IP.`,
        requestBody: body(registerSchema),
        responses: {
          '201': ok(
            'Signed in; sets the session cookie',
            obj({ user: ref('User'), organizations: arrayOf(ref('OrganizationSummary')) }),
          ),
          ...errors(400, 409, 429),
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        operationId: 'login',
        tags: ['Auth'],
        summary: 'Sign in',
        description: `${csrfNote} Any failure returns the same \`INVALID_CREDENTIALS\`.`,
        requestBody: body(loginSchema),
        responses: { '200': ok('Signed in', obj({ user: ref('User') })), ...errors(400, 401, 429) },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        operationId: 'logout',
        ...sessionTags('Auth'),
        summary: 'Sign out and revoke the session server-side',
        responses: { '204': { description: 'Signed out' } },
      },
    },
    '/api/v1/auth/me': {
      get: {
        operationId: 'me',
        ...sessionTags('Auth'),
        summary: 'Current user and their organizations',
        responses: {
          '200': ok(
            'Current user',
            obj({ user: ref('User'), organizations: arrayOf(ref('OrganizationSummary')) }),
          ),
          ...errors(401),
        },
      },
    },

    '/api/v1/organizations': {
      get: {
        operationId: 'listOrganizations',
        ...sessionTags('Organizations'),
        summary: 'Organizations the caller belongs to',
        responses: {
          '200': ok('Organizations', obj({ organizations: arrayOf(ref('OrganizationSummary')) })),
          ...errors(401),
        },
      },
    },
    '/api/v1/organizations/{organizationId}': {
      parameters: [org],
      get: {
        operationId: 'getOrganization',
        ...sessionTags('Organizations'),
        summary: 'Organization detail (members)',
        responses: {
          '200': ok('Organization', obj({ organization: { type: 'object' } })),
          ...errors(401, 404),
        },
      },
    },
    '/api/v1/organizations/{organizationId}/members': {
      parameters: [org],
      get: {
        operationId: 'listMembers',
        ...sessionTags('Organizations'),
        summary: 'Member list (members)',
        responses: {
          '200': ok('Members', obj({ members: arrayOf({ type: 'object' }) })),
          ...errors(401, 404),
        },
      },
    },
    '/api/v1/organizations/{organizationId}/usage': {
      parameters: [org],
      get: {
        operationId: 'getUsage',
        ...sessionTags('Usage'),
        summary: 'Today’s quota use, per-project breakdown, plan limits, 7-day history (members)',
        responses: { '200': ok('Usage', obj({ usage: ref('Usage') })), ...errors(401, 404) },
      },
    },

    '/api/v1/organizations/{organizationId}/projects': {
      parameters: [org],
      get: {
        operationId: 'listProjects',
        ...sessionTags('Projects'),
        summary: 'Projects of the organization (members)',
        responses: {
          '200': ok('Projects', obj({ projects: arrayOf(ref('Project')) })),
          ...errors(401, 404),
        },
      },
      post: {
        operationId: 'createProject',
        ...sessionTags('Projects'),
        summary: 'Create a project (owners); the plan’s project limit is enforced atomically',
        description: csrfNote,
        requestBody: body(createProjectSchema),
        responses: {
          '201': ok('Created', obj({ project: ref('Project') })),
          ...errors(400, 401, 403, 404, 409),
        },
      },
    },
    '/api/v1/projects/{projectId}': {
      parameters: [project],
      get: {
        operationId: 'getProject',
        ...sessionTags('Projects'),
        summary: 'Project detail (members)',
        responses: { '200': ok('Project', obj({ project: ref('Project') })), ...errors(401, 404) },
      },
      patch: {
        operationId: 'renameProject',
        ...sessionTags('Projects'),
        summary: 'Rename (owners)',
        description: csrfNote,
        requestBody: body(updateProjectSchema),
        responses: {
          '200': ok('Updated', obj({ project: ref('Project') })),
          ...errors(400, 401, 403, 404, 409),
        },
      },
      delete: {
        operationId: 'deleteProject',
        ...sessionTags('Projects'),
        summary: 'Delete (owners); revokes every key of the project',
        description: csrfNote,
        responses: { '204': { description: 'Deleted' }, ...errors(401, 403, 404) },
      },
    },

    '/api/v1/projects/{projectId}/keys': {
      parameters: [project],
      get: {
        operationId: 'listKeys',
        ...sessionTags('Ingestion keys'),
        summary: 'Key metadata (members); secrets are never listed',
        responses: {
          '200': ok('Keys', obj({ keys: arrayOf(ref('ApiKey')) })),
          ...errors(401, 404),
        },
      },
      post: {
        operationId: 'createKey',
        ...sessionTags('Ingestion keys'),
        summary: 'Create a key (owners). The secret is in this response only.',
        description: `${csrfNote} Sent with \`Cache-Control: no-store\`.`,
        requestBody: body(createApiKeySchema),
        responses: {
          '201': ok('Created', ref('CreatedApiKey')),
          ...errors(400, 401, 403, 404),
        },
      },
    },
    '/api/v1/projects/{projectId}/keys/{keyId}/revoke': {
      parameters: [project, { name: 'keyId', in: 'path', required: true, schema: str }],
      post: {
        operationId: 'revokeKey',
        ...sessionTags('Ingestion keys'),
        summary: 'Revoke a key (owners); effective immediately on this instance',
        description: csrfNote,
        responses: { '200': ok('Revoked', obj({ key: ref('ApiKey') })), ...errors(401, 403, 404) },
      },
    },
    '/api/v1/projects/{projectId}/keys/{keyId}/rotate': {
      parameters: [project, { name: 'keyId', in: 'path', required: true, schema: str }],
      post: {
        operationId: 'rotateKey',
        ...sessionTags('Ingestion keys'),
        summary: 'Rotate a key (owners); the old key may stay valid for a grace period',
        description: csrfNote,
        requestBody: body(rotateApiKeySchema),
        responses: {
          '200': ok(
            'Replacement key, and the previous key (now expiring or revoked)',
            obj({ replacement: ref('CreatedApiKey'), previous: ref('ApiKey') }),
          ),
          ...errors(400, 401, 403, 404),
        },
      },
    },

    '/api/v1/projects/{projectId}/metrics/summary': {
      parameters: [project, ...queryParams(metricSummarySchema)],
      get: {
        operationId: 'metricsSummary',
        ...sessionTags('Metrics'),
        summary: 'Window summary: request total, 4xx/5xx rates, p50/p95/p99, last data',
        responses: {
          '200': ok('Summary', obj({ summary: ref('MetricSummary') })),
          ...errors(400, 401, 404, 429, 502, 503),
        },
      },
    },
    '/api/v1/projects/{projectId}/metrics/query': {
      parameters: [project],
      post: {
        operationId: 'metricsQuery',
        ...sessionTags('Metrics'),
        summary: 'Time series for an allow-listed metric descriptor',
        description:
          'The browser never sends PromQL. Unknown fields (e.g. `promql`, `organizationId`) are rejected with 400; the server generates the query with the caller’s scope.',
        requestBody: body(metricQuerySchema),
        responses: {
          '200': ok('Series', ref('MetricSeries')),
          ...errors(400, 401, 404, 429, 502, 503),
        },
      },
    },
    '/api/v1/projects/{projectId}/logs': {
      parameters: [project, ...queryParams(logQuerySchema)],
      get: {
        operationId: 'searchLogs',
        ...sessionTags('Logs'),
        summary: 'Log search, newest first, with cursor pagination',
        responses: {
          '200': ok(
            'Entries',
            obj({
              entries: arrayOf(ref('LogEntry')),
              nextCursor: { ...nullableStr, description: 'Pass as `cursor` for older entries.' },
              from: dateTime,
              to: dateTime,
            }),
          ),
          ...errors(400, 401, 404, 429, 502, 503),
        },
      },
    },
    '/api/v1/projects/{projectId}/services': {
      parameters: [project],
      get: {
        operationId: 'listServices',
        ...sessionTags('Metrics'),
        summary: 'Service names seen in metrics or logs (filter options)',
        responses: {
          '200': ok('Services', obj({ services: arrayOf(str) })),
          ...errors(401, 404, 503),
        },
      },
    },

    '/api/v1/projects/{projectId}/alert-rules': {
      parameters: [project],
      get: {
        operationId: 'listAlertRules',
        ...sessionTags('Alerts'),
        summary: 'Alert rules of the project (members)',
        responses: {
          '200': ok('Rules', obj({ rules: arrayOf(ref('AlertRule')) })),
          ...errors(401, 404),
        },
      },
      post: {
        operationId: 'createAlertRule',
        ...sessionTags('Alerts'),
        summary: 'Create a rule (members, using an existing destination)',
        description: `${csrfNote} MVP: \`error_rate\` or \`p95_latency\` with \`gt\`/\`gte\`.`,
        requestBody: body(createAlertRuleSchema),
        responses: {
          '201': ok('Created', obj({ rule: ref('AlertRule') })),
          ...errors(400, 401, 404, 409),
        },
      },
    },
    '/api/v1/alert-rules/{alertRuleId}': {
      parameters: [pathId('alertRuleId')],
      patch: {
        operationId: 'updateAlertRule',
        ...sessionTags('Alerts'),
        summary: 'Edit, enable, or disable (owners: any rule; members: their own)',
        description: `${csrfNote} Disabling a firing rule resolves its incident.`,
        requestBody: body(updateAlertRuleSchema),
        responses: {
          '200': ok('Updated', obj({ rule: ref('AlertRule') })),
          ...errors(400, 401, 403, 404),
        },
      },
      delete: {
        operationId: 'deleteAlertRule',
        ...sessionTags('Alerts'),
        summary: 'Delete (owners: any rule; members: their own)',
        description: csrfNote,
        responses: { '204': { description: 'Deleted' }, ...errors(401, 403, 404) },
      },
    },
    '/api/v1/projects/{projectId}/incidents': {
      parameters: [project, ...queryParams(incidentListSchema)],
      get: {
        operationId: 'listIncidents',
        ...sessionTags('Alerts'),
        summary: 'Incidents, newest first',
        responses: {
          '200': ok('Incidents', obj({ incidents: arrayOf(ref('Incident')) })),
          ...errors(400, 401, 404),
        },
      },
    },
    '/api/v1/incidents/{incidentId}': {
      parameters: [pathId('incidentId')],
      get: {
        operationId: 'getIncident',
        ...sessionTags('Alerts'),
        summary: 'Incident detail',
        responses: {
          '200': ok('Incident', obj({ incident: ref('Incident') })),
          ...errors(401, 404),
        },
      },
    },
    '/api/v1/incidents/{incidentId}/deliveries': {
      parameters: [pathId('incidentId')],
      get: {
        operationId: 'listDeliveries',
        ...sessionTags('Alerts'),
        summary: 'Notification attempts for the incident',
        responses: {
          '200': ok('Deliveries', obj({ deliveries: arrayOf(ref('Delivery')) })),
          ...errors(401, 404),
        },
      },
    },

    '/api/v1/organizations/{organizationId}/notification-destinations': {
      parameters: [org],
      get: {
        operationId: 'listDestinations',
        ...sessionTags('Notifications'),
        summary: 'Webhook destinations (members); no secrets or full URLs',
        responses: {
          '200': ok('Destinations', obj({ destinations: arrayOf(ref('Destination')) })),
          ...errors(401, 404),
        },
      },
      post: {
        operationId: 'createDestination',
        ...sessionTags('Notifications'),
        summary: 'Add a webhook destination (owners); the signing secret is shown once',
        description: `${csrfNote} Private, loopback, link-local, and metadata addresses are refused (SSRF).`,
        requestBody: body(createDestinationSchema),
        responses: {
          '201': ok(
            'Created',
            obj({ destination: ref('Destination'), signingSecret: { ...str, pattern: '^whsec_' } }),
          ),
          ...errors(400, 401, 403, 404),
        },
      },
    },
    '/api/v1/notification-destinations/{destinationId}': {
      parameters: [pathId('destinationId')],
      patch: {
        operationId: 'updateDestination',
        ...sessionTags('Notifications'),
        summary: 'Rename, change URL, enable, or disable (owners)',
        description: csrfNote,
        requestBody: body(updateDestinationSchema),
        responses: {
          '200': ok('Updated', obj({ destination: ref('Destination') })),
          ...errors(400, 401, 403, 404),
        },
      },
      delete: {
        operationId: 'deleteDestination',
        ...sessionTags('Notifications'),
        summary: 'Delete (owners)',
        description: csrfNote,
        responses: { '204': { description: 'Deleted' }, ...errors(401, 403, 404) },
      },
    },
    '/api/v1/notification-destinations/{destinationId}/test': {
      parameters: [pathId('destinationId')],
      post: {
        operationId: 'testDestination',
        ...sessionTags('Notifications'),
        summary: 'Send a labelled, signed test payload (owners; rate-limited)',
        description: csrfNote,
        responses: {
          '200': ok(
            'Attempt result',
            obj({
              result: obj(
                {
                  status: { type: 'string', enum: ['success', 'failed', 'blocked'] },
                  responseStatus: int,
                  errorSummary: str,
                },
                ['status'],
              ),
            }),
          ),
          ...errors(401, 403, 404, 429),
        },
      },
    },

    '/api/v1/operator/health': {
      get: {
        operationId: 'operatorHealth',
        tags: ['Operator'],
        security: [{ operatorToken: [] }],
        summary: 'Platform health for the operator (not an organization role)',
        description:
          'Requires `Authorization: Bearer <OPERATOR_TOKEN>`. Returns 404 when no token is configured. Also served without a token at `/operator/health` on the internal listener. `/api/v1/operator/status` is an alias.',
        responses: {
          '200': ok('Report', obj({ report: { type: 'object' } })),
          ...errors(401, 404, 429),
        },
      },
    },

    '/v1/telemetry/test': {
      post: {
        operationId: 'telemetryConnectionCheck',
        tags: ['Ingestion'],
        security: [{ ingestionKey: [] }],
        summary: 'Verify an ingestion key without storing anything',
        responses: {
          '200': ok(
            'Key is valid',
            obj({
              ok: bool,
              keyId: str,
              project: obj({ id: str, name: str, environment: str }),
              receivedAt: dateTime,
            }),
          ),
          ...errors(401, 429),
        },
      },
    },
    '/v1/telemetry/batch': {
      post: {
        operationId: 'ingestBatch',
        tags: ['Ingestion'],
        security: [{ ingestionKey: [] }],
        summary: 'Ingest a batch of request metrics and logs',
        description:
          'Tenant fields in the body or headers are ignored: the key decides the organization and project. Subject to the organization’s daily quota (`429 QUOTA_EXCEEDED`, `Retry-After` until 00:00 UTC). Full contract: docs/ingestion-api.md.',
        requestBody: { required: true, content: json(ref('TelemetryBatch')) },
        responses: {
          '202': ok('Processed; per-record rejections are listed', ref('IngestResult')),
          ...errors(400, 401, 413, 429, 502, 503),
        },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Application Observability Platform API',
      version: '1.0.0',
      description:
        'Product API (`/api/v1`, session cookie) and telemetry ingestion API (`/v1/telemetry`, project key). Every error uses the `ErrorEnvelope` shape.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: [
      'Health',
      'Auth',
      'Organizations',
      'Projects',
      'Ingestion keys',
      'Metrics',
      'Logs',
      'Alerts',
      'Notifications',
      'Usage',
      'Operator',
      'Ingestion',
    ].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'aop_sid',
          description:
            'HttpOnly session cookie set by register/login (`__Host-aop_sid` in production).',
        },
        ingestionKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Project ingestion key `aop_<keyId>.<secret>`; scope `telemetry:write` only.',
        },
        operatorToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The deployment’s OPERATOR_TOKEN.',
        },
      },
      schemas,
    },
  };
}
