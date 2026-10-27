import { Router, type RequestHandler } from 'express';
import type { HealthService } from './health.service.js';

// Readiness: every configured dependency answered within the timeout. `degraded` (some
// backends not configured) still serves traffic, so it returns 200 with an explicit status.
function readinessHandler(health: HealthService): RequestHandler {
  return async (_req, res) => {
    const report = await health.checkReadiness();
    res.status(report.status === 'not_ready' ? 503 : 200).json(report);
  };
}

/** Infrastructure probes (hosting health checks, scripts). Not called by the browser. */
export function healthRouter(health: HealthService): Router {
  const router = Router();

  // Liveness: the process is running and the event loop responds. No dependency checks, so an
  // orchestrator never restarts the API just because MongoDB is briefly unavailable.
  router.get('/live', (_req, res) => {
    res.json({ status: 'live', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/ready', readinessHandler(health));

  return router;
}

/**
 * Browser-facing copy of the readiness report. Content blockers' default filter lists (e.g.
 * uBlock Origin with EasyPrivacy) block monitoring-style paths such as `/health/*` even on
 * first-party requests, so the web app uses this neutral path instead.
 */
export function statusRouter(health: HealthService): Router {
  const router = Router();
  router.get('/', readinessHandler(health));
  return router;
}
