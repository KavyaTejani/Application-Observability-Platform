import path from 'node:path';
import express, { Router } from 'express';

/** Paths owned by the API; they must keep returning JSON errors, never the SPA's HTML. */
const API_PREFIXES = ['/api/', '/health/', '/v1/'];

/**
 * Serves the built React app so the UI and API share one origin (the session cookie stays
 * first-party and `SameSite=Lax` works). Hashed assets are cached for a year; `index.html` is
 * never cached so a deploy takes effect immediately. Unknown non-API GETs fall back to
 * `index.html` for client-side routing.
 */
export function webAppRouter(distDir: string): Router {
  const root = path.resolve(distDir);
  const indexHtml = path.join(root, 'index.html');
  const router = Router();

  router.use(
    '/assets',
    express.static(path.join(root, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: false,
    }),
  );
  router.use(express.static(root, { index: false, maxAge: 0 }));

  router.get(/.*/, (req, res, next) => {
    const isApiPath = API_PREFIXES.some((prefix) => `${req.path}/`.startsWith(prefix));
    if (isApiPath || !req.accepts('html')) {
      next();
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  return router;
}
