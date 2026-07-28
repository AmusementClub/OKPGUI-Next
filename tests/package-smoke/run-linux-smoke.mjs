#!/usr/bin/env node
/**
 * Linux AppImage / host binary smoke.
 *
 * Prefer OKPGUI_APPIMAGE (final AppImage) or OKPGUI_PACKAGE_SMOKE_BIN.
 * Requires the binary to enter OKPGUI_DESKTOP_SMOKE_OUT mode and write a valid report.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSmokeReport } from './validate-smoke-report.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin =
  process.env.OKPGUI_APPIMAGE ||
  process.env.OKPGUI_PACKAGE_SMOKE_BIN ||
  process.env.OKPGUI_HOST_BIN ||
  path.join(rootDir, 'src-tauri', 'target', 'release', 'okpgui-next');

if (!fs.existsSync(bin)) {
  console.error(`package-smoke(linux): missing binary: ${bin}`);
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okpgui-package-smoke-'));
const outFile = path.join(outDir, 'smoke-report.json');
const result = spawnSync(bin, [], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    OKPGUI_DESKTOP_SMOKE_OUT: outFile,
  },
  timeout: 180_000,
});

if (result.error) {
  console.error(`package-smoke(linux): spawn failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`package-smoke(linux): binary exited ${result.status}`);
  process.exit(result.status ?? 1);
}

assertSmokeReport(outFile, 'package-smoke(linux)');
console.log('package-smoke(linux): ok');
process.exit(0);
