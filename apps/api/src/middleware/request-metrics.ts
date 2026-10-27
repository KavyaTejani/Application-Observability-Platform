import type { Request, RequestHandler } from 'express';
import type { PlatformMetrics } from '../observability/platform-metrics.js';

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Route template for metric labels, e.g. `/api/v1/projects/:projectId`. Requests that matched
 * no route share one label so scanners probing random paths cannot create unbounded series.
 */
export function routeTemplate(req: Request): string {
  const routePath: unknown = req.route?.path;
  if (typeof routePath !== 'string') return '__unmatched__';
  return `${req.baseUrl}${routePath}` || '/';
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function requestMetrics(metrics: PlatformMetrics): RequestHandler {
  return (req, res, next) => {
    const stopTimer = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const labels = {
        method: KNOWN_METHODS.has(req.method) ? req.method : 'OTHER',
        route: routeTemplate(req),
        status_class: statusClass(res.statusCode),
      };
      metrics.httpRequests.inc(labels);
      stopTimer(labels);
    });
    next();
  };
}
