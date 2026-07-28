#!/usr/bin/env node
/**
 * macOS packaged / host binary smoke.
 *
 * When OKPGUI_MACOS_APP / OKPGUI_PACKAGE_SMOKE_APP is set, require a valid .app
 * binary and never fall back to the host tree. Host binary is only used when no
 * app env is configured (local developer smoke).
 *
 * Requires OKPGUI_DESKTOP_SMOKE_OUT smoke mode + valid report.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSmokeReport } from './validate-smoke-report.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @returns {{ bin: string, packaged: boolean }}
 */
function resolveBinary() {
  const appPath = process.env.OKPGUI_MACOS_APP || process.env.OKPGUI_PACKAGE_SMOKE_APP;
  if (appPath) {
    // App intent is explicit: fail closed — never fall back to host release binary.
    if (!fs.existsSync(appPath)) {
      console.error(`package-smoke(macos): OKPGUI_MACOS_APP does not exist: ${appPath}`);
      process.exit(1);
    }
    if (!appPath.endsWith('.app') && !appPath.endsWith('.app/')) {
      console.error(
        `package-smoke(macos): OKPGUI_MACOS_APP must be a .app bundle, got: ${appPath}`,
      );
      process.exit(1);
    }
    const name = path.basename(appPath.replace(/\/$/, ''), '.app');
    const candidates = [
      path.join(appPath, 'Contents', 'MacOS', 'okpgui-next'),
      path.join(appPath, 'Contents', 'MacOS', name),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { bin: candidate, packaged: true };
      }
    }
    console.error(
      `package-smoke(macos): invalid .app (no Contents/MacOS binary): ${appPath}\n` +
        `  looked for:\n${candidates.map((c) => `    - ${c}`).join('\n')}`,
    );
    process.exit(1);
  }

  const bin =
    process.env.OKPGUI_PACKAGE_SMOKE_BIN ||
    process.env.OKPGUI_HOST_BIN ||
    path.join(rootDir, 'src-tauri', 'target', 'release', 'okpgui-next');
  return { bin, packaged: false };
}

const { bin, packaged } = resolveBinary();
if (!fs.existsSync(bin)) {
  console.error(`package-smoke(macos): missing binary: ${bin}`);
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okpgui-package-smoke-'));
const outFile = path.join(outDir, 'smoke-report.json');
const env = {
  ...process.env,
  OKPGUI_DESKTOP_SMOKE_OUT: outFile,
};
if (packaged) {
  // Packaged CI/local .app: do not search repo MediaInfo fallbacks.
  env.OKPGUI_SMOKE_PACKAGED_ONLY = '1';
  env.OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR = '1';
}

const result = spawnSync(bin, [], {
  cwd: rootDir,
  stdio: 'inherit',
  env,
  timeout: 180_000,
});

if (result.error) {
  console.error(`package-smoke(macos): spawn failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`package-smoke(macos): binary exited ${result.status}`);
  process.exit(result.status ?? 1);
}

assertSmokeReport(outFile, 'package-smoke(macos)', {
  requirePackagedAppLayout: packaged,
});
console.log(
  packaged
    ? 'package-smoke(macos): ok (packaged .app)'
    : 'package-smoke(macos): ok (host binary)',
);
process.exit(0);
