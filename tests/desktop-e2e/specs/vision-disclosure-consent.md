# Critical flow: Vision disclosure consent (any candidates)

| Field | Value |
| --- | --- |
| Evidence name | `vision-disclosure-consent` |
| Entry | Shared preflight (Home or Quick Publish) |
| Harness | `desktop-webdriver` |
| Fixture | `visionCandidates` (count 3, max 5) |

## Policy under test

- **Any** non-empty Vision candidate set requires explicit user confirmation before fetch/bind
- Under-cap counts do **not** auto-bind
- Disclosure shows source context, candidate count, maximum count, and that selected normalized images will be sent to the configured (mock) provider
- Text-only continues exactly one formal audit without Vision (`status=skipped`); does not attach images later
- Redirects remain hard failures (no three-hop following)

## Steps

1. Prepare a plan whose final content yields Vision candidates from the local mock.
2. Assert panel enters `awaiting_vision` / selection UI with `ai-preflight-vision-disclosure`.
3. Path A: Select all / use selected → bind via production `ai_bind_plan_vision` → audit continues.
4. Path B: Text-only → no bind → formal audit runs once without images.
5. Assert no auto-bind on candidate presentation alone.

## Pass criteria

- Production IPC for list/bind; consent UI exercised on real WebView
- `productionIpcMarker: true` only with real app path

## WDIO-style stub

```js
describe('vision-disclosure-consent', () => {
  it('requires explicit consent for any non-empty candidates', async () => {
    // expect disclosure; no auto-bind; text-only or use-selected
  });
});
```
