#!/usr/bin/env node
/**
 * Offline BYOK AI Preflight V2 release-gate verifier.
 *
 * Cross-checks Tauri sidecar/resource mapping, the three required target triples,
 * MediaInfo staging/native-bundle/notice references, the no-shell frontend
 * capability boundary, and the honest mocked-UI vs unrun desktop-E2E boundary.
 *
 * Fail-closed and offline-only: no network, credentials, archive downloads,
 * live providers, or new dependencies. Does not stage MediaInfo or run desktop E2E.
 *
 * Source of truth (not reimplemented here):
 *   - scripts/verify-mediainfo-package.mjs
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/capabilities/default.json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

/** Exact target triples required for packaging matrices and MediaInfo staging. */
const REQUIRED_TARGETS = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-apple-darwin',
];

const STAGED_NAMES = {
  'x86_64-pc-windows-msvc': 'mediainfo-x86_64-pc-windows-msvc.exe',
  'x86_64-unknown-linux-gnu': 'mediainfo-x86_64-unknown-linux-gnu',
  'aarch64-apple-darwin': 'mediainfo-aarch64-apple-darwin',
};

const EXTERNAL_BIN = 'binaries/mediainfo';
const NOTICE_RESOURCE_SRC = 'resources/mediainfo/THIRD_PARTY_NOTICES.html';
const NOTICE_RESOURCE_DEST = 'notices/mediainfo-THIRD_PARTY_NOTICES.html';
const NOTICE_REPO_PATH = 'src-tauri/resources/mediainfo/THIRD_PARTY_NOTICES.html';
const errors = [];

function rel(filePath) {
  return path.relative(rootDir, filePath) || filePath;
}

function fail(message) {
  errors.push(message);
}

function readText(relPath) {
  const abs = path.join(rootDir, relPath);
  if (!existsSync(abs)) {
    fail(`missing required file: ${relPath}`);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

function readJson(relPath) {
  const text = readText(relPath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      `${relPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function requireIncludes(relPath, markers, label) {
  const text = readText(relPath);
  if (text === null) return;
  for (const marker of markers) {
    if (!text.includes(marker)) {
      fail(`${relPath}: missing ${label} marker ${JSON.stringify(marker)}`);
    }
  }
}

function requireAbsent(relPath, markers, label) {
  const text = readText(relPath);
  if (text === null) return;
  for (const marker of markers) {
    if (text.includes(marker)) {
      fail(`${relPath}: forbidden ${label} ${JSON.stringify(marker)}`);
    }
  }
}

/**
 * Tauri bundle: externalBin + redistribution notice resource mapping.
 * Source of truth: src-tauri/tauri.conf.json
 */
function checkTauriBundle() {
  const conf = readJson('src-tauri/tauri.conf.json');
  if (!conf) return;

  const externalBin = conf?.bundle?.externalBin;
  if (!Array.isArray(externalBin) || !externalBin.includes(EXTERNAL_BIN)) {
    fail(
      `src-tauri/tauri.conf.json: bundle.externalBin must include ${JSON.stringify(EXTERNAL_BIN)}`,
    );
  }

  const resources = conf?.bundle?.resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    fail('src-tauri/tauri.conf.json: bundle.resources must be a mapping object');
  } else if (resources[NOTICE_RESOURCE_SRC] !== NOTICE_RESOURCE_DEST) {
    fail(
      `src-tauri/tauri.conf.json: bundle.resources must map ${JSON.stringify(NOTICE_RESOURCE_SRC)} -> ${JSON.stringify(NOTICE_RESOURCE_DEST)}`,
    );
  }

  if (!existsSync(path.join(rootDir, NOTICE_REPO_PATH))) {
    fail(`missing redistribution notice file: ${NOTICE_REPO_PATH}`);
  }
}

/**
 * Frontend capability boundary: no shell plugin / shell execute permission.
 * Source of truth: src-tauri/capabilities/default.json
 */
function checkNoShellCapability() {
  const caps = readJson('src-tauri/capabilities/default.json');
  if (!caps) return;

  const permissions = caps.permissions;
  if (!Array.isArray(permissions)) {
    fail('src-tauri/capabilities/default.json: permissions must be an array');
    return;
  }

  const shellLike = permissions.filter((perm) => {
    const value = typeof perm === 'string' ? perm : JSON.stringify(perm);
    return /(^|[:/])shell([:/]|$)/i.test(value) || /shell:allow/i.test(value);
  });
  if (shellLike.length > 0) {
    fail(
      `src-tauri/capabilities/default.json: shell permission is forbidden on the frontend capability boundary: ${shellLike.join(', ')}`,
    );
  }

  // Positive baseline so the file cannot be emptied of all capability structure.
  for (const required of ['core:default', 'dialog:default']) {
    if (!permissions.includes(required)) {
      fail(
        `src-tauri/capabilities/default.json: missing required permission ${JSON.stringify(required)}`,
      );
    }
  }
}

/**
 * Manifest + MediaInfo package verifier must enumerate exact targets, staged
 * names, externalBin, and notice/license references.
 */
function checkMediaInfoPackageGate() {
  const manifest = readJson('scripts/mediainfo-manifest.json');
  if (manifest) {
    if (manifest.tauri_external_bin !== EXTERNAL_BIN) {
      fail(
        `scripts/mediainfo-manifest.json: tauri_external_bin must be ${JSON.stringify(EXTERNAL_BIN)}`,
      );
    }
    if (manifest.resources_notice !== NOTICE_REPO_PATH) {
      fail(
        `scripts/mediainfo-manifest.json: resources_notice must be ${JSON.stringify(NOTICE_REPO_PATH)}`,
      );
    }
    if (manifest?.license?.notice_path !== NOTICE_REPO_PATH) {
      fail(
        `scripts/mediainfo-manifest.json: license.notice_path must be ${JSON.stringify(NOTICE_REPO_PATH)}`,
      );
    }
    const targets = manifest.targets && typeof manifest.targets === 'object' ? manifest.targets : {};
    for (const triple of REQUIRED_TARGETS) {
      if (!Object.prototype.hasOwnProperty.call(targets, triple)) {
        fail(`scripts/mediainfo-manifest.json: missing required target ${triple}`);
        continue;
      }
      const staged = targets[triple]?.staged_name;
      if (staged !== STAGED_NAMES[triple]) {
        fail(
          `scripts/mediainfo-manifest.json: targets.${triple}.staged_name must be ${JSON.stringify(STAGED_NAMES[triple])}`,
        );
      }
    }
    for (const key of Object.keys(targets)) {
      if (!REQUIRED_TARGETS.includes(key)) {
        fail(`scripts/mediainfo-manifest.json: unknown target ${key}`);
      }
    }
  }

  // Ensure the dedicated package verifier still encodes the same fail-closed set.
  requireIncludes(
    'scripts/verify-mediainfo-package.mjs',
    [
      ...REQUIRED_TARGETS,
      ...Object.values(STAGED_NAMES),
      EXTERNAL_BIN,
      'THIRD_PARTY_NOTICES.html',
      '--manifest-only',
      'NOTICE_REQUIRED_MARKERS',
    ],
    'MediaInfo package gate',
  );

  requireIncludes(
    'scripts/stage-mediainfo.sh',
    [...REQUIRED_TARGETS, 'externalBin', 'mediainfo-manifest.json'],
    'Unix staging script',
  );
  requireIncludes(
    'scripts/stage-mediainfo.ps1',
    ['x86_64-pc-windows-msvc', 'externalBin', 'mediainfo-manifest.json'],
    'Windows staging script',
  );
}

/**
 * Workflows must keep sidecar/provider/UI gates and honest desktop-E2E notice,
 * and must invoke this verifier before build/package work.
 */
function checkWorkflows() {
  const workflowMarkers = [
    'node scripts/verify-byok-release-gates.mjs',
    'node scripts/verify-mediainfo-package.mjs --manifest-only',
    'node scripts/verify-provider-contract.mjs',
    'node scripts/verify-ui-integration-inventory.mjs',
    'not desktop E2E',
    'stage-mediainfo',
    ...REQUIRED_TARGETS,
  ];

  for (const workflow of [
    '.github/workflows/build-artifact.yml',
    '.github/workflows/draft-release.yml',
  ]) {
    requireIncludes(workflow, workflowMarkers, 'workflow release gate');
    // Platform-limited honesty: must not claim desktop E2E passed.
    requireAbsent(
      workflow,
      [
        'desktop E2E passed',
        'desktop E2E complete',
        'packaged-app smoke passed',
        'WebDriver E2E passed',
      ],
      'false desktop-E2E claim',
    );
  }

  for (const workflow of [
    '.github/workflows/build-artifact.yml',
    '.github/workflows/draft-release.yml',
  ]) {
    requireIncludes(
      workflow,
      [
        'build_args: --no-bundle',
        'build_args: --bundles dmg',
        'build_args: --bundles appimage',
        'target/release/okpgui-next.exe',
        'bundle/dmg/*.dmg',
        'bundle/appimage/*.AppImage',
        'pnpm tauri build ${{ matrix.platform.build_args }}',
        'compression-level: 0',
        'hdiutil attach -nobrowse -readonly',
        'DESKTOP_E2E_PACKAGE="${dmgs[0]}"',
      ],
      'native output workflow',
    );
    requireAbsent(
      workflow,
      [
        'Compress-Archive',
        'tar -C',
        'verify-release-archive.mjs',
        'target/release/bundle/**',
        'bundle_target: nsis',
        'bundle/nsis/',
      ],
      'duplicate or custom archive packaging',
    );
  }

  // Build artifact / draft-release: separate named evidence-class steps (Milestone 6).
  for (const workflow of [
    '.github/workflows/build-artifact.yml',
    '.github/workflows/draft-release.yml',
  ]) {
    requireIncludes(
      workflow,
      [
        'Desktop production critical flows (Windows/Linux)',
        'macOS packaged production smoke',
        'Upload desktop / packaged evidence JSON',
        'desktop-webdriver',
        'macos-packaged-smoke',
        'host-binary-smoke',
        'productionBinaryMarker',
        'DESKTOP_E2E_REQUIRE_PASS',
        'run-desktop-e2e.mjs',
        'run-macos-packaged-smoke.mjs',
        'mocked Tauri IPC',
        'productionIpcMarker',
      ],
      'workflow desktop evidence steps',
    );
  }
}

/**
 * package.json must expose the offline verifier and inventory scripts.
 */
function checkPackageJson() {
  const pkg = readJson('package.json');
  if (!pkg) return;
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const requiredScripts = {
    'verify:byok-release-gates': 'node scripts/verify-byok-release-gates.mjs',
    'verify:mediainfo': 'node scripts/verify-mediainfo-package.mjs --manifest-only',
    'verify:ui-integration-inventory': 'node scripts/verify-ui-integration-inventory.mjs',
    'test:ui-integration': 'node scripts/run-playwright-ui-integration.mjs',
    'test:desktop-e2e': 'node scripts/run-desktop-e2e.mjs',
    'test:macos-packaged-smoke': 'node scripts/run-macos-packaged-smoke.mjs',
  };
  for (const [name, command] of Object.entries(requiredScripts)) {
    if (scripts[name] !== command) {
      fail(
        `package.json: scripts.${name} must be ${JSON.stringify(command)}, got ${JSON.stringify(scripts[name])}`,
      );
    }
  }
}

/**
 * Milestone 0A/6 desktop harness inventory + frozen evidence schema.
 * Empty tests/desktop-e2e/out/ does not fail offline (no binary required).
 *
 * Separately named inventory classes:
 *   1. mocked Playwright UI integration (not desktop E2E)
 *   2. desktop WebDriver (Windows/Linux critical flows)
 *   3. macOS packaged smoke (IPC/event/sidecar/keyring)
 */
function checkDesktopHarnessInventory() {
  const requiredFiles = [
    'tests/desktop-e2e/README.md',
    'tests/desktop-e2e/evidence.schema.json',
    'tests/desktop-e2e/evidence.example.json',
    'tests/desktop-e2e/spike/minimal-ipc-roundtrip.md',
    'tests/desktop-e2e/suite/critical-flows.mjs',
    'tests/desktop-e2e/suite/run-critical-flows.execute.mjs',
    'tests/desktop-e2e/suite/run-macos-smoke.execute.mjs',
    'tests/desktop-e2e/suite/wdio.conf.stub.mjs',
    'tests/desktop-e2e/fixtures/deterministic-profile.json',
    'tests/desktop-e2e/fixtures/mock-provider.md',
    'tests/desktop-e2e/specs/home-prepare-observe-ack-publish.md',
    'tests/desktop-e2e/specs/quick-publish-prepare-observe-ack-publish.md',
    'tests/desktop-e2e/specs/cancellation-and-failed-poll-recovery.md',
    'scripts/run-desktop-e2e.mjs',
    'scripts/run-macos-packaged-smoke.mjs',
  ];
  for (const relPath of requiredFiles) {
    if (!existsSync(path.join(rootDir, relPath))) {
      fail(`missing desktop harness inventory file: ${relPath}`);
    }
  }

  requireIncludes(
    'tests/desktop-e2e/README.md',
    [
      'tauri-driver',
      'WebdriverIO',
      'not desktop E2E',
      'macos-packaged-smoke',
      'desktop-webdriver',
      'host-binary-smoke',
      'productionIpcMarker',
      'productionBinaryMarker',
      'v2.tauri.app/develop/tests/webdriver',
      'macOS',
      'home-prepare-observe-ack-publish',
      'quick-publish-prepare-observe-ack-publish',
      'cancellation-and-failed-poll-recovery',
    ],
    'desktop harness README',
  );

  requireIncludes(
    'tests/desktop-e2e/evidence.schema.json',
    [
      'commitSha',
      'targetTriple',
      'harnessType',
      'desktop-webdriver',
      'macos-packaged-smoke',
      'mocked-playwright-not-desktop',
      'binarySha256',
      'packageSha256',
      'productionIpcMarker',
      'namedTests',
      'artifactPaths',
      'startedAt',
      'finishedAt',
    ],
    'desktop evidence schema',
  );

  requireIncludes(
    'tests/desktop-e2e/evidence.example.json',
    ['productionIpcMarker', 'host-binary-smoke', 'productionBinaryMarker', 'commitSha'],
    'desktop evidence example',
  );

  // Inventory item: desktop WebDriver runner (critical flow IDs live in suite catalog).
  requireIncludes(
    'scripts/run-desktop-e2e.mjs',
    [
      'not desktop E2E',
      'desktop-webdriver',
      'host-binary-smoke',
      'blocked',
      'productionIpcMarker',
      'darwin',
      'CRITICAL_FLOWS',
      'skippedCriticalFlowTests',
      'DESKTOP_E2E_ALLOW_BLOCKED',
      'run-critical-flows.execute.mjs',
      'evidence-webdriver-blocked',
    ],
    'desktop WebDriver runner inventory',
  );

  // Inventory item: macOS packaged smoke runner + probe names.
  requireIncludes(
    'scripts/run-macos-packaged-smoke.mjs',
    [
      'macos-packaged-smoke',
      'blocked',
      'productionIpcMarker',
      'WebDriver',
      'bundle/macos',
      'DESKTOP_E2E_ALLOW_BLOCKED',
      'run-macos-smoke.execute.mjs',
      '.app/Contents/MacOS',
    ],
    'macOS packaged smoke runner inventory',
  );
  requireIncludes(
    'tests/desktop-e2e/suite/run-critical-flows.execute.mjs',
    [
      'OKPGUI_DESKTOP_SMOKE_OUT',
      'productionIpcMarker',
      'OKPGUI_PRODUCTION_BINARY_V1',
      'productionBinaryMarker',
      'CRITICAL_FLOWS',
    ],
    'desktop execute suite inventory',
  );

  requireIncludes(
    'tests/desktop-e2e/suite/critical-flows.mjs',
    [
      'home-prepare-observe-ack-publish',
      'quick-publish-prepare-observe-ack-publish',
      'cancellation-and-failed-poll-recovery',
      'production-binary-probe',
      'sidecar-mediainfo-probe',
      'keyring-session-only-probe',
    ],
    'critical flow catalog',
  );

  requireIncludes(
    'tests/desktop-e2e/fixtures/deterministic-profile.json',
    [
      'mockProvider',
      '127.0.0.1',
      'formalAuditGo',
      'formalAuditWarning',
      'transportError',
      'prepare_plan',
      'publish_prepared_plan',
      'productionIpcMarkerRule',
    ],
    'deterministic fixture profile',
  );

  // Forbidden: claiming desktop E2E from Playwright paths alone.
  const playwrightPaths = [
    'scripts/run-playwright-ui-integration.mjs',
    'scripts/verify-ui-integration-inventory.mjs',
    'playwright.config.ts',
  ];
  for (const relPath of playwrightPaths) {
    requireAbsent(
      relPath,
      [
        'desktop E2E passed',
        'desktop E2E complete',
        'real desktop E2E',
        'harnessType": "desktop-webdriver',
      ],
      'Playwright-as-desktop claim',
    );
  }

  // Optional: if evidence files exist under out/, validate required keys.
  // Empty out/ must not fail the offline gate.
  const evidenceOutDir = path.join(rootDir, 'tests', 'desktop-e2e', 'out');
  if (!existsSync(evidenceOutDir)) {
    return;
  }
  let names = [];
  try {
    names = readdirSync(evidenceOutDir).filter(
      (n) => n.startsWith('evidence-') && n.endsWith('.json'),
    );
  } catch {
    return;
  }
  const requiredKeys = [
    'commitSha',
    'targetTriple',
    'harnessType',
    'binarySha256',
    'productionIpcMarker',
    'namedTests',
    'result',
    'timestamps',
    'artifactPaths',
  ];
  const harnessTypes = new Set([
    'desktop-webdriver',
    'macos-packaged-smoke',
    'host-binary-smoke',
    'mocked-playwright-not-desktop',
  ]);
  for (const name of names) {
    const relPath = `tests/desktop-e2e/out/${name}`;
    const data = readJson(relPath);
    if (!data || typeof data !== 'object') continue;
    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        fail(`${relPath}: missing required evidence field ${key}`);
      }
    }
    if (data.harnessType && !harnessTypes.has(data.harnessType)) {
      fail(
        `${relPath}: harnessType must be one of ${[...harnessTypes].join(', ')}`,
      );
    }
    if (
      data.result === 'pass' &&
      data.harnessType === 'mocked-playwright-not-desktop'
    ) {
      fail(
        `${relPath}: mocked-playwright-not-desktop cannot claim result pass as desktop proof`,
      );
    }
    // Real WebDriver UI path only: pass requires productionIpcMarker.
    if (
      data.result === 'pass' &&
      data.harnessType === 'desktop-webdriver' &&
      data.productionIpcMarker !== true
    ) {
      fail(
        `${relPath}: desktop-webdriver result pass requires productionIpcMarker true`,
      );
    }
    // Host binary + macOS packaged binary smoke: productionBinaryMarker, never IPC claim.
    if (
      data.result === 'pass' &&
      (data.harnessType === 'host-binary-smoke' ||
        data.harnessType === 'macos-packaged-smoke')
    ) {
      if (data.productionBinaryMarker !== true) {
        fail(
          `${relPath}: ${data.harnessType} pass requires productionBinaryMarker true`,
        );
      }
      if (data.productionIpcMarker === true) {
        fail(
          `${relPath}: ${data.harnessType} must not set productionIpcMarker true (not WebView IPC)`,
        );
      }
    }
  }
}

/**
 * Honest boundary: mocked Playwright UI integration is not desktop E2E.
 */
function checkDesktopE2EHonesty() {
  const honestyFiles = [
    'scripts/verify-ui-integration-inventory.mjs',
    'scripts/run-playwright-ui-integration.mjs',
    'playwright.config.ts',
  ];
  for (const relPath of honestyFiles) {
    requireIncludes(relPath, ['not desktop E2E'], 'desktop-E2E honesty');
  }

  requireIncludes(
    'scripts/verify-ui-integration-inventory.mjs',
    [
      'mocked Tauri IPC',
      'not desktop E2E',
      'FORBIDDEN_CLAIMS',
      'desktop E2E automation',
    ],
    'UI inventory honesty',
  );

  // Checklist must document the three evidence classes without claiming desktop E2E pass.
  requireIncludes(
    'docs/byok-ai-preflight-v2-release-checklist.md',
    [
      ...REQUIRED_TARGETS,
      'node scripts/verify-byok-release-gates.mjs',
      'node scripts/verify-mediainfo-package.mjs --manifest-only',
      'not desktop E2E',
      'mocked',
      'binaries/mediainfo',
      'THIRD_PARTY_NOTICES',
      'no shell',
      'platform-limited',
      'desktop-webdriver',
      'macos-packaged-smoke',
      'mocked-playwright-not-desktop',
      'evidence.schema.json',
      'home-prepare-observe-ack-publish',
      'productionIpcMarker',
    ],
    'release checklist',
  );
  requireAbsent(
    'docs/byok-ai-preflight-v2-release-checklist.md',
    [
      'desktop E2E passed',
      'desktop E2E has passed',
      'packaged-app smoke passed',
      'real desktop E2E complete',
    ],
    'false checklist claim',
  );

  checkDesktopHarnessInventory();
}

/**
 * Delegate to existing offline MediaInfo package verifier (manifest + notice).
 * Does not download or stage binaries.
 */
function runExistingMediaInfoManifestGate() {
  const scriptPath = path.join(rootDir, 'scripts', 'verify-mediainfo-package.mjs');
  const result = spawnSync(process.execPath, [scriptPath, '--manifest-only'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(
      `scripts/verify-mediainfo-package.mjs --manifest-only failed${detail ? `: ${detail}` : ''}`,
    );
  }
}

function main() {
  checkTauriBundle();
  checkNoShellCapability();
  checkMediaInfoPackageGate();
  checkPackageJson();
  checkWorkflows();
  checkDesktopE2EHonesty();
  runExistingMediaInfoManifestGate();

  if (errors.length > 0) {
    console.error('error: BYOK release gates failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('OK: BYOK AI Preflight V2 release gates (offline)');
  console.log(`  targets: ${REQUIRED_TARGETS.join(', ')}`);
  console.log(`  externalBin: ${EXTERNAL_BIN}`);
  console.log(`  notice: ${NOTICE_REPO_PATH}`);
  console.log('  capability: no frontend shell permission');
  // Separately named evidence inventory (Milestone 6).
  console.log(
    '  evidence class [mocked UI]: Playwright browser integration (mocked-playwright-not-desktop; not desktop E2E)',
  );
  console.log(
    '  evidence class [desktop WebDriver]: Windows/Linux critical flows via run-desktop-e2e.mjs (desktop-webdriver)',
  );
  console.log(
    '  evidence class [packaged smoke]: macOS IPC/event/sidecar/keyring via run-macos-packaged-smoke.mjs (macos-packaged-smoke)',
  );
  console.log(
    '  desktop harness: tests/desktop-e2e execute suite + evidence schema (empty out/ OK offline; binary required for pass)',
  );
  console.log(`  root: ${rel(rootDir)}`);
}

main();
