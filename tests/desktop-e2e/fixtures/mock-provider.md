# Local mock provider (desktop E2E)

Desktop critical flows **must** use a **loopback mock provider**.
Paid/live APIs and real credentials are **forbidden**.

## Goals

- Same BYOK provider contract surface used by offline `verify-provider-contract` / Rust `provider_contract` tests
- Deterministic GO / WARNING / transport-error responses for critical flows
- No outbound network beyond `127.0.0.1`

## Configuration

| Item | Value |
| --- | --- |
| Profile | `tests/desktop-e2e/fixtures/deterministic-profile.json` |
| Preferred bind | `127.0.0.1:18765` |
| Env override | `DESKTOP_E2E_MOCK_PROVIDER_URL` (e.g. `http://127.0.0.1:18765`) |

Point the app’s AI base URL / custom endpoint at the mock **only for the desktop harness session**.
Do not commit live API keys. Session-only keyring fixtures must not claim cold-start restore.

## Scenario map

| Scenario key | Used by critical flow |
| --- | --- |
| `formalAuditGo` | Home / Quick Publish happy path (no ack or light path) |
| `formalAuditWarning` | Ack path: WARNING requires acknowledgement before publish |
| `transportError` | Cancellation / failed-poll recovery |

## Implementation notes

1. Prefer reusing Rust localhost mock helpers (`spawn_oneshot_mock` patterns in `provider_contract.rs`) from a host-side harness, **or** a small Node HTTP mock started by the desktop runner before WebDriver.
2. Runner must record `productionIpcMarker: true` only when the **built app** talked to this mock via production IPC — not when Playwright mocked `invoke`.

## What this is not

- Not a substitute for real desktop WebDriver evidence
- Not an approval to label `tests/ui-integration/**` as desktop E2E
