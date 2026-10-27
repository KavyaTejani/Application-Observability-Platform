/**
 * Demo store API instrumented with @aop/node-sdk. It produces realistic telemetry: varied
 * routes, latency, client errors, and a configurable server-error rate, so dashboards, log
 * search, and alerts can be demonstrated with real data.
 */
import { createClient, type Environment } from '@aop/node-sdk';
import express, { type NextFunction, type Request, type Response } from 'express';

const env = process.env;
const required = (name: string): string => {
  const value = env[name];
  if (!value) {
    process.stderr.write(`Missing ${name}. Copy apps/demo-node-service/.env.example to .env.\n`);
    process.exit(1);
  }
  return value;
};

const port = Number(env.PORT ?? 3001);
const errorRate = Math.min(1, Math.max(0, Number(env.DEMO_ERROR_RATE ?? 0.05)));
const extraLatencyMs = Math.max(0, Number(env.DEMO_EXTRA_LATENCY_MS ?? 0));

const telemetry = createClient({
  endpoint: required('AOP_ENDPOINT'),
  apiKey: required('AOP_API_KEY'),
  serviceName: env.AOP_SERVICE_NAME ?? 'demo-store',
  environment: (env.AOP_ENVIRONMENT || undefined) as Environment | undefined,
  flushIntervalMs: 2000,
  onError: (error) => process.stderr.write(`[telemetry] ${error.code}: ${error.message}\n`),
});
const log = telemetry.logger;

const PRODUCTS = Array.from({ length: 20 }, (_, i) => ({
  id: String(i + 1),
  name: `Product ${i + 1}`,
  priceCents: 500 + i * 250,
  stock: (i * 7) % 13,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Roughly log-normal latency: mostly fast, with a long tail. */
const latency = (medianMs: number) =>
  sleep(extraLatencyMs + medianMs * Math.exp((Math.random() - 0.5) * 1.6));

const app = express();
app.use(telemetry.middleware());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/products', async (_req, res) => {
  await latency(25);
  res.json({ products: PRODUCTS });
});

app.get('/products/:id', async (req, res) => {
  await latency(15);
  const product = PRODUCTS.find((p) => p.id === req.params.id);
  if (!product) {
    log.warn('Product not found', { productId: req.params.id });
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(product);
});

app.post('/cart/items', async (req, res) => {
  await latency(20);
  const { productId, quantity } = (req.body ?? {}) as { productId?: string; quantity?: number };
  if (!productId || !quantity || quantity < 1) {
    log.info('Rejected invalid cart item', { productId: productId ?? null });
    res.status(400).json({ error: 'invalid_item' });
    return;
  }
  res.status(201).json({ productId, quantity });
});

app.post('/checkout', async (_req, res, next) => {
  await latency(120);
  if (Math.random() < errorRate) {
    next(new Error('Payment provider timed out'));
    return;
  }
  const orderId = `ord_${Math.random().toString(36).slice(2, 10)}`;
  log.info('Order placed', { orderId, items: 1 + Math.floor(Math.random() * 4) });
  res.status(201).json({ orderId });
});

// Express error handler: logs with the request's ID (via the SDK context) and returns 500.
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error('Unhandled error', { error });
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(port, async () => {
  const check = await telemetry.testConnection();
  if (check.ok) {
    process.stdout.write(
      `Demo store on http://localhost:${port} → project "${check.project?.name}" (${check.project?.environment})\n`,
    );
  } else {
    process.stderr.write(
      `Telemetry connection failed: ${check.error?.code} ${check.error?.message}\n`,
    );
  }
});

// Flush buffered telemetry before exiting (PRD SDK-006).
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void telemetry.shutdown(5000).then(() => {
      const stats = telemetry.stats();
      process.stdout.write(
        `Telemetry sent: ${stats.sent.metrics} metrics, ${stats.sent.logs} logs; dropped: ${JSON.stringify(stats.dropped)}\n`,
      );
      process.exit(0);
    });
  });
}
