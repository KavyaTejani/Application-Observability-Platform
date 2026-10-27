import { logQuerySchema, metricQuerySchema, metricSummarySchema } from '@aop/validation';
import { Router } from 'express';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { parseInput } from '../../lib/validate.js';
import {
  authOf,
  projectScopeOf,
  requireAuth,
  requireProjectScope,
} from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { assertCan } from '../authz/tenant-scope.js';
import type { LogsQueryService } from './logs-query.service.js';
import type { MetricsQueryService } from './metrics-query.service.js';

export interface QueryRouterDeps {
  metricsQuery: MetricsQueryService;
  logsQuery: LogsQueryService;
  limiter: RateLimiter;
}

/**
 * Telemetry read API, mounted at `/projects/:projectId`. Every handler runs with a ProjectScope
 * resolved from the session plus the project's own organization, so the tenant used for the
 * backend query never comes from the request.
 */
export function queryRouter({ metricsQuery, logsQuery, limiter }: QueryRouterDeps): Router {
  const router = Router({ mergeParams: true });
  // Attached per route, not with router.use(): this router shares the `/projects/:projectId`
  // prefix with project CRUD, which must not consume the query rate limit.
  const guard = [
    requireAuth,
    // Bound backend load per user: dashboards issue several queries per refresh.
    rateLimit(limiter, [
      {
        name: 'query:user',
        limit: 240,
        windowSeconds: 60,
        key: (req) => authOf(req).userId.toHexString(),
      },
    ]),
    requireProjectScope,
  ];

  router.get('/metrics/summary', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'telemetry:read');
    const input = parseInput(metricSummarySchema, req.query);
    res.json({ summary: await metricsQuery.summary(scope, input.range, input.serviceName) });
  });

  router.post('/metrics/query', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'telemetry:read');
    const query = parseInput(metricQuerySchema, req.body);
    res.json(await metricsQuery.query(scope, query));
  });

  router.get('/logs', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'telemetry:read');
    const query = parseInput(logQuerySchema, req.query);
    res.json(await logsQuery.search(scope, query));
  });

  router.get('/services', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'telemetry:read');
    // Filter options are best effort: one backend being down must not break the page.
    const [fromMetrics, fromLogs] = await Promise.allSettled([
      metricsQuery.services(scope),
      logsQuery.services(scope),
    ]);
    const names = new Set<string>();
    for (const result of [fromMetrics, fromLogs]) {
      if (result.status === 'fulfilled') for (const name of result.value) names.add(name);
    }
    res.json({ services: [...names].sort() });
  });

  return router;
}
