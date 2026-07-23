import { expect, test } from '@playwright/test';
import {
  buildDefaultBridgeState,
  defaultReadySettings,
  installTauriMock,
  navigateToPage,
  readBridgeState,
} from './helpers/tauriBridge';

/**
 * UI integration: AI settings + capability probe against mocked Tauri IPC.
 * Not desktop E2E — no real keyring, provider network, or packaged WebView.
 */
test.describe('UI integration · settings/capability', () => {
  test('loads BYOK settings without secrets and runs capability probe via IPC mock', async ({
    page,
  }) => {
    const state = buildDefaultBridgeState({
      settings: defaultReadySettings(),
    });
    await installTauriMock(page, state);
    await page.goto('/');

    await navigateToPage(page, 'ai_settings');
    await expect(page.getByText('BYOK AI 连接')).toBeVisible();
    await expect(page.getByTestId('capability-status')).toContainText(/Ready|ready|Chat|chat/i);
    await expect(page.locator('body')).not.toContainText('sk-');
    await expect(page.getByText('密钥已配置')).toBeVisible();

    // Change model then re-probe through mocked IPC.
    await page.getByLabel('模型').fill('mock-gpt-mini');
    await page.getByRole('button', { name: '运行探测' }).click();
    await expect(page.getByText(/能力探测通过|正式 AI 任务已解锁/)).toBeVisible({
      timeout: 15_000,
    });

    const bridge = await readBridgeState(page);
    const commands = bridge.invokeLog.map((entry) => entry.command);
    expect(commands).toContain('ai_get_settings');
    expect(commands).toContain('ai_run_capability_probe');
    expect(commands).not.toContain('publish_prepared_plan');
    // Secret fields must never appear in the mock settings snapshot.
    expect(JSON.stringify(bridge.settings)).not.toContain('sk-');
  });

  test('refresh models uses list IPC and keeps manual model path', async ({ page }) => {
    await installTauriMock(
      page,
      buildDefaultBridgeState({
        settings: {
          ...defaultReadySettings(),
          model: 'manual-model',
          discovered_models: [],
          models_fetched_at_unix: null,
        },
      }),
    );
    await page.goto('/');
    await navigateToPage(page, 'ai_settings');
    await page.getByRole('button', { name: '刷新模型' }).click();
    await expect(page.getByText(/^已刷新 \d+ 个模型。$/)).toBeVisible({ timeout: 15_000 });
    const bridge = await readBridgeState(page);
    expect(bridge.invokeLog.some((entry) => entry.command === 'ai_list_models')).toBeTruthy();
  });
});
