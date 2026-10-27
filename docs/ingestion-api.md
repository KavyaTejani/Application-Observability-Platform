# Telemetry Ingestion API — v1

This is the public contract for anything that sends telemetry: the official
[`@aop/node-sdk`](../packages/node-sdk/README.md), or your own client. The product API
(`/api/v1`) is documented separately.

## Authentication

Every request carries a **project ingestion key**:

```
Authorization: Bearer aop_<16 hex keyId>.<43-char secret>
```

- Owners create keys in the web app (Projects → project → Ingestion API keys). A key is shown
  once.
- A key can **only write telemetry** for its project. It cannot read data or call account APIs.
- The organization, project, and environment are taken **from the key**. Tenant fields in the
  body or headers (`organizationId`, `tenantId`, `X-Scope-OrgID`, …) are ignored.
- Browser session cookies are not accepted on these routes.

Invalid, revoked, expired, or malformed keys all return the same response:
`401 INVALID_API_KEY` with `WWW-Authenticate: Bearer`. A key revoked through another API
instance is rejected within `API_KEY_CACHE_TTL_SECONDS` (default 30 s). The instance that
revoked it rejects it immediately.

## `POST /v1/telemetry/test`: connection check

No body. It confirms the key and reports its project without storing anything.
It is rate-limited to 30 requests per minute per key.

```json
200 { "ok": true, "keyId": "3f9a…", "project": { "id": "…", "name": "Shop", "environment": "production" }, "receivedAt": "…" }
```

## `POST /v1/telemetry/batch`

`Content-Type: application/json`. It is rate-limited to 300 requests per 10 s per key
(`429 RATE_LIMITED` with `Retry-After`). Daily usage quotas are added in milestone M7.

### Request

```json
{
  "schemaVersion": 1,
  "service": { "name": "demo-api", "environment": "production" },
  "metrics": [
    { "kind": "http_request", "timestamp": "2026-10-27T10:00:00.000Z",
      "method": "GET", "route": "/products/:id", "statusCode": 200, "durationMs": 42 }
  ],
  "logs": [
    { "timestamp": "2026-10-27T10:00:00.000Z", "severity": "INFO",
      "message": "Request completed", "requestId": "req_demo",
      "attributes": { "route": "/products/:id", "statusCode": 200 } }
  ]
}
```

| Field | Rules |
|---|---|
| `schemaVersion` | Must be `1` |
| `service.name` | 1–63 chars: letters, digits, `.` `_` `-`. It becomes the `service` label. |
| `service.environment` | Optional. If present, it must equal the project's environment (otherwise `400 ENVIRONMENT_MISMATCH`). The project's environment is always the one stored. |
| batch size | `metrics` + `logs` ≤ **500** records (otherwise `413 BATCH_TOO_LARGE`); body ≤ **1 MiB** (otherwise `413 PAYLOAD_TOO_LARGE`) |
| `timestamp` | ISO 8601. It must lie within the last **24 h** and at most **5 min** in the future. |
| metric `method` | Any HTTP method. Values outside GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS are recorded as `OTHER`. |
| metric `route` | A route **template** starting with `/`, ≤ 200 chars, no query string. Identifier-like segments (`/users/8812`, UUIDs, ObjectIds) are normalized server-side (`/users/:id`). |
| metric `statusCode` | 100–599 |
| metric `durationMs` | 0 – 3 600 000 |
| log `severity` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` |
| log `message` | 1–8192 chars |
| log `requestId` | Optional, `[A-Za-z0-9_-]{1,64}` |
| log `attributes` | Optional flat object: ≤ 32 keys (`[A-Za-z_][A-Za-z0-9_.-]{0,63}`); values are a string (≤ 1024), number, boolean, or null |

**Redaction.** Before storage, attribute values whose names look like secrets (`password`,
`token`, `authorization`, `api_key`, `cookie`, `secret`, `session`) are replaced with
`[REDACTED]`. Ingestion keys, `Bearer`/`Basic` credentials, and `password=…`-style pairs are
also removed from messages and string values.

### Responses

| Status | Code | Meaning | Retry? |
|---|---|---|---|
| `202` | — | Batch processed. Some records may have been rejected individually (see below). | — |
| `400` | `INVALID_BATCH` | Envelope invalid (`details.fields`) | No |
| `400` | `EMPTY_BATCH` | No records | No |
| `400` | `ENVIRONMENT_MISMATCH` | `service.environment` differs from the project's | No |
| `400` | `NO_VALID_RECORDS` | Every record was invalid (`details.rejected`, `details.errors`) | No |
| `401` | `INVALID_API_KEY` | Key missing, malformed, revoked, or expired | No |
| `413` | `BATCH_TOO_LARGE` / `PAYLOAD_TOO_LARGE` | Over 500 records / over 1 MiB | No (split the batch) |
| `429` | `RATE_LIMITED` | Too many requests for this key; see `Retry-After` | Yes |
| `502` | `BACKEND_WRITE_FAILED` | Log storage permanently rejected the batch (`details.retryable: false`) | No |
| `503` | `BACKEND_WRITE_FAILED` | Log storage temporarily unavailable (`Retry-After: 5`, `details.retryable: true`) | Yes |
| `503` | `BACKEND_NOT_CONFIGURED` | This deployment has no storage for that signal (`details.retryable: false`) | No |

Successful response (partial acceptance):

```json
202 {
  "requestId": "req_…",
  "accepted": { "metrics": 1, "logs": 1 },
  "rejected": { "metrics": 2, "logs": 1 },
  "errors": [
    { "signal": "metrics", "index": 1, "code": "INVALID_RECORD", "message": "statusCode: …" },
    { "signal": "metrics", "index": 2, "code": "TIMESTAMP_OUT_OF_RANGE", "message": "…" }
  ]
}
```

`accepted` and `rejected` are exact counts. `errors` lists at most the first 50, and `index` is the
record's position in its array.

### What "accepted" means (durability)

- **Logs** count as accepted only after Loki has acknowledged the write.
- **Metrics** count as accepted once recorded in the gateway's metrics registry. They become
  queryable after Prometheus's next scrape (every **15 s**, which bounds dashboard freshness and
  alert latency). Series time is the gateway's receipt/scrape time, not the record's `timestamp`.
  Metrics accepted in the last few seconds before an API process stops can be lost. This is a
  known limitation of the pull model.
- **All or nothing on backend failure.** If the log write fails, *nothing* from the request is
  recorded, metrics included, so a client can safely retry the whole batch without
  double counting.

## Stored representation

| Signal | Store | Tenant boundary | Labels |
|---|---|---|---|
| Request metrics | Prometheus: `app_http_requests_total`, `app_http_request_duration_seconds` (histogram) | `organization_id`, `project_id` labels set by the gateway. Queried only through server-generated PromQL (M5). | `environment`, `service`, `method`, `route`, `status_class` |
| Logs | Loki | `X-Scope-OrgID` = organization ID, set by the gateway. A `project` label on every stream. | `project`, `service`, `environment`, `severity` (request ID as structured metadata) |

**Latency buckets (seconds):** 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30.
Percentiles (p50/p95/p99) are interpolated within these buckets, so they are approximate.

**Cardinality caps:** at most 100 distinct routes and 20 distinct services per project (configurable
via `MAX_ROUTES_PER_PROJECT` and `MAX_SERVICES_PER_PROJECT`). Further values are recorded as `__other__` and
counted in `aop_ingest_cardinality_overflow_total`.
