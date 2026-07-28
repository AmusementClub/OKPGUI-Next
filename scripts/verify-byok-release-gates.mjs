#!/usr/bin/env node
/**
 * Offline BYOK release-gate verifier.
 *
 * Structured configuration + coarse residue bans + one behavioral package-smoke
 * failure probe. Does not freeze workflow wording or runner source layout.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(relPath) {
  const abs = path.join(rootDir, relPath);
  if (!existsSync(abs)) {
    fail(`missing file: ${relPath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    fail(`${relPath}: invalid JSON (${error.message})`);
    return null;
  }
}

function checkMediaInfoPackage() {
  const verify = spawnSync(
    process.execPath,
    [path.join(rootDir, 'scripts', 'verify-mediainfo-package.mjs'), '--manifest-only'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  if (verify.status !== 0) {
    fail(
      `verify-mediainfo-package.mjs --manifest-only failed: ${(verify.stderr || verify.stdout || '').trim()}`,
    );
  }
}

function checkNoShellCapability() {
  const caps = readJson('src-tauri/capabilities/default.json');
  if (!caps) return;
  const permissions = caps.permissions;
  if (!Array.isArray(permissions)) {
    fail('src-tauri/capabilities/default.json: permissions must be an array');
    return;
  }
  const forbidden = permissions.flatMap((permission) => {
    const identifier = typeof permission === 'string'
      ? permission
      : permission && typeof permission === 'object' && typeof permission.identifier === 'string'
        ? permission.identifier
        : null;
    if (!identifier) return [];
    const normalized = identifier.toLowerCase();
    return normalized.includes('shell') || normalized.includes('execute') ? [identifier] : [];
  });
  if (forbidden.length > 0) {
    fail(
      `src-tauri/capabilities/default.json: forbids shell/execute permissions: ${forbidden.join(', ')}`,
    );
  }
}

function checkNoLegacyHarnessResidue() {
  const forbiddenPaths = [
    'tests/desktop-e2e',
    'scripts/run-desktop-e2e.mjs',
    'scripts/verify-ui-integration-inventory.mjs',
    'scripts/run-macos-packaged-smoke.mjs',
    'scripts/evidence-hash.mjs',
    'tests/desktop-e2e/suite/wdio.conf.stub.mjs',
    'tests/desktop-e2e/evidence.schema.json',
  ];
  for (const rel of forbiddenPaths) {
    if (existsSync(path.join(rootDir, rel))) {
      fail(`WebDriver/desktop-e2e residue must be removed: ${rel}`);
    }
  }
}

function runRepositoryHygiene() {
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'scripts', 'verify-repository-hygiene.mjs')],
    { cwd: rootDir, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    fail(`repository hygiene failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

/**
 * Behavioral fail-closed probe: package-smoke with no ambient smoke paths and a
 * nonexistent binary must exit nonzero (cannot greenwash /usr/bin/true or missing bins).
 */
function checkPackageSmokeFailsClosed() {
  const missingBin = path.join(
    rootDir,
    'scripts',
    `.byok-missing-smoke-bin-${process.pid}-${Date.now()}`,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'OKPGUI_PACKAGE_SMOKE_BIN' ||
      key === 'OKPGUI_APPIMAGE' ||
      key === 'OKPGUI_MACOS_APP' ||
      key === 'OKPGUI_PACKAGE_SMOKE_APP' ||
      key === 'OKPGUI_HOST_BIN' ||
      key === 'OKPGUI_SMOKE_PACKAGED_ONLY' ||
      key === 'OKPGUI_DESKTOP_SMOKE_OUT' ||
      key === 'OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR' ||
      key === 'OKPGUI_SMOKE_RESOURCE_DIR' ||
      key.startsWith('DESKTOP_E2E_')
    ) {
      delete env[key];
    }
  }
  // Force a missing binary path so host fallbacks cannot greenwash this probe.
  env.OKPGUI_PACKAGE_SMOKE_BIN = missingBin;

  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'scripts', 'run-package-smoke.mjs')],
    { cwd: rootDir, encoding: 'utf8', env },
  );
  if (result.status === 0) {
    fail(
      'package-smoke must exit nonzero when ambient smoke paths are cleared and binary is missing',
    );
  }
}

function main() {
  checkMediaInfoPackage();
  checkNoShellCapability();
  checkNoLegacyHarnessResidue();
  runRepositoryHygiene();
  checkPackageSmokeFailsClosed();

  if (errors.length > 0) {
    console.error('error: BYOK release gates failed:');
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(
    'OK: BYOK release gates (MediaInfo, no shell, residue ban, hygiene, package-smoke fail-closed)',
  );
}

main();
