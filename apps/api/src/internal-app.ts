import express, { type Express } from 'express';
import type { PlatformMetrics } from './observability/platform-metrics.js';

/**
 * Internal-only listener scraped by Prometheus over the private Docker network. It is bound
 * to a separate port that is never published or routed by the public reverse proxy.
 */
export function createInternalApp(metrics: PlatformMetrics): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  return app;
}
