# Critical flow: Cancellation and failed-poll recovery

| Field | Value |
| --- | --- |
| Evidence name | `cancellation-and-failed-poll-recovery` |
| Entry | Shared (Home or Quick Publish) |
| Harness | `desktop-webdriver` |
| Fixture | `transportError` + cancel mid-flight |

## Scenarios

### A — Explicit Cancel

1. Start prepare / audit so panel is `preparing` or `auditing`.
2. Click Cancel (`ai-preflight-cancel`).
3. Expect immediate local invalidation and `reconciling` until Rust `ai_cancel_preflight_session` returns `reconciled=true`.
4. Expect terminal cancelled/unavailable; `canConfirm` false; late completion cannot reopen confirmation.
5. Retry creates a **fresh** generation (no reuse of failed token).

### B — Failed poll / transport loss

1. Configure mock for connection drop during `ai_poll_formal_audit`.
2. Expect panel leaves error-free live `PENDING`; enters reconciling; atomic cancel path runs.
3. Without backend-bound terminal evidence, do not invent GO/WARNING in the browser.
4. After `reconciled=true`, terminal `UNAVAILABLE` / recovery actions only.

## Pass criteria

- Production IPC for cancel/reconcile (not client-only state)
- No silent PENDING; no confirm while reconciling
- Mocked UI tests are **not** evidence for this flow

## WDIO-style stub

```js
describe('cancellation-and-failed-poll-recovery', () => {
  it('cancel mid-audit reconciles via production IPC', async () => { /* ... */ });
  it('poll transport failure forces reconciling then UNAVAILABLE', async () => { /* ... */ });
});
```
