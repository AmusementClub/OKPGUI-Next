import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
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
        mode: 'responses',
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

describe('AiSettingsPage model discovery and direct JSON configuration', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('shows only Messages for Anthropic and normalizes legacy incompatible modes', async () => {
        invokeMock.mockResolvedValue(baseSettings({
            provider: 'anthropic',
            mode: 'auto',
            auth_mode: 'bearer',
        }));

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const mode = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="调用模式"]');
        expect(mode).toBeTruthy();
        expect(Array.from(mode!.options).map((option) => [option.value, option.textContent])).toEqual([
            ['anthropic_messages', 'Messages JSON'],
        ]);
        expect(mode!.value).toBe('anthropic_messages');
        expect(rendered.container.querySelector<HTMLInputElement>('input[value="https://api.anthropic.com/v1"]')).toBeTruthy();
        const auth = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="认证"]');
        expect(Array.from(auth!.options).map((option) => [option.value, option.textContent])).toEqual([
            ['anthropic_api_key', 'Anthropic API Key (x-api-key)'],
            ['custom_header', '自定义 Header'],
        ]);
        expect(auth!.value).toBe('anthropic_api_key');

        const save = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('保存连接'),
        );
        expect(save).toBeTruthy();
        await act(async () => save!.click());
        await flushAsync();

        const saveCall = invokeMock.mock.calls.find(([command]) => command === 'ai_save_settings');
        expect(saveCall?.[1]).toMatchObject({
            connection: {
                provider: 'anthropic',
                endpoint: 'https://api.anthropic.com/v1',
                mode: 'anthropic_messages',
                auth_mode: 'anthropic_api_key',
            },
        });
    });

    it('shows only Responses and Chat for OpenAI Compatible and removes automatic mode', async () => {
        invokeMock.mockResolvedValue(baseSettings({ provider: 'anthropic', mode: 'anthropic_messages' }));

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const provider = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="提供商"]');
        expect(provider).toBeTruthy();
        await act(async () => {
            provider!.value = 'open_ai';
            provider!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flushAsync();

        const mode = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="调用模式"]');
        expect(Array.from(mode!.options).map((option) => [option.value, option.textContent])).toEqual([
            ['responses', 'Responses JSON'],
            ['chat', 'Chat JSON'],
        ]);
        expect(mode!.value).toBe('responses');
        expect(rendered.container.textContent).not.toContain('Messages JSON');
        expect(rendered.container.querySelector<HTMLInputElement>('input[value="https://api.openai.com/v1"]')).toBeTruthy();
        const auth = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="认证"]');
        expect(Array.from(auth!.options).map((option) => [option.value, option.textContent])).toEqual([
            ['bearer', 'OpenAI API Key (Authorization: Bearer)'],
            ['custom_header', '自定义 Header'],
        ]);
        expect(auth!.value).toBe('bearer');
    });

    it('preserves a custom endpoint when switching providers', async () => {
        invokeMock.mockResolvedValue(baseSettings({
            endpoint: 'https://gateway.example/v1',
            auth_mode: 'custom_header',
        }));

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();
        const provider = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="提供商"]');
        await act(async () => {
            provider!.value = 'anthropic';
            provider!.dispatchEvent(new Event('change', { bubbles: true }));
        });

        expect(rendered.container.querySelector<HTMLInputElement>('input[value="https://gateway.example/v1"]')).toBeTruthy();
        const auth = rendered.container.querySelector<HTMLSelectElement>('select[aria-label="认证"]');
        expect(auth!.value).toBe('custom_header');
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
        expect(rendered.container.textContent).toContain('JSON object');
        expect(rendered.container.textContent).not.toContain('sk-');
        expect(invokeMock).toHaveBeenCalledWith('ai_get_settings');
    });

    it('refreshes models via IPC and keeps manual model on fallback', async () => {
        const saved = baseSettings({ model: 'manual-model' });
        invokeMock.mockImplementation(async (command: string) => {
            switch (command) {
                case 'ai_get_settings':
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

        expect(invokeMock).toHaveBeenCalledWith('ai_list_models', {
            connection: saved,
            secret: null,
        });
        expect(invokeMock.mock.calls.some(([command]) => command === 'ai_save_settings')).toBe(false);
        expect(rendered.container.textContent).toContain('可继续手动输入模型');
        expect(rendered.container.textContent).not.toContain('sk-');
    });

    it('discovers models from an incomplete disabled draft without saving first', async () => {
        const draft = baseSettings({ enabled: false, model: '', credential_ref: null });
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') return draft;
            if (command === 'ai_list_models') {
                return {
                    models: ['gpt-draft-model'],
                    fetched_at_unix: 101,
                    manual_fallback: false,
                    message: 'models refreshed',
                };
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const secret = rendered.container.querySelector<HTMLInputElement>('input[type="password"]');
        expect(secret).toBeTruthy();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(secret, 'draft-secret');
            secret!.dispatchEvent(new Event('input', { bubbles: true }));
            secret!.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const refresh = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('刷新模型'),
        );
        expect(refresh).toBeTruthy();
        expect(refresh).toHaveProperty('disabled', false);
        await act(async () => refresh!.click());
        await flushAsync();

        expect(invokeMock).toHaveBeenCalledWith('ai_list_models', {
            connection: draft,
            secret: 'draft-secret',
        });
        expect(invokeMock.mock.calls.some(([command]) => command === 'ai_save_settings')).toBe(false);
        expect(rendered.container.textContent).toContain('已刷新 1 个模型');
    });

    it('shows persistent session-only warning when credential is not durable', async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') {
                return baseSettings({
                    credential_session_only: true,
                    credential_ref: { id: 'session-cred' },
                });
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const banner = rendered.container.querySelector(
            '[data-testid="credential-session-only-warning"]',
        );
        expect(banner).toBeTruthy();
        expect(banner?.textContent).toContain('仅保存在本会话');
        expect(banner?.textContent).toContain('重启');
        expect(rendered.container.textContent).toContain('重启后丢失');
        // Never surface secret material.
        expect(rendered.container.textContent).not.toContain('sk-');
        expect(rendered.container.querySelector('[data-testid="credential-session-only"]')).toBeTruthy();
    });

    it('does not show session-only warning for durable keyring credentials', async () => {
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'ai_get_settings') {
                return baseSettings({
                    credential_session_only: false,
                    credential_ref: { id: 'durable-cred' },
                });
            }
            throw new Error(`unexpected command ${command}`);
        });

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        expect(
            rendered.container.querySelector('[data-testid="credential-session-only-warning"]'),
        ).toBeNull();
        expect(rendered.container.textContent).toContain('密钥已配置');
        expect(rendered.container.textContent).not.toContain('重启后丢失');
    });

    it('after save with session-only response keeps the restart warning visible', async () => {
        const sessionSettings = baseSettings({
            credential_session_only: true,
            credential_ref: { id: 'session-after-save' },
        });
        invokeMock.mockImplementation(async (command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return baseSettings({ credential_session_only: false, credential_ref: null });
                case 'ai_save_settings':
                    return sessionSettings;
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });

        const rendered = await renderElement(<AiSettingsPage />);
        await flushAsync();

        const save = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('保存连接'),
        );
        expect(save).toBeTruthy();
        save!.click();
        await flushAsync();

        expect(
            rendered.container.querySelector('[data-testid="credential-session-only-warning"]'),
        ).toBeTruthy();
        expect(rendered.container.textContent).toContain('仅保存在本会话');
        expect(rendered.container.textContent).not.toContain('sk-');
    });
});
