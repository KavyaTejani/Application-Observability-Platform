import express, { type Express } from 'express';
import type { CustomerMetrics } from './modules/telemetry/customer-metrics.js';
import type { PlatformMetrics } from './observability/platform-metrics.js';

/**
 * Internal-only listener scraped by Prometheus over the private network. It is bound to a
 * separate port that is never published or routed by the public reverse proxy.
 *
 * - `/metrics`: the platform's own health metrics.
 * - `/telemetry-metrics`: customer request metrics aggregated by the gateway, labelled with
 *   server-derived tenant IDs. These are kept separate so customer series never mix with
 *   platform series. Serving goes through `scrape()`, which completes the zero-initialization
 *   of new series (see CustomerMetrics).
 */
export function createInternalApp(
  metrics: PlatformMetrics,
  customerMetrics?: CustomerMetrics,
): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  if (customerMetrics) {
    app.get('/telemetry-metrics', async (_req, res) => {
      res.set('Content-Type', customerMetrics.registry.contentType);
      res.send(await customerMetrics.scrape());
    });
  }
  return app;
}
