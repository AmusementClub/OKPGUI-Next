#!/usr/bin/env node
/**
 * Offline inventory gate for Playwright UI integration scaffolding.
 *
 * Labels this layer accurately as browser/UI integration (mocked Tauri IPC),
 * not desktop E2E. Does not launch browsers or claim packaged-app automation.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const REQUIRED_FILES = [
  'playwright.config.ts',
  'scripts/run-playwright-ui-integration.mjs',
  'tests/ui-integration/helpers/tauriBridge.ts',
  'tests/ui-integration/settings-capability.spec.ts',
  'tests/ui-integration/auto-template-handoff.spec.ts',
  'tests/ui-integration/confirmation-states.spec.ts',
  'tests/ui-integration/disabled-ai-no-side-effect.spec.ts',
];

const REQUIRED_MARKERS = {
  'playwright.config.ts': [
    'UI integration',
    'not desktop E2E',
    'webServer',
  ],
  'scripts/run-playwright-ui-integration.mjs': [
    'UI integration',
    'not desktop E2E',
    'playwright',
  ],
  'tests/ui-integration/helpers/tauriBridge.ts': [
    '__TAURI_INTERNALS__',
    'installTauriMock',
    'ai_get_settings',
    'prepare_plan',
    'publish_prepared_plan',
  ],
  'tests/ui-integration/settings-capability.spec.ts': [
    'UI integration',
    'capability',
    'ai_run_capability_probe',
  ],
  'tests/ui-integration/auto-template-handoff.spec.ts': [
    'UI integration',
    'auto_template',
    'seed',
  ],
  'tests/ui-integration/confirmation-states.spec.ts': [
    'UI integration',
    'acknowledgement',
    'ai-preflight-panel',
  ],
  'tests/ui-integration/disabled-ai-no-side-effect.spec.ts': [
    'UI integration',
    'enabled: false',
    'no-side-effect',
  ],
};

const FORBIDDEN_CLAIMS = [
  'desktop E2E automation',
  'real Tauri WebDriver',
  'packaged app E2E complete',
];

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main() {
  for (const rel of REQUIRED_FILES) {
    const abs = path.join(rootDir, rel);
    if (!existsSync(abs)) {
      die(`missing UI integration file: ${rel}`);
    }
    const text = readFileSync(abs, 'utf8');
    for (const marker of REQUIRED_MARKERS[rel] ?? []) {
      if (!text.includes(marker)) {
        die(`${rel}: missing marker ${JSON.stringify(marker)}`);
      }
    }
    for (const claim of FORBIDDEN_CLAIMS) {
      if (text.includes(claim)) {
        die(`${rel}: forbidden desktop E2E claim ${JSON.stringify(claim)}`);
      }
    }
  }

  const specDir = path.join(rootDir, 'tests', 'ui-integration');
  const specs = readdirSync(specDir).filter((name) => name.endsWith('.spec.ts'));
  if (specs.length < 4) {
    die(`expected at least 4 UI integration specs, found ${specs.length}`);
  }

  console.log('verify-ui-integration-inventory: ok');
  console.log(`  specs: ${specs.join(', ')}`);
  console.log('  layer: browser/UI integration with mocked Tauri IPC (not desktop E2E)');
}

main();
