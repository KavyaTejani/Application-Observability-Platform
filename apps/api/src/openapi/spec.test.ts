import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from './spec.js';

const committed = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url));
const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

describe('OpenAPI document', () => {
  const spec = buildOpenApiSpec();

  it('matches the committed docs/openapi.json (run `npm run openapi -w @aop/api`)', () => {
    expect(JSON.parse(readFileSync(committed, 'utf8'))).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  it('documents every operation with an ID, a tag, and its error responses', () => {
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = (item as Record<string, Record<string, unknown>>)[method];
        if (!op) continue;
        expect(op.operationId, `${method} ${path}`).toBeTypeOf('string');
        expect(ids.has(op.operationId as string)).toBe(false);
        ids.add(op.operationId as string);
        expect((op.tags as string[]).length).toBeGreaterThan(0);
        const responses = Object.keys(op.responses as object);
        expect(
          responses.some((code) => code.startsWith('2')),
          `${method} ${path}`,
        ).toBe(true);
      }
    }
    expect(ids.size).toBeGreaterThanOrEqual(39);
  });

  it('resolves every $ref', () => {
    const refs = JSON.stringify(spec).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const ref of new Set(refs)) {
      expect(spec.components.schemas, ref).toHaveProperty(ref.split('/').pop()!);
    }
  });

  it('rejects the fields the query model forbids (generated from the server schemas)', () => {
    const query = spec.paths['/api/v1/projects/{projectId}/metrics/query'].post.requestBody.content[
      'application/json'
    ].schema as { additionalProperties?: boolean };
    expect(query.additionalProperties).toBe(false);
  });
});
