import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    pool: 'forks',
  },
});
