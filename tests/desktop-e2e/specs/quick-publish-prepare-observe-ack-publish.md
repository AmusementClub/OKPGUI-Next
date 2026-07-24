# Critical flow: Quick Publish prepare → observe IPC → ack → publish

| Field | Value |
| --- | --- |
| Evidence name | `quick-publish-prepare-observe-ack-publish` |
| Entry | Quick Publish |
| Harness | `desktop-webdriver` (Windows / Linux only) |
| Fixture profile | `tests/desktop-e2e/fixtures/deterministic-profile.json` |

## Preconditions

Same as Home flow: built binary, `tauri-driver`, WebdriverIO, loopback mock provider.
**Forbidden:** mocked Playwright as desktop evidence.

## Steps

1. Launch built app via `tauri-driver`.
2. Open **Quick Publish**; if auto-template banner is present, complete ordinary review/edit (no silent publish).
3. Start prepare on Quick Publish path (`prepare_plan` production IPC).
4. Observe shared preflight panel state (same lifecycle semantics as Home).
5. Acknowledge when WARNING requires it; publish frozen token via `publish_prepared_plan`.
6. Assert result parity with Home frozen-token contract (shared recovery / error presentation).

## Pass criteria

- Quick Publish uses the same production IPC authority as Home
- No one-shot handoff seed mint without explicit Review when auto-template is involved
- Evidence names this flow distinctly from Home

## WDIO-style stub

```js
describe('quick-publish-prepare-observe-ack-publish', () => {
  it('prepare → observe → ack → publish frozen token', async () => {
    // Navigate Quick Publish; prepare; observe ai-preflight-*; ack; publish
  });
});
```
