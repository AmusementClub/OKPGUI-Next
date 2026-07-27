# Desktop critical-flow specs (Milestone 6)

Named flows for **real** Tauri desktop WebDriver on Windows/Linux.
These are **not** Playwright UI-integration tests and must never be labeled mocked-desktop.

| Evidence name | Spec |
| --- | --- |
| `home-prepare-observe-ack-publish` | [home-prepare-observe-ack-publish.md](./home-prepare-observe-ack-publish.md) |
| `quick-publish-prepare-observe-ack-publish` | [quick-publish-prepare-observe-ack-publish.md](./quick-publish-prepare-observe-ack-publish.md) |
| `cancellation-and-failed-poll-recovery` | [cancellation-and-failed-poll-recovery.md](./cancellation-and-failed-poll-recovery.md) |

Catalog source of truth for runners: `tests/desktop-e2e/suite/critical-flows.mjs`.

macOS uses **packaged smoke** probes (IPC / event / sidecar / keyring), not these full UI flows.
