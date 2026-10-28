# Implementation Checklist (Phase 0)

Mapped to the Phase 0 milestones (M1–M8) of the project requirements document. An item is ticked only after it has been
verified against the running system and tests. Each milestone ends with `npm run check`
(lint + type-check + tests), whose real output is recorded below.

## M1 — Foundations ✅

- [x] npm-workspaces TypeScript monorepo (`apps/*`, `packages/*`), strict `tsconfig.base.json`
- [x] ESLint (typescript-eslint strict), Prettier, Vitest projects
- [x] Validated config module (`apps/api/src/config`) — fails fast, never echoes secret values,
      rejects `.env.example` placeholder secrets in production
- [x] `.env.example`; real `.env` is git-ignored
- [x] Docker Compose (`infra/compose.yaml`): MongoDB, Redis, Prometheus, Loki (multi-tenant,
      7-day retention via compactor), OpenTelemetry Collector on a private `backend` network;
      dev ports bound to `127.0.0.1` only; named volumes
- [x] `GET /health/live` (no dependency checks) and `GET /health/ready` (MongoDB, Redis,
      Prometheus, Loki with timeouts; `503` and no internal details when one is down)
- [x] Platform metrics on a separate internal listener (`:9464/metrics`), not on the public
      port; route-template labels; Prometheus scrapes it
- [x] Request IDs, documented error envelope, log redaction
- [x] React + Vite + Tailwind web shell showing live API readiness via the dev proxy

**Verification (2026-10-27):** `npm run lint` clean; `npm run typecheck` clean; `npm test`
15/15 passed; `npm run build` succeeded. Manually verified against the live Compose stack:
readiness `200` with all four dependencies up, `503` with Loki stopped, recovery after restart;
Prometheus target `aop-api` healthy; public `/metrics` returns `404`.

### M1 follow-ups (deployment)

- [x] Production `Dockerfile`: one image, Express serves API + built UI from one origin
- [x] Telemetry backends optional; readiness reports `degraded` / `not_configured` honestly
- [x] Browser status uses `/api/v1/status` (content blockers block `/health/*`)
- [x] Deployed on Render (free) + MongoDB Atlas + Render Key Value

## M2 — Identity and tenancy ✅

- [x] Register / login / logout (AUTH-001, -003). Argon2id password hashing (AUTH-002).
- [x] Server-side sessions: HMAC-hashed IDs, idle (sliding) + absolute TTL, TTL index,
      revocation on logout, fresh ID on login (AUTH-003, -007)
- [x] CSRF origin check on every state-changing `/api/v1` request (AUTH-004)
- [x] Redis rate limits on sign-up and login. Generic invalid-credentials error with
      timing equalization (AUTH-005).
- [x] Consistent `401 UNAUTHENTICATED` (AUTH-006)
- [x] Organization created on sign-up with owner membership; default Developer plan seeded
      (ORG-001, QUOTA-002 data model)
- [x] Owner/member RBAC in one policy module with a matrix test (ORG-002, ORG-003)
- [x] `TenantScope` helper; non-members get `404`. Metadata isolation tests (§14.2 item 1, M2 surface).
- [x] Shared `@aop/validation` package (Zod) used by API and web forms
- [x] Web: sign-in, sign-up, session guard, organization overview with members, sign-out
- [x] Demo seed (`npm run seed:demo -w @aop/api`) for owner/member demonstration
- [x] `docs/threat-model.md` started

**Verification (2026-10-27):** lint clean; type-check clean; `npm test` 86/86 passed. The 10
test files include integration tests against real MongoDB and Redis (Docker). End-to-end via the
Vite proxy: register → me → members → CSRF rejection → logout → session revoked → generic login
error. Production image verified: `__Host-aop_sid; HttpOnly; Secure; SameSite=Lax`.

**Deferred (by design):** invitations, email verification, password reset (P1). Membership
for the member role comes from the seed script for now.

## M3 — Projects and keys ✅

- [x] Project create / list / get / rename / soft-delete; environment fixed at creation
      (ORG-004, ORG-005)
- [x] Plan `maxProjects` enforced with an atomic conditional `$inc` (8 concurrent creates →
      exactly 3 succeed). Organizations that predate the counter are handled.
- [x] Key generation with CSPRNG; full key shown once (`Cache-Control: no-store`) (KEY-001)
- [x] Only HMAC-SHA-256(pepper, secret) + public `keyId`/prefix stored; constant-time compare
      (KEY-002)
- [x] Revoke (idempotent) and rotate with optional grace ≤ 24 h. Same-process cache
      invalidation, plus a documented 30 s TTL across instances, covered by a two-instance test
      (KEY-003)
- [x] Keys scoped to one project, `telemetry:write` only; they cannot call account APIs; browser
      sessions cannot use ingestion routes (KEY-004, ING-002)
- [x] Key-auth middleware + `POST /v1/telemetry/test` (§12.4, SDK-007 server side)
- [x] Project deletion revokes all its keys immediately (§16)
- [x] Isolation tests: cross-tenant project read/rename/delete, key list/create/revoke/rotate,
      foreign keyId under own project, forged `X-Scope-OrgID`/body tenant fields (§14.2 items 1, 4)
- [x] Web: projects list/create, project page with keys (one-time reveal + copy, revoke, rotate
      with grace), rename, delete, SDK setup snippet

**Verification (2026-10-27):** lint, type-check, and build clean; `npm test` 120/120 passed
(15 files). Live dev-server run: create project → create key → `/v1/telemetry/test` 200 →
revoke → 401 → member create-key 403 → delete 204. The key never appears in the server logs.

## M4 — SDK and ingestion ✅

- [x] `packages/node-sdk`, no runtime deps (SDK-001, SDK-002)
  - [x] Express middleware: count, duration, status, route template, request ID; request ID never
        a label (SDK-003)
  - [x] Structured logger correlated via AsyncLocalStorage; bounded attributes (SDK-004)
  - [x] Time/size flush; bounded buffer (drop + count); bounded retries, exponential backoff + full
        jitter, `Retry-After`; permanent failures not retried (SDK-005)
  - [x] `flush()` and `shutdown(timeout)`; demo calls shutdown on SIGINT/SIGTERM (SDK-006)
  - [x] `testConnection()`; key in a private field, never in errors, debug output, or inspect (SDK-007)
- [x] `apps/demo-node-service` (store API with configurable error rate and latency) + traffic generator
- [x] `POST /v1/telemetry/batch`, schema v1, documented in `docs/ingestion-api.md` (ING-001)
- [x] Key-only auth; tenant from the key; body/header tenant fields ignored (ING-002, ING-003)
- [x] Validation of envelope and per record; 500 records / 1 MiB → `413`; timestamp window
      24 h / +5 min (ING-004, ING-005, ING-012)
- [x] Per-key request rate limit (ING-006, partial: daily quota is M7)
- [x] Exact accepted/rejected counts, stable codes, request IDs (ING-007)
- [x] No secrets logged; redaction of keys, bearer tokens, and secret attributes before storage
      (ING-008, §9.1)
- [x] Backend failure → `503` + `Retry-After`, nothing recorded (no false ack); not configured
      → `503 BACKEND_NOT_CONFIGURED` (ING-009)
- [x] Metrics in a gateway registry on the internal `/telemetry-metrics`, scraped every 15 s;
      fixed buckets documented (ING-012, MET-001 buckets)
- [x] Environment authoritative, `ENVIRONMENT_MISMATCH` (ING-013)
- [x] Route cap 100 / service cap 20 per project → `__other__` + overflow counter; ID segments
      normalized (ING-014)
- [x] Loki multi-tenant: tenant = org, `project` label on every stream, low-cardinality labels,
      request ID as structured metadata (LOG-001, LOG-002, LOG-003, LOG-009)
- [x] Platform metrics: ingest records/requests/duration, backend calls/latency, overflow (SELF-002)

**Verification (2026-10-27):** lint, type-check, and build clean; `npm test` 182/182 passed
(22 files). Highlights:

- A real-Loki test proves another tenant sees 0 streams.
- An SDK → API end-to-end test runs over a real HTTP port.
- Live stack run: the demo store sent 183 requests (165 × 2xx, 18 × 4xx). Prometheus showed exactly
  165 and 18. Loki held 232 lines (183 access logs + 49 app logs), with no loss. p95 per route was
  computed from the histogram. Querying Loki as a different tenant returned 0 streams.

**Known limitation:** metrics accepted in the seconds before an API process stops, and not yet
scraped, are lost (pull model). This is documented in `docs/ingestion-api.md`.

## M5 — Metrics and logs exploration ✅

- [x] Strict, allow-listed query descriptors in `@aop/validation`. Raw `promql`/`expr`/`query`
      fields and tenant overrides are rejected with 400 (MET-003, §14.2 item 7).
- [x] Dedicated PromQL generator (`modules/query/promql.ts`). Tenant matchers come first, always
      from the ProjectScope; values are escaped; there is a fixed template per metric key
      (MET-004, §9.5).
- [x] Ranges 15m/1h/6h/24h; steps bounded to ≤ 1000 points; rate window ≥ 4 scrapes (MET-002,
      MET-003)
- [x] Group-by/filter limited to service, route, method, status_class (MET-005)
- [x] Error rate = 5xx share; 4xx reported separately; zero traffic = no data, zero errors = 0
      (`or (total*0)` trick); NaN → null gaps on charts (MET-001, MET-006)
- [x] Metrics summary + time-series API; dashboard with range selector, service filter, refresh,
      auto-refresh, stat tiles, charts with legend, tooltip, data table, and an empty state (§13.2 #4)
- [x] LogQL generator: mandatory `project` matcher; tenant = `X-Scope-OrgID` from scope;
      structured-metadata request-ID filter; literal case-insensitive text search (LOG-004,
      LOG-009)
- [x] Log search bounded: span ≤ 24 h, lookback ≤ 7 d, limit ≤ 200. Cursor pagination with no
      loss or duplicates on equal timestamps (LOG-005, LOG-006).
- [x] Log explorer UI: filters in the URL, detail panel, "show all logs for this request",
      load older, time-zone label (§13.2 #5)
- [x] Telemetry freshness: `lastTelemetryAt` per project (throttled `$max` write)
- [x] **Bug found and fixed in live testing:** new series were exported with their first
      increments already applied, so `increase()`/`rate()` never counted them (for example the
      first 5xx of a route). New series are now exported at 0 first, and their increments are
      applied after the next scrape. Verified live: raw samples went `0 → 7`.
- [x] Isolation: cross-tenant metrics/logs return 404 before any backend call. With real Loki, a
      forged `X-Scope-OrgID` from the browser is ignored (§14.2 items 2, 3).

**Verification (2026-10-27):** lint, type-check, and build clean; `npm test` 213/213 passed.
Live stack: summary, time series, p95, severity and request-ID log filters, and pagination all
behaved correctly on demo-store data. A raw-PromQL request was rejected with 400.

**Known approximations (documented in the UI):** latency percentiles come from histogram buckets;
the request total uses `increase()`, which extrapolates (shown as "≈").

## M6 — Alerts and incidents ✅

- [x] Rule CRUD: create, enable/disable, edit, delete; `error_rate`/`p95_latency`; `gt`/`gte`
      only; threshold, window, and interval bounds; window ≥ 2 scrapes and ≥ interval
      (ALERT-001 to ALERT-003)
- [x] RBAC: members create rules with existing destinations and edit only their own; owners
      manage all rules and destinations (ORG-003)
- [x] Evaluator: lease-based claiming (safe across instances); query scope from the rule record
      only; window = rate window (ALERT-004)
- [x] Pure state machine: normal → pending → firing → normal; no data = non-breaching; query
      error → `error`, incidents untouched; resolve after M consecutive OKs (ALERT-005,
      ALERT-011)
- [x] One open incident per rule: partial unique index `{alertRuleId, fingerprint}` where
      `status: firing`; tested with two racing evaluators (ALERT-006)
- [x] Outbox jobs deduplicated per (incident, destination, event); firing and resolved events;
      retries 30 s / 2 min / 10 min / 30 min; permanent failures not retried; every attempt
      recorded (ALERT-007, ALERT-008)
- [x] SSRF: scheme allow-list; no credentials; every DNS answer checked against private,
      loopback, link-local/metadata, CGNAT, multicast, ULA, mapped and NAT64 ranges; IP pinning
      (rebinding-proof); no redirects; timeouts; payload and response caps; checked on save and
      on send; dev-only override refused in production
- [x] HMAC-signed payloads (`t=…,v1=…`); per-destination secret shown once, stored with
      AES-256-GCM; URL preview hides path tokens
- [x] UI: Alerts tab (rules with icon+text state, incidents), incident detail with delivery
      attempts, Notifications page (destinations, one-time secret, test send)
- [x] Demo webhook receiver that verifies signatures; platform metrics for evaluations and
      notification attempts
- [x] Isolation: A cannot list, create, edit, or delete B's rules; cannot read B's incidents or
      deliveries; cannot list, edit, delete, or test B's destinations (§14.2 item 1)

**Verification (2026-10-28):** lint, type-check, and build clean; `npm test` 305/305 passed.
Real-HTTP tests: the signature verified receiver-side, a 302 was not followed, and DNS rebinding
to 127.0.0.1 was blocked before connecting. **Live stack:** demo store at a 90% checkout failure
rate → rule pending (15.9%) → firing (14.4%) → 6 breaching evaluations → 1 incident → traffic
stopped → resolved after 2 no-data checks. The receiver got exactly 2 webhooks (firing, resolved),
both with valid signatures.

**Deferred (documented):** manual incident resolution (no defined semantics in the PRD);
email/SMTP notifications (P1).

## M7 — Quotas and self-monitoring ✅

- [x] Daily per-organization quota on records and estimated bytes, in UTC days; per-project
      accepted/rejected counters in `usageDaily` (QUOTA-001, §11.8)
- [x] Plan limits read from the organization's plan (cached `PLAN_CACHE_TTL_SECONDS`); projects
      and alert rules already enforced against the same plan (QUOTA-002)
- [x] Atomic reservation with a conditional `$inc` before forwarding; released when the forward
      fails; fails closed (`503 QUOTA_UNAVAILABLE`) if MongoDB is unreachable (QUOTA-003)
- [x] `429 QUOTA_EXCEEDED` with `Retry-After` (seconds to 00:00 UTC), `resetsAt`, used/allowed;
      SDK drops instead of retrying (QUOTA-004)
- [x] Usage page: meters with near-limit/limit-reached text, reset time, quota-exceeded
      explanation, per-project table, plan limits, retention (read-only), last 7 days
      (QUOTA-005)
- [x] Platform metrics: `aop_quota_rejections_total{limit}`, `aop_ingest_bytes_total{signal}`, plus
      the existing request, ingestion, backend, alert, and notification counters (SELF-002, §15)
- [x] Operator health: `GET /api/v1/operator/health` (bearer `OPERATOR_TOKEN`; 404 when unset),
      `/operator/health` on the internal listener, and a `/operator` web view: dependencies,
      alert worker, pipeline counters, platform state (SELF-004, AC-10)
- [x] `npm run plan:set -w @aop/api` moves an organization to a plan with custom limits (demos,
      quota tests, the raised-quota load-test profile)

**Verification (2026-10-28):** lint, type-check, and build clean; `npm test` 321/321 passed.
Tests cover the limit boundary (an exact fit is accepted), the byte limit, 20 concurrent batches
against a limit of 10 batches (exactly 10 accepted), release on Loki failure, UTC rollover, the
usage API's RBAC, and operator token handling. **Live stack:** demo org on a 300-record plan;
traffic for 35 s → 268 records accepted, 446 refused with `QUOTA_EXCEEDED`, and the SDK
dropped them without retry storms. Operator report showed the quota rejections and the same
usage total.

## M8 — Hardening and delivery ✅

- [x] Tenant-isolation suite: all seven PRD §14.2 items in one file against real MongoDB and
      Loki (`apps/api/src/test/isolation/tenant-isolation-suite.integration.test.ts`)
- [x] Exposure: `infra/compose.prod.yaml` publishes only the app port (backends on an
      `internal: true` network), checked from `docker compose config` by a test;
      `npm run check:exposure` probes a live deployment (Render: no backend port reachable, every
      internal path 404)
- [x] End-to-end flow (`npm run test:e2e`): register → project → key → real sample app → metrics
      → logs → alert fires → one incident → signed webhook → still one incident while breaching
      → resolves → resolved webhook → fresh session sees the state → wrong password, foreign org,
      anonymous, and revoked key refused
- [x] Load test (`npm run loadtest -w @aop/api`): open-loop, seeded dataset, raised-quota
      benchmark plan, stored-data verification; report in `docs/load-test-report.md`
- [x] Retention (`npm run check:retention`): Loki short profile deletes expired logs and keeps
      fresh ones; Prometheus block retention documented (AC-11)
- [x] OpenAPI 3.1 (`docs/openapi.json`), request schemas generated from the Zod validators; a
      test fails if the committed file is stale
- [x] Secret scan (`npm run scan:secrets`) and GitHub Actions CI (lint, format, types, tests
      against real backends, build, scan, image)
- [x] Docs: `architecture.md`, `deployment.md`, `demo-script.md`, `future-roadmap.md`,
      `load-test-report.md`; README with solution, architecture, testing, limitations,
      troubleshooting; threat model updated
- [x] Persistence across a controlled restart (AC-08): MongoDB container restarted, all
      organizations, projects, keys, and incidents still present

**Verification (2026-10-28):** lint, format, type-check, build, secret scan, and image build
clean; `npm test` 336/336 passed. **E2E:** passed in 157 s (15 steps). **Load (full profile,
mixed):** 999 records/s for 300 s (p95 68 ms) and 4,992 records/s for 30 s (p95 52 ms), 0
rejected; 496,800 acknowledged = 496,800 stored; log ingest → searchable p95 318 ms; dashboard
query p95 21 ms. **Retention:** expired Loki logs deleted after 90 s in the short profile.

**Deferred (documented in the roadmap):** browser-level E2E (Playwright), multi-instance and
saturation load tests, demo video (recorded by the author).
