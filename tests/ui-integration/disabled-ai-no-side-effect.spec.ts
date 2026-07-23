import { expect, test } from '@playwright/test';
import {
  buildDefaultBridgeState,
  defaultDisabledSettings,
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
    await navigateToPage(page, 'ai_settings');

    await expect(page.getByText('BYOK AI 连接')).toBeVisible();
    await expect(page.getByText('启用 AI 建议层')).toBeVisible();

    // Probe / model refresh must remain disabled while AI is off.
    const probe = page.getByRole('button', { name: '运行探测' });
    const refresh = page.getByRole('button', { name: '刷新模型' });
    await expect(probe).toBeDisabled();
    await expect(refresh).toBeDisabled();

    const bridge = await readBridgeState(page);
    const commands = bridge.invokeLog.map((entry) => entry.command);
    expect(commands).toContain('ai_get_settings');
    expect(commands).not.toContain('ai_run_capability_probe');
    expect(commands).not.toContain('ai_list_models');
    expect(commands).not.toContain('ai_start_formal_audit');
    expect(commands).not.toContain('ai_start_template_selection');
    expect(commands).not.toContain('publish_prepared_plan');
    expect(bridge.formalAuditStarts).toBe(0);
    expect(bridge.publishCalls).toBe(0);
    expect(bridge.settings.enabled).toBe(false);
  });

  test('disabled AI path does not invent capability ready state', async ({ page }) => {
    await installTauriMock(
      page,
      buildDefaultBridgeState({
        settings: defaultDisabledSettings(),
      }),
    );
    await page.goto('/');
    await navigateToPage(page, 'ai_settings');
    await expect(page.getByTestId('capability-status')).toContainText(/未探测|未知/);
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
