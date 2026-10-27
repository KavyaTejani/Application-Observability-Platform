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

## M3 — Projects and keys

- [ ] Project CRUD; key create/list/revoke/rotate with one-time reveal and HMAC-SHA-256 storage
- [ ] Key-auth middleware for ingestion

## M4 — SDK and ingestion

- [ ] `packages/node-sdk` (Express middleware, logger, batching, retries, flush/shutdown)
- [ ] Demo service; versioned ingestion API with limits/validation; metrics → Prometheus,
      logs → Loki; accurate accepted/rejected counts

## M5 — Metrics and logs exploration

- [ ] Structured, allow-listed query builder; metrics summary and charts; log search

## M6 — Alerts and incidents

- [ ] Rule CRUD, evaluator, incident lifecycle with dedupe, webhook worker with SSRF protection

## M7 — Quotas and self-monitoring

- [ ] Atomic quota enforcement with `429`; usage screen; operator health view

## M8 — Hardening and delivery

- [ ] Tenant-isolation suite, E2E test, load test and report, retention check, docs, deployment
