#!/usr/bin/env node
/**
 * Offline BYOK AI Preflight V2 release-gate verifier.
 *
 * Cross-checks Tauri sidecar/resource mapping, the four required target triples,
 * MediaInfo staging/archive/notice script references, the no-shell frontend
 * capability boundary, and the honest mocked-UI vs unrun desktop-E2E boundary.
 *
 * Fail-closed and offline-only: no network, credentials, archive downloads,
 * live providers, or new dependencies. Does not stage MediaInfo or run desktop E2E.
 *
 * Source of truth (not reimplemented here):
 *   - scripts/verify-mediainfo-package.mjs
 *   - scripts/verify-release-archive.mjs
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/capabilities/default.json
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

/** Exact target triples required for packaging matrices and MediaInfo staging. */
const REQUIRED_TARGETS = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];

const STAGED_NAMES = {
  'x86_64-pc-windows-msvc': 'mediainfo-x86_64-pc-windows-msvc.exe',
  'x86_64-unknown-linux-gnu': 'mediainfo-x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin': 'mediainfo-x86_64-apple-darwin',
  'aarch64-apple-darwin': 'mediainfo-aarch64-apple-darwin',
};

const EXTERNAL_BIN = 'binaries/mediainfo';
const NOTICE_RESOURCE_SRC = 'resources/mediainfo/THIRD_PARTY_NOTICES.html';
const NOTICE_RESOURCE_DEST = 'notices/mediainfo-THIRD_PARTY_NOTICES.html';
const NOTICE_REPO_PATH = 'src-tauri/resources/mediainfo/THIRD_PARTY_NOTICES.html';
const ARCHIVE_NOTICE_MEMBER = 'mediainfo/THIRD_PARTY_NOTICES.html';

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
 * Release archive membership verifier must require binary + sidecar + notice.
 */
function checkReleaseArchiveGate() {
  requireIncludes(
    'scripts/verify-release-archive.mjs',
    [
      ARCHIVE_NOTICE_MEMBER,
      '--archive',
      '--binary',
      '--sidecar',
      '--notice',
      'MediaInfo sidecar',
      'redistribution notice',
      'Fail-closed',
    ],
    'release archive gate',
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

  // Draft release must still call the archive membership verifier.
  requireIncludes(
    '.github/workflows/draft-release.yml',
    [
      'node scripts/verify-release-archive.mjs',
      '--sidecar',
      ARCHIVE_NOTICE_MEMBER,
      'THIRD_PARTY_NOTICES.html',
    ],
    'draft-release archive membership',
  );

  // Build artifact must keep the platform-limited notice step.
  requireIncludes(
    '.github/workflows/build-artifact.yml',
    [
      'Platform-limited gates',
      'mocked Tauri IPC',
      'WebDriver',
    ],
    'build-artifact platform-limited notice',
  );
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

  // Checklist must document the evidence boundary without claiming desktop E2E pass.
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
  checkReleaseArchiveGate();
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
  console.log('  UI layer: mocked Playwright browser integration (not desktop E2E)');
  console.log(`  root: ${rel(rootDir)}`);
}

main();
