# Application Observability Platform

A developer-facing SaaS for monitoring Node.js applications: collect request metrics and
structured logs with a TypeScript SDK, explore them in dashboards and a log search, and get
alerted (with deduplicated incidents and webhooks) when error rate or latency crosses a threshold.

> **Status:** under active development. Milestones **M1–M5** (foundations, identity and tenancy, projects and keys, SDK
> and ingestion, metrics and logs exploration) are complete. See
> [`docs/implementation-checklist.md`](docs/implementation-checklist.md) for verified progress.
> Features below are listed only once they work.

## Problem

Developers of Node.js services need to know whether their services are healthy, which endpoints
are slow or failing, what happened around an error, and to be notified before users complain.
Scattered console logs and disconnected charts make it hard to tie behavior to a service and a
time window.

## Target users

- **Independent developers** who own one or more Node.js services.
- **Small-team owners** who manage projects, credentials, usage limits, and alerts.
- **Team members** who investigate dashboards, logs, and incidents.

## Key features (working now)

- **Accounts:** email/password sign-up, sign-in, and sign-out. Server-side sessions use
  `HttpOnly`, `SameSite=Lax`, and `Secure` cookies, with idle and absolute expiry.
- **Organizations and roles:** sign-up creates an organization with you as **owner**. Members
  get the **member** role. Every organization route verifies membership on the server.
- **Security controls:** Argon2id password hashing, CSRF origin checks on state-changing
  requests, rate-limited sign-up and sign-in, and one generic error for any failed sign-in.
- **Projects:** owners create projects (`development`, `staging`, or `production`), rename
  them, and delete them. The plan's project limit is enforced atomically, so concurrent requests
  cannot exceed it.
- **Ingestion API keys:** each key is shown exactly once and stored only as an HMAC-SHA-256 hash.
  Keys can be revoked (effective immediately) or rotated, with an optional grace period of up to
  24 hours. Deleting a project revokes all of its keys.
- **Connection check:** `POST /v1/telemetry/test` with `Authorization: Bearer <key>` confirms a
  key works and reports which project it writes to.
- **Node.js SDK** ([`packages/node-sdk`](packages/node-sdk/README.md)): Express middleware
  that records request rate, latency, and status per route template; a structured logger
  correlated by request ID; and bounded batching with retries, `flush()`, `shutdown()`, and
  `testConnection()`.
- **Telemetry ingestion** (`POST /v1/telemetry/batch`, [contract](docs/ingestion-api.md)): batches
  are key-authenticated, validated, and size-limited. Each record is accepted or rejected with an
  exact count. Metrics go to Prometheus and logs to Loki, both tenant-scoped by the server. Secrets
  are redacted, and route and service cardinality is capped.
- **Metrics dashboard:** request rate, server error rate (5xx), and p50/p95/p99 latency charts
  over 15 minutes, 1 hour, 6 hours, or 24 hours, filterable by service. Summary tiles show request
  totals, 4xx and 5xx rates, latency, and last data received. "No data" (gaps) is kept distinct from
  zero, and every chart has a data-table view.
- **Log explorer:** search by time range, severity, service, request ID, and case-insensitive text.
  Results are newest first, with "load older" pagination, a detail panel, and "show all logs for this
  request". Filters live in the URL, so a search can be shared.
- **Safe query model:** the browser never sends PromQL or LogQL. It sends allow-listed descriptors
  (strict schemas reject unknown fields), and the server generates every query with the caller's
  organization and project.
- **Demo service** ([`apps/demo-node-service`](apps/demo-node-service)): an instrumented store API
  plus a traffic generator for realistic demo data.
- **System status page** showing live readiness of every backend.

## Tech stack

| Layer           | Technology                                                    |
| --------------- | ------------------------------------------------------------- |
| Language        | TypeScript (strict) across all packages, npm workspaces       |
| Web             | React, Vite, Tailwind CSS                                     |
| API / gateway   | Node.js, Express 5, Zod, Pino                                 |
| Product data    | MongoDB (Mongoose)                                            |
| Counters / jobs | Redis                                                         |
| Metrics         | Prometheus (private; queried only through the API)            |
| Logs            | Grafana Loki (multi-tenant; tenant header set by the gateway) |
| Pipeline        | OpenTelemetry Collector                                       |
| Tooling         | Docker Compose, ESLint, Prettier, Vitest                      |

## Repository layout

```text
apps/api      Express control plane, telemetry gateway, health and internal metrics
apps/web      React web application
packages/validation   Zod schemas shared by the API and the web forms
packages/node-sdk     TypeScript SDK for instrumenting Node.js services
apps/demo-node-service  Sample Express service instrumented with the SDK
infra/        Docker Compose and Prometheus / Loki / OTel Collector configuration
docs/         Architecture, checklist, and (later) API docs, threat model, reports
```

## Local setup

**Prerequisites:** Node.js 22.12+ (24 recommended), Docker Desktop (WSL 2 backend on Windows).

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file, then replace both "change-me" secrets with
#    random values: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
cp .env.example .env

# 3. Start the private backends (MongoDB, Redis, Prometheus, Loki, OTel Collector)
npm run infra:up

# 4. In two terminals
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Open <http://localhost:5173> and create an account. System status is at `/status`.

**Demo users (optional):** `npm run seed:demo -w @aop/api` creates a "Demo Organization" with
`owner@demo.local` (owner) and `member@demo.local` (member). Both use the password
`demo-password-2026`, or the value of `DEMO_PASSWORD` if it is set. Run this in development only.

| Command                                 | Purpose                                   |
| --------------------------------------- | ----------------------------------------- |
| `npm run check`                         | Lint, type-check, and run all tests       |
| `npm test`                              | Run tests (integration tests need `infra:up`) |
| `npm run build`                         | Production build of all workspaces        |
| `npm run infra:up` / `infra:down`       | Start / stop the Docker backends          |

Backend ports are bound to `127.0.0.1` only, for development. They are never reachable from
other machines.

### Send real telemetry from the demo service

1. In the web app, create a project (environment `development`) and a key, then copy it.
2. `cp apps/demo-node-service/.env.example apps/demo-node-service/.env` and paste the key into
   `AOP_API_KEY`.
3. Run `npm run start -w @aop/demo-node-service`. It prints the project it connected to.
4. Generate traffic with `npm run traffic -w @aop/demo-node-service` (about 5 req/s for 60 s).
5. Open the project in the web app. The **Dashboard** tab shows the metrics, which appear
   within about 30 s (the scrape interval, plus one scrape for new series), and the **Logs** tab
   shows the logs immediately.

## Environment variables

All variables are documented in [`.env.example`](.env.example) and validated at API startup.
The API refuses to start, with a clear message, if a variable is missing or invalid.

## Endpoints available so far

| Endpoint                     | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `GET /health/live`           | Process liveness (no dependency checks)                    |
| `GET /health/ready`          | Dependency readiness; `503` if any dependency is down      |
| `GET :9464/metrics`          | Platform metrics, internal listener only (not public)      |
| `GET /api/v1/status`         | Readiness report for the browser status page               |
| `POST /api/v1/auth/register` | Create account + organization; signs in                    |
| `POST /api/v1/auth/login`    | Sign in (rate-limited, generic error on failure)           |
| `POST /api/v1/auth/logout`   | Sign out and revoke the session server-side                |
| `GET /api/v1/auth/me`        | Current user and their organizations                       |
| `GET /api/v1/organizations`  | Organizations the caller belongs to                        |
| `GET /api/v1/organizations/:organizationId`         | Organization detail (members only) |
| `GET /api/v1/organizations/:organizationId/members` | Member list (members only)         |
| `GET, POST /api/v1/organizations/:organizationId/projects` | List (members) / create (owners) projects |
| `GET, PATCH, DELETE /api/v1/projects/:projectId` | Read (members) / rename, delete (owners) |
| `GET, POST /api/v1/projects/:projectId/keys` | List key metadata (members) / create a key (owners) |
| `POST /api/v1/projects/:projectId/keys/:keyId/revoke` | Revoke a key (owners)          |
| `POST /api/v1/projects/:projectId/keys/:keyId/rotate` | Rotate a key, optional `gracePeriodHours` (owners) |
| `GET /api/v1/projects/:projectId/metrics/summary?range=1h` | Window summary: requests, 4xx/5xx rates, p50/p95/p99, last data (members) |
| `POST /api/v1/projects/:projectId/metrics/query` | Time series for `{ metricKey, range, interval?, filters?, groupBy? }` (members) |
| `GET /api/v1/projects/:projectId/logs` | Log search: `from, to, severity, service, requestId, contains, limit, cursor` (members) |
| `GET /api/v1/projects/:projectId/services` | Service names seen in metrics or logs (filter options) |
| `POST /v1/telemetry/test`    | Verify an ingestion key (`Authorization: Bearer <key>`)   |

All `/api/v1` errors use one envelope: `{ "error": { "code", "message", "requestId", "details" } }`.
State-changing requests must come from the app's own origin (CSRF protection).

## Security notes

See [`docs/threat-model.md`](docs/threat-model.md) for trust boundaries, controls, and known
limitations.

## Deployment

The production [`Dockerfile`](Dockerfile) builds one image. Express serves both the API and the
built React app from a single origin, so the session cookie stays first-party.

**Hosted deployment (Render free tier):**

| Component        | Where                       |
| ---------------- | --------------------------- |
| Web app + API    | Render Web Service (Docker) |
| MongoDB          | MongoDB Atlas (M0)          |
| Redis            | Render Key Value            |
| Prometheus, Loki | Not hosted (see below)      |

**Known limitation:** Prometheus and Loki need persistent disks and private services, which
are not available on the free hosting tier. The hosted app therefore reports readiness as
`degraded`, and metrics and log features run only in the full local Docker Compose stack
described above. This split is intentional and stated here so that evaluators are not misled.

Build and run the production image locally:

```bash
docker build -t aop-app .
docker run --env-file .env -e NODE_ENV=production -p 4000:4000 aop-app
```
