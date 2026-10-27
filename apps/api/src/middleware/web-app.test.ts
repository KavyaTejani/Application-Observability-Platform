import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../test/test-app.js';

describe('web app serving', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(path.join(tmpdir(), 'aop-web-'));
    mkdirSync(path.join(distDir, 'assets'));
    writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  });
  afterAll(() => rmSync(distDir, { recursive: true, force: true }));

  const app = () => buildTestApp({ config: { webDistDir: distDir } }).app;

  it('serves index.html for client-side routes without caching it', async () => {
    const res = await request(app()).get('/projects/123').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets with long-lived caching', async () => {
    const res = await request(app()).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('returns 404 for a missing asset instead of the HTML shell', async () => {
    const res = await request(app()).get('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('keeps JSON 404s for unknown API paths', async () => {
    const res = await request(app()).get('/api/v1/unknown').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('still answers health checks', async () => {
    const res = await request(app()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('live');
  });
});
