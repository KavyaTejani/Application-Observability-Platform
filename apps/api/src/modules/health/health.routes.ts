import { Router } from 'express';
import type { HealthService } from './health.service.js';

export function healthRouter(health: HealthService): Router {
  const router = Router();

  // Liveness: the process is running and the event loop responds. No dependency checks, so an
  // orchestrator never restarts the API just because MongoDB is briefly unavailable.
  router.get('/live', (_req, res) => {
    res.json({ status: 'live', uptimeSeconds: Math.round(process.uptime()) });
  });

  // Readiness: every critical dependency answered within the timeout.
  router.get('/ready', async (_req, res) => {
    const report = await health.checkReadiness();
    res.status(report.status === 'ready' ? 200 : 503).json(report);
  });

  return router;
}
