# Threat Model

Living document, updated each milestone. It describes the controls that **exist in the code
today**. Planned controls are marked _(planned, Mx)_.

## Trust boundaries

```text
 Browser ──(session cookie)──► Express API ──► MongoDB, Redis       (private network)
 Customer app + SDK ─(key)──► Ingestion gateway ──► Prometheus, Loki (private network)  (planned, M4)
```

1. **Browser → API.** Untrusted. Identity comes only from the server-side session.
2. **SDK → ingestion gateway.** Untrusted. Identity comes only from the project API key _(planned, M3/M4)_.
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

## Planned

- Ingestion key hashing (HMAC-SHA-256 + pepper), revocation, and rotation _(M3)_
- Telemetry tenant isolation in Prometheus/Loki, with server-generated queries only _(M4/M5)_
- Webhook SSRF protection _(M6)_; quotas _(M7)_; the full isolation suite _(M8)_
