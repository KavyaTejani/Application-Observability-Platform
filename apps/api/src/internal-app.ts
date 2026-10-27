import express, { type Express } from 'express';
import type { Registry } from 'prom-client';
import type { PlatformMetrics } from './observability/platform-metrics.js';

const serve =
  (registry: Registry): express.RequestHandler =>
  async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  };

/**
 * Internal-only listener scraped by Prometheus over the private network. It is bound to a
 * separate port that is never published or routed by the public reverse proxy.
 *
 * - `/metrics`: the platform's own health metrics.
 * - `/telemetry-metrics`: customer request metrics aggregated by the gateway, labelled with
 *   server-derived tenant IDs. These are kept separate so customer series never mix with
 *   platform series.
 */
export function createInternalApp(metrics: PlatformMetrics, customerRegistry?: Registry): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', serve(metrics.registry));
  if (customerRegistry) app.get('/telemetry-metrics', serve(customerRegistry));
  return app;
}
