import {
  createAlertRuleSchema,
  createDestinationSchema,
  incidentListSchema,
  updateAlertRuleSchema,
  updateDestinationSchema,
} from '@aop/validation';
import { Router } from 'express';
import type { RateLimiter } from '../../lib/rate-limiter.js';
import { parseInput } from '../../lib/validate.js';
import {
  authOf,
  projectScopeOf,
  requireAuth,
  requireOrgScope,
  requireProjectScope,
  scopeOf,
} from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { assertCan } from '../authz/tenant-scope.js';
import type { AlertService } from './alert.service.js';

/** `/projects/:projectId/alert-rules` and `/projects/:projectId/incidents` (PRD §12.7). */
export function projectAlertsRouter(alerts: AlertService): Router {
  const router = Router({ mergeParams: true });
  const guard = [requireAuth, requireProjectScope];

  router.get('/alert-rules', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'telemetry:read');
    res.json({ rules: await alerts.listRules(scope) });
  });

  router.post('/alert-rules', ...guard, async (req, res) => {
    const input = parseInput(createAlertRuleSchema, req.body);
    res.status(201).json({ rule: await alerts.createRule(projectScopeOf(req), input) });
  });

  router.get('/incidents', ...guard, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'incident:read');
    const input = parseInput(incidentListSchema, req.query);
    res.json({ incidents: await alerts.listIncidents(scope, input.status, input.limit) });
  });

  return router;
}

/** `/alert-rules/:alertRuleId` */
export function alertRuleRouter(alerts: AlertService): Router {
  const router = Router();
  router.use(requireAuth);
  router.patch('/:alertRuleId', async (req, res) => {
    const input = parseInput(updateAlertRuleSchema, req.body);
    res.json({ rule: await alerts.updateRule(authOf(req).userId, req.params.alertRuleId, input) });
  });
  router.delete('/:alertRuleId', async (req, res) => {
    await alerts.deleteRule(authOf(req).userId, req.params.alertRuleId);
    res.status(204).end();
  });
  return router;
}

/** `/incidents/:incidentId` */
export function incidentRouter(alerts: AlertService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/:incidentId', async (req, res) => {
    res.json({ incident: await alerts.getIncident(authOf(req).userId, req.params.incidentId) });
  });
  router.get('/:incidentId/deliveries', async (req, res) => {
    res.json({
      deliveries: await alerts.listDeliveries(authOf(req).userId, req.params.incidentId),
    });
  });
  return router;
}

/** `/organizations/:organizationId/notification-destinations` (PRD §12.7.1) */
export function organizationDestinationsRouter(alerts: AlertService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOrgScope);
  router.get('/', async (req, res) => {
    res.json({ destinations: await alerts.listDestinations(scopeOf(req)) });
  });
  router.post('/', async (req, res) => {
    const input = parseInput(createDestinationSchema, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await alerts.createDestination(scopeOf(req), input));
  });
  return router;
}

/** `/notification-destinations/:destinationId` */
export function destinationRouter(alerts: AlertService, limiter: RateLimiter): Router {
  const router = Router();
  router.use(requireAuth);
  router.patch('/:destinationId', async (req, res) => {
    const input = parseInput(updateDestinationSchema, req.body);
    res.json({
      destination: await alerts.updateDestination(
        authOf(req).userId,
        req.params.destinationId,
        input,
      ),
    });
  });
  router.delete('/:destinationId', async (req, res) => {
    await alerts.deleteDestination(authOf(req).userId, req.params.destinationId);
    res.status(204).end();
  });
  router.post(
    '/:destinationId/test',
    rateLimit(limiter, [
      {
        name: 'destination-test:user',
        limit: 10,
        windowSeconds: 300,
        key: (req) => authOf(req).userId.toHexString(),
      },
    ]),
    async (req, res) => {
      const result = await alerts.testDestination(authOf(req).userId, req.params.destinationId);
      res.json({ result });
    },
  );
  return router;
}
