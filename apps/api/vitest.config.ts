import { defaultServerConditions } from 'vite';
import { defineProject } from 'vitest/config';

// `source` resolves workspace packages to their TypeScript source, so tests never need a build.
const conditions = ['source', ...defaultServerConditions];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests share one MongoDB/Redis instance; files run serially to keep it simple.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
