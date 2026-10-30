import { defineConfig } from '@playwright/test';

/**
 * Boots a fresh relay (in-memory DB) and the Vite dev server, then drives real browsers.
 * Locally: PW_CHANNEL=chrome uses the installed Chrome; CI installs Playwright's Chromium.
 * E2E_BASE_URL=https://… runs the same tests against a deployment (e.g. `pnpm start`).
 */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: external ?? 'http://localhost:5173',
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: external
    ? []
    : [
        {
          command: 'npx tsx src/main.ts',
          cwd: 'backend',
          url: 'http://localhost:8787/healthz',
          env: { DB_PATH: ':memory:', PORT: '8787', LOG_LEVEL: 'warn' },
          reuseExistingServer: false,
        },
        {
          command: 'npx vite --port 5173 --strictPort',
          cwd: 'frontend',
          url: 'http://localhost:5173',
          reuseExistingServer: false,
        },
      ],
});
