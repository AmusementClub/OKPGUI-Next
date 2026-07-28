#!/usr/bin/env node
/**
 * Package smoke for built artifacts (Windows EXE, Linux AppImage, macOS .app).
 * Exit status + CI logs are the evidence surface — no parallel evidence JSON product.
 *
 * Not WebDriver UI automation and not mocked Playwright IPC.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform;

function run(scriptRel, args = []) {
  const scriptPath = path.join(rootDir, scriptRel);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (platform === 'darwin') {
  run('tests/package-smoke/run-macos-smoke.mjs', process.argv.slice(2));
} else if (platform === 'win32') {
  run('tests/package-smoke/run-windows-smoke.mjs', process.argv.slice(2));
} else if (platform === 'linux') {
  run('tests/package-smoke/run-linux-smoke.mjs', process.argv.slice(2));
} else {
  console.error(`package-smoke: unsupported platform ${platform}`);
  process.exit(1);
}
