# @aop/node-sdk

Node.js SDK for the Application Observability Platform. It provides:

- Express middleware that records the request count, duration, status, and route **template** for every request
- A structured logger whose logs are automatically tagged with the current request ID
- Bounded in-memory batching with retries, plus `flush()`, `shutdown()`, and `testConnection()`

It has no runtime dependencies and needs Node.js 18.17 or later (it uses the built-in `fetch`).

## Quick start

```ts
import express from 'express';
import { createClient } from '@aop/node-sdk';

const telemetry = createClient({
  endpoint: process.env.AOP_ENDPOINT!,   // e.g. https://aop-app-fbtl.onrender.com
  apiKey: process.env.AOP_API_KEY!,      // project ingestion key; never commit it
  serviceName: 'checkout-api',
  environment: 'production',             // optional; must match the project
});

const app = express();
app.use(telemetry.middleware());         // first, so every route is measured

app.get('/orders/:id', async (req, res) => {
  telemetry.logger.info('Loading order', { orderId: req.params.id }); // tagged with the request ID
  res.json({ id: req.params.id });
});

const server = app.listen(3000);

// Send what is buffered before the process exits.
process.on('SIGTERM', async () => {
  server.close();
  await telemetry.shutdown();
  process.exit(0);
});
```

Check your configuration without sending telemetry:

```ts
const result = await telemetry.testConnection();
// { ok: true, project: { name: 'Checkout', environment: 'production', … } }
```

## What gets recorded

| Source | Data |
|---|---|
| `middleware()` | One metric per request: method, route template (`/orders/:id`, never `/orders/8812`), status code, and duration. With `logRequests: true` (the default) it also writes one access log per request: `INFO` for 2xx/3xx, `WARN` for 4xx, `ERROR` for 5xx. |
| `logger.trace/debug/info/warn/error/fatal(message, attributes?)` | A structured log. Attributes are flattened to primitives (≤ 32 keys; values ≤ 1024 chars). An `Error` becomes `name.name` / `name.message`. |
| `recordRequest({ method, route, statusCode, durationMs })` | A manual metric, for frameworks other than Express |

Each request gets an ID. A well-formed inbound `X-Request-Id` is reused; otherwise one is generated. The ID is
echoed in the response header and attached to every log written during that request, including
from async code. It is never used as a metric label.

## Options

| Option | Default | Purpose |
|---|---|---|
| `endpoint`, `apiKey`, `serviceName` | — | Required |
| `environment` | — | Must match the project's environment if set |
| `flushIntervalMs` | 5000 | Send buffered telemetry at least this often |
| `maxBatchSize` | 500 | Records per request (server maximum: 500) |
| `maxBufferSize` | 10 000 | In-memory limit. Beyond it, **new records are dropped** and counted. |
| `maxRetries` | 3 | Retries for network errors, 429, and 5xx |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 500 / 30 000 | Exponential backoff with full jitter; `Retry-After` is honoured |
| `requestTimeoutMs` | 10 000 | Per-request deadline |
| `logRequests` | `true` | Write one access log per request |
| `onError(err)` | — | Called on dropped batches and server-side rejections |
| `debug(msg)` | — | Diagnostics |

## Failure behaviour

The SDK must never harm the application it observes:

- **Bounded memory.** At most `maxBufferSize` records are held. When the platform is unreachable for long,
  new records are dropped (`stats().dropped.bufferFull`) instead of growing the heap.
- **Bounded retries.** Transient failures are retried `maxRetries` times, then the batch is dropped
  (`dropped.retriesExhausted`). Permanent failures, such as an invalid key or an invalid batch, are not retried
  (`dropped.nonRetryable`).
- **No crashes.** Telemetry errors go to `onError`, never to the host's request handling. The flush
  timer is `unref()`'d, so it never keeps the process alive.
- **No secrets in output.** The API key lives in a private field and never appears in errors,
  debug messages, or `util.inspect(client)`.

`telemetry.stats()` returns `{ buffered, sent, rejectedByServer, dropped }` for health checks.

The wire format is documented in [`docs/ingestion-api.md`](../../docs/ingestion-api.md).
