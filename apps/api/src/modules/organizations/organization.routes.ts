import { Router } from 'express';
import { authOf, requireAuth, requireOrgScope, scopeOf } from '../../middleware/authenticate.js';
import { assertCan } from '../authz/tenant-scope.js';
import { getOrganization, listMembers, listOrganizationsForUser } from './organization.service.js';

export function organizationRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json({ organizations: await listOrganizationsForUser(authOf(req).userId) });
  });

  router.get('/:organizationId', requireOrgScope, async (req, res) => {
    const scope = scopeOf(req);
    assertCan(scope, 'organization:read');
    res.json({ organization: await getOrganization(scope) });
  });

  router.get('/:organizationId/members', requireOrgScope, async (req, res) => {
    const scope = scopeOf(req);
    assertCan(scope, 'members:read');
    res.json({ members: await listMembers(scope) });
  });

  return router;
}
