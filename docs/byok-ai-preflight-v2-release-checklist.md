# BYOK AI Preflight V2 — release checklist

Offline packaging and honesty checklist for the BYOK AI Preflight V2 release slice.
This document records **reproducible local/CI gates** and the **evidence boundary**.
It does **not** claim that real desktop WebDriver IPC or packaged-app smoke has passed
unless machine-readable evidence under `tests/desktop-e2e/out/` shows `result: "pass"`
with the correct markers for that `harnessType`:

| `harnessType` | Pass requires |
| --- | --- |
| `host-binary-smoke` | `productionBinaryMarker: true` **and** `productionIpcMarker: false` |
| `macos-packaged-smoke` | `productionBinaryMarker: true` **and** `productionIpcMarker: false` |
| `desktop-webdriver` | `productionIpcMarker: true` (real WebView IPC only) |

## Required target triples (exact)

MediaInfo sidecar staging and CI matrices must cover exactly these three triples:

| Triple | Platform matrix role |
| --- | --- |
| `x86_64-pc-windows-msvc` | Windows x64 |
| `x86_64-unknown-linux-gnu` | Linux x64 |
| `aarch64-apple-darwin` | macOS Apple Silicon |

Staged sidecar names (under `src-tauri/binaries/`):

- `mediainfo-x86_64-pc-windows-msvc.exe`
- `mediainfo-x86_64-unknown-linux-gnu`
- `mediainfo-aarch64-apple-darwin`

## Sidecar and notice requirements

| Item | Expected value |
| --- | --- |
| Tauri `bundle.externalBin` | `binaries/mediainfo` |
| Checked-in redistribution notice | `src-tauri/resources/mediainfo/THIRD_PARTY_NOTICES.html` |
| Tauri resource mapping | `resources/mediainfo/THIRD_PARTY_NOTICES.html` → `notices/mediainfo-THIRD_PARTY_NOTICES.html` |
| Release-archive notice member | `mediainfo/THIRD_PARTY_NOTICES.html` |
| Manifest / inventory source | `scripts/mediainfo-manifest.json` |
| Staging (Unix) | `scripts/stage-mediainfo.sh <triple>` |
| Staging (Windows) | `scripts/stage-mediainfo.ps1 -Target <triple>` |
| Package inventory verifier | `scripts/verify-mediainfo-package.mjs` |
| Archive membership verifier | `scripts/verify-release-archive.mjs` |

## Frontend capability boundary (no shell)

`src-tauri/capabilities/default.json` must **not** grant frontend shell execute permissions.
Sidecar launch is backend-owned; the UI capability set stays limited (e.g. `core:default`, `dialog:default`, `opener:default`).

## Honest evidence boundary (three classes)

| Layer / class | `harnessType` | What it is | What it is not |
| --- | --- | --- | --- |
| Vitest unit/component tests | — | Frontend logic under jsdom | Desktop shell / keyring / MediaInfo process |
| Playwright `tests/ui-integration/**` | `mocked-playwright-not-desktop` | Browser/UI integration with **mocked** Tauri IPC | Real desktop E2E, WebDriver, or packaged-app automation |
| Offline provider/security contract | — | Localhost / offline contract checks | Live paid provider calls |
| MediaInfo manifest + notice gates | — | Offline inventory / checksum / license markers | Proof that binaries were downloaded in every local checkout |
| Tauri `pnpm tauri build` artifact jobs | — | Produces platform bundles when CI stages sidecars | Automatic pass of WebDriver or packaged smoke |
| **Host binary smoke** (Win/Linux) | `host-binary-smoke` | Production Rust in built binary (`OKPGUI_DESKTOP_SMOKE_OUT`) | WebView IPC / WebDriver UI |
| **Desktop WebDriver** (Win/Linux) | `desktop-webdriver` | Critical flows via `tauri-driver` + WDIO (stub until executable specs) | Mocked Playwright; host smoke alone |
| **macOS packaged smoke** | `macos-packaged-smoke` | Prefer `.app` layout + binary probes + MediaInfo spawn + keyring policy | Full UI WebDriver E2E on Darwin |

**Explicit:** mocked Playwright is **not desktop E2E**. Host binary smoke is **not** `productionIpcMarker` proof.

### Evidence classes (Milestone 6)

Release evidence must use distinct `harnessType` values (see `tests/desktop-e2e/evidence.schema.json`):

| Evidence class | `harnessType` | Runner | Real production IPC? |
| --- | --- | --- | --- |
| Mocked Playwright | `mocked-playwright-not-desktop` | `pnpm run test:ui-integration` | **No** — browser mock only |
| Host binary smoke | `host-binary-smoke` | `pnpm run test:desktop-e2e` (Windows/Linux) | **No** — `productionIpcMarker` must stay `false`; use `productionBinaryMarker` |
| Desktop WebDriver | `desktop-webdriver` | same runner when `tauri-driver` + executable WDIO specs exist | **Yes** only when `productionIpcMarker: true` |
| macOS packaged smoke | `macos-packaged-smoke` | `pnpm run test:macos-packaged-smoke` | **No** WebView IPC yet; packaged binary + sidecar + keyring policy |

Critical desktop WebDriver flows (named evidence tests; require `desktop-webdriver` for dual UI entries):

- `home-prepare-observe-ack-publish`
- `quick-publish-prepare-observe-ack-publish`
- `cancellation-and-failed-poll-recovery`

macOS packaged smoke probes: `packaged-app-layout`, `production-binary-probe`, `sidecar-mediainfo-probe` (spawn), `keyring-session-only-probe`, `minimal-backend-roundtrip`.
`production-ipc-probe` / `event-delivery-probe` / `minimal-ipc-roundtrip` are **skipped** until WebView IPC is proven.

- Schema + README: `tests/desktop-e2e/`
- Offline gate inventories the harness files; **empty** `tests/desktop-e2e/out/` does **not** fail offline verification (no binary required).
- Pass rules depend on `harnessType` (table above). Playwright-only paths never count as desktop pass.
- macOS remains **platform-limited** for UI WebDriver; packaged smoke is the honest Darwin class.
- CI uploads `desktop-evidence-*` artifacts; missing evidence JSON on applicable OS runners is fail-closed. Blocked evidence is honest, not a pass.

## Local commands (offline-friendly)

Run from the repository root:

```bash
# Cross-check release gates (offline, fail-closed)
node scripts/verify-byok-release-gates.mjs
# equivalent package script:
pnpm run verify:byok-release-gates

# MediaInfo manifest + redistribution notice only (no download/stage)
node scripts/verify-mediainfo-package.mjs --manifest-only
pnpm run verify:mediainfo

# Offline UI integration inventory (does not launch browsers)
node scripts/verify-ui-integration-inventory.mjs
pnpm run verify:ui-integration-inventory

# Offline provider/security contract inventory
node scripts/verify-provider-contract.mjs
pnpm run test:provider-contract

# Desktop harness (writes blocked evidence when binary/driver missing; not a pass claim)
pnpm run test:desktop-e2e
pnpm run test:macos-packaged-smoke

# Optional local suite (already verified separately for this milestone; not packaging)
pnpm test
pnpm build
```

Stage and fully verify a sidecar only when intentionally packaging (requires network for download):

```bash
./scripts/stage-mediainfo.sh x86_64-unknown-linux-gnu
node scripts/verify-mediainfo-package.mjs --target x86_64-unknown-linux-gnu
```

After building a draft-release archive, membership gate:

```bash
node scripts/verify-release-archive.mjs \
  --archive <path-to.zip-or.tar.gz> \
  --binary <okpgui-next|okpgui-next.exe> \
  --sidecar <mediainfo-<triple>[.exe]> \
  --notice mediainfo/THIRD_PARTY_NOTICES.html
```

## CI wiring

Both workflows invoke the offline BYOK release-gate verifier **before** build/package work and retain existing gates:

- `.github/workflows/build-artifact.yml`
- `.github/workflows/draft-release.yml`

Retained gates include:

1. `node scripts/verify-byok-release-gates.mjs`
2. MediaInfo inventory (`--manifest-only`) then per-target stage + verify
3. Cargo fmt / clippy
4. Offline provider contract + UI integration inventory
5. Frontend tests + production build
6. Playwright browser/UI integration (**mocked Tauri IPC; not desktop E2E** — evidence class mocked UI)
7. Backend tests + Tauri build
8. **Host binary smoke (Windows/Linux)** — `run-desktop-e2e.mjs` → `host-binary-smoke` with `productionBinaryMarker: true` (WebDriver remains blocked side-evidence until executable WDIO specs)
9. **macOS packaged smoke** — `run-macos-packaged-smoke.mjs` prefers `.app`; `productionBinaryMarker: true`, `productionIpcMarker: false`
10. Draft release only: archive membership via `verify-release-archive.mjs`

When a release binary exists, CI sets `DESKTOP_E2E_REQUIRE_PASS=1` for host/packaged binary smoke. Blocked WebDriver side-evidence is honest inventory, not a pass. Jobs fail if primary evidence JSON is missing on applicable runners.

## Sign-off notes (do not invent passes)

- [ ] Offline release gates green (`verify-byok-release-gates`)
- [ ] MediaInfo manifest + notice green (`--manifest-only`)
- [ ] Four target triples present in manifest, staging scripts, and workflow matrices
- [ ] Tauri `externalBin` + notice resource mapping intact
- [ ] Capability file still has **no shell** frontend permission
- [ ] Mocked Playwright labeled **not desktop E2E** (`mocked-playwright-not-desktop`)
- [ ] Desktop harness inventory present (`tests/desktop-e2e/evidence.schema.json`, runners, critical-flow specs)
- [ ] Per-target **host-binary-smoke** evidence for Windows/Linux (`productionBinaryMarker: true`, `productionIpcMarker: false`)
- [ ] Per-target **macos-packaged-smoke** evidence for x64/arm64 (prefer `.app`; sidecar spawn hard inside `.app`)
- [ ] Desktop WebDriver **not** checked as passed unless `harnessType: desktop-webdriver` + `productionIpcMarker: true`
- [ ] Dual-entry Home/Quick Publish UI not claimed from a single backend-only check
