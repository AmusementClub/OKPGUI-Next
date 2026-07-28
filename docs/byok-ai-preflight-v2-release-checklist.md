# BYOK AI Preflight — Release Checklist

## Offline gates

```bash
pnpm run verify:byok-release-gates
pnpm run verify:mediainfo
pnpm run test:provider-contract
```

`verify:repository-hygiene` runs nested inside `verify:byok-release-gates` and remains available as a standalone diagnostic script.

## Package smoke (built artifacts)

```bash
pnpm run test:package-smoke
```

Platform coverage:

- Windows production executable
- Linux AppImage / host binary
- macOS packaged `.app` (CI sets `OKPGUI_SMOKE_PACKAGED_ONLY=1`; invalid `.app` fails closed without host fallback). Local host binary is only allowed when no `OKPGUI_MACOS_APP` is set.

Success is **command exit status** plus CI logs. There is no parallel evidence JSON product and no WebDriver UI coverage.

## UI integration (mocked IPC)

```bash
pnpm run test:ui-integration
```

Playwright covers settings, disabled-AI, and confirmation states. It is not desktop package smoke.

## Notes

- Provider capability probing behavior is unchanged.
- Formal audit requests carry only `plan_token`.
- Auth mode `none` is legacy-migrated (disabled AI + provider default auth).
