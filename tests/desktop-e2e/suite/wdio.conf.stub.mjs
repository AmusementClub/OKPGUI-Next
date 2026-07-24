/**
 * WebdriverIO config STUB for Tauri 2 desktop-webdriver (Windows/Linux).
 *
 * STATUS: documentation / inventory only. Not executed by CI.
 * CRITICAL_FLOWS specs under tests/desktop-e2e/specs/*.md are markdown stubs —
 * not mocha/WDIO step files. run-desktop-e2e.mjs records desktop-webdriver as
 * blocked side-evidence when tools/specs are missing, and runs host-binary-smoke
 * separately (productionIpcMarker=false).
 *
 * Real desktop-webdriver pass requires:
 *   - built binary (DESKTOP_E2E_BINARY)
 *   - tauri-driver on PATH or TAURI_DRIVER
 *   - webdriverio / @wdio/cli present
 *   - executable WDIO specs (.mjs/.js/.ts), not markdown alone
 *   - productionIpcMarker: true only after real WebView IPC is observed
 *
 * Official: https://v2.tauri.app/develop/tests/webdriver/
 *
 * Never point this harness at Playwright mocked invoke.
 * Never treat host-binary-smoke as desktop-webdriver pass.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITICAL_FLOWS } from './critical-flows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../../..');

/** @type {import('webdriverio').Options} */
export const config = {
  // Hostname/port for tauri-driver (defaults documented by Tauri 2).
  hostname: process.env.TAURI_DRIVER_HOST || '127.0.0.1',
  port: Number(process.env.TAURI_DRIVER_PORT || 4444),
  path: '/',
  specs: CRITICAL_FLOWS.map((f) => path.join(rootDir, f.specRelPath)),
  maxInstances: 1,
  capabilities: [
    {
      // Application under test: built binary, never vite dev server as desktop proof.
      'tauri:options': {
        application: process.env.DESKTOP_E2E_BINARY,
      },
      maxInstances: 1,
    },
  ],
  logLevel: 'info',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180_000,
  },
  // Specs above are markdown documentation stubs until executable WDIO suites land.
  // Runner scripts treat missing executable suite as blocked evidence, not pass.
};
