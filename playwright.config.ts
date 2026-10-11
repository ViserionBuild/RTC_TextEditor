import { defineConfig } from '@playwright/test';

/**
 * Boots a fresh relay (in-memory DB) and the Vite dev server, then drives real browsers.
 * Locally: PW_CHANNEL=chrome uses the installed Chrome; CI installs Playwright's Chromium.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx src/main.ts',
      cwd: 'apps/relay',
      url: 'http://localhost:8787/healthz',
      env: { DB_PATH: ':memory:', PORT: '8787', LOG_LEVEL: 'warn' },
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      cwd: 'apps/web',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
    },
  ],
});
