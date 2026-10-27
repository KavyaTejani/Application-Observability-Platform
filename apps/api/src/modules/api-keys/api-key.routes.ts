import { createApiKeySchema, rotateApiKeySchema } from '@aop/validation';
import { Router } from 'express';
import { notFound } from '../../lib/errors.js';
import { parseInput } from '../../lib/validate.js';
import { projectScopeOf, requireAuth, requireProjectScope } from '../../middleware/authenticate.js';
import { assertCan } from '../authz/tenant-scope.js';
import type { ApiKeyService } from './api-key.service.js';

const KEY_ID = /^[a-f0-9]{16}$/;

/** `:keyId` is the public, non-secret key identifier (PRD §12.3). */
function keyIdParam(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID.test(value)) throw notFound('API key not found.');
  return value;
}

/** Mounted at `/projects/:projectId/keys`. */
export function apiKeyRouter(apiKeys: ApiKeyService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireProjectScope);

  // Secrets are never stored, so even owners only ever see metadata here.
  router.get('/', async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'apiKey:read');
    res.json({ keys: await apiKeys.list(scope) });
  });

  router.post('/', async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'apiKey:manage');
    const input = parseInput(createApiKeySchema, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await apiKeys.create(scope, input.name));
  });

  router.post('/:keyId/revoke', async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'apiKey:manage');
    res.json({ key: await apiKeys.revoke(scope, keyIdParam(req.params.keyId)) });
  });

  router.post('/:keyId/rotate', async (req, res) => {
    const scope = projectScopeOf(req);
    assertCan(scope, 'apiKey:manage');
    const input = parseInput(rotateApiKeySchema, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await apiKeys.rotate(scope, keyIdParam(req.params.keyId), input.gracePeriodHours));
  });

  return router;
}
