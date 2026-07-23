import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flushAsync, renderElement } from '../test-utils/react';
import type { AiSettings } from '../types/ai';
import AiSettingsPage from './AiSettingsPage';

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

function baseSettings(overrides: Partial<AiSettings> = {}): AiSettings {
    return {
        provider: 'open_ai',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        mode: 'auto',
        auth_mode: 'bearer',
        custom_header_name: null,
        credential_ref: { id: 'cred-1' },
        enabled: true,
        capability: null,
        discovered_models: ['gpt-4o', 'gpt-4o-mini'],
        models_fetched_at_unix: 1,
        ...overrides,
    };
}

describe('AiSettingsPage model discovery and capability probe', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('loads settings without exposing secrets and shows manual model fallback path', async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') {
                return baseSettings({
                    capability: {
                        state: 'unknown',
                        identity_digest: '',
                        message: 'no capability probe has been run',
                        identity_matches: false,
                    },
                });
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        expect(rendered.container.textContent).toContain('BYOK AI 连接');
        expect(rendered.container.textContent).toContain('密钥已配置');
        expect(rendered.container.textContent).toContain('未知');
        expect(rendered.container.textContent).not.toContain('sk-');
        expect(invokeMock).toHaveBeenCalledWith('ai_get_settings');
    });

    it('refreshes models via IPC and keeps manual model on fallback', async () => {
        const saved = baseSettings({ model: 'manual-model' });
        invokeMock.mockImplementation(async (command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return saved;
                case 'ai_save_settings':
                    return saved;
                case 'ai_list_models':
                    return {
                        models: ['gpt-4o'],
                        fetched_at_unix: 99,
                        manual_fallback: true,
                        message: 'provider authentication failed (HTTP 401)',
                    };
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });

        const rendered = await renderElement(<AiSettingsPage />);
        const refresh = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('刷新模型'),
        );
        expect(refresh).toBeTruthy();
        refresh!.click();
        await flushAsync();

        expect(invokeMock).toHaveBeenCalledWith('ai_list_models');
        expect(rendered.container.textContent).toContain('可继续手动输入模型');
        expect(rendered.container.textContent).not.toContain('sk-');
    });

    it('runs capability probe and surfaces Ready status without secrets', async () => {
        let settings = baseSettings({
            capability: {
                state: 'unknown',
                identity_digest: '',
                message: '',
                identity_matches: false,
            },
        });
        invokeMock.mockImplementation(async (command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return settings;
                case 'ai_save_settings':
                    return settings;
                case 'ai_run_capability_probe': {
                    settings = baseSettings({
                        capability: {
                            state: 'ready',
                            identity_digest: 'sha256:probe',
                            resolved_mode: 'chat',
                            message: 'strict structured output is available',
                            identity_matches: true,
                            probed_at_unix: 123,
                        },
                    });
                    return settings.capability;
                }
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });

        const rendered = await renderElement(<AiSettingsPage />);
        const probe = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('运行探测'),
        );
        expect(probe).toBeTruthy();
        probe!.click();
        await flushAsync();

        expect(invokeMock).toHaveBeenCalledWith('ai_run_capability_probe');
        expect(rendered.container.textContent).toContain('Ready');
        expect(rendered.container.textContent).toContain('正式审计与 AI 自动选模板已解锁');
        expect(rendered.container.textContent).not.toContain('sk-');
    });

    it('does not call model discovery while AI is disabled (zero-network path)', async () => {
        const pending = deferred<AiSettings>();
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') {
                return pending.promise;
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        pending.resolve(baseSettings({ enabled: false, model: '', credential_ref: null }));
        await flushAsync();

        const refresh = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('刷新模型'),
        );
        expect(refresh).toBeTruthy();
        expect(refresh).toHaveProperty('disabled', true);
        expect(invokeMock.mock.calls.every(([command]) => command === 'ai_get_settings')).toBe(true);
    });

    it('keeps capability probe disabled and zero-network when AI is off (release-gate regression)', async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') {
                return baseSettings({
                    enabled: false,
                    model: '',
                    credential_ref: null,
                    capability: null,
                    discovered_models: [],
                });
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const probe = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('运行探测'),
        );
        expect(probe).toBeTruthy();
        expect(probe).toHaveProperty('disabled', true);
        // Click must not schedule formal probe IPC while disabled.
        probe!.click();
        await flushAsync();
        expect(invokeMock.mock.calls.every(([command]) => command === 'ai_get_settings')).toBe(true);
        expect(rendered.container.textContent).not.toContain('sk-');
        expect(rendered.container.textContent).toMatch(/未探测|未知/);
    });
});
