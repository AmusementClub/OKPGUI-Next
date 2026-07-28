#!/usr/bin/env node
/**
 * Windows production executable smoke.
 *
 * Prefer OKPGUI_PACKAGE_SMOKE_BIN. Requires OKPGUI_DESKTOP_SMOKE_OUT smoke mode + valid report.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSmokeReport } from './validate-smoke-report.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe =
  process.env.OKPGUI_PACKAGE_SMOKE_BIN ||
  process.env.OKPGUI_HOST_BIN ||
  path.join(rootDir, 'src-tauri', 'target', 'release', 'okpgui-next.exe');

if (!fs.existsSync(exe)) {
  console.error(`package-smoke(windows): missing binary: ${exe}`);
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okpgui-package-smoke-'));
const outFile = path.join(outDir, 'smoke-report.json');
const result = spawnSync(exe, [], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    OKPGUI_DESKTOP_SMOKE_OUT: outFile,
  },
  timeout: 120_000,
});

if (result.error) {
  console.error(`package-smoke(windows): spawn failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`package-smoke(windows): binary exited ${result.status}`);
  process.exit(result.status ?? 1);
}

assertSmokeReport(outFile, 'package-smoke(windows)');
console.log('package-smoke(windows): ok');
process.exit(0);
