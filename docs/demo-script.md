# Demo Script (3–5 minutes)

Recorded against the **local full stack**, because metrics, logs, and alerts need Prometheus and
Loki (the hosted demo does not run them). Everything shown is real data from the sample service.
Nothing is mocked.

## Before recording (about 5 minutes)

```bash
npm run infra:up
npm run dev:api                    # terminal 1  (.env: WEBHOOK_ALLOW_PRIVATE_NETWORKS=true)
npm run dev:web                    # terminal 2
npm run seed:demo -w @aop/api      # owner@demo.local / demo-password-2026
```

1. Sign in as the owner. Create project **demo-store** (development) and a key, and paste it into
   `apps/demo-node-service/.env`.
2. **Notifications** → add `http://localhost:5050/hook`, copy the secret, and start the receiver:
   `WEBHOOK_SIGNING_SECRET=… npm run webhook-receiver -w @aop/demo-node-service` (terminal 3).
3. Start the healthy store `npm run start -w @aop/demo-node-service` (terminal 4) and run
   `npm run traffic -w @aop/demo-node-service` once, so the dashboard has a few minutes of data.
4. Prepare (not started) a failing store:
   `PORT=3002 DEMO_ERROR_RATE=0.9 npm run start -w @aop/demo-node-service`, and traffic for it:
   `TRAFFIC_TARGET=http://localhost:3002 TRAFFIC_DURATION_SECONDS=150 npm run traffic -w @aop/demo-node-service`.
5. Create the rule in advance: **Alerts** → "Checkout errors", error rate > 10 %, 1 min window,
   every 30 s, fire after 2, resolve after 2, notify "My receiver".

## Script

| Time | Show | Say |
|---|---|---|
| 0:00–0:25 | Sign-in page → Overview | "Developers running Node.js services need to know when endpoints get slow or start failing, and why. This platform collects request metrics and structured logs from an SDK, and alerts on them." |
| 0:25–1:00 | Projects → demo-store → **Settings**: keys | "Each project gets ingestion keys. A key is shown once and stored only as a hash. I can rotate or revoke it, and revocation applies immediately." Briefly create and revoke a throwaway key. |
| 1:00–1:45 | Terminal: start the failing store and its traffic. Then the **Dashboard** tab | "This is the sample Express store with our SDK: one middleware line and a logger. Request rate, 5xx rate, and p95 latency come in within about 30 seconds. Gaps mean no data, not zero." Switch the range to 15 min. |
| 1:45–2:30 | **Logs** tab: severity ERROR, then click an entry → "show all logs for this request" | "Logs are searchable by time, severity, service, text, and request ID. Here is the failing checkout and every log line of that request." |
| 2:30–3:20 | **Alerts** tab: Pending → Firing. Open the incident (delivery attempts). Show terminal 3: `incident_firing … signature: valid` | "The rule needs two breaching checks to fire, so one spike doesn't page anyone. One continuous breach is exactly one incident; a database index guarantees that. The webhook is signed, so the receiver can verify it came from us." |
| 3:20–3:50 | Stop the traffic. Incident → **Resolved**; receiver prints `incident_resolved` | "After two clean checks it resolves and sends one resolved notification." (Play this part sped up if needed.) |
| 3:50–4:30 | **Usage** page, then `/operator`. Then the terminal: `npm test` summary, and docs/load-test-report.md | "Each organization has a daily quota, enforced atomically, so parallel requests can't exceed it. The operator view shows the platform's own health. 336 automated tests include a tenant-isolation suite. The load test sustained 1,000 records per second, with every acknowledged record verified in storage." |

Total about 4:30.

## Do not

- Show trace views (not built), or claim the benchmark proves more than the report states.
- Use the hosted URL for metrics, logs, or alerts: they are not configured there, by design.
- Show `.env` files, keys, or signing secrets on screen longer than necessary. Revoke any key
  that appeared in the recording afterwards.
