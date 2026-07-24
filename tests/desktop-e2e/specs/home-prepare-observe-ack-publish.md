# Critical flow: Home prepare → observe IPC → ack → publish

| Field | Value |
| --- | --- |
| Evidence name | `home-prepare-observe-ack-publish` |
| Entry | Home |
| Harness | `desktop-webdriver` (Windows / Linux only) |
| Fixture profile | `tests/desktop-e2e/fixtures/deterministic-profile.json` |

## Preconditions

- Built app binary (`DESKTOP_E2E_BINARY`), `tauri-driver`, WebdriverIO client
- Local mock provider on loopback (see `fixtures/mock-provider.md`)
- Controlled draft / media paths from the fixture profile
- **Forbidden:** Vite-only, Playwright mocked `invoke`, paid providers

## Steps

1. Launch built app via `tauri-driver` (production WebView, not browser mock).
2. Navigate to **Home** publish entry; fill deterministic draft fields from profile.
3. Start prepare / preflight (`prepare_plan` production IPC).
4. **Observe** panel state driven by real IPC/events (`ai-preflight-status`, advisory disclaimer visible).
5. If audit decision is WARNING (fixture `formalAuditWarning`), complete required acknowledgements via production `set_plan_acknowledgements`.
6. Confirm publish of the **frozen plan token** (`publish_prepared_plan`) against the local mock / offline publish path as applicable.
7. Assert terminal emitted/result state; token cannot be reused after success/invalidation.

## Pass criteria

- All command paths are production Tauri IPC on the built binary
- `productionIpcMarker: true` in evidence for this run only when the above holds
- Frozen-token contract: no client-forged publish plan body bypassing the token

## WDIO-style stub (structure only)

```js
// Conceptual — executed only when desktop-webdriver prerequisites are present.
describe('home-prepare-observe-ack-publish', () => {
  it('prepare → observe → ack → publish frozen token', async () => {
    // await browser.url('tauri://localhost'); // driver-owned
    // await $(profile.selectors.homePrepare).click();
    // await expect($(profile.selectors.preflightPanel)).toBeDisplayed();
    // await expect($(profile.selectors.advisoryDisclaimer)).toBeDisplayed();
    // ... ack if WARNING, then publish; assert result
  });
});
```
