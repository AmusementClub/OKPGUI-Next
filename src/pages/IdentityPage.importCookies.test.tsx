import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import IdentityPage from './IdentityPage';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(),
    save: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);

const IMPORT_ERROR = '未在导入的 Cookie 文件中识别到受支持站点的 Cookie。';

function flushMicrotasks() {
    return act(async () => {
        await Promise.resolve();
    });
}

function renderPage() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
        root.render(<IdentityPage />);
    });

    return {
        container,
        unmount() {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

async function clickImportButton(container: HTMLElement) {
    const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes('导入自定义 Cookie 文件'),
    );
    expect(button).toBeDefined();

    await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
    });
}

describe('IdentityPage cookie import', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        openMock.mockReset();

        invokeMock.mockImplementation((command) => {
            switch (command) {
                case 'get_profile_list':
                    return Promise.resolve([]);
                case 'get_profiles':
                    return Promise.resolve({ profiles: {} });
                case 'save_profile':
                    return Promise.resolve({ name: 'default', profile: {} });
                case 'import_cookie_file':
                    return Promise.reject(IMPORT_ERROR);
                default:
                    return Promise.resolve(null);
            }
        });
        openMock.mockResolvedValue('/tmp/cookies.txt');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('surfaces a notice when the import fails', async () => {
        const page = renderPage();
        await flushMicrotasks();

        await clickImportButton(page.container);
        await flushMicrotasks();

        expect(document.body.textContent).toContain('导入 Cookie 失败');
        expect(document.body.textContent).toContain(IMPORT_ERROR);

        page.unmount();
    });

    it('merges imported cookies per site and preserves sites absent from the file', async () => {
        const existingNyaa = 'https://nyaa.si\tkeep=1; path=/';
        const importedDmhy = 'https://share.dmhy.org\tnew=1; path=/';

        invokeMock.mockImplementation((command, args) => {
            switch (command) {
                case 'get_profile_list':
                    return Promise.resolve([]);
                case 'get_profiles':
                    return Promise.resolve({
                        profiles: {
                            default: {
                                user_agent: 'ProfileAgent/1.0',
                                site_cookies: {
                                    dmhy: { raw_text: '' },
                                    nyaa: { raw_text: existingNyaa },
                                    acgrip: { raw_text: '' },
                                    bangumi: { raw_text: '' },
                                },
                            },
                        },
                    });
                case 'save_profile':
                    return Promise.resolve({
                        name: 'default',
                        profile: (args as { profile: unknown }).profile,
                    });
                case 'import_cookie_file':
                    return Promise.resolve({
                        user_agent: 'ProfileAgent/1.0',
                        site_cookies: {
                            dmhy: { raw_text: importedDmhy },
                            nyaa: { raw_text: '' },
                            acgrip: { raw_text: '' },
                            bangumi: { raw_text: '' },
                        },
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const page = renderPage();
        await flushMicrotasks();
        await flushMicrotasks();

        await clickImportButton(page.container);
        await flushMicrotasks();

        const saveCall = invokeMock.mock.calls.find(([command]) => command === 'save_profile');
        expect(saveCall).toBeDefined();

        const savedProfile = (saveCall![1] as { profile: {
            site_cookies: Record<string, { raw_text: string }>;
            cookies: string;
        } }).profile;

        // dmhy came from the file; nyaa survived even though the file lacked it.
        expect(savedProfile.site_cookies.dmhy.raw_text).toBe(importedDmhy);
        expect(savedProfile.site_cookies.nyaa.raw_text).toBe(existingNyaa);
        expect(savedProfile.cookies).toContain('user-agent:\tProfileAgent/1.0');
        expect(document.body.textContent).not.toContain('导入 Cookie 失败');

        page.unmount();
    });
});
