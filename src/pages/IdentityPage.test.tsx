import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import IdentityPage from './IdentityPage';
import { emptySiteCookies } from '../utils/cookieUtils';

const invokeMock = vi.mocked(invoke);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeProfile() {
    return {
        cookies: '',
        site_cookies: emptySiteCookies(),
        user_agent: '',
        dmhy_name: '',
        nyaa_name: '',
        acgrip_name: '',
        acgrip_api_token: '',
        bangumi_name: '',
        acgnx_asia_name: '',
        acgnx_asia_token: '',
        acgnx_global_name: '',
        acgnx_global_token: '',
    };
}

describe('IdentityPage duplicate-name save guard', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_profile_list':
                    return Promise.resolve(['alpha', 'beta']);
                case 'get_profiles':
                    return Promise.resolve({
                        last_used: 'alpha',
                        profiles: { alpha: makeProfile(), beta: makeProfile() },
                    });
                case 'save_profile':
                    return Promise.reject('已存在同名身份配置: beta（请改名或先重新加载）');
                default:
                    return Promise.resolve(null);
            }
        });

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        document.body.innerHTML = '';
    });

    it('shows a notice and keeps the form when the backend rejects a duplicate name', async () => {
        await act(async () => {
            root.render(<IdentityPage />);
        });

        // Initial load applied the last-used profile.
        const select = container.querySelector('select') as HTMLSelectElement;
        expect(select.value).toBe('alpha');

        const nameInput = Array.from(
            container.querySelectorAll('input'),
        ).find((input) => input.placeholder === '新配置名称（失焦自动创建）') as HTMLInputElement;
        expect(nameInput).toBeTruthy();

        // Type an existing profile name and blur to trigger the auto-create save.
        const valueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )!.set!;
        await act(async () => {
            valueSetter.call(nameInput, 'beta');
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            await Promise.resolve();
        });

        // The duplicate-name rejection is surfaced via the notice dialog...
        expect(document.body.textContent).toContain('保存配置失败');
        expect(document.body.textContent).toContain('已存在同名身份配置');

        // ...and the form is neither cleared nor switched to another profile.
        expect(nameInput.value).toBe('beta');
        expect(select.value).toBe('alpha');
    });
});
