# Application Observability Platform — Learning Guide From Scratch

**Purpose:** Teach the project owner how the observability platform works, why each component exists, how data moves through the system, what the key engineering decisions mean, and how to explain and debug the project.

**Companion document:** `prd.md` is the implementation contract for Claude/Codex. This guide is the learning document. The PRD defines what must be built; this guide explains the concepts and the reasoning behind it.

**Important:** This is an architecture and learning guide written before inspecting the final generated source code. The actual implementation may use different module names or make documented adjustments. When implementation is complete, compare this guide with the repository and update examples to match the code. Do not learn a fictitious behavior that the code does not implement.

---

## 1. What Are We Building?

Imagine you build a Node.js API used by hundreds or thousands of people. One afternoon, users say that the application is slow and occasionally returns errors. Looking only at the frontend will not tell you exactly why.

You need to answer questions such as:

- How many requests are reaching the API?
- Which endpoints are slow?
- What percentage of requests fail?
- What happened at the time an error occurred?
- Is the database slow, or is the application code slow?
- Did a deployment cause the increase in latency?
- Can the system notify a developer before the issue becomes severe?

An **observability platform** collects evidence from applications and lets a developer explore it to understand application behavior.

Your platform is a developer-facing SaaS. Developers create an account, make an organization and project, install your Node.js SDK, send telemetry to your service, explore metrics and logs, create alerts, and track incidents.

This is more than a CRUD app. The core engineering problems are:

1. Collecting events reliably.
2. Validating and routing telemetry.
3. Storing different data types in suitable backends.
4. Querying telemetry efficiently.
5. Keeping each organization's data isolated.
6. Evaluating alert rules and handling state transitions correctly.
7. Measuring the performance and health of the platform itself.

## 2. Observability: Metrics, Logs, and Traces

These are related signals, but they answer different questions.

### 2.1 Metrics — What is changing?

A metric is a numerical measurement aggregated over time or observed as a value. Examples:

- Number of HTTP requests per second.
- Request error percentage.
- Request duration.
- CPU or memory utilization.
- Queue depth.
- Count of telemetry records accepted or rejected.

Metrics are well suited to dashboards and alert conditions because they summarize behavior. For example, an error-rate graph may show that errors climbed from 0.2% to 8% at 14:05.

Common metric types include:

- **Counter:** Value increases over time; for example, total requests. A process restart can reset a process-local counter, and query tools account for resets when calculating rates.
- **Gauge:** A value that can rise or fall; for example, current queue depth.
- **Histogram:** A distribution summarized using buckets and counts; useful for latency percentiles such as p95.

A p95 latency of 800 ms means that 95% of the observed requests completed in 800 ms or less over the selected calculation window. It does not mean every request takes 800 ms.

### 2.2 Logs — What happened?

A log is a record of an event. A structured log commonly contains:

```json
{
  "timestamp": "2026-10-27T10:00:00.000Z",
  "severity": "ERROR",
  "message": "Database request timed out",
  "service": "shop-api",
  "requestId": "req_123",
  "attributes": {
    "route": "/products/:id",
    "statusCode": 500
  }
}
```

Structured logs are easier to search and filter than unstructured strings. The timestamp, severity, service, and request ID can be indexed or parsed into fields.

Never put passwords, bearer tokens, API keys, cookies, or unnecessary personal data in logs. Observability data often contains production details, so telemetry collection itself must be secured.

### 2.3 Traces — Where did time go?

A distributed trace follows one request through multiple operations. Each operation is called a **span**. A trace might look like:

```text
GET /orders/123              950 ms
├── Validate session            5 ms
├── Query MongoDB             180 ms
├── Call payment service      720 ms
└── Serialize response         20 ms
```

This makes it easier to determine where time was spent. Your first release deliberately postpones tracing, then adds a trace backend and a waterfall viewer in a later phase.

### 2.4 How signals work together

A dashboard tells you that an endpoint is slow. A log reveals an error around the same time. A trace eventually shows the slow database query or external service call. The useful experience comes from correlating signals, not merely drawing separate charts.

## 3. Why Not Store Everything in MongoDB?

MongoDB is a good fit for product data such as:

- User accounts and memberships.
- Organizations and projects.
- API-key metadata and hashes.
- Dashboard definitions.
- Alert rules and incidents.
- Quota plans and usage summaries.

Metrics are time-series data, and logs can be high-volume chronological records. Specialized systems are designed around their query patterns:

- **Prometheus:** Time-series metrics and PromQL queries.
- **Loki:** Log ingestion and LogQL queries.
- **OpenTelemetry Collector:** Receives, processes, and exports telemetry.
- **Tempo:** Trace storage/querying when tracing is added.

This separation is called **polyglot persistence**: use different storage technologies because the data has different access patterns. It also makes the product more complex to operate, so the project uses only the components that have a clear purpose.

## 4. The Main Architecture

Think of the application as four layers.

### 4.1 Product/control plane

The control plane handles user accounts and configuration:

- React web interface.
- Express API.
- Authentication and organization membership.
- Project management and API-key lifecycle.
- Dashboards and alert-rule definitions.
- Usage quotas and settings.

MongoDB stores this information. The control plane also provides the only customer-facing query endpoints.

### 4.2 Telemetry data plane

The data plane receives the application's metrics and logs. It authenticates the project key, validates the payload, decides which organization/project owns it, applies quotas, and forwards it to the correct backend.

The critical idea is that the customer doesn't get to choose the organization ID used for storage. The server looks up the project key and derives the organization/project scope from trusted database records.

### 4.3 Telemetry backends

Prometheus stores metrics. Loki stores logs. The OpenTelemetry Collector is used for internal instrumentation and provides the intended integration point for standard OTLP support later. Tempo is added when traces are in scope.

These systems are private services. A browser should not connect directly to Prometheus or Loki. The browser calls the Express API; the API authorizes the user and calls the telemetry backend using a constrained query.

### 4.4 Background processing

Alert evaluation and webhook delivery should not make telemetry ingestion wait for a slow destination. A worker evaluates rules and delivers notifications separately. Redis can support rate-limit counters and background coordination, while MongoDB remains the durable source for incidents and rules.

## 5. End-to-End Data Flow

### 5.1 From a Node.js request to a metric

1. A request arrives at the sample Node.js application.
2. SDK middleware captures a route template, method, status, duration, and request ID.
3. The SDK puts the event into a bounded batch.
4. SDK sends the batch to the platform with a project ingestion key.
5. The gateway authenticates the key and looks up the project and organization.
6. The gateway validates the event and applies quota checks.
7. The gateway adds trusted organization/project context and updates/forwards the metric into the Prometheus collection path.
8. Prometheus scrapes the internal metric endpoint and persists time-series samples.
9. The user opens a dashboard.
10. The frontend sends a structured query request to the Express API.
11. The API derives the tenant scope from the logged-in user and project, validates the query descriptor, and generates a safe PromQL expression.
12. Prometheus returns time-series results; the API transforms them into a stable JSON format; React draws the chart.

This flow is why an ingestion key and a browser session are different. The session lets a user view data; the key lets a program send telemetry for one project.

### 5.2 From a Node.js log to the log explorer

1. The application writes a structured log through the SDK logger.
2. SDK batches and sends the log to the telemetry gateway.
3. Gateway validates the record, strips forbidden attributes, derives organization/project from the key, and checks usage limits.
4. Gateway converts the event to the backend log format and sends it to Loki.
5. The trusted server sets the Loki tenant header, not the customer.
6. A user searches logs in React.
7. Express authorizes the organization/project and issues a tenant-scoped Loki query.
8. The UI renders results with timestamps, severity, message, and attributes.

### 5.3 Alert flow

1. User saves a rule, such as “error rate greater than 5% for five minutes.”
2. A worker evaluates the rule periodically.
3. If the condition is sustained, rule state becomes firing.
4. The system creates one open incident for the continuous event.
5. The worker posts a notification to the configured webhook.
6. Delivery result and any error are saved.
7. After the metric returns to normal for the recovery window, the incident resolves.

A rule should not create a new incident on every evaluation. That behavior would spam the user and make incident history nearly useless.

## 6. Authentication, API Keys, and Authorization

These terms solve different problems.

### 6.1 Authentication

Authentication answers: “Who is making this request?”

The MVP uses email/password. The server hashes passwords with an established password-hashing algorithm, checks the hash during login, and creates a server-side session. The browser receives an opaque session cookie. The database stores session state so a logout can invalidate it.

Cookie security attributes matter:

- `HttpOnly`: JavaScript in the page cannot read the cookie.
- `Secure`: the browser sends it only over HTTPS in production.
- `SameSite=Lax`: reduces some cross-site request risks.

Cookie-based authentication also requires CSRF/origin protection for state-changing requests.

### 6.2 Authorization and RBAC

Authorization answers: “What is this authenticated identity allowed to do?”

The product has an organization and memberships. A user's role is associated with an organization; a project belongs to one organization. The API checks membership and permission on each relevant request.

A React route guard is only a user-experience feature. It does not protect data; backend authorization is mandatory.

### 6.3 API keys

A project API key is for an application/SDK, not for a human in the dashboard. The key should be a random secret, shown once to the user. The database stores its hash and a safe prefix for display. Revocation changes its status so it can no longer ingest data.

Never put the raw API key in a public repository, a client-side React bundle, screenshots, or logs.

## 7. Multi-Tenant Isolation

A **tenant** is an organization that shares the platform but must not access another organization's data.

### 7.1 The trust boundary

Imagine Organization A submits this body:

```json
{
  "organizationId": "organization-B",
  "message": "hello"
}
```

The server must ignore/reject the supplied organization ID. It derives the real organization from the verified project key. Otherwise, a user could attempt to write telemetry into another tenant's namespace.

The same principle applies to queries: the frontend must not be able to ask the server to use an arbitrary tenant ID.

### 7.2 Metadata tenancy

MongoDB documents owned by a tenant include `organizationId`; project data also includes `projectId`. Every read and update includes an ownership filter after the user has been authorized. Do not fetch a document by its ID and assume that guessing or hiding the ID is security.

### 7.3 Loki tenancy

Loki supports tenant separation through the `X-Scope-OrgID` request header when multi-tenant mode is enabled. The request must use the tenant ID derived by a trusted gateway. The browser does not get direct access to Loki and does not choose the tenant header.

### 7.4 Prometheus in the MVP

The selected MVP uses Prometheus as a private backend. Its query endpoint is not treated as a customer security boundary. The API generates queries using a constrained query definition and adds the tenant/project filter itself. The backend port is not exposed externally. Raw PromQL is deferred until a proper tenant-aware query solution is designed.

Example of a structured query:

```json
{
  "metricKey": "error_rate",
  "range": "1h",
  "groupBy": ["serviceName"]
}
```

The customer sends the metric key, not this expression:

```promql
sum(rate(http_requests_total[5m]))
```

The server knows the approved metric name and generates the expression with the required tenant/project constraint. That is a key security design decision.

### 7.5 Prove isolation with tests

Create two organizations, two projects, and two API keys. Send different uniquely identifiable logs and metrics to each. Then attempt all of the following:

- Fetch the other organization's projects.
- Query the other project's metrics by changing a URL ID.
- Insert another organization's ID in the telemetry payload.
- Send a forged `X-Scope-OrgID` header.
- Use a revoked key.
- Try to call a backend's public port directly.

All unauthorized paths must fail or stay scoped to the caller's own tenant.

## 8. Quotas and Rate Limits

They are related but distinct.

- **Rate limit:** How fast can a client send requests? Example: 20 telemetry requests per second per key.
- **Usage quota:** How much can the organization ingest over a period? Example: 250,000 records per day.
- **Payload limit:** How much data can be submitted in a single request? Example: at most 1 MiB.

The platform checks all applicable limits. A request can be rate-limited even if the daily quota is not exhausted; it can also exceed a daily quota while sending at a low rate.

The MVP accounts for record count and estimated bytes. A response such as `429 QUOTA_EXCEEDED` must tell the caller that the daily limit has been hit and, when known, when it resets.

Usage accounting has concurrency problems. If two concurrent requests each check “under quota” before either increments usage, they might both be accepted and exceed the limit. Use atomic counters/transactions/coordination and test concurrent submissions.

## 9. Retention

Retention means how long telemetry data remains queryable before being deleted or compacted.

Initial defaults:

- Metrics: 15 days.
- Logs: 7 days.
- Traces when introduced: 3 days.

These are configurable product defaults, not promises that any arbitrary deployment has enough storage. Retention configuration must match actual backend settings. The product must not show “kept for 7 days” while Loki actually stores data for 30 days or indefinitely.

During development, retention can be tested using a short test profile. Don't wait seven days just to verify that the cleanup path works.

## 10. Alerting and Incidents

An alert rule describes a condition. An incident describes an occurrence of that condition.

Example rule:

- Metric: error rate.
- Operator: greater than.
- Threshold: 5 percent.
- Window: 5 minutes.
- Evaluation interval: 30 seconds.

The evaluator queries the metric series in the rule's own project scope. It updates the rule state and creates an incident when the condition transitions to firing. It does not create multiple incidents for the same continuing breach.

A notification is a side effect that can fail independently. If a webhook times out, the incident still exists. The notification delivery record captures the failed attempt, and bounded retry logic may try again.

Webhook destinations are security-sensitive. A malicious user might try to configure a URL pointing to an internal service such as the application's database. Validate schemes and host addresses, block local/private/metadata IPs, apply timeouts, and revalidate redirects/DNS results.

## 11. SDK, CLI, and Instrumentation

A useful SDK makes it easy for an application to send consistent telemetry without writing HTTP calls manually.

The Node.js SDK should provide:

- Configuration from environment variables/options.
- Express middleware to measure requests.
- Route-template labels rather than raw parameterized URLs.
- Structured logger API.
- Bounded batching and time-based flush.
- Retry behavior for transient errors.
- A shutdown hook to flush pending events.
- Safe diagnostics and test connection.

Why bounded buffering? If the observability platform is down, an application shouldn't accumulate an unbounded in-memory queue until it crashes. The SDK needs a defined behavior for full buffers: drop records, sample them, or block briefly. The choice should be configurable within limits and documented.

A CLI can validate the API connection and submit test data. That makes integration problems easier to diagnose and provides a useful demo. The full command set can follow after the MVP.

## 12. Load Testing and Performance

Performance numbers are meaningful only when accompanied by a test protocol.

The project target is:

- 1,000 telemetry records per second for at least 5 minutes.
- 5,000 records per second for at least 30 seconds.

A telemetry record means one log record or one metric observation as defined by the generator. Run separate metrics-only, logs-only, and mixed tests. Record the test environment, average payload size, client concurrency, p50/p95/p99 ingestion latency, error/rejection rate, and end-to-end visibility delay.

The benchmark should check correctness, not merely HTTP status. A gateway that returns 202 quickly but drops the record isn't delivering successful ingestion.

Because the end-term deadline and runtime resources are limited, the target is an engineering benchmark, not a condition that blocks submission. The measured outcome must be recorded honestly. Do not claim the target was passed if it wasn't measured.

## 13. Why These Specific Technologies?

### React + TypeScript

React supports a dashboard-oriented interface with reusable filters, charts, tables, and forms. TypeScript helps constrain data structures for metrics, log records, alert rules, and dashboard JSON.

### Node.js + Express + TypeScript

The platform's public control APIs, ingestion gateway, SDK, and CLI are all in the same ecosystem. This reduces context switching for the project owner and enables shared validation/types.

### MongoDB + Mongoose

MongoDB stores flexible product metadata. Mongoose schemas and validation make the domain model explicit; indexes help lookups by email, organization/project, session, and usage window.

### Redis

Redis is useful for fast shared rate-limit counters, temporary coordination, and optional background queues. It should not be the sole permanent store for alert incidents or customer configuration.

### Prometheus

Prometheus stores time series and supports PromQL. It is used behind a product query gateway, not exposed directly to customers.

### Loki

Loki is specialized for log storage/querying. Multi-tenant request headers must be set by trusted application infrastructure, not untrusted customers.

### OpenTelemetry Collector

The Collector is a flexible telemetry pipeline that can receive, process, batch, and export telemetry. It supports the later move toward standard OTLP ingestion and can collect platform-internal telemetry earlier.

### Tempo later

Tempo is the trace backend planned for the tracing phase. It supports tenant scope through `X-Scope-OrgID` when multi-tenancy is enabled; those headers still need trusted gateway enforcement.

### Docker Compose

Compose makes the many local dependencies reproducible. It is a development/deployment tool, not proof that the service is horizontally scalable or highly available. Production deployment still needs persistent storage, private networking, TLS, resource limits, backups, and monitoring.

## 14. Development Order: What to Build and Why

### Step 1 — Read the repository and bootstrap

Inspect Node/npm versions and existing files. Add a strict TypeScript config, linting, formatting, shared environment parsing, and a clear monorepo structure. Verify the web and API can start before adding backend dependencies.

### Step 2 — MongoDB models and authentication

Build user, session, organization, membership, project, and API-key models. Add signup/login/logout and test that a second organization cannot read the first organization's records.

This is foundational because every telemetry action depends on knowing which organization and project owns it.

### Step 3 — API keys and tenant-scope helper

Implement key generation, hashing, verification, revocation, and project scoping. Write tests before wiring telemetry. Add one central helper that returns an authorized scope object containing organizationId, projectId, and caller identity.

### Step 4 — SDK and demo service

Build the Express middleware and structured logger. Run the sample service and verify that telemetry requests reach the gateway with the expected shape. Test invalid keys and backend downtime.

### Step 5 — Real metrics path

Connect the gateway to the defined metrics collection path and Prometheus. Start with a small fixed metric catalogue, then implement server-generated queries and charts. Make tenant isolation tests pass before expanding the query builder.

### Step 6 — Real log path

Connect Loki in multi-tenant mode. Send real logs from the SDK, derive the tenant ID on the server, and implement the log explorer with filters and limits.

### Step 7 — Alerts and incidents

Create rule definitions, a periodic evaluator, transition logic, incident persistence, and webhook delivery. Test repeated firing, resolution, and notification failure.

### Step 8 — Quotas and self-monitoring

Add event/byte accounting, quota enforcement, API health metrics, downstream error counts, and a small operator view.

### Step 9 — Compose, documentation, and tests

Verify a fresh clone can start. Run unit, integration, and end-to-end tests. Add the security model, environment variables, deployment instructions, benchmark report, and demo script.

### Step 10 — Only then expand scope

Add saved dashboards/queries, richer CLI, email, standard OTLP ingestion, and tracing according to phases in the PRD. Do not begin a later phase while core workflows or tenant tests are broken.

## 15. How to Read the Code Once Generated

Trace one user action from frontend to backend.

For example, when a user creates a project:

1. Find the React form/component.
2. Find the frontend API client method.
3. Find the Express route that handles `POST /api/v1/organizations/:id/projects`.
4. Find the authentication middleware.
5. Find the authorization/membership check.
6. Find the service that validates and creates the project.
7. Find the Mongoose model and its indexes.
8. Find the response schema and the UI success/error state.
9. Find the corresponding tests.

For telemetry, trace the same path: sample app → SDK → ingestion route → API-key verification → tenant scope → quota check → backend writer → backend query API → frontend display. If you can explain this path without reading the whole codebase, you understand the architecture at a practical level.

## 16. Common Bugs and How to Diagnose Them

### Metrics dashboard is empty

Check in order:

1. Is the demo service running and receiving requests?
2. Is SDK endpoint configuration correct?
3. Does the SDK have the correct project key?
4. Does the ingestion API accept the request, or is the key/plan invalid?
5. Is the metrics registry/export endpoint publishing samples?
6. Is Prometheus scraping the intended target and reporting it healthy?
7. Does the API's generated query match the actual metric name and labels?
8. Is the dashboard time range correct and are timestamps within it?

### Logs don't appear

Check:

1. SDK sends a structured log event.
2. Ingestion response shows it accepted.
3. Gateway derives correct project/organization scope.
4. Loki is healthy and configured with multi-tenancy enabled.
5. Gateway set `X-Scope-OrgID` correctly.
6. The query API uses the same tenant ID and time range.
7. The query filters match the actual labels/attributes.

### One tenant sees another tenant's data

Treat this as a release-blocking security bug. Inspect the authorization middleware, resource ownership check, and query generation. Ensure tenant scope comes from the authenticated identity/database relationship, not the URL/body/header. Keep backend ports private. Add a regression test so the bug can't recur unnoticed.

### Requests return 429

Distinguish request rate limit from daily usage quota. Check `Retry-After`, reset time, current usage, and plan limit. The UI should not show a generic “server error” for an expected quota rejection.

### Alert keeps creating incidents

Check incident fingerprint/deduplication and state transition logic. One continuous firing period should map to one open incident. Re-resolving and refiring later may create a new incident according to the product semantics.

### Docker app starts but data disappears after restart

Verify named volumes are declared and attached to MongoDB and telemetry backends. A container's internal filesystem is not a backup strategy. Check volume paths and any development reset command.

## 17. Questions You Should Be Able to Answer in a Viva or Demo

### Product and architecture

1. What problem does your platform solve?
2. Who is the target user?
3. Why did you choose metrics and logs before traces?
4. Why use MongoDB for metadata but Prometheus/Loki for telemetry?
5. What is the difference between control plane and data plane?
6. Why is the platform more than a CRUD application?

### Security

7. What is a tenant and how is tenant isolation enforced?
8. Why does the client not supply the authoritative organization ID?
9. Why do you store an API-key hash instead of the raw key?
10. What is the difference between a browser session and an ingestion API key?
11. Why are Prometheus and Loki not exposed directly to the browser?
12. How do you prevent webhook SSRF?

### Metrics and logs

13. What's the difference between a counter, gauge, and histogram?
14. What does p95 latency mean?
15. Why are raw URL paths bad metric labels?
16. What is cardinality and why does it matter?
17. How do log filters and time ranges work?

### Reliability

18. What happens if the telemetry backend is unavailable?
19. What happens when a customer's quota is exceeded?
20. How do you stop retries from creating duplicate incidents?
21. How does the SDK behave if its internal buffer fills?
22. What do you test under load?

### Limitations and future work

23. Why is the MVP not full distributed tracing?
24. Why does standard OTLP ingestion belong in a later phase?
25. What would need to change before supporting high volume or arbitrary PromQL?
26. What did your load test actually achieve, and under what setup?

Be honest about current limitations. An accurate explanation of what works, what doesn't, and why is stronger than claiming production scale without evidence.

## 18. Suggested Three-to-Five Minute Demo Narrative

1. Introduce the problem and target developer.
2. Log in and open a real project.
3. Show the Node SDK configuration and run the sample service.
4. Generate a few requests, including a controlled error.
5. Show metrics changing and search for the error in the log explorer.
6. Trigger an alert and show the incident/notification result.
7. Briefly show tenant-isolation tests, README, deployment, and actual load-test results.

Do not spend most of the demo reading code. Show the live product behavior first; use the code only to explain one or two meaningful engineering choices.

## 19. Useful Official Documentation

- OpenTelemetry: https://opentelemetry.io/docs/
- OpenTelemetry Collector: https://opentelemetry.io/docs/collector/
- Prometheus: https://prometheus.io/docs/
- PromQL basics: https://prometheus.io/docs/prometheus/latest/querying/basics/
- Loki: https://grafana.com/docs/loki/latest/
- Loki authentication/tenancy: https://grafana.com/docs/loki/latest/operations/authentication/
- Grafana Mimir (future native metrics tenancy option): https://grafana.com/docs/mimir/latest/manage/secure/authentication-and-authorization/
- Tempo multi-tenancy (future tracing): https://grafana.com/docs/tempo/latest/operations/manage-advanced-systems/multitenancy/
- Docker Compose: https://docs.docker.com/compose/
- k6: https://grafana.com/docs/k6/latest/

## 20. The Main Mental Model to Remember

Keep this model in your head:

- **The SDK observes the application.**
- **The gateway verifies who owns the data.**
- **The quota layer controls consumption.**
- **The telemetry backends store signals.**
- **The query API authorizes and constrains reads.**
- **The UI helps the developer investigate.**
- **The alert evaluator detects conditions and creates incidents.**
- **Self-monitoring shows whether the platform itself is healthy.**

The most important architecture rule is that the system must preserve tenant scope from ingestion through storage and query. The most important delivery rule is that a few real, tested workflows are more valuable than a broad UI whose functionality is incomplete.

---

## 21. Implementation Notes by Milestone

These sections describe the code as it actually exists, milestone by milestone.

### 21.1 M1 — Foundations

**Where to look**

| Concept | File |
|---|---|
| Config validation | `apps/api/src/config/index.ts` |
| Liveness vs readiness | `apps/api/src/modules/health/` |
| Platform metrics | `apps/api/src/observability/platform-metrics.ts`, `apps/api/src/middleware/request-metrics.ts` |
| Internal-only listener | `apps/api/src/internal-app.ts` (port 9464) |
| Error envelope | `apps/api/src/middleware/error-handler.ts` |
| Docker stack | `infra/compose.yaml`, `infra/loki/loki.yaml`, `infra/prometheus/prometheus.yml` |

**Ideas worth being able to explain**

1. **Fail-fast configuration.** Every environment variable is validated by one Zod schema at startup. A missing secret stops the process with a readable message instead of failing mysteriously on the first request. The error lists variable *names*, never their values.
2. **Liveness ≠ readiness.** `/health/live` only proves the process responds. `/health/ready` checks MongoDB, Redis, Prometheus, and Loki, each with a timeout. If liveness checked the database, a short MongoDB outage would make an orchestrator restart healthy API processes over and over, which is a classic cascading-failure mistake. Readiness returns `503` and says *which* dependency is down, but never the error text (it may contain internal IP addresses).
3. **Two listeners.** The public port serves the product. A second port (9464) serves `/metrics` for Prometheus only. This is simpler and safer than protecting `/metrics` with a password on the public port, because the internal port is never routed by the reverse proxy.
4. **Route templates as labels.** The request-metrics middleware labels by `/api/v1/projects/:projectId`, never `/api/v1/projects/65f1…`. Requests matching no route share the label `__unmatched__`. Otherwise a scanner probing random URLs would create a new Prometheus time series per URL (a *cardinality explosion*).
5. **Loki multi-tenancy.** `auth_enabled: true` makes Loki demand an `X-Scope-OrgID` header, but Loki does not verify it. That is why the gateway must be the only thing that talks to Loki.
6. **Retention is enforced by the compactor.** `retention_period` alone deletes nothing. `compactor.retention_enabled: true` is what actually removes old chunks.

**Try it yourself**

```bash
npm run infra:up && npm run dev:api
curl localhost:4000/health/ready          # all "up", HTTP 200
docker compose -f infra/compose.yaml stop loki
curl localhost:4000/health/ready          # loki "down", HTTP 503
docker compose -f infra/compose.yaml start loki
curl localhost:9464/metrics | grep aop_   # internal metrics
# Prometheus UI (local only): http://localhost:9090/targets
```

## 22. Further Reading

**Books and chapters (free online)**

- Google SRE Book, *Monitoring Distributed Systems* (the "four golden signals": latency, traffic, errors, saturation): https://sre.google/sre-book/monitoring-distributed-systems/
- Google SRE Book, *Practical Alerting*: https://sre.google/sre-book/practical-alerting/
- Google SRE Workbook, *Alerting on SLOs* (burn-rate alerts, the future of your alert rules): https://sre.google/workbook/alerting-on-slos/
- Google SRE Book, *Addressing Cascading Failures* (why liveness must not check dependencies): https://sre.google/sre-book/addressing-cascading-failures/

**Research papers**

- Sigelman et al., *Dapper, a Large-Scale Distributed Systems Tracing Infrastructure* (Google, 2010), the origin of modern tracing: https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/
- Pelkonen et al., *Gorilla: A Fast, Scalable, In-Memory Time Series Database* (Facebook, VLDB 2015); Prometheus's storage compression is based on it: https://www.vldb.org/pvldb/vol8/p1816-teller.pdf
- Dean & Barroso, *The Tail at Scale* (CACM 2013), why p95/p99 matter more than averages: https://research.google/pubs/the-tail-at-scale/
- Beyer et al., *Borg, Omega, and Kubernetes* (ACM Queue 2016), background for health checks and orchestration: https://queue.acm.org/detail.cfm?id=2898444

**Practical guides**

- Prometheus naming and label best practices: https://prometheus.io/docs/practices/naming/
- Prometheus histograms vs summaries (how p95 is estimated): https://prometheus.io/docs/practices/histograms/
- Loki label best practices (why request IDs are not labels): https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/
- Brendan Gregg, *The USE Method* (utilization, saturation, errors): https://www.brendangregg.com/usemethod.html
- Tom Wilkie, *The RED Method* (rate, errors, duration), the exact signals your SDK collects: https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/
- OWASP Session Management Cheat Sheet (for M2): https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP SSRF Prevention Cheat Sheet (for webhooks in M6): https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- The Twelve-Factor App, *Config* (why config lives in environment variables): https://12factor.net/config
