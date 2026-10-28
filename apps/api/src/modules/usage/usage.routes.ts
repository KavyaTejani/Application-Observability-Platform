import { Router } from 'express';
import { requireAuth, requireOrgScope, scopeOf } from '../../middleware/authenticate.js';
import { assertCan } from '../authz/tenant-scope.js';
import { getUsage } from './usage.service.js';

/** Mounted at `/organizations/:organizationId/usage`. Owners and members can read it. */
export function usageRouter(now: () => Date): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOrgScope);

  router.get('/', async (req, res) => {
    const scope = scopeOf(req);
    assertCan(scope, 'usage:read');
    res.json({ usage: await getUsage(scope, now()) });
  });

  return router;
}
