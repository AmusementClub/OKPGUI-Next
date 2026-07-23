import { defineConfig, devices } from '@playwright/test';

/**
 * Browser/UI integration configuration for BYOK AI Preflight V2.
 *
 * These tests run against Vite with a deterministic mocked Tauri IPC/event bridge.
 * They are intentionally labeled UI integration — not desktop E2E, not WebDriver,
 * and not packaged-app automation. Windows/Linux desktop E2E and macOS packaged
 * smoke remain separate platform-limited gates when a real runner harness exists.
 */
export default defineConfig({
  testDir: './tests/ui-integration',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
