import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/security/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/support/setup.ts'],
    testTimeout: 45000,
    hookTimeout: 45000,
    fileParallelism: false,
  },
});
