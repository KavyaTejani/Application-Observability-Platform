# Future Roadmap

What the MVP deliberately leaves out, roughly in the order it would be built. Each item names
the limitation it removes.

## Phase 1: product depth

- **Standard OTLP ingestion.** Accept OpenTelemetry logs and metrics over OTLP/HTTP, routed
  through the Collector that already runs in the stack, so any OTel SDK works, not just ours.
- **Email notifications (SMTP)** and more destination types (Slack, PagerDuty).
- **Custom dashboards.** A dashboard builder on the existing allow-listed descriptors; the plan
  model already carries `maxDashboards`.
- **Invitations and member management.** Today members are added by the seed script.
- **Plan administration UI** and organization-level overrides (QUOTA-006), usage alerts near the
  limit, and usage history beyond 7 days.
- **Per-tenant log retention** through Loki limits overrides (RET-004).
- **CLI (`obsctl`).** `doctor`, `send-test-data`, key rotation, and log search from the terminal.
- **Email verification**, which also removes the duplicate-email disclosure at sign-up.

## Phase 2: traces

- Distributed tracing with Grafana Tempo (multi-tenant like Loki): trace ingestion, trace search,
  and trace ↔ log correlation through the request ID that logs already carry. Retention of 3 days.

## Phase 3: scale and resilience

- **Tenant-aware metrics backend** (Grafana Mimir) with remote-write from the gateway. This
  removes the pull-model loss window and allows per-tenant metrics retention and arbitrary
  (still tenant-scoped) queries.
- **A durable ingestion queue** (Redis Streams, NATS, or Kafka) between the gateway and the
  backends. Bursts are absorbed and backend outages no longer reject writes.
- **Horizontal scaling.** Several API instances behind a load balancer, with service discovery
  for scraping, and the alert worker split into its own deployment (it is already lease-based).
- **Network-level egress control** for webhooks (defence in depth beyond the application SSRF
  checks).
- **Platform self-telemetry** through the Collector into a dedicated internal tenant (SELF-005,
  SELF-006).
- **Sampling and cost controls**: per-signal sampling rules, cost-based retention, archive/export.

## Hardening backlog

- Per-operator accounts and an audit log, instead of one shared operator token.
- Dual-pepper rollover for ingestion keys (rotate `TELEMETRY_KEY_PEPPER` without invalidating
  every key).
- Atomic alert-rule limit (currently count-then-insert).
- Browser E2E tests (Playwright) on top of the API-level E2E flow.
