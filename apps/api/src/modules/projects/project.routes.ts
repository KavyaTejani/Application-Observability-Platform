import { createProjectSchema, updateProjectSchema } from '@aop/validation';
import { Router } from 'express';
import { parseInput } from '../../lib/validate.js';
import {
  projectScopeOf,
  requireAuth,
  requireOrgScope,
  requireProjectScope,
  scopeOf,
} from '../../middleware/authenticate.js';
import { assertCan } from '../authz/tenant-scope.js';
import type { ProjectService } from './project.service.js';

/** Mounted at `/organizations/:organizationId/projects`. */
export function organizationProjectsRouter(projects: ProjectService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOrgScope);

  router.get('/', async (req, res) => {
    const scope = scopeOf(req);
    assertCan(scope, 'project:read');
    res.json({ projects: await projects.list(scope) });
  });

  router.post('/', async (req, res) => {
    const scope = scopeOf(req);
    assertCan(scope, 'project:create');
    const input = parseInput(createProjectSchema, req.body);
    res.status(201).json({ project: await projects.create(scope, input) });
  });

  return router;
}

/** Mounted at `/projects`. Each route resolves the project's organization server-side. */
export function projectRouter(projects: ProjectService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/:projectId', requireProjectScope, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'project:read');
    res.json({ project: await projects.get(scope) });
  });

  router.patch('/:projectId', requireProjectScope, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'project:update');
    const input = parseInput(updateProjectSchema, req.body);
    res.json({ project: await projects.rename(scope, input.name) });
  });

  router.delete('/:projectId', requireProjectScope, async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'project:delete');
    await projects.remove(scope);
    res.status(204).end();
  });

  return router;
}
