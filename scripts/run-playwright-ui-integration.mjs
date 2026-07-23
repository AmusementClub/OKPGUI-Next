#!/usr/bin/env node
/**
 * Browser/UI integration runner (mocked Tauri IPC; not desktop E2E).
 *
 * Resolves `@playwright/test` from the workspace when present, otherwise
 * falls back to `npm exec` so `pnpm install --frozen-lockfile` remains valid
 * without committing a Playwright lock entry from this offline modify lane.
 *
 * Host verification may also run `pnpm exec playwright test` after adding the
 * dependency locally; this script is the deterministic package.json entrypoint.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const PLAYWRIGHT_VERSION = '1.54.2';

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function hasLocalPlaywright() {
  try {
    require.resolve('@playwright/test/package.json');
    return true;
  } catch {
    return existsSync(path.join(rootDir, 'node_modules', '@playwright', 'test'));
  }
}

function main() {
  const extraArgs = process.argv.slice(2);

  if (hasLocalPlaywright()) {
    // Prefer workspace install when Codex/host has added the dependency.
    run('pnpm', ['exec', 'playwright', 'test', ...extraArgs]);
    return;
  }

  console.log(
    `[ui-integration] @playwright/test not in node_modules; using npm exec @playwright/test@${PLAYWRIGHT_VERSION} (browser/UI integration only, not desktop E2E)`,
  );
  run('npm', [
    'exec',
    '--yes',
    `--package=@playwright/test@${PLAYWRIGHT_VERSION}`,
    '--',
    'playwright',
    'install',
    'chromium',
  ]);
  run('npm', [
    'exec',
    '--yes',
    `--package=@playwright/test@${PLAYWRIGHT_VERSION}`,
    '--',
    'playwright',
    'test',
    ...extraArgs,
  ]);
}

main();
