#!/usr/bin/env node
/**
 * Desktop E2E runner (Tauri 2 WebDriver on Windows/Linux) — Milestone 6.
 *
 * Offline-friendly and fail-closed:
 *   - Detects platform and required tools/binary
 *   - Writes evidence JSON with result "blocked" when harness cannot run
 *   - Enumerates named critical flows from tests/desktop-e2e/suite/critical-flows.mjs
 *   - NEVER labels mocked Playwright as desktop E2E
 *   - productionIpcMarker is true ONLY for real WebView WebDriver IPC (not host smoke)
 *   - Host binary smoke is a separate harnessType (host-binary-smoke)
 *   - Does not install network packages or call paid providers
 *
 * Flow when binary is present on Windows/Linux:
 *   1. Always run host-binary-smoke execute suite (production Rust in built binary)
 *   2. If tauri-driver + WebdriverIO are present, also attempt desktop-webdriver
 *      (currently specs are documentation stubs — attempt records blocked/fail honestly)
 *
 * Official doc: https://v2.tauri.app/develop/tests/webdriver/
 *
 * Env:
 *   DESKTOP_E2E_BINARY     Built app binary (required for real run)
 *   DESKTOP_E2E_PACKAGE    Optional installer/package path
 *   DESKTOP_E2E_TARGET     Override target triple
 *   DESKTOP_E2E_OUT        Evidence output directory
 *   TAURI_DRIVER           Path to tauri-driver executable
 *   DESKTOP_E2E_MOCK_PROVIDER_URL  Loopback mock base URL
 *   DESKTOP_E2E_ALLOW_BLOCKED=1    Exit 0 after writing blocked evidence (CI upload path)
 *   DESKTOP_E2E_REQUIRE_PASS=1     Exit non-zero unless result=pass
 *   DESKTOP_E2E_SKIP_HOST_SMOKE=1  Skip host binary smoke (WebDriver-only attempt)
 *   DESKTOP_E2E_ATTEMPT_WDIO=1     Force WDIO attempt even when tools missing (writes blocked)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256RegularFile } from './evidence-hash.mjs';
import {
  CRITICAL_FLOWS,
  FIXTURE_PROFILE_REL,
  skippedCriticalFlowTests,
} from '../tests/desktop-e2e/suite/critical-flows.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outDir = process.env.DESKTOP_E2E_OUT
  ? path.resolve(process.env.DESKTOP_E2E_OUT)
  : path.join(rootDir, 'tests', 'desktop-e2e', 'out');

const PLATFORM_TRIPLES = {
  win32: 'x86_64-pc-windows-msvc',
  linux: 'x86_64-unknown-linux-gnu',
  darwin: null,
};

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

function resolveDarwinTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `${arch}-apple-darwin`;
}

function resolveTargetTriple() {
  if (process.env.DESKTOP_E2E_TARGET) {
    return process.env.DESKTOP_E2E_TARGET;
  }
  if (process.platform === 'darwin') {
    return resolveDarwinTriple();
  }
  return PLATFORM_TRIPLES[process.platform] || `unknown-${process.platform}`;
}

function commandExists(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [name], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function writeEvidence(evidence) {
  mkdirSync(outDir, { recursive: true });
  const triple = evidence.targetTriple.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = path.join(outDir, `evidence-${triple}.json`);
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return outPath;
}

function loadFixtureProfile() {
  const abs = path.join(rootDir, FIXTURE_PROFILE_REL);
  if (!existsSync(abs)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function blockedEvidence({
  targetTriple,
  harnessType,
  notes,
  namedTests,
  binaryPath,
  packagePath,
  artifactPaths = [],
}) {
  const startedAt = nowIso();
  const finishedAt = nowIso();
  const packageSha256 = sha256RegularFile(packagePath);
  return {
    commitSha: gitCommitSha(),
    targetTriple,
    harnessType,
    binarySha256: sha256RegularFile(binaryPath) || 'not-built',
    ...(packageSha256 ? { packageSha256 } : {}),
    productionIpcMarker: false,
    productionBinaryMarker: false,
    namedTests,
    result: 'blocked',
    timestamps: { startedAt, finishedAt },
    artifactPaths,
    notes,
  };
}

function exitAfterEvidence(evidencePath, message, result) {
  const allowBlocked = process.env.DESKTOP_E2E_ALLOW_BLOCKED === '1';
  const requirePass = process.env.DESKTOP_E2E_REQUIRE_PASS === '1';

  if (result === 'pass') {
    console.log('[desktop-e2e] pass');
    console.log(`  evidence: ${path.relative(rootDir, evidencePath)}`);
    process.exit(0);
  }

  console.error('error: desktop E2E blocked or failed (fail-closed honesty)');
  console.error(`  ${message}`);
  console.error(`  evidence: ${path.relative(rootDir, evidencePath)}`);
  console.error(
    '  note: mocked Playwright (tests/ui-integration) is browser/UI integration only — not desktop E2E',
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

function runDarwin() {
  const targetTriple = resolveTargetTriple();
  console.log(
    `[desktop-e2e] platform=darwin target=${targetTriple}: UI WebDriver is platform-limited on macOS.`,
  );
  console.log(
    '[desktop-e2e] Use packaged smoke instead: node scripts/run-macos-packaged-smoke.mjs',
  );
  console.log(
    '[desktop-e2e] (pnpm run test:macos-packaged-smoke). This runner does not claim desktop-webdriver on Darwin.',
  );

  const namedTests = [
    {
      name: 'desktop-webdriver-automation',
      result: 'skipped',
      detail: 'Not automated on macOS; see macos-packaged-smoke harness.',
    },
    ...skippedCriticalFlowTests(
      'Darwin is not desktop-webdriver; deferred to macos-packaged-smoke.',
    ),
  ];

  const evidence = blockedEvidence({
    targetTriple,
    harnessType: 'macos-packaged-smoke',
    notes:
      'macOS: Tauri 2 UI WebDriver automation is limited/unsupported for full desktop E2E. ' +
      'Use scripts/run-macos-packaged-smoke.mjs for packaged .app launch + production binary/sidecar/keyring probes. ' +
      'run-desktop-e2e.mjs refuses to label Darwin as desktop-webdriver pass. ' +
      'Mocked Playwright is not desktop E2E. productionIpcMarker stays false without WebView IPC.',
    namedTests,
    binaryPath: process.env.DESKTOP_E2E_BINARY,
    packagePath: process.env.DESKTOP_E2E_PACKAGE,
  });
  const evidencePath = writeEvidence(evidence);
  exitAfterEvidence(
    evidencePath,
    'Darwin is not fully automated via desktop WebDriver; packaged smoke is the macOS path.',
    'blocked',
  );
}

/**
 * Probe whether real WebDriver tools are available (tauri-driver + wdio).
 * Specs remain markdown stubs until executable WDIO suites land — we never claim
 * desktop-webdriver pass from host-binary smoke.
 */
function webdriverToolsStatus() {
  const tauriDriver =
    process.env.TAURI_DRIVER ||
    (commandExists('tauri-driver') ? 'tauri-driver' : '');
  const hasTauriDriver =
    Boolean(tauriDriver) &&
    (tauriDriver === 'tauri-driver' ? commandExists('tauri-driver') : existsSync(tauriDriver));

  // Prefer local node_modules webdriverio without requiring global install.
  const wdioCli = path.join(rootDir, 'node_modules', '.bin', 'wdio');
  const hasWdio =
    existsSync(wdioCli) || commandExists('wdio') || commandExists('npx');

  // Executable WDIO step files (not markdown stubs).
  const executableSpecs = CRITICAL_FLOWS.every((f) => {
    const abs = path.join(rootDir, f.specRelPath);
    // Markdown specs are documentation only.
    return abs.endsWith('.mjs') || abs.endsWith('.js') || abs.endsWith('.ts');
  });

  return {
    hasTauriDriver,
    hasWdio,
    executableSpecs,
    tauriDriver: hasTauriDriver ? tauriDriver : '',
    ready: hasTauriDriver && hasWdio && executableSpecs,
  };
}

/**
 * Record honest blocked desktop-webdriver evidence when tools/specs are not ready.
 * Does not overwrite host-binary-smoke evidence (writes a side note file).
 */
function writeWebdriverBlockedSideEvidence({
  targetTriple,
  binaryPath,
  packagePath,
  tools,
}) {
  const packageSha256 = sha256RegularFile(packagePath);
  const notes =
    'desktop-webdriver not executable in this environment. ' +
    `tauri-driver=${tools.hasTauriDriver}, wdio=${tools.hasWdio}, executableSpecs=${tools.executableSpecs}. ` +
    'CRITICAL_FLOWS specs are still markdown documentation stubs (suite/wdio.conf.stub.mjs). ' +
    'Host binary smoke is a separate harnessType (host-binary-smoke) with productionIpcMarker=false. ' +
    'Do not treat host smoke as WebDriver IPC proof.';
  const side = {
    commitSha: gitCommitSha(),
    targetTriple,
    harnessType: 'desktop-webdriver',
    binarySha256: sha256RegularFile(binaryPath) || 'not-built',
    ...(packageSha256 ? { packageSha256 } : {}),
    productionIpcMarker: false,
    productionBinaryMarker: false,
    namedTests: [
      {
        name: 'webdriver-prerequisites',
        result: 'skipped',
        detail: notes,
      },
      ...skippedCriticalFlowTests(
        'Blocked: WebDriver tools and/or executable WDIO specs not available.',
      ),
    ],
    result: 'blocked',
    timestamps: { startedAt: nowIso(), finishedAt: nowIso() },
    artifactPaths: binaryPath ? [binaryPath] : [],
    notes,
  };
  mkdirSync(outDir, { recursive: true });
  const triple = targetTriple.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Side file so host-binary evidence remains the primary CI artifact.
  const outPath = path.join(outDir, `evidence-webdriver-blocked-${triple}.json`);
  writeFileSync(outPath, `${JSON.stringify(side, null, 2)}\n`, 'utf8');
  console.log(
    `[desktop-e2e] desktop-webdriver blocked side-evidence: ${path.relative(rootDir, outPath)}`,
  );
  return outPath;
}

/**
 * Run host production smoke (execute suite) — harnessType host-binary-smoke.
 */
function runHostBinarySmoke({ binaryPath, packagePath, targetTriple }) {
  const profile = loadFixtureProfile();
  const mockUrl =
    process.env.DESKTOP_E2E_MOCK_PROVIDER_URL ||
    (profile?.mockProvider
      ? `http://${profile.mockProvider.bindHost}:${profile.mockProvider.preferredPort}`
      : '');

  console.log('[desktop-e2e] running host-binary-smoke execute suite');
  console.log(`[desktop-e2e] binary=${binaryPath}`);
  console.log(`[desktop-e2e] fixture=${FIXTURE_PROFILE_REL}`);
  console.log(`[desktop-e2e] mockProvider=${mockUrl || '(unset)'}`);
  console.log(
    `[desktop-e2e] flows catalogued=${CRITICAL_FLOWS.map((f) => f.id).join(', ')} (UI entries skipped in host smoke)`,
  );

  const executableSuite = path.join(
    rootDir,
    'tests',
    'desktop-e2e',
    'suite',
    'run-critical-flows.execute.mjs',
  );

  if (!existsSync(executableSuite)) {
    const notes =
      'Executable suite missing: tests/desktop-e2e/suite/run-critical-flows.execute.mjs';
    const evidence = blockedEvidence({
      targetTriple,
      harnessType: 'host-binary-smoke',
      notes,
      namedTests: skippedCriticalFlowTests(notes),
      binaryPath,
      packagePath,
    });
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(evidencePath, notes, 'blocked');
    return 2;
  }

  const result = spawnSync(process.execPath, [executableSuite], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      DESKTOP_E2E_BINARY: binaryPath,
      DESKTOP_E2E_PACKAGE: packagePath || '',
      DESKTOP_E2E_TARGET: targetTriple,
      DESKTOP_E2E_MOCK_PROVIDER_URL: mockUrl,
      DESKTOP_E2E_OUT: outDir,
      DESKTOP_E2E_HARNESS_TYPE: 'host-binary-smoke',
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === null ? 1 : result.status;
}

function runWinOrLinux() {
  const targetTriple = resolveTargetTriple();
  const binaryPath = process.env.DESKTOP_E2E_BINARY || '';
  const packagePath = process.env.DESKTOP_E2E_PACKAGE || '';

  if (!binaryPath || !existsSync(binaryPath)) {
    const notes =
      'Built binary missing (set DESKTOP_E2E_BINARY). Vite/mocked invoke is forbidden. ' +
      `Critical flows inventoried: ${CRITICAL_FLOWS.map((f) => f.id).join(', ')}. ` +
      'Playwright mocked IPC is not a substitute. ' +
      'Host binary smoke and desktop-webdriver are separate evidence classes.';
    const evidence = blockedEvidence({
      targetTriple,
      harnessType: 'host-binary-smoke',
      notes,
      namedTests: [
        {
          name: 'harness-prerequisites',
          result: 'skipped',
          detail: 'built binary required for host production smoke',
        },
        ...skippedCriticalFlowTests('Blocked: built binary missing.'),
      ],
      binaryPath: binaryPath || undefined,
      packagePath: packagePath || undefined,
    });
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(evidencePath, notes, 'blocked');
    return;
  }

  const tools = webdriverToolsStatus();
  console.log(
    `[desktop-e2e] webdriver tools: tauri-driver=${tools.hasTauriDriver} wdio=${tools.hasWdio} executableSpecs=${tools.executableSpecs} ready=${tools.ready}`,
  );

  // Always record honest WebDriver status (blocked until executable specs exist).
  if (!tools.ready) {
    writeWebdriverBlockedSideEvidence({
      targetTriple,
      binaryPath,
      packagePath,
      tools,
    });
  } else {
    console.log(
      '[desktop-e2e] WebDriver tools ready — WDIO executable suite not yet wired; treating as blocked until specs are .mjs/.js',
    );
    writeWebdriverBlockedSideEvidence({
      targetTriple,
      binaryPath,
      packagePath,
      tools: { ...tools, ready: false, executableSpecs: false },
    });
  }

  if (process.env.DESKTOP_E2E_SKIP_HOST_SMOKE === '1') {
    const notes =
      'DESKTOP_E2E_SKIP_HOST_SMOKE=1 and desktop-webdriver is not executable; no pass evidence.';
    const evidence = blockedEvidence({
      targetTriple,
      harnessType: 'desktop-webdriver',
      notes,
      namedTests: skippedCriticalFlowTests(notes),
      binaryPath,
      packagePath,
    });
    const evidencePath = writeEvidence(evidence);
    exitAfterEvidence(evidencePath, notes, 'blocked');
    return;
  }

  const status = runHostBinarySmoke({ binaryPath, packagePath, targetTriple });
  process.exit(status);
}

function main() {
  console.log(
    '[desktop-e2e] Tauri 2 desktop harness runner (Milestone 6 critical flows)',
  );
  console.log(`[desktop-e2e] platform=${process.platform} arch=${process.arch}`);
  console.log(
    '[desktop-e2e] Playwright mocked UI integration is NOT desktop E2E',
  );
  console.log(
    `[desktop-e2e] critical flows: ${CRITICAL_FLOWS.map((f) => f.id).join(', ')}`,
  );
  console.log(
    '[desktop-e2e] host-binary-smoke ≠ desktop-webdriver; productionIpcMarker only for real WebView IPC',
  );

  if (process.platform === 'darwin') {
    runDarwin();
    return;
  }

  if (process.platform === 'win32' || process.platform === 'linux') {
    runWinOrLinux();
    return;
  }

  const targetTriple = `unknown-${process.platform}`;
  const notes = `Unsupported platform for desktop-webdriver: ${process.platform}`;
  const evidence = blockedEvidence({
    targetTriple,
    harnessType: 'desktop-webdriver',
    notes,
    namedTests: [
      {
        name: 'platform-support',
        result: 'skipped',
        detail: notes,
      },
      ...skippedCriticalFlowTests(notes),
    ],
  });
  const evidencePath = writeEvidence(evidence);
  exitAfterEvidence(evidencePath, notes, 'blocked');
}

main();
