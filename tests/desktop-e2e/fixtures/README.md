# Desktop E2E fixtures

Local-only assets for **desktop WebDriver** and **macOS packaged smoke**.

## Deterministic profile

| File | Role |
| --- | --- |
| `deterministic-profile.json` | Fixture profile: mock bind, scenarios, selectors, IPC contract |
| `mock-provider.md` | Loopback mock provider notes |
| `media/` | Controlled media/path placeholders |

Load profile from runners via `tests/desktop-e2e/suite/critical-flows.mjs` → `FIXTURE_PROFILE_REL`.

## Mock provider

Desktop critical flows must hit a **local mock provider** (loopback), never paid/live APIs.

- Mock HTTP server (or in-process Rust mock) implementing the BYOK provider contract
- Controlled GO / WARNING / FAIL / transport error bodies
- No credentials and no outbound network beyond loopback

See [mock-provider.md](./mock-provider.md).

## Controlled test files

- Small fake media / path fixtures for MediaInfo discovery and path-sensitive publish prep
- Packaged smoke prefers bundled MediaInfo sidecar
- No production user data

## Honesty

- Fixtures alone never set `productionIpcMarker: true`
- Playwright under `tests/ui-integration/**` is a different evidence class (`mocked-playwright-not-desktop`)
