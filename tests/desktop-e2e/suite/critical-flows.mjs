/**
 * Named critical-flow inventory for real desktop WebDriver evidence (Milestone 6).
 *
 * Windows/Linux desktop-webdriver runners must enumerate these flows in evidence
 * namedTests. productionIpcMarker may be true only when a real built-app IPC path
 * was exercised — never for mocked Playwright / Vite invoke.
 *
 * Spec docs live under tests/desktop-e2e/specs/.
 */

/** @typedef {'pass' | 'fail' | 'skipped'} NamedTestResult */

/**
 * @typedef {object} CriticalFlow
 * @property {string} id Stable evidence name (namedTests[].name)
 * @property {string} title Human title
 * @property {string} entry Home | QuickPublish | Shared
 * @property {string} specRelPath Spec doc relative to repo root
 * @property {string} summary Short intent
 */

/** @type {CriticalFlow[]} */
export const CRITICAL_FLOWS = [
  {
    id: 'home-prepare-observe-ack-publish',
    title: 'Home prepare → observe IPC → ack → publish frozen token',
    entry: 'Home',
    specRelPath: 'tests/desktop-e2e/specs/home-prepare-observe-ack-publish.md',
    summary:
      'Home entry: prepare_plan over production IPC, observe panel state from real events, acknowledge when required, publish_prepared_plan to local mock, assert result.',
  },
  {
    id: 'quick-publish-prepare-observe-ack-publish',
    title: 'Quick Publish prepare → observe IPC → ack → publish frozen token',
    entry: 'QuickPublish',
    specRelPath:
      'tests/desktop-e2e/specs/quick-publish-prepare-observe-ack-publish.md',
    summary:
      'Quick Publish entry: same frozen-token contract as Home via production IPC and local mock provider.',
  },
  {
    id: 'cancellation-and-failed-poll-recovery',
    title: 'Cancellation and failed-poll recovery',
    entry: 'Shared',
    specRelPath:
      'tests/desktop-e2e/specs/cancellation-and-failed-poll-recovery.md',
    summary:
      'Cancel mid-prepare/audit and force poll transport failure; require reconciling → UNAVAILABLE, no silent PENDING, Retry starts fresh generation.',
  },
  {
    id: 'vision-disclosure-consent',
    title: 'Vision disclosure consent (any candidates)',
    entry: 'Shared',
    specRelPath: 'tests/desktop-e2e/specs/vision-disclosure-consent.md',
    summary:
      'Any non-empty Vision candidate set requires explicit consent (select/text-only); no auto-bind; disclosure shows count/max/provider send.',
  },
];

/** macOS packaged-smoke named probes (not full UI WebDriver). */
export const MACOS_PACKAGED_SMOKE_PROBES = [
  {
    id: 'packaged-binary-present',
    summary: 'Packaged .app / binary path exists and is hashed.',
  },
  {
    id: 'packaged-app-layout',
    summary: 'macOS .app Contents/MacOS + Info.plist layout verified when bundled.',
  },
  {
    id: 'production-binary-probe',
    summary:
      'Production Rust backend paths exercised inside the packaged/host binary (not Vite mock; not WebView IPC).',
  },
  {
    id: 'production-ipc-probe',
    summary:
      'Reserved for real Tauri WebView IPC. Host/packaged binary smoke skips this (productionIpcMarker stays false).',
  },
  {
    id: 'event-delivery-probe',
    summary:
      'WebView event delivery. Host smoke skips (no AppHandle); requires desktop-webdriver.',
  },
  {
    id: 'sidecar-mediainfo-probe',
    summary:
      'Bundled MediaInfo sidecar is resolved and spawned (--Version). Hard-required inside .app.',
  },
  {
    id: 'keyring-session-only-probe',
    summary:
      'Session-only cold-start policy: missing session secret clears stale pointer; no secret restore.',
  },
  {
    id: 'minimal-backend-roundtrip',
    summary: 'prepare_plan + pending bind + publish-safe cancel backend round-trip.',
  },
  {
    id: 'minimal-ipc-roundtrip',
    summary:
      'Reserved for real IPC wire round-trip. Host smoke skips; see minimal-backend-roundtrip.',
  },
];

export const FIXTURE_PROFILE_REL =
  'tests/desktop-e2e/fixtures/deterministic-profile.json';

/**
 * Build skipped namedTests for all critical flows when harness cannot run.
 * @param {string} detail
 */
export function skippedCriticalFlowTests(detail) {
  return CRITICAL_FLOWS.map((flow) => ({
    name: flow.id,
    result: /** @type {NamedTestResult} */ ('skipped'),
    detail: `${detail} Spec: ${flow.specRelPath}`,
  }));
}

/**
 * Build skipped namedTests for macOS packaged smoke probes.
 * @param {string} detail
 */
export function skippedMacosSmokeTests(detail) {
  return MACOS_PACKAGED_SMOKE_PROBES.map((probe) => ({
    name: probe.id,
    result: /** @type {NamedTestResult} */ ('skipped'),
    detail: `${detail} ${probe.summary}`,
  }));
}
