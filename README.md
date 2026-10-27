# Application Observability Platform

A developer-facing SaaS for monitoring Node.js applications: collect request metrics and
structured logs with a TypeScript SDK, explore them in dashboards and a log search, and get
alerted (with deduplicated incidents and webhooks) when error rate or latency crosses a threshold.

> **Status:** under active development. Milestone **M1 (Foundations)** is complete. See
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
packages/     Shared packages (SDK, validation, types) — added in later milestones
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

Check the stack: open <http://localhost:5173>. It shows live readiness for every dependency.
You can also run `curl http://localhost:4000/health/ready`.

| Command                                 | Purpose                                   |
| --------------------------------------- | ----------------------------------------- |
| `npm run check`                         | Lint, type-check, and run all tests       |
| `npm test`                              | Run tests                                 |
| `npm run build`                         | Production build of all workspaces        |
| `npm run infra:up` / `infra:down`       | Start / stop the Docker backends          |

Backend ports are bound to `127.0.0.1` only, for development. They are never reachable from
other machines.

## Environment variables

All variables are documented in [`.env.example`](.env.example) and validated at API startup.
The API refuses to start, with a clear message, if a variable is missing or invalid.

## Endpoints available so far

| Endpoint                     | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `GET /health/live`           | Process liveness (no dependency checks)                    |
| `GET /health/ready`          | Dependency readiness; `503` if any dependency is down      |
| `GET :9464/metrics`          | Platform metrics, internal listener only (not public)      |

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
