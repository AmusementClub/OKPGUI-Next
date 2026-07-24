#!/usr/bin/env node
/**
 * Executable host / packaged binary smoke harness.
 *
 * Launches the **built** application binary with OKPGUI_DESKTOP_SMOKE_OUT so Rust runs
 * production prepare_plan / cancel / vision / keyring-policy / MediaInfo spawn paths
 * inside that process.
 *
 * Honesty:
 *   - harnessType defaults to host-binary-smoke (override via DESKTOP_E2E_HARNESS_TYPE)
 *   - productionIpcMarker is ALWAYS false (no WebView Tauri IPC / WebDriver)
 *   - productionBinaryMarker is true only when the smoke report is ok
 *   - Dual-entry UI critical flows may be skipped in the smoke report; that is expected
 *   - This is not mocked Playwright
 *
 * Full WebView UI automation remains a separate desktop-webdriver class (wdio runner).
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CRITICAL_FLOWS, FIXTURE_PROFILE_REL } from './critical-flows.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../../..');
const outDir = process.env.DESKTOP_E2E_OUT
  ? path.resolve(process.env.DESKTOP_E2E_OUT)
  : path.join(rootDir, 'tests', 'desktop-e2e', 'out');

/** Binary production marker (host smoke). Legacy IPC marker string is no longer emitted. */
const PRODUCTION_BINARY_MARKER = 'OKPGUI_PRODUCTION_BINARY_V1';
/** Accept legacy marker from older binaries during transition. */
const LEGACY_PRODUCTION_MARKER = 'OKPGUI_PRODUCTION_IPC_V1';

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

function sha256File(filePath) {
  if (!filePath || !existsSync(filePath)) return 'not-built';
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

function resolveTargetTriple() {
  if (process.env.DESKTOP_E2E_TARGET) return process.env.DESKTOP_E2E_TARGET;
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'linux') return 'x86_64-unknown-linux-gnu';
  return `unknown-${process.platform}`;
}

function normalizeResult(result) {
  if (result === 'pass' || result === 'fail' || result === 'skipped') return result;
  return 'fail';
}

function main() {
  const startedAt = nowIso();
  const binaryPath = process.env.DESKTOP_E2E_BINARY || '';
  const packagePath = process.env.DESKTOP_E2E_PACKAGE || '';
  const targetTriple = resolveTargetTriple();
  const harnessType =
    process.env.DESKTOP_E2E_HARNESS_TYPE || 'host-binary-smoke';

  if (!binaryPath || !existsSync(binaryPath)) {
    console.error('[execute] DESKTOP_E2E_BINARY missing or not found');
    process.exit(2);
  }

  const reportPath = path.join(
    outDir,
    `smoke-report-${targetTriple.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`,
  );
  mkdirSync(outDir, { recursive: true });
  if (existsSync(reportPath)) {
    try {
      unlinkSync(reportPath);
    } catch {
      /* ignore */
    }
  }

  // Prefer staged MediaInfo next to repo for non-packaged host smoke.
  const resourceCandidates = [
    process.env.OKPGUI_SMOKE_RESOURCE_DIR,
    path.join(rootDir, 'src-tauri', 'binaries'),
    path.dirname(binaryPath),
  ].filter(Boolean);

  let resourceDir = '';
  for (const c of resourceCandidates) {
    if (c && existsSync(c)) {
      resourceDir = c;
      break;
    }
  }

  console.log(`[execute] launching production smoke binary=${binaryPath}`);
  console.log(`[execute] report=${reportPath}`);
  console.log(`[execute] harnessType=${harnessType}`);
  if (resourceDir) {
    console.log(`[execute] OKPGUI_SMOKE_RESOURCE_DIR=${resourceDir}`);
  }

  const run = spawnSync(binaryPath, [], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      OKPGUI_DESKTOP_SMOKE_OUT: reportPath,
      ...(resourceDir ? { OKPGUI_SMOKE_RESOURCE_DIR: resourceDir } : {}),
      RUST_BACKTRACE: process.env.RUST_BACKTRACE || '0',
    },
    timeout: 120_000,
  });

  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  if (!existsSync(reportPath)) {
    const evidence = {
      commitSha: gitCommitSha(),
      targetTriple,
      harnessType,
      binarySha256: sha256File(binaryPath),
      ...(packagePath ? { packageSha256: sha256File(packagePath) } : {}),
      productionIpcMarker: false,
      productionBinaryMarker: false,
      namedTests: [
        {
          name: 'host-smoke-launch',
          result: 'fail',
          detail: `Binary exited ${run.status} without writing smoke report. stderr=${(run.stderr || '').slice(0, 400)}`,
        },
        ...CRITICAL_FLOWS.map((f) => ({
          name: f.id,
          result: 'fail',
          detail: 'Smoke report missing',
        })),
      ],
      result: 'fail',
      timestamps: { startedAt, finishedAt: nowIso() },
      artifactPaths: [binaryPath],
      notes:
        'Executable suite failed: built binary did not write OKPGUI desktop smoke report. ' +
        'Not mocked Playwright. productionIpcMarker remains false.',
    };
    const evidencePath = writeEvidence(evidence);
    console.error(`[execute] fail evidence=${evidencePath}`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(`[execute] invalid smoke report: ${error}`);
    process.exit(1);
  }

  const markerRaw =
    report.productionMarker || report.production_marker || '';
  const markerOk =
    markerRaw === PRODUCTION_BINARY_MARKER ||
    markerRaw === LEGACY_PRODUCTION_MARKER;
  // production_ipc_marker from Rust must be false; binary marker is the pass signal.
  const rustIpcClaim = Boolean(
    report.productionIpcMarker ?? report.production_ipc_marker,
  );
  const binaryMarker = Boolean(
    report.productionBinaryMarker ??
      report.production_binary_marker ??
      // Legacy: older reports used production_ipc_marker as the "ok" bit.
      (markerRaw === LEGACY_PRODUCTION_MARKER && report.ok),
  );
  const smokeOk =
    Boolean(report.ok) && markerOk && binaryMarker && !rustIpcClaim;

  const smokeTests = Array.isArray(report.namedTests)
    ? report.namedTests
    : Array.isArray(report.named_tests)
      ? report.named_tests
      : [];

  const byName = new Map(smokeTests.map((t) => [t.name, t]));

  // Prefer smoke report results (including honest skipped dual-entry names).
  const namedTests = CRITICAL_FLOWS.map((flow) => {
    const hit = byName.get(flow.id);
    if (hit) {
      return {
        name: flow.id,
        result: normalizeResult(hit.result),
        detail: hit.detail || flow.summary,
      };
    }
    return {
      name: flow.id,
      result: 'skipped',
      detail: `Not produced by host/packaged binary smoke (${flow.summary})`,
    };
  });

  for (const t of smokeTests) {
    if (!namedTests.some((n) => n.name === t.name)) {
      namedTests.push({
        name: t.name,
        result: normalizeResult(t.result),
        detail: t.detail || '',
      });
    }
  }

  namedTests.unshift({
    name: 'host-smoke-launch',
    result: smokeOk ? 'pass' : 'fail',
    detail: `Binary smoke exit=${run.status}; marker=${markerRaw}; ok=${report.ok}; productionBinaryMarker=${binaryMarker}; rust productionIpcMarker=${rustIpcClaim}`,
  });

  if (rustIpcClaim) {
    namedTests.push({
      name: 'production-ipc-marker-honesty',
      result: 'fail',
      detail:
        'Smoke report claimed production_ipc_marker=true; host/packaged binary smoke must never claim WebView IPC.',
    });
  }

  const evidence = {
    commitSha: gitCommitSha(),
    targetTriple,
    harnessType,
    binarySha256: sha256File(binaryPath),
    ...(packagePath ? { packageSha256: sha256File(packagePath) } : {}),
    // Hard rule: this harness is never WebView/Tauri IPC or WebDriver.
    productionIpcMarker: false,
    productionBinaryMarker: smokeOk,
    namedTests,
    result: smokeOk ? 'pass' : 'fail',
    timestamps: { startedAt, finishedAt: nowIso() },
    artifactPaths: [binaryPath, reportPath, FIXTURE_PROFILE_REL],
    notes: smokeOk
      ? `${harnessType}: production Rust paths in built binary (prepare_plan, publish-safe cancel, session cancel, vision, keyring policy; MediaInfo when present). NOT desktop-webdriver, NOT webview IPC (productionIpcMarker=false), NOT mocked Playwright. Dual-entry UI flows are skipped here.`
      : `${harnessType} failed. See namedTests. Not WebDriver / not mocked Playwright. productionIpcMarker remains false.`,
  };

  const evidencePath = writeEvidence(evidence);
  console.log(
    `[execute] ${smokeOk ? 'pass' : 'fail'} harness=${harnessType} productionBinaryMarker=${smokeOk} productionIpcMarker=false evidence=${path.relative(rootDir, evidencePath)}`,
  );
  process.exit(smokeOk ? 0 : 1);
}

main();
