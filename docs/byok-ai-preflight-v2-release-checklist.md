# BYOK AI Preflight V2 — release checklist

Offline packaging and honesty checklist for the BYOK AI Preflight V2 release slice.
This document records **reproducible local/CI gates** and the **evidence boundary**.
It does **not** claim that real desktop E2E or packaged-app smoke has passed.

## Required target triples (exact)

MediaInfo sidecar staging and CI matrices must cover exactly these four triples:

| Triple | Platform matrix role |
| --- | --- |
| `x86_64-pc-windows-msvc` | Windows x64 |
| `x86_64-unknown-linux-gnu` | Linux x64 |
| `x86_64-apple-darwin` | macOS Intel |
| `aarch64-apple-darwin` | macOS Apple Silicon |

Staged sidecar names (under `src-tauri/binaries/`):

- `mediainfo-x86_64-pc-windows-msvc.exe`
- `mediainfo-x86_64-unknown-linux-gnu`
- `mediainfo-x86_64-apple-darwin`
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

## Honest evidence boundary

| Layer | What it is | What it is not |
| --- | --- | --- |
| Vitest unit/component tests | Frontend logic under jsdom | Desktop shell / keyring / MediaInfo process |
| Playwright `tests/ui-integration/**` | Browser/UI integration with **mocked** Tauri IPC | Real desktop E2E, WebDriver, or packaged-app automation |
| Offline provider/security contract | Localhost / offline contract checks | Live paid provider calls |
| MediaInfo manifest + notice gates | Offline inventory / checksum / license markers | Proof that binaries were downloaded in every local checkout |
| Tauri `pnpm tauri build` artifact jobs | Produces platform bundles when CI stages sidecars | Automatic pass of Windows/Linux WebDriver or macOS packaged smoke |
| Desktop E2E / macOS packaged smoke | **Platform-limited / not run** without a dedicated harness | Do **not** treat mocked Playwright as a substitute pass |

**Explicit:** mocked Playwright is **not desktop E2E**. Real Windows/Linux desktop WebDriver E2E and macOS packaged IPC/sidecar/keyring smoke remain **platform-limited and unrun** unless a separate runner harness is added and executed.

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
6. Playwright browser/UI integration (**mocked Tauri IPC; not desktop E2E**)
7. Backend tests + Tauri build
8. Platform-limited desktop E2E / packaged-smoke **notice** (not a pass claim)
9. Draft release only: archive membership via `verify-release-archive.mjs`

## Sign-off notes (do not invent passes)

- [ ] Offline release gates green (`verify-byok-release-gates`)
- [ ] MediaInfo manifest + notice green (`--manifest-only`)
- [ ] Four target triples present in manifest, staging scripts, and workflow matrices
- [ ] Tauri `externalBin` + notice resource mapping intact
- [ ] Capability file still has **no shell** frontend permission
- [ ] Mocked Playwright labeled **not desktop E2E**
- [ ] Desktop WebDriver / packaged-app smoke recorded as **not run / platform-limited** (not checked as passed)
