# Desktop E2E harness (Tauri 2 WebDriver)

**Status (Milestone 6 + honesty closure):** separately named host, packaged, and WebDriver evidence classes.

| `harnessType` | What it proves | `productionIpcMarker` | Pass signal |
| --- | --- | --- | --- |
| `host-binary-smoke` | Production Rust modules inside the **built binary** (prepare/cancel/keyring policy; MediaInfo spawn when present) | **must be `false`** | `result: "pass"` + `productionBinaryMarker: true` |
| `linux-appimage-smoke` | Final **AppImage** launch with production Rust and packaged MediaInfo sidecar probes | **must be `false`** | `result: "pass"` + `productionBinaryMarker: true` |
| `macos-packaged-smoke` | Prefer packaged **`.app`** layout + same binary probes; hard MediaInfo spawn inside `.app` | **must be `false`** until WebView IPC exists | `result: "pass"` + `productionBinaryMarker: true` |
| `desktop-webdriver` | Real Tauri WebDriver / WebView IPC on Windows/Linux | **must be `true`** | `result: "pass"` + `productionIpcMarker: true` |

Without a binary, evidence is **blocked** (fail-closed). Mocked Playwright is never a substitute.

**WebdriverIO** (`suite/wdio.conf.stub.mjs` + `specs/*.md`) remains a **documentation stub**. The Win/Linux runner records honest `evidence-webdriver-blocked-*.json` side-evidence and does **not** claim `desktop-webdriver` pass from host smoke.

## Purpose

Prove the **real desktop boundary** for BYOK AI Preflight V2 release evidence:

- Built Tauri app (not Vite-only)
- Honest separation of **binary production paths** vs **WebView IPC / WebDriver**
- Machine-readable evidence per target triple

Playwright under `tests/ui-integration/**` remains **browser/UI integration with mocked Tauri IPC**.
It is **not desktop E2E** and must never be labeled as such.

## Evidence classes (separately named)

| Class | `harnessType` | Runner | CI step |
| --- | --- | --- | --- |
| Mocked Playwright | `mocked-playwright-not-desktop` | `pnpm run test:ui-integration` | Playwright browser/UI integration |
| Host binary smoke | `host-binary-smoke` | `pnpm run test:desktop-e2e` (Windows) | Final standalone EXE production smoke |
| Linux packaged smoke | `linux-appimage-smoke` | same runner with final AppImage paths | AppImage + packaged MediaInfo production smoke |
| Desktop WebDriver | `desktop-webdriver` | same runner (side evidence until WDIO specs land) | Reserved for real `tauri-driver` + WDIO |
| macOS packaged smoke | `macos-packaged-smoke` | `pnpm run test:macos-packaged-smoke` | Prefer `.app`; binary + sidecar + keyring policy |

## Pinned Tauri version

| Surface | Pin |
| --- | --- |
| Rust crate (`src-tauri/Cargo.toml`) | `tauri = { version = "2", features = [] }` |
| CLI / JS API (`package.json`) | `@tauri-apps/cli` / `@tauri-apps/api` `^2` |

Official documentation (Tauri 2 WebDriver):
https://v2.tauri.app/develop/tests/webdriver/

## Approach by platform

| Platform | Primary harness | What runs |
| --- | --- | --- |
| **Windows** (`x86_64-pc-windows-msvc`) | `host-binary-smoke` (+ blocked `desktop-webdriver` side file) | Final standalone EXE; embedded MediaInfo release path |
| **Linux** (`x86_64-unknown-linux-gnu`) | `linux-appimage-smoke` (+ blocked `desktop-webdriver` side file) | Final AppImage launched with `APPIMAGE_EXTRACT_AND_RUN=1`; packaged MediaInfo spawn |
| **macOS** (`aarch64-apple-darwin`) | `macos-packaged-smoke` | Apple Silicon only; prefer `bundle/macos/*.app` over raw `target/release` binary |

### Windows / Linux critical flows

Named flows (catalog: `suite/critical-flows.mjs`, specs: `specs/`):

| Evidence name | Intent |
| --- | --- |
| `home-prepare-observe-ack-publish` | Home prepare → observe IPC state → ack when needed → publish frozen token (requires desktop-webdriver) |
| `quick-publish-prepare-observe-ack-publish` | Quick Publish same path (requires desktop-webdriver) |
| `cancellation-and-failed-poll-recovery` | Cancel + failed-poll recovery (backend proven in host smoke) |

Host/packaged binary smoke **skips** dual-entry UI names and proves a single shared backend contract instead (`shared-backend-prepare-observe-ack-publish`). That is intentional honesty — not dual-pass mapping.

1. Build the app for the target (`cargo build` / `pnpm tauri build` / CI matrix job).
2. Set `DESKTOP_E2E_BINARY` to the final EXE/AppImage (macOS: prefer `.app` Contents/MacOS path). For Linux, set `DESKTOP_E2E_PACKAGE` to the same AppImage.
3. Run `pnpm run test:desktop-e2e` (Win/Linux) or `pnpm run test:macos-packaged-smoke` (macOS).
4. The runner launches the binary with `OKPGUI_DESKTOP_SMOKE_OUT` — Rust `desktop_smoke` module writes a production report; Node maps it to evidence JSON.
5. **Markers:**
   - `productionBinaryMarker: true` when hard binary probes pass
   - `productionIpcMarker: false` for host/packaged binary smoke (always)
   - `productionIpcMarker: true` only for real desktop-webdriver WebView IPC

Environment variables:

| Variable | Role |
| --- | --- |
| `DESKTOP_E2E_BINARY` | Path to the built app binary (**required for pass**) |
| `DESKTOP_E2E_PACKAGE` | Optional path to the installer/package/`.app` |
| `DESKTOP_E2E_HARNESS_TYPE` | `linux-appimage-smoke` when the Linux binary/package paths identify the same final AppImage |
| `APPIMAGE_EXTRACT_AND_RUN=1` | Let AppImage execute on CI hosts without FUSE while still running its packaged payload |
| `DESKTOP_E2E_OUT` | Optional override for evidence output directory |
| `DESKTOP_E2E_MOCK_PROVIDER_URL` | Loopback mock base URL (reserved for UI WebDriver extension) |
| `DESKTOP_E2E_ALLOW_BLOCKED=1` | Exit 0 after writing blocked evidence when binary is absent only |
| `DESKTOP_E2E_REQUIRE_PASS=1` | Exit non-zero unless `result=pass` (CI sets this when binary exists) |
| `OKPGUI_DESKTOP_SMOKE_OUT` | Set by execute suite; path for in-binary smoke JSON |
| `OKPGUI_SMOKE_RESOURCE_DIR` | Optional MediaInfo search root |
| `OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR=1` | Hard-fail if MediaInfo resolve+spawn fails |

### macOS limitation (explicit)

Tauri 2 **UI WebDriver automation on macOS is limited / not supported** the same way as Windows and Linux.
For Apple targets this repo records **`macos-packaged-smoke`** only:

| Probe | Intent |
| --- | --- |
| `packaged-binary-present` | Hash packaged binary |
| `packaged-app-layout` | `.app` Contents/MacOS + Info.plist when bundled |
| `production-binary-probe` | Production backend paths in binary |
| `production-ipc-probe` | **Skipped** — not WebView IPC |
| `event-delivery-probe` | **Skipped** — no AppHandle/WebView |
| `sidecar-mediainfo-probe` | Resolve + spawn MediaInfo (`--Version`); hard inside `.app` |
| `keyring-session-only-probe` | `decide_session_only_cold_start` policy assertions |
| `minimal-backend-roundtrip` | prepare + cancel backend round-trip |

Runner: `node scripts/run-macos-packaged-smoke.mjs` (or `pnpm run test:macos-packaged-smoke`).
Resolution order: env `.app` / `bundle/macos/*.app` **before** raw `target/release/okpgui-next`.

## Evidence schema

| File | Role |
| --- | --- |
| `evidence.schema.json` | JSON Schema for per-target evidence records |
| `evidence.example.json` | Example final AppImage fixture (`linux-appimage-smoke`, `productionIpcMarker: false`) |
| `out/evidence-<triple>.json` | Runner output when a harness executes |

Required evidence fields:

- `commitSha`, `targetTriple`, `harnessType`
- `binarySha256`, optional `packageSha256`
- `productionIpcMarker` — **true only for real desktop WebView/WebDriver IPC**
- `productionBinaryMarker` — true when host/packaged binary smoke hard probes pass
- `namedTests[]` with `name`, `result` (`pass` \| `fail` \| `skipped`), optional `detail`
- `result` (`pass` \| `fail` \| `blocked`)
- `timestamps.startedAt` / `timestamps.finishedAt`
- `artifactPaths[]`, optional `notes`

### Pass rules (fail-closed)

| `harnessType` | `result: "pass"` requires |
| --- | --- |
| `host-binary-smoke` | `productionBinaryMarker === true` **and** `productionIpcMarker === false` |
| `linux-appimage-smoke` | `productionBinaryMarker === true` **and** `productionIpcMarker === false` |
| `macos-packaged-smoke` | `productionBinaryMarker === true` **and** `productionIpcMarker === false` |
| `desktop-webdriver` | `productionIpcMarker === true` |
| `mocked-playwright-not-desktop` | must never be used as desktop release pass |

## Fixtures

| Path | Role |
| --- | --- |
| `fixtures/deterministic-profile.json` | Deterministic mock scenarios + selectors |
| `fixtures/mock-provider.md` | Loopback mock provider notes |
| `fixtures/media/` | Controlled media placeholders |

## Layout

```
tests/desktop-e2e/
  suite/critical-flows.mjs    # flow + probe catalog imported by runners
  suite/wdio.conf.stub.mjs    # WDIO config shape (not offline-executable)
  suite/run-critical-flows.execute.mjs
  suite/run-macos-smoke.execute.mjs
  specs/*.md                  # named critical-flow specs + WDIO stubs
  fixtures/                   # mock provider profile
  spike/minimal-ipc-roundtrip.md
  evidence.schema.json
```

## Local commands

```bash
# Offline-friendly runner (writes blocked evidence when tools/binary missing)
pnpm run test:desktop-e2e
# node scripts/run-desktop-e2e.mjs

# macOS packaged smoke (prefers .app)
pnpm run test:macos-packaged-smoke
# node scripts/run-macos-packaged-smoke.mjs

# Offline release gates (inventory; empty out/ does not fail)
pnpm run verify:byok-release-gates
```

## CI evidence production

1. After `pnpm tauri build`, Windows runs the final EXE; Linux runs the unique final AppImage with `linux-appimage-smoke`.
2. macOS jobs run `run-macos-packaged-smoke.mjs`, preferring `bundle/macos/*.app`.
3. Both use `DESKTOP_E2E_REQUIRE_PASS=1` when a binary exists.
4. Jobs **fail closed** if no `tests/desktop-e2e/out/evidence-*.json` is written on applicable runners.
5. Artifacts upload as `desktop-evidence-*` separately from app bundles.
6. Pass rules above apply — blocked is never a pass; host smoke never sets `productionIpcMarker: true`.

## What this does **not** do

- Does not claim live Windows/Linux WebDriver has passed without `harnessType: desktop-webdriver` + `productionIpcMarker: true`
- Does not treat Playwright mocked IPC as desktop E2E pass evidence
- Does not call paid/live providers
- Does not set `productionIpcMarker: true` for host-binary-smoke, linux-appimage-smoke, or macos-packaged-smoke
- Does not dual-pass Home and Quick Publish UI entries from a single backend check
