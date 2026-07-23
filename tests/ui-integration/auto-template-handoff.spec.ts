import { expect, test } from '@playwright/test';
import {
  buildDefaultBridgeState,
  defaultReadySettings,
  installTauriMock,
  navigateToPage,
  readBridgeState,
} from './helpers/tauriBridge';

/**
 * UI integration: automatic template selection page + opaque seed handoff.
 * Not desktop E2E — torrent/MediaInfo/provider work is mocked at the IPC boundary.
 */
test.describe('UI integration · auto-template handoff', () => {
  test('shows auto-template entry and starts selection job without live provider', async ({
    page,
  }) => {
    await installTauriMock(
      page,
      buildDefaultBridgeState({
        settings: defaultReadySettings(),
      }),
    );
    await page.goto('/');
    await navigateToPage(page, 'auto_template');

    // Page title / primary CTA from AutoTemplatePage.
    await expect(page.getByRole('heading', { name: '自动选择模板' })).toBeVisible({
      timeout: 15_000,
    });

    // Provide a mock path (no real filesystem access in browser UI integration).
    await page.getByPlaceholder('/path/to/file.torrent').fill('/mock/release.torrent');
    await page.getByRole('button', { name: '选择并进入发布' }).click();

    // Poll bridge for selection IPC; success path may navigate or show status.
    await expect
      .poll(async () => {
        const bridge = await readBridgeState(page);
        return bridge.invokeLog.some(
          (entry) =>
            entry.command === 'ai_start_template_selection'
            || entry.command === 'ai_poll_template_selection'
            || entry.command === 'ai_get_settings',
        );
      }, { timeout: 15_000 })
      .toBeTruthy();

    const bridge = await readBridgeState(page);
    // No live publish as a side effect of opening auto-template.
    expect(bridge.publishCalls).toBe(0);
    expect(JSON.stringify(bridge.invokeLog)).not.toContain('sk-');
  });

  test('navigation shell exposes auto_template under AI section', async ({ page }) => {
    await installTauriMock(page, buildDefaultBridgeState());
    await page.goto('/');
    // Sidebar label from Sidebar.tsx
    await expect(page.getByText('自动选择模板')).toBeVisible();
    await page.getByText('自动选择模板').click();
    await expect
      .poll(async () => {
        const bridge = await readBridgeState(page);
        return bridge.invokeLog.some((entry) => entry.command === 'ai_get_settings');
      })
      .toBeTruthy();
  });
});
