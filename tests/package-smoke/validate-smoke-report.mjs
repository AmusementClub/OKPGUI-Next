#!/usr/bin/env node
/**
 * Validate the four-field package-smoke handshake written by the built binary
 * when OKPGUI_DESKTOP_SMOKE_OUT is set.
 *
 * Contract fields:
 *   - ok
 *   - productionBinaryMarker
 *   - productionMarker
 *   - packagedAppLayout
 *
 * Not a durable evidence inventory; probe detail lives in CI stdout/stderr.
 */
import fs from 'node:fs';

const PRODUCTION_MARKER = 'OKPGUI_PRODUCTION_BINARY_V1';

/**
 * @param {string} reportPath
 * @param {{ requirePackagedAppLayout?: boolean }} [options]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateSmokeReport(reportPath, options = {}) {
  if (!reportPath || typeof reportPath !== 'string') {
    return { ok: false, error: 'smoke report path is required' };
  }
  if (!fs.existsSync(reportPath)) {
    return {
      ok: false,
      error: `smoke report missing (binary did not enter smoke mode?): ${reportPath}`,
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    return { ok: false, error: `unable to read smoke report: ${error.message}` };
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `smoke report is not JSON: ${error.message}` };
  }
  if (report?.ok !== true) {
    return { ok: false, error: `smoke report ok is not true (got ${JSON.stringify(report?.ok)})` };
  }
  if (report?.productionBinaryMarker !== true) {
    return {
      ok: false,
      error: `smoke report productionBinaryMarker is not true (got ${JSON.stringify(report?.productionBinaryMarker)})`,
    };
  }
  if (report?.productionMarker !== PRODUCTION_MARKER) {
    return {
      ok: false,
      error: `smoke report productionMarker must be ${JSON.stringify(PRODUCTION_MARKER)} (got ${JSON.stringify(report?.productionMarker)})`,
    };
  }

  // macOS .app layout is a platform-specific assertion. The cross-platform
  // packaged-only env only restricts MediaInfo resource discovery in Rust.
  const requirePackaged = options.requirePackagedAppLayout === true;
  if (requirePackaged && report?.packagedAppLayout !== true) {
    return {
      ok: false,
      error: `smoke report packagedAppLayout must be true for packaged smoke (got ${JSON.stringify(report?.packagedAppLayout)})`,
    };
  }
  return { ok: true };
}

/**
 * @param {string} reportPath
 * @param {string} [label]
 * @param {{ requirePackagedAppLayout?: boolean }} [options]
 */
export function assertSmokeReport(reportPath, label = 'package-smoke', options = {}) {
  const result = validateSmokeReport(reportPath, options);
  if (!result.ok) {
    console.error(`${label}: ${result.error}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-smoke-report.mjs')) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: validate-smoke-report.mjs <report.json>');
    process.exit(1);
  }
  assertSmokeReport(path);
  console.log('package-smoke report: ok');
}
