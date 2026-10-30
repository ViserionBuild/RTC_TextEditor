import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'shared/*/test/**/*.test.ts',
      'frontend/test/**/*.test.ts',
      'backend/test/**/*.test.ts',
    ],
    exclude: ['e2e/**', '**/node_modules/**'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['shared/*/src/**/*.ts', 'backend/src/**/*.ts'],
      exclude: ['backend/src/main.ts'],
      thresholds: { lines: 90 },
    },
  },
});
