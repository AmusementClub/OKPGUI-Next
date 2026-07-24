# Spike: minimal production IPC round-trip

**Goal:** Prove one built-app launch and one **production** Tauri command + event path on a supported runner.
Vite-only and mocked `invoke` are **forbidden** for this proof.

## Steps

1. **Build** the app for the runner’s target triple
   (`pnpm tauri build` / CI matrix with staged MediaInfo sidecar as required).
2. **Launch** the built binary (or packaged app on macOS), not `vite` / `tauri dev` with a browser mock.
3. **Invoke** one production command over real Tauri IPC
   (example candidates once harness exists: a cheap health/settings/capability probe that hits Rust registration).
4. **Observe** one production event delivered to the WebView
   (or assert a command response that can only be produced by the Rust backend).
5. **Record** evidence under `tests/desktop-e2e/out/evidence-<triple>.json` with:
   - `harnessType`: `desktop-webdriver` (Windows/Linux) or `macos-packaged-smoke` (macOS)
   - `productionIpcMarker`: `true` only if steps 3–4 used production paths
   - `binarySha256` of the launched binary
   - `namedTests` including `minimal-ipc-roundtrip`
   - `result`: `pass` | `fail` | `blocked`

## Pass criteria (stop gate)

- Supported runner launches the **built** app.
- At least one production command round-trip and event/response proof succeeds.
- Evidence JSON validates against `evidence.schema.json` required fields.
- Mocked Playwright UI integration is **not** cited as this proof.

## Blocked / not proven

If `tauri-driver`, WebdriverIO/Selenium, or the binary is missing:

- Runner writes evidence with `result: "blocked"`, `productionIpcMarker: false`.
- Exit non-zero with a clear message (fail-closed honesty).
- Do **not** defer feasibility silently to the final release milestone.

## macOS

UI WebDriver is platform-limited. Use packaged smoke (`macos-packaged-smoke`) to launch and probe IPC markers; do not claim full WebDriver E2E on Darwin.
