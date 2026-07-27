import { expect, test } from '@playwright/test';
import {
  buildDefaultBridgeState,
  defaultDisabledSettings,
  ensureTauriMockOnPage,
  installTauriMock,
  navigateToPage,
  readBridgeState,
} from './helpers/tauriBridge';

/**
 * UI integration: disabled AI is a true no-side-effect path.
 * Not desktop E2E — asserts the mocked IPC boundary issues no formal AI starts
 * and no publish solely from opening settings when AI is off.
 */
test.describe('UI integration · disabled-AI no-side-effect', () => {
  test('disabled settings load without formal audit/provider side effects', async ({ page }) => {
    // Explicit disabled snapshot: enabled: false must produce no formal AI side effects.
    await installTauriMock(
      page,
      buildDefaultBridgeState({
        settings: { ...defaultDisabledSettings(), enabled: false },
        decision: 'GO',
      }),
    );
    await page.goto('/');
    await ensureTauriMockOnPage(page, buildDefaultBridgeState({         settings: { ...defaultDisabledSettings(), enabled: false },         decision: 'GO',       }));
    await navigateToPage(page, 'ai_settings');

    await expect(page.getByText('BYOK AI 连接')).toBeVisible();
    await expect(page.getByText('启用 AI 建议层')).toBeVisible();

    // Capability probing is removed. Model discovery remains an explicit setup action and must
    // not run until the user clicks it.
    const probe = page.getByRole('button', { name: '运行探测' });
    const refresh = page.getByRole('button', { name: '刷新模型' });
    await expect(probe).toHaveCount(0);
    await expect(refresh).toBeEnabled();

    const bridge = await readBridgeState(page);
    const commands = bridge.invokeLog.map((entry) => entry.command);
    expect(commands).toContain('ai_get_settings');
    expect(commands).not.toContain('ai_list_models');
    expect(commands).not.toContain('ai_start_formal_audit');
    expect(commands).not.toContain('publish_prepared_plan');
    expect(bridge.formalAuditStarts).toBe(0);
    expect(bridge.publishCalls).toBe(0);
    expect(bridge.settings.enabled).toBe(false);
  });

  test('disabled AI path stays disabled without capability UI or provider side effects', async ({ page }) => {
    await installTauriMock(
      page,
      buildDefaultBridgeState({
        settings: defaultDisabledSettings(),
      }),
    );
    await page.goto('/');
    await ensureTauriMockOnPage(page, buildDefaultBridgeState({         settings: defaultDisabledSettings(),       }));
    await navigateToPage(page, 'ai_settings');
    await expect(page.getByRole('checkbox', { name: '启用 AI 建议层' })).not.toBeChecked();
    await expect(page.getByTestId('capability-status')).toHaveCount(0);
    const bridge = await readBridgeState(page);
    expect(bridge.settings.capability).toBeNull();
    // no-side-effect: opening Home must not start formal AI either.
    await navigateToPage(page, 'home');
    await page.waitForTimeout(300);
    const after = await readBridgeState(page);
    expect(after.formalAuditStarts).toBe(0);
    expect(after.publishCalls).toBe(0);
  });
});
