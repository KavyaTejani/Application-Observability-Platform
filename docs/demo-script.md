# Demo Script (target 4:30, hard limit 5:00)

A shot-by-shot plan for the demo video: what to have ready, what to click, what to say, and what
must be visible in each time slot. Everything shown is real data from the sample service; nothing
is mocked.

Record against the **local full stack**: metrics, logs, and alerts need Prometheus and Loki, which
the free hosted demo does not run. Use the **light theme** (the neo-brutalist design).

---

## Part A — Preparation (15–20 minutes, not recorded)

### A1. Start everything

Use PowerShell from the project root. Close every old API / Node terminal first (only one API may
run, or metrics break).

| Terminal | Command | Leave it showing |
|---|---|---|
| 1 | `npm run infra:up` then `npm run dev:api` | API log |
| 2 | `npm run dev:web` | — |
| 3 | `$env:WEBHOOK_SIGNING_SECRET="whsec_…"; npm run webhook-receiver -w @aop/demo-node-service` (secret from step A3) | **Visible in the video** (webhooks) |
| 4 | `cd apps/demo-node-service; npm start` (healthy store, port 3001) | — |
| 5 | Prepared, **not started**: `cd apps/demo-node-service; $env:PORT="3002"; $env:DEMO_ERROR_RATE="0.9"; npm start` | **Visible in the video** |
| 6 | Prepared, **not started**: `$env:TRAFFIC_TARGET="http://localhost:3002"; $env:TRAFFIC_RPS="8"; $env:TRAFFIC_DURATION_SECONDS="150"; npm run traffic -w @aop/demo-node-service` | **Visible in the video** |

Check `.env` contains `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` and `OPERATOR_TOKEN=…`.

### A2. Data and accounts

```powershell
npm run seed:demo -w @aop/api                                   # owner@demo.local / demo-password-2026
npm run plan:set -w @aop/api -- --org owner@demo.local --plan developer   # normal quota
```

### A3. In the web app (http://localhost:5173, signed in as `owner@demo.local`)

1. **Projects:** `demo-store` (development) exists and its key is in
   `apps/demo-node-service/.env`. If not: create the project, then **Keys & setup → Create key**,
   paste it into `AOP_API_KEY`.
2. **Notifications → Add a webhook destination:** name `On-call webhook`, URL
   `http://localhost:5050/hook` → **Add destination**. Copy the `whsec_…` secret into terminal 3's
   command and start the receiver. Click **Send test** → `Test: success (HTTP 200)`.
3. **demo-store → Alerts → New rule:** name `Checkout errors`, metric **Server error rate (5xx)**,
   above **10 %**, window **1 min**, every **30 s**, fire after **2**, resolve after **2**, notify
   **On-call webhook** → **Create rule**. It shows **Normal**.
4. Give the dashboard history: in a spare terminal run
   `npm run traffic -w @aop/demo-node-service` (healthy store, 60 s) once or twice, 5–10 minutes
   before recording.

### A4. Screen setup

- Browser at 1920 × 1080, zoom 110 %, bookmarks bar hidden, other tabs closed, notifications off.
- Theme toggle (top bar) set to **Light** (☀).
- Ad/tracker blockers off for `localhost`.
- Tabs ready: **Tab 1** the app (signed **out**, on `/login`); **Tab 2**
  `http://localhost:5173/operator`; **Tab 3** `docs/load-test-report.md` on GitHub (or in VS Code
  preview).
- Arrange terminals 3, 5, and 6 so you can show them side by side in one window.
- Have the password ready to type: `demo-password-2026`.

---

## Part B — Timeline (what to show, click, and say)

Times are video times. Waiting periods are marked **✂ cut**: keep recording, then trim them in
editing (state "a minute later" in the voice-over). Say the lines naturally; the wording is a
guide, the **must show** column is not optional.

### 0:00 – 0:25 · Problem and landing

| Do | Must show |
|---|---|
| Start on the sign-in page (Tab 1). Pause 2 s on the left panel. Sign in as `owner@demo.local`. Land on **Overview**. | The product name and the three feature cards; after sign-in, the stat tiles (Projects, Receiving data, Records today, Members). |

> "Developers running Node.js services need to know when an endpoint gets slow or starts
> failing, and why. This is a multi-tenant observability platform: a small SDK sends request
> metrics and structured logs, and the platform turns them into dashboards, log search, and
> alerts."

### 0:25 – 1:00 · Organization, project, and keys

| Do | Must show |
|---|---|
| 1. Sidebar → **Projects** → click the `demo-store` card. 2. Tab **Keys & setup**. 3. Type `demo-key` → **Create key**: the yellow box with the pink edge appears; point at "shown once". 4. Click **I've stored it**. 5. On that new row: **Revoke** → **Confirm revoke** (status turns *Revoked*). 6. Scroll briefly over **Connect a service**. | The one-time reveal warning, the key list with prefixes only (never the full key), a revoke taking effect. |

> "Each project has its own ingestion keys. A key is shown exactly once and only a hash is
> stored, so even a database leak can't send data as you. Keys can be rotated with a grace
> period or revoked instantly. Every tenant boundary comes from the session or the key — the
> browser never chooses the tenant."

### 1:00 – 1:45 · Real instrumentation

| Do | Must show |
|---|---|
| 1. Switch to the terminals. Start **terminal 5** (failing store): it prints `Demo store on http://localhost:3002 → project "demo-store"`. 2. Start **terminal 6** (traffic). 3. Back to the browser → tab **Metrics** → range **15m**. ✂ cut the wait (≈ 20–30 s) until the numbers move. 4. Hover the request-rate line to show the tooltip. 5. Click **Show data table** once, then hide it. | The connection line in the terminal, then the dashboard: Requests, **Server errors (5xx)** rising, p95 latency, the charts with real points. |

> "This is a sample Express store instrumented with our SDK — one middleware line and a logger.
> I've set its checkout to fail 90 % of the time. Within about 30 seconds the dashboard shows
> request rate, the 5xx error rate, and p50, p95, and p99 latency. A gap in a chart means no
> data, which is different from zero, and every chart has a table view for accessibility."

### 1:45 – 2:25 · Log search

| Do | Must show |
|---|---|
| 1. Tab **Logs**. 2. Severity chip **ERROR** → **Search**. 3. Click an `Unhandled error` row to expand it: show the error attribute (*Payment provider timed out*) and the request ID. 4. Click the request ID once (it selects whole) → **Show all logs for this request**. | Filtered results, the detail panel with structured attributes, every log line of that one request. |

> "Logs are searchable by time, severity, service, text, and request ID. Here's a failed
> checkout with its structured attributes. Because the SDK attaches the request ID, one click
> shows everything that happened in that request. Queries are built by the server with the
> caller's tenant, so one customer can never read another's logs."

### 2:25 – 3:15 · Alert, incident, and webhook

| Do | Must show |
|---|---|
| 1. Tab **Alerts**. The rule shows **Pending** (yellow) or already **Firing** (red). ✂ cut the wait if needed. 2. When **Firing**: the new incident appears at the top of **Incidents** with *1 firing*. 3. Show **terminal 3**: `incident_firing … [firing]` and `signature: valid ✔`. 4. Click the incident: details (started, latest value, condition) and **Notification attempts** → *Firing · 1 · Delivered · 200*. | The state change with icon + label, exactly one incident, the signed webhook verified by the receiver, the recorded delivery. |

> "The rule needs two breaching checks in a row, so a single spike doesn't page anyone. One
> continuous breach is exactly one incident — a database index guarantees it even with several
> workers. The webhook is signed with HMAC, so the receiver can verify it really came from us,
> and every delivery attempt is recorded, with retries if the receiver is down."

### 3:15 – 3:45 · Resolution (and editing a rule)

| Do | Must show |
|---|---|
| 1. Stop **terminal 6** (Ctrl+C) and **terminal 5**. 2. Back on **Alerts**, click **Edit** on the rule, point at the form (threshold, window, checks), then **Cancel**. 3. ✂ cut ≈ 60–90 s. 4. Show the incident **Resolved** and terminal 3 printing `incident_resolved … [resolved]`. | Edit form pre-filled; the incident resolving on its own; exactly one resolved notification. |

> "When traffic stops, the window has no data, which counts as healthy, so after two clean
> checks the incident resolves and one 'resolved' notification is sent. Rules can be edited at
> any time — metric and condition stay fixed, thresholds and timing can change."

### 3:45 – 4:10 · Usage and platform health

| Do | Must show |
|---|---|
| 1. Sidebar → **Usage**: the records and bytes meters, reset time, per-project table. 2. Sidebar → **Settings**: members with Owner / Member roles. 3. **Tab 2** (`/operator`): paste the `OPERATOR_TOKEN` → **Open**. Show dependencies all up, ingestion counts, alert evaluations, webhook attempts. | Quotas per UTC day; roles; the operator view is separate from customer accounts. |

> "Each organization has a daily quota, enforced atomically so parallel requests can't exceed
> it; over-limit batches get a 429 with a retry time. Owners and members have different
> permissions. And there's a separate operator view, protected by its own token, that shows the
> platform's own health."

### 4:10 – 4:30 · Reliability and wrap-up

| Do | Must show |
|---|---|
| 1. A terminal with `npm test` already run: the line `Tests 337 passed`. 2. **Tab 3**: the load-test summary table. 3. Optional 2 s: toggle the theme to **Dark** and back. 4. End on the Overview page. | Test count, the measured benchmark numbers. |

> "There are 337 automated tests, including a tenant-isolation suite that attacks one tenant
> from another at every layer, an end-to-end test, and CI on every push. Under load it sustained
> a thousand records per second and a five-thousand-per-second burst with no rejections, and
> every acknowledged record was verified in storage. Thanks for watching."

**Total ≈ 4:30.** If you run long, shorten 3:45–4:10 (skip Settings) — never skip the alert
segment.

---

## Part C — If something goes wrong while recording

| Problem | Fix |
|---|---|
| Dashboard stays empty after 60 s | Only one API may run (port 9464 is scraped). Check terminal 5 printed `→ project "demo-store"`. Keep recording; cut later. |
| Rule stays **Normal** | Traffic must hit port **3002** (the failing store). It fires 60–90 s after traffic starts. |
| Receiver prints `INVALID (mismatch)` | Wrong `WEBHOOK_SIGNING_SECRET`; restart terminal 3 with the destination's secret. |
| `429 QUOTA_EXCEEDED` in terminal 5 | The org is on a small plan; run the `plan:set … --plan developer` command from A2. |
| Login says "Too many attempts" | Rate limit after many sign-ins; wait 15 minutes or record without signing out. |

## Part D — Do not

- Show trace views or OTLP (not built), or claim the benchmark proves more than the report says.
- Use the hosted URL for metrics, logs, or alerts (not configured there, by design). You may
  mention it: "accounts, projects, keys, and quotas also run on the hosted version".
- Leave `.env`, keys, or signing secrets on screen. **After recording, revoke every key and
  delete the webhook destination that appeared in the video.**
- Exceed 5:00.

## Part E — After recording

1. Trim the ✂ waits; add short captions for cuts ("1 minute later").
2. Check audio and that text is readable at 1080p.
3. Upload (unlisted YouTube or Google Drive "anyone with the link"), open the link in an
   incognito window to confirm access, and add it to the README and the submission form.
