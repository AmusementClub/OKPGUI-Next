#!/usr/bin/env node
/**
 * macOS packaged smoke execute suite.
 *
 * Prefers a packaged .app Contents/MacOS binary, verifies bundle layout, then
 * launches host production smoke with harnessType=macos-packaged-smoke.
 *
 * productionIpcMarker stays false (no WebView IPC). productionBinaryMarker is
 * the pass signal. Sidecar spawn is required when running from a .app.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../../..');
const critical = path.join(scriptDir, 'run-critical-flows.execute.mjs');

/**
 * Resolve preferred macOS executable: .app first, then env/raw binary.
 * Returns { binaryPath, appBundlePath|null, packagePath|null }.
 */
function resolveMacosLaunchTarget() {
  const envBinary = process.env.DESKTOP_E2E_BINARY || process.env.MACOS_PACKAGED_APP || '';
  const packageEnv = process.env.DESKTOP_E2E_PACKAGE || '';

  /** @type {string[]} */
  const appBundleCandidates = [];
  if (packageEnv.endsWith('.app') && existsSync(packageEnv)) {
    appBundleCandidates.push(packageEnv);
  }
  if (envBinary.endsWith('.app') && existsSync(envBinary)) {
    appBundleCandidates.push(envBinary);
  }
  // Prefer env binary when it already points inside an .app.
  if (envBinary.includes('.app/Contents/MacOS/') && existsSync(envBinary)) {
    const appIdx = envBinary.indexOf('.app/');
    const appPath = envBinary.slice(0, appIdx + 4);
    return {
      binaryPath: envBinary,
      appBundlePath: appPath,
      packagePath: packageEnv || appPath,
    };
  }

  const releaseDir = path.join(rootDir, 'src-tauri', 'target', 'release');
  const bundleMacos = path.join(releaseDir, 'bundle', 'macos');
  if (existsSync(bundleMacos)) {
    try {
      for (const name of readdirSync(bundleMacos)) {
        if (!name.endsWith('.app')) continue;
        appBundleCandidates.push(path.join(bundleMacos, name));
      }
    } catch {
      /* ignore */
    }
  }

  for (const app of appBundleCandidates) {
    if (!existsSync(app)) continue;
    const base = path.basename(app, '.app');
    const candidates = [
      path.join(app, 'Contents', 'MacOS', 'okpgui-next'),
      path.join(app, 'Contents', 'MacOS', base),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) {
        return {
          binaryPath: cand,
          appBundlePath: app,
          packagePath: packageEnv || app,
        };
      }
    }
  }

  // Fall back to explicit env binary / raw release executable.
  const rawCandidates = [
    envBinary,
    path.join(releaseDir, 'okpgui-next'),
  ].filter(Boolean);
  for (const c of rawCandidates) {
    if (c && existsSync(c) && !c.endsWith('.app')) {
      return {
        binaryPath: c,
        appBundlePath: null,
        packagePath: packageEnv || '',
      };
    }
  }

  return { binaryPath: '', appBundlePath: null, packagePath: packageEnv || '' };
}

/**
 * Verify macOS .app layout probes (Info.plist, MacOS dir, optional Resources).
 * @param {string} appBundlePath
 * @returns {{ ok: boolean, details: string[] }}
 */
function verifyAppBundleLayout(appBundlePath) {
  const details = [];
  let ok = true;
  const contents = path.join(appBundlePath, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const infoPlist = path.join(contents, 'Info.plist');
  const resources = path.join(contents, 'Resources');

  if (!existsSync(contents) || !statSync(contents).isDirectory()) {
    ok = false;
    details.push('missing Contents/');
  } else {
    details.push('Contents/ present');
  }
  if (!existsSync(macosDir) || !statSync(macosDir).isDirectory()) {
    ok = false;
    details.push('missing Contents/MacOS/');
  } else {
    details.push('Contents/MacOS/ present');
  }
  if (!existsSync(infoPlist)) {
    ok = false;
    details.push('missing Contents/Info.plist');
  } else {
    try {
      const plist = readFileSync(infoPlist, 'utf8');
      if (!plist.includes('CFBundle') && !plist.includes('plist')) {
        ok = false;
        details.push('Info.plist unreadable/empty');
      } else {
        details.push('Contents/Info.plist present');
      }
    } catch {
      ok = false;
      details.push('Info.plist read failed');
    }
  }
  if (existsSync(resources)) {
    details.push('Contents/Resources/ present');
  } else {
    details.push('Contents/Resources/ absent (may still be valid for some layouts)');
  }
  return { ok, details };
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('[macos-execute] requires darwin');
    process.exit(2);
  }

  const resolved = resolveMacosLaunchTarget();
  if (!resolved.binaryPath) {
    console.error('[macos-execute] no packaged/raw binary found');
    process.exit(2);
  }

  const env = {
    ...process.env,
    DESKTOP_E2E_BINARY: resolved.binaryPath,
    DESKTOP_E2E_HARNESS_TYPE: 'macos-packaged-smoke',
  };
  if (resolved.packagePath) {
    env.DESKTOP_E2E_PACKAGE = resolved.packagePath;
  }

  if (resolved.appBundlePath) {
    console.log(
      `[macos-execute] preferred packaged .app: ${resolved.appBundlePath}`,
    );
    const layout = verifyAppBundleLayout(resolved.appBundlePath);
    console.log(
      `[macos-execute] app layout: ${layout.ok ? 'ok' : 'FAIL'} (${layout.details.join('; ')})`,
    );
    if (!layout.ok) {
      console.error('[macos-execute] packaged .app layout verification failed');
      process.exit(1);
    }
    // Packaged .app: require real MediaInfo resolve+spawn.
    env.OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR = '1';
    env.OKPGUI_SMOKE_PACKAGED_ONLY = '1';
    // Resource root: Contents/MacOS (sidecar sibling) and Contents/Resources.
    const macosDir = path.join(resolved.appBundlePath, 'Contents', 'MacOS');
    const resourcesDir = path.join(resolved.appBundlePath, 'Contents', 'Resources');
    env.OKPGUI_SMOKE_RESOURCE_DIR = existsSync(macosDir) ? macosDir : resourcesDir;
  } else {
    console.log(
      `[macos-execute] no .app bundle found — using host binary ${resolved.binaryPath}`,
    );
    console.log(
      '[macos-execute] sidecar not hard-required for raw host binary; prefer tauri bundle .app for full packaged proof',
    );
    // Still label macos-packaged-smoke but probes will skip sidecar if missing.
  }

  const result = spawnSync(process.execPath, [critical], {
    cwd: rootDir,
    encoding: 'utf8',
    env,
    stdio: 'inherit',
  });

  process.exit(result.status === null ? 1 : result.status);
}

main();
