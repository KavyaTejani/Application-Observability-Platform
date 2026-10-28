# Load Test Report

**Date:** 2026-10-28 · **Tool:** `apps/api/src/loadtest/ingest-load.ts` (open-loop generator,
written for this project) · **Raw results:** [`load-test-results/`](load-test-results/)

## Summary

| Objective (PRD §9.3) | Target | Measured | Met? |
|---|---|---|---|
| Sustained ingestion | 1,000 records/s for ≥ 5 min | **999 records/s for 300 s**, 0 rejected | Yes |
| Burst ingestion | 5,000 records/s for ≥ 30 s | **4,992 records/s for 30 s**, 0 rejected | Yes |
| Ingestion latency, sustained | p95 < 500 ms | **p95 68 ms** (p50 36, p99 139) | Yes |
| Dashboard query, 15-min window | p95 < 2 s | **p95 21 ms** (p50 15) | Yes |
| No data loss | Every acknowledged record stored | **496,800 of 496,800** stored (Loki and Prometheus counts equal acknowledgements) | Yes |
| No cross-tenant response or secret exposure | None | None observed (dedicated tenant; isolation suite covers the boundary) | Yes |

These numbers come from **one development laptop with every component on it**. They show that
the design does not lose data and has headroom at the PRD targets. They are not a capacity claim
for a production cluster. See [Limitations](#limitations).

## Environment

| Item | Value |
|---|---|
| Machine | Laptop: Intel Core Ultra 9 275HX (24 logical cores), 31 GiB RAM, Windows 11 (build 26300) |
| Docker | Docker Desktop 29.9.2 on WSL 2: 24 CPUs, 15.3 GiB visible to containers; **no per-container CPU/memory limits** |
| API | Production build (`node dist/server.js`), Node.js 24.19.0, one process, `LOG_LEVEL=warn`, running on the host |
| Backends | MongoDB 8.0, Redis 7.4, Loki 3.5.0 (multi-tenant, filesystem storage), Prometheus 3.5.0 (15 s scrape), all from `infra/compose.yaml` with default settings |
| Load generator | Same machine, Node.js 24, one process |
| Isolation of the run | A separate API instance (ports 4100/9465), its own MongoDB database, and its own Prometheus, so development traffic could not mix in. Loki was shared, but queries are scoped to the run's tenant and project. |

## Method

**Open loop.** Batches are sent on a fixed schedule, whatever the response time. A slow server
shows up as latency and in-flight backlog; the client never backs off to hide it (no
coordinated omission).

**Workload.** A fixed, seeded dataset (PRNG seed 42), 50/50 logs and metrics, sent by
**4 concurrent clients**, each with its own ingestion key, like four instrumented services. Each
request carries **200 records**.

| Record | Serialized size | Notes |
|---|---|---|
| Log | **937 bytes** | ~700-character message, 8 attributes, request ID (PRD suggests ≈ 1 KiB) |
| Metric (HTTP request observation) | **134 bytes** | Deviation: the metric schema is a fixed small record, so it cannot be padded to 1 KiB |

Mixed batches average about 107 KiB per request.

**Phases (profile `full`):** ramp 100 → 1,000 records/s over 30 s, sustained 1,000 records/s for
300 s, burst 5,000 records/s for 30 s, recovery 500 records/s for 60 s.

**Quota.** The test organization is moved to a dedicated `benchmark` plan (50 M records/day)
before the run. Quota enforcement stays fully on, including the atomic reservation on every
batch; only the limit is raised, as PRD §9.3 prescribes. At 1,000 records/s the default Developer
plan (250,000/day) would run out after about 4 minutes.

**Correctness check.** Accepted and rejected counts from every `202` response are summed. After
the run, the harness counts what was actually stored for the test project: log lines in Loki
(`count_over_time`) and the request counter in Prometheus (`sum(app_http_requests_total)`). It
fails if either differs from the acknowledged count.

**Delays.** During the sustained phase, every 5 s, a probe writes one marked log and polls the
product's own log-search API until that log appears (ingest → searchable). In the same loop a
dashboard summary query (15-minute window) is timed through the product API.

## Results: mixed workload, full profile

| Phase | Target rec/s | Duration | Requests | Accepted | Accepted rec/s | Rejected | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| Ramp | 100 → 1,000 | 30 s | 82 | 16,400 | 546 (avg) | 0 | 36 ms | 39 ms | 139 ms | 139 ms |
| **Sustained** | 1,000 | 300 s | 1,499 | 299,800 | **999** | 0 | 36 ms | **68 ms** | 139 ms | 142 ms |
| **Burst** | 5,000 | 30 s | 749 | 149,800 | **4,992** | 0 | 35 ms | **52 ms** | 70 ms | 76 ms |
| Recovery | 500 | 60 s | 149 | 29,800 | 497 | 0 | 36 ms | 39 ms | 138 ms | 139 ms |

All 2,479 requests returned `202`, with no network errors and no records rejected. At most
2 requests were in flight at once, so the server kept up and no backlog built up.

**Verification:** 248,414 logs acknowledged = 248,414 in Loki; 247,386 metric observations
acknowledged = 247,386 counted by Prometheus. Both counts matched within 6 s of the run ending
(one scrape).

**Processing delay (sustained phase):** ingest → searchable in the log explorer: p50 208 ms, p95
318 ms, max 324 ms (58 samples). Metrics become queryable on the next Prometheus scrape: up to
15 s by design, or up to 30 s for a brand-new series, which is first exported at zero.

**Dashboard query (15-minute summary, 58 samples):** p50 15 ms, p95 21 ms.

**API resources:** CPU averaged 0.04 cores (4 % of one core) during the sustained phase and 0.11
cores during the burst, measured from the process's own `process_cpu_seconds_total`. RSS was
361 MB after all runs.

## Results: each signal separately (profile `smoke`)

Same shape at 10 s / 60 s / 10 s / 20 s.

| Mix | Sustained rec/s | Sustained p50 / p95 / p99 | Burst rec/s | Burst p95 | Stored = acknowledged | Ingest → searchable p50 / p95 |
|---|---|---|---|---|---|---|
| Logs only | 997 | 37 / 39 / 41 ms | 4,980 | 38 ms | 124,800 = 124,800 (Loki) | 106 / 189 ms |
| Metrics only | 997 | 23 / 25 / 26 ms | 4,977 | 23 ms | 124,800 = 124,800 (Prometheus) | n/a (scrape-bound) |

Logs cost more per request than metrics because each batch waits for Loki's acknowledgement
before the API answers `202` (the durability contract). Metric batches skip that step but still
pay the two MongoDB writes of the quota reservation and the per-project usage record.

## Observations

- **A recurring ~139 ms p99** appears at the lower rates of the mixed run, but not in the burst
  or in the single-signal runs. The API's own ingestion histogram
  (`aop_ingest_request_duration_seconds`) puts about 1.8 % of all ingestion requests across these
  runs between 100 and 250 ms, so at least part of it is server-side, most likely an occasional
  slow Loki push or MongoDB write. The cause was not isolated further. The p99 figures above
  include it as measured, and they stay well inside the 500 ms objective.
- **Headroom.** CPU stayed far below one core even at 5,000 records/s, and latency did not grow
  with load. The limit was not reached, so these runs do not show where the system saturates.
  Finding that would need a stepped stress profile on dedicated hardware.
- **Rate limits were not a factor**: 4 keys × up to 6.25 requests/s, against 30 requests/s per key.

## Limitations

1. **Single machine.** The generator, API, and backends share one laptop (no network latency
   between them, no resource contention limits). Production latency would include network hops,
   and a host without NVMe storage would make Loki slower.
2. **One API instance.** Horizontal scaling was not tested.
3. **Short burst.** 30 s does not test sustained high load or Loki compaction under pressure.
4. **Pull-model loss window.** Metrics acknowledged in the last ≤ 15 s before an API crash are
   lost (documented contract). The test does not crash the API mid-run.
5. **Metric record size** is 134 bytes, not 1 KiB (schema-bound, see Method).
6. **The hosted demo** (Render free tier, no Prometheus/Loki) was not benchmarked.

## Reproduce

```bash
npm run infra:up && npm run dev:api          # or any running stack
npm run loadtest -w @aop/api -- --profile full \
  --base http://localhost:4000 --prometheus http://localhost:9090 --loki http://localhost:3100 \
  --mongo mongodb://localhost:27017/aop --internal http://localhost:9464 \
  --out docs/load-test-results/my-run.json
# quick version: --profile smoke ; single signal: --mix logs | --mix metrics
```

The script exits non-zero if stored data does not match what the API acknowledged.
