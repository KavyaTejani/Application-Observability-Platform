import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'node-sdk', include: ['src/**/*.test.ts'] },
});
