import { defineConfig, devices } from '@playwright/test';

/**
 * The Playwright leg of `pnpm verify` (Spec section 15/16): 320px renders
 * without horizontal scroll, and both / and /demo deliver their content
 * with JavaScript disabled — which, at M0, means all of it, since the site
 * ships none.
 *
 * No `webServer` block here on purpose: scripts/e2e.mjs (the `pnpm e2e`
 * entry point) builds the site and manages the preview server's lifecycle
 * itself, because Playwright's own webServer teardown only kills its
 * direct child, and on Windows `pnpm --filter @lrd/site preview` is a
 * multi-level process tree (cmd -> pnpm -> node -> astro) whose innermost
 * process reliably survived as an orphan still holding the port —
 * reproduced twice while building this config. Run `pnpm e2e`, not
 * `npx playwright test` directly, unless a preview server is already up.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  outputDir: 'test-results/playwright',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
