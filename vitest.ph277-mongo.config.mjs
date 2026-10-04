import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/ph277-mongo-performance.test.mjs'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
