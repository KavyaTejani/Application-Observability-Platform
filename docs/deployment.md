# Deployment

Three ways to run the platform, from most to least complete.

## 1. Full stack on one host (Docker Compose)

Every feature works, including metrics, logs, and alerts. Only the app port is published.

```bash
cp .env.example .env.prod
# Edit .env.prod: real random values for SESSION_SECRET, TELEMETRY_KEY_PEPPER, OPERATOR_TOKEN,
# and APP_BASE_URL / WEB_ORIGIN set to the public HTTPS URL.
docker compose -f infra/compose.prod.yaml --env-file .env.prod up -d --build
```

- The API listens on `APP_PORT` (default 8080). Put a TLS-terminating reverse proxy (Caddy,
  nginx, or a platform load balancer) in front of it, and keep `TRUST_PROXY=true`.
- MongoDB, Redis, Prometheus, Loki, and the Collector publish **no** ports. They sit on an
  internal Docker network without outside connectivity. The API's metrics port (9464) is
  reachable only by Prometheus on that network.
- Data lives in named volumes (`mongo-data`, `redis-data`, `prometheus-data`, `loki-data`) and
  survives `docker compose restart` and image upgrades. `down -v` deletes it.
- After deploying, run `npm run check:exposure -- https://your-host` from another machine.
- **Linux kernel 6.19 or newer:** MongoDB 8.0 refuses to start there (a known MongoDB bug,
  SERVER-121912). Add `MONGO_IMAGE=mongo:7.0` to `.env.prod`. The platform is tested on both
  versions, and CI runs on 7.0 for this reason.

## 2. Hosted demo (Render free tier) — current public deployment

<https://aop-app-fbtl.onrender.com>

| Component | Service |
|---|---|
| Web app + API | Render Web Service, built from the root `Dockerfile` |
| MongoDB | MongoDB Atlas M0 |
| Redis | Render Key Value (internal URL) |
| Prometheus, Loki | **Not hosted.** The free tier has no persistent disks or private services for them. |

Environment variables on Render: `NODE_ENV=production`, `PORT=10000`, `TRUST_PROXY=true`,
`MONGODB_URI`, `REDIS_URL`, `SESSION_SECRET`, `TELEMETRY_KEY_PEPPER`, `APP_BASE_URL` and
`WEB_ORIGIN` (both the Render URL), and optionally `OPERATOR_TOKEN` to enable `/operator`.
Health check path: `/health/live`.

**What works there:** accounts, organizations, roles, projects, keys, quotas and the Usage page,
alert rules and destinations (with SSRF protection fully on), the status page, and the operator
view. **What does not:** metrics charts, log search, and alert evaluation report "not configured" or
"error", because their backends are absent. Readiness says `degraded` rather than pretending
otherwise. Use deployment 1 or local development for those features.

Other free-tier effects: the service sleeps after inactivity, and the first request can take up
to a minute.

**Verified (2026-10-28):** `npm run check:exposure -- https://aop-app-fbtl.onrender.com`
reported no reachable backend port (27017, 6379, 9090, 3100, 4317, 4318, 9464) and `404` for
every internal path.

## 3. Local development

See the README: `npm run infra:up`, `npm run dev:api`, `npm run dev:web`. Backend ports are
published on `127.0.0.1` only.

## Checks after any deployment

| Check | Command / URL |
|---|---|
| Liveness | `GET /health/live` |
| Dependencies | `GET /health/ready` (or the `/status` page) |
| No exposed backends | `npm run check:exposure -- <url>` |
| No secrets committed or bundled | `npm run scan:secrets` |
| Main workflow end to end | `E2E_BASE_URL=<url> npm run test:e2e` (needs Prometheus and Loki, so deployment 1 or local) |
| Operator view | `<url>/operator` with `OPERATOR_TOKEN` |

## Persistence across a controlled restart (AC-08)

Product state is in MongoDB and survives API and container restarts. With the local stack:

```bash
npm run infra:down && npm run infra:up   # volumes are kept
```

Sign in again: organizations, projects, keys, rules, and incidents are all still there. The E2E
test also signs in with a fresh session at the end and checks the project, the incident history,
and the usage record.
