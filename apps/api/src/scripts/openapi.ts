/**
 * Writes the OpenAPI document to docs/openapi.json.
 *
 *   npm run openapi -w @aop/api
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../openapi/spec.js';

export const OPENAPI_PATH = fileURLToPath(
  new URL('../../../../docs/openapi.json', import.meta.url),
);

writeFileSync(OPENAPI_PATH, `${JSON.stringify(buildOpenApiSpec(), null, 2)}\n`);
process.stdout.write(`Wrote ${OPENAPI_PATH}\n`);
