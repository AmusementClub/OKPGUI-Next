#!/usr/bin/env node
/**
 * macOS packaged smoke (x64 / arm64) — Milestone 6.
 *
 * Prefers a packaged .app (Contents/MacOS + layout probes) over a raw release
 * executable. Proves production binary paths + MediaInfo spawn when packaged.
 * Does NOT claim full UI WebDriver E2E or productionIpcMarker (WebView IPC).
 *
 * Offline-friendly: if the packaged binary is missing, writes blocked evidence
 * with explicit limitation text. Default exit non-zero on blocked.
 *
 * Env:
 *   DESKTOP_E2E_BINARY / MACOS_PACKAGED_APP  Packaged binary or .app path
 *   DESKTOP_E2E_PACKAGE                      Optional package/archive/.app path
 *   DESKTOP_E2E_TARGET                       Override triple
 *   DESKTOP_E2E_OUT                          Evidence output dir
 *   DESKTOP_E2E_ALLOW_BLOCKED=1              Exit 0 after blocked evidence (CI upload)
 *   DESKTOP_E2E_REQUIRE_PASS=1               Exit non-zero unless result=pass
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MACOS_PACKAGED_SMOKE_PROBES,
  skippedMacosSmokeTests,
} from '../tests/desktop-e2e/suite/critical-flows.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outDir = process.env.DESKTOP_E2E_OUT
  ? path.resolve(process.env.DESKTOP_E2E_OUT)
  : path.join(rootDir, 'tests', 'desktop-e2e', 'out');

const MACOS_LIMITATION =
  'macOS UI WebDriver automation is limited/unsupported for full desktop E2E under Tauri 2. ' +
  'This harness is macos-packaged-smoke: prefer packaged .app launch, verify bundle layout, ' +
  'and probe production binary paths + MediaInfo spawn + keyring session-only policy. ' +
  'productionIpcMarker stays false (no WebView IPC). ' +
  'See https://v2.tauri.app/develop/tests/webdriver/ and tests/desktop-e2e/README.md.';

function nowIso() {
  return new Date().toISOString();
}

function gitCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status === 0 && result.stdout?.trim()) {
    return result.stdout.trim();
  }
  return process.env.GITHUB_SHA || process.env.COMMIT_SHA || 'unknown-commit';
}

function resolveTargetTriple() {
  if (process.env.DESKTOP_E2E_TARGET) {
    return process.env.DESKTOP_E2E_TARGET;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `${arch}-apple-darwin`;
}

function sha256File(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return 'not-built';
  }
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function writeEvidence(evidence) {
  mkdirSync(outDir, { recursive: true });
  const triple = evidence.targetTriple.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = path.join(outDir, `evidence-${triple}.json`);
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return outPath;
}

function exitAfterEvidence(evidencePath, message, result) {
  const allowBlocked = process.env.DESKTOP_E2E_ALLOW_BLOCKED === '1';
  const requirePass = process.env.DESKTOP_E2E_REQUIRE_PASS === '1';

  if (result === 'pass') {
    console.log('[macos-packaged-smoke] pass');
    console.log(`  evidence: ${path.relative(rootDir, evidencePath)}`);
    process.exit(0);
  }

  console.error(
    'error: macos packaged smoke blocked or failed (fail-closed honesty)',
  );
  console.error(`  ${message}`);
  console.error(`  evidence: ${path.relative(rootDir, evidencePath)}`);
  console.error(
    '  note: mocked Playwright is not packaged-smoke or desktop E2E evidence',
  );

  if (requirePass) {
    process.exit(result === 'fail' ? 1 : 2);
  }
  if (allowBlocked && result === 'blocked') {
    console.error(
      '  DESKTOP_E2E_ALLOW_BLOCKED=1: exiting 0 so CI can upload blocked evidence (not a pass claim)',
    );
    process.exit(0);
  }
  process.exit(result === 'fail' ? 1 : 2);
}

/**
 * Resolve macOS binary path: prefer .app bundle, then env, then raw release.
 * Returns executable path or ''.
 */
function resolveBinaryPath() {
  const envBinary = process.env.DESKTOP_E2E_BINARY || '';
  const envApp = process.env.MACOS_PACKAGED_APP || '';
  const packagePath = process.env.DESKTOP_E2E_PACKAGE || '';

  /** @type {string[]} */
  const appBundles = [];
  for (const p of [packagePath, envApp, envBinary]) {
    if (p && p.endsWith('.app') && existsSync(p)) appBundles.push(p);
  }

  // Env binary already inside .app
  if (envBinary.includes('.app/Contents/MacOS/') && existsSync(envBinary)) {
    return envBinary;
  }

  const releaseDir = path.join(rootDir, 'src-tauri', 'target', 'release');
  const bundleMacos = path.join(releaseDir, 'bundle', 'macos');
  if (existsSync(bundleMacos)) {
    try {
      for (const name of readdirSync(bundleMacos)) {
        if (name.endsWith('.app')) {
          appBundles.push(path.join(bundleMacos, name));
        }
      }
    } catch {
      // ignore unreadable bundle dir
    }
  }

  for (const app of appBundles) {
    const base = path.basename(app, '.app');
    for (const cand of [
      path.join(app, 'Contents', 'MacOS', 'okpgui-next'),
      path.join(app, 'Contents', 'MacOS', base),
    ]) {
      if (existsSync(cand)) return cand;
    }
  }

  // Raw binary fallbacks (host layout — weaker than packaged .app).
  for (const c of [envBinary, envApp, path.join(releaseDir, 'okpgui-next')]) {
    if (c && existsSync(c) && !c.endsWith('.app')) return c;
  }
  return '';
}

function main() {
  const startedAt = nowIso();
  const targetTriple = resolveTargetTriple();

  console.log('[macos-packaged-smoke] Milestone 6 packaged smoke runner');
  console.log(`[macos-packaged-smoke] ${MACOS_LIMITATION}`);
  console.log(
    `[macos-packaged-smoke] probes: ${MACOS_PACKAGED_SMOKE_PROBES.map((p) => p.id).join(', ')}`,
  );

  if (process.platform !== 'darwin') {
    const evidence = {
      commitSha: gitCommitSha(),
      targetTriple,
      harnessType: 'macos-packaged-smoke',
      binarySha256: 'not-built',
      productionIpcMarker: false,
      productionBinaryMarker: false,
      namedTests: [
        {
          name: 'platform-check',
          result: 'skipped',
          detail: `Host platform is ${process.platform}; macOS packaged smoke requires darwin.`,
        },
        ...skippedMacosSmokeTests(`Host is ${process.platform}.`),
      ],
      result: 'blocked',
      timestamps: { startedAt, finishedAt: nowIso() },
      artifactPaths: [],
      notes: `Not running on macOS (host=${process.platform}). ${MACOS_LIMITATION}`,
    };
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(
      evidencePath,
      'macos packaged smoke blocked — host is not darwin',
      'blocked',
    );
    return;
  }

  const binaryPath = resolveBinaryPath();
  const packagePath = process.env.DESKTOP_E2E_PACKAGE || '';

  if (!binaryPath) {
    const evidence = {
      commitSha: gitCommitSha(),
      targetTriple,
      harnessType: 'macos-packaged-smoke',
      binarySha256: 'not-built',
      ...(packagePath ? { packageSha256: sha256File(packagePath) } : {}),
      productionIpcMarker: false,
      productionBinaryMarker: false,
      namedTests: skippedMacosSmokeTests(
        'Blocked: no packaged binary. Set DESKTOP_E2E_BINARY, MACOS_PACKAGED_APP, or build a .app under target/release/bundle/macos.',
      ),
      result: 'blocked',
      timestamps: { startedAt, finishedAt: nowIso() },
      artifactPaths: [],
      notes:
        `${MACOS_LIMITATION} Binary not present in this checkout; evidence blocked. ` +
        'Do not treat mocked Playwright as desktop or packaged-smoke pass.',
    };
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(
      evidencePath,
      'macos packaged smoke blocked — packaged binary missing',
      'blocked',
    );
    return;
  }

  const executableSuite = path.join(
    rootDir,
    'tests',
    'desktop-e2e',
    'suite',
    'run-macos-smoke.execute.mjs',
  );
  if (!existsSync(executableSuite)) {
    const notes = `${MACOS_LIMITATION} Execute suite missing: ${executableSuite}`;
    const evidence = {
      commitSha: gitCommitSha(),
      targetTriple,
      harnessType: 'macos-packaged-smoke',
      binarySha256: sha256File(binaryPath),
      productionIpcMarker: false,
      productionBinaryMarker: false,
      namedTests: skippedMacosSmokeTests(notes),
      result: 'blocked',
      timestamps: { startedAt, finishedAt: nowIso() },
      artifactPaths: [binaryPath],
      notes,
    };
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(evidencePath, notes, 'blocked');
    return;
  }

  const fromApp = binaryPath.includes('.app/Contents/MacOS/');
  console.log(
    `[macos-packaged-smoke] binary present (${fromApp ? 'packaged .app' : 'host/raw'}) — running execute suite (${binaryPath})`,
  );
  const result = spawnSync(process.execPath, [executableSuite], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      DESKTOP_E2E_BINARY: binaryPath,
      DESKTOP_E2E_PACKAGE: packagePath || (fromApp
        ? binaryPath.slice(0, binaryPath.indexOf('.app/') + 4)
        : ''),
      DESKTOP_E2E_TARGET: targetTriple,
      DESKTOP_E2E_OUT: outDir,
      DESKTOP_E2E_HARNESS_TYPE: 'macos-packaged-smoke',
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === null ? 1 : result.status);
}

main();
