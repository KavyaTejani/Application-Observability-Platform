# Threat Model

Living document, updated each milestone. It describes the controls that **exist in the code
today**. Planned controls are marked _(planned, Mx)_.

## Trust boundaries

```text
 Browser ──(session cookie)──► Express API ──► MongoDB, Redis       (private network)
 Customer app + SDK ─(key)──► Ingestion gateway ──► Prometheus, Loki (private network)  (planned, M4)
```

1. **Browser → API.** Untrusted. Identity comes only from the server-side session.
2. **SDK → ingestion gateway.** Untrusted. Identity comes only from the project API key
   (key authentication done in M3; telemetry ingestion arrives in M4).
3. **API → backends.** Trusted private network. Backends are never exposed publicly. Dev ports
   bind to `127.0.0.1`, and the production deployment publishes none.

## Assets

User credentials, session tokens, ingestion keys _(M3)_, tenant telemetry and metadata, webhook
secrets _(M6)_, and server secrets (`SESSION_SECRET`, `TELEMETRY_KEY_PEPPER`).

## Controls in place

| Threat | Control | Where |
|---|---|---|
| Password database leak | Argon2id hashing (19 MiB, t=2, p=1). The hash is never selected by default. | `modules/auth/password.ts`, `user.model.ts` |
| Session-store leak | Only the HMAC-SHA-256 of the 256-bit session token is stored | `modules/auth/session.service.ts` |
| Session theft through XSS | `HttpOnly` cookie. A strict CSP (`script-src 'self'`, no inline scripts). | `auth.routes.ts`, Helmet |
| Session over plain HTTP | `Secure` and the `__Host-` cookie prefix in production | `config/index.ts` |
| Session fixation | A fresh session ID on every login, and any previous session is revoked | `auth.routes.ts` |
| Stale or stolen sessions | Idle (12 h, sliding) and absolute (7 d) expiry, checked per request. Logout deletes the session server-side. | `session.service.ts` |
| CSRF | `Origin`/`Referer` must match an allowed origin on every non-GET `/api/v1` request. `SameSite=Lax` adds a second layer. | `middleware/origin-check.ts` |
| Credential stuffing / brute force | Redis rate limits: sign-up 10/h per IP; login 30/15 min per IP and 10/15 min per IP+email | `auth.routes.ts`, `lib/rate-limiter.ts` |
| Account enumeration through login | One generic `INVALID_CREDENTIALS` response. Unknown emails still run a full Argon2 verification (timing equalization). | `auth.service.ts`, `password.ts` |
| Cross-tenant metadata access | `TenantScope` is built only from the session plus an active-membership lookup. Non-members get `404` (no existence oracle). | `modules/authz/tenant-scope.ts` |
| Privilege escalation | A single RBAC policy (`can(role, action)`) covered by a matrix test. Client-supplied `role` and `organizationId` are ignored. | `modules/authz/policy.ts` |
| Secrets in logs | Pino redaction of auth headers, cookies, and password/key fields. Request logs record only method, URL, ID, and status. | `lib/logger.ts`, `app.ts` |
| Information leakage in errors | A generic `500` with a request ID. Readiness reports up/down but never error text. | `error-handler.ts`, `health.service.ts` |
| Misconfiguration | Startup validation of every variable. Placeholder secrets are rejected in production. | `config/index.ts` |
| Ingestion-key database leak | Only `HMAC-SHA-256(TELEMETRY_KEY_PEPPER, secret)` is stored; the pepper lives outside the database. A leaked `apiKeys` collection cannot authenticate. | `api-keys/api-key.crypto.ts` |
| Key brute force | 256-bit secrets; constant-time comparison; unknown key IDs still run a verification (no timing oracle) | `key-authenticator.ts` |
| Key exposure in transit or logs | The key is shown once, with `Cache-Control: no-store`. It is sent only in `Authorization`, which is never logged (verified by grepping the logs). | `api-key.routes.ts`, `app.ts` |
| Revoked key reuse | The revoking instance evicts its cache entry immediately. Other instances re-read within `API_KEY_CACHE_TTL_SECONDS` (30 s). Project deletion revokes every key. | `key-authenticator.ts`, `project.service.ts` |
| Cross-tenant writes through a key | The ingestion principal (org, project, environment) comes only from the key record. Body and header tenant fields are ignored (tested with a forged `X-Scope-OrgID`). | `key-authenticator.ts` |
| Key misuse beyond ingestion | Keys carry only `telemetry:write`. Ingestion routes accept no cookies, and product routes accept no keys. | `ingestion.routes.ts`, `app.ts` |
| Writing into another tenant's telemetry | The Loki `X-Scope-OrgID` and the Prometheus `organization_id`/`project_id` labels are set by the gateway from the key. Client tenant fields and headers are ignored (tested against real Loki). | `telemetry/ingest.service.ts`, `loki-writer.ts` |
| Reading another tenant's logs at the storage layer | Loki runs with `auth_enabled: true`. A different tenant ID sees nothing (real-Loki test), and requests without a tenant are refused (`401`). | `infra/loki/loki.yaml`, `loki.integration.test.ts` |
| Cardinality / memory DoS on Prometheus | Route and service caps per project (`__other__`); ID-like path segments normalized; bounded label alphabets; 500 records and 1 MiB per batch; per-key rate limit | `customer-metrics.ts`, `normalize.ts` |
| Secrets stored in telemetry | Keys, Bearer/Basic credentials, and `password=`-style pairs are redacted from messages. Secret-named attributes are replaced with `[REDACTED]`. | `telemetry/redact.ts` |
| False acknowledgement / double counting | Logs are acknowledged only after Loki confirms. On failure nothing from the batch is recorded, so SDK retries are safe. | `ingest.service.ts` |
| SDK harming the host app | Bounded buffer and retries; errors go to `onError`, never thrown into handlers; the timer is `unref()`'d; the key is a private field | `packages/node-sdk/src/client.ts` |
| Cross-tenant metric queries | The browser sends allow-listed descriptors only (strict schemas reject `promql`, `expr`, and tenant fields). PromQL is generated server-side, with the `organization_id`/`project_id` matchers taken from the ProjectScope, first in every selector; label values are escaped. | `modules/query/promql.ts`, `packages/validation/src/queries.ts` |
| Cross-tenant log queries | `X-Scope-OrgID` is set from the scope (a browser-sent header is ignored; tested with real Loki), plus a mandatory `project` matcher. Text search is regex-escaped inside a raw string; backticks are refused. | `modules/query/logql.ts`, `backend-clients.ts` |
| Expensive / unbounded queries | Fixed ranges; ≤ 1000 points per series; log span ≤ 24 h, lookback ≤ 7 d, limit ≤ 200; validated cursors; 240 queries/min per user; backend timeouts | `queries.ts`, `query.routes.ts` |
| Backend details in errors | Query failures map to generic `503 QUERY_BACKEND_UNAVAILABLE` / `502 QUERY_FAILED`. Details are logged server-side only. | `backend-clients.ts` |
| Webhook SSRF (reaching internal services or cloud metadata) | Scheme allow-list; no URL credentials; every resolved address is checked against private/loopback/link-local/metadata/CGNAT/multicast/ULA/IPv4-mapped/NAT64 ranges (`net.BlockList`), on save and on every send; the socket is pinned to the validated IP; redirects are never followed; dev-only override refused in production | `alerts/ssrf.ts`, `webhook-client.ts`, `config/index.ts` |
| DNS rebinding | Re-resolution at send time plus IP pinning through a custom `lookup`, so the address that was checked is the address that is used (tested) | `webhook-client.ts` |
| Forged webhooks to customers | HMAC-SHA-256 signature over `timestamp.body` with a per-destination secret, so receivers can verify origin and reject replays | `secret-box.ts`, `notifier.ts` |
| Secret exposure via destinations | The signing secret is shown once, stored with AES-256-GCM (HKDF-derived key). The URL is never returned (only a preview), since paths often contain tokens. Delivery records hold only a status and a safe summary, never response bodies. | `alert.service.ts`, `alert.models.ts` |
| Duplicate incidents / notification storms | A partial unique index allows one firing incident per rule; outbox jobs are unique per (incident, destination, event); evaluation leases | `alert.models.ts`, `alert-evaluator.ts` |
| Alert queries escaping tenant scope | Scope comes from the rule record; the expression is built by the same generator as the dashboards | `alert-evaluator.ts` |
| Notification failures hiding incidents | Delivery is separate from incident state; failures are retried, recorded, and counted (`aop_notification_attempts_total`) | `notifier.ts` |
| Plan-limit bypass by racing | Project slots are reserved with a conditional atomic `$inc`, and released if the insert fails | `project.service.ts` |
| Ingestion quota bypass by concurrency | The daily quota is reserved with one conditional atomic `$inc` on the organization's day counter (`records <= limit - n`), so parallel batches cannot together exceed it (tested with 20 concurrent batches) | `usage/quota.service.ts` |
| Quota consumed by failed writes | The reservation is released when the forward fails; a crash in between only overcounts (fails safe) | `quota.service.ts`, `ingest.service.ts` |
| Quota bypass during a database outage | Ingestion fails closed with a retryable `503 QUOTA_UNAVAILABLE`; it never admits unchecked traffic | `quota.service.ts` |
| Operator view exposed to customers | Not an organization role: it needs `OPERATOR_TOKEN` (bearer, SHA-256 + constant-time compare, rate-limited per IP); a customer session grants nothing; without the token configured the public route returns 404. The internal listener serves it on the private network only. The report holds aggregates only, no tenant names, emails, or IDs (tested). | `operator/operator.routes.ts`, `operator.service.ts` |

## Known limitations (accepted for the MVP)

1. **Duplicate-email disclosure at sign-up.** `POST /auth/register` returns `409 EMAIL_TAKEN`,
   which reveals that an account exists. Email verification (P1) would allow a generic response.
   Mitigated by the sign-up rate limit (10 per hour per IP).
2. **Rate limiting fails open.** If Redis is unreachable, auth requests are allowed and the
   failure is logged, so a Redis outage does not lock every user out. During such an outage,
   brute-force protection is reduced to Argon2's cost.
3. **No multi-document transactions on registration.** A standalone MongoDB has no
   transactions, so a partial failure is undone with compensating deletes. A session is issued
   only after every step succeeds.
4. **IP-based limits behind proxies.** Correct client IPs depend on `TRUST_PROXY=true` being set
   when (and only when) the app runs behind exactly one trusted proxy, as on Render.
5. **Shared IPs.** Per-IP limits can affect users behind one NAT, which is acceptable at this
   scale.
6. **Revocation propagation window.** With several API instances, a revoked key can keep working
   on other instances for up to `API_KEY_CACHE_TTL_SECONDS` (default 30 s). Setting it to `0`
   removes the window at the cost of one database read per ingestion request.
7. **Rotating the pepper** invalidates every ingestion key. There is no dual-pepper rollover.
8. **Soft-deleted projects** keep their telemetry until backend retention removes it. Deletion is
   not an instant purge.

9. **Redaction is pattern-based.** A secret in an unrecognized format inside a free-text message
   can still be stored. Applications should not log secrets in the first place.
10. **The internal scrape port (9464) has no authentication.** It relies on network isolation:
   it is never published in production, and Prometheus reaches it over the private network only.

11. **Prometheus is not itself tenant-aware.** Isolation rests on the API being the only query path
    and on generated matchers. Arbitrary PromQL would need a multi-tenant backend such as Mimir
    (PRD §2.3).

12. **Webhook egress is not network-restricted.** SSRF defence is application-level. A production
    deployment should also restrict outbound traffic at the network layer (defence in depth).
13. **The alert rule limit uses count-then-insert.** A narrow race could exceed the plan's rule
    limit by one or two. This is acceptable because rule creation is low-rate and authenticated.
14. **The encryption key falls back to `SESSION_SECRET`** when `WEBHOOK_ENCRYPTION_KEY` is unset.
    Rotating the session secret would then make stored signing secrets unreadable; set a
    dedicated key in production.

15. **The operator token is a single shared secret.** There are no per-operator accounts or audit
    trail. It should be long and random, sent only over HTTPS, and rotated by changing the
    environment variable.
16. **Operator counters are per instance.** They reset on restart, and with several instances each
    reports its own. Prometheus (scraping every instance) holds the aggregate history.
17. **Quota granularity is the batch.** A batch that does not fit is refused whole, so an
    organization can stop slightly below its limit.

## Planned

- The full isolation suite and backend-port exposure checks _(M8)_
