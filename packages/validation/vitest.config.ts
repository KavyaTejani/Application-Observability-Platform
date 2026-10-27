import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'validation', include: ['src/**/*.test.ts'] },
});
