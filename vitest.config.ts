import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/relay/src/**/*.ts'],
      exclude: ['apps/relay/src/main.ts'],
      thresholds: { lines: 90 },
    },
  },
});
