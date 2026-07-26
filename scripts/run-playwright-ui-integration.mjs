#!/usr/bin/env node
/**
 * Browser/UI integration runner (mocked Tauri IPC; not desktop E2E).
 *
 * Installs the browser matching the workspace-pinned Playwright version before
 * running the suite so clean CI runners do not depend on a pre-warmed cache.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function main() {
  const extraArgs = process.argv.slice(2);

  run('pnpm', ['exec', 'playwright', 'install', 'chromium']);
  run('pnpm', ['exec', 'playwright', 'test', ...extraArgs]);
}

main();
