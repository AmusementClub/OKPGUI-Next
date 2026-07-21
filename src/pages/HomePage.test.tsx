import { act, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
import { emptySiteCookies } from '../utils/cookieUtils';
import HomePage from './HomePage';

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
    }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(() => Promise.resolve(null)),
    save: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock('../components/PublishContentEditor', () => ({
    default: () => null,
}));

vi.mock('../components/TagInput', () => ({
    default: () => null,
}));

function buildProfile() {
    return {
        user_agent: '',
        site_cookies: emptySiteCookies(),
        dmhy_name: '',
        nyaa_name: '',
        acgrip_name: '',
        acgrip_api_token: 'token-123',
        bangumi_name: '',
        acgnx_asia_name: '',
        acgnx_asia_token: '',
        acgnx_global_name: '',
        acgnx_global_token: '',
    };
}

function routeInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    switch (command) {
        case 'get_config':
            return Promise.resolve({
                last_used_template: 'default',
                okp_executable_path: '/okp',
                templates: {
                    default: { profile: 'p1' },
                },
            });
        case 'get_profile_list':
            return Promise.resolve(['p1']);
        case 'get_profiles':
            return Promise.resolve({ profiles: { p1: buildProfile() } });
        case 'save_template':
            return Promise.resolve({ name: args?.name, template: args?.template });
        default:
            return Promise.resolve(null);
    }
}

function countSaveTemplateCalls(): number {
    return invokeMock.mock.calls.filter(([command]) => command === 'save_template').length;
}

describe('HomePage site toggle', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockImplementation(routeInvoke);
    });

    it('saves the template exactly once per toggle under StrictMode', async () => {
        const rendered = await renderElement(
            <StrictMode>
                <HomePage />
            </StrictMode>,
        );
        await flushAsync();

        const checkbox = rendered.container.querySelector<HTMLInputElement>(
            'input[type="checkbox"][title="选择 ACG.RIP"]',
        );
        expect(checkbox).not.toBeNull();
        expect(checkbox?.disabled).toBe(false);

        const savesBefore = countSaveTemplateCalls();
        await act(async () => {
            checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        expect(countSaveTemplateCalls() - savesBefore).toBe(1);

        await rendered.unmount();
    });
});

function setInputValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
    )!.set!;
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findAcgripCheckbox(container: HTMLElement): HTMLInputElement {
    const checkbox = container.querySelector<HTMLInputElement>(
        'input[type="checkbox"][title="选择 ACG.RIP"]',
    );
    expect(checkbox).not.toBeNull();
    return checkbox!;
}

function findAboutInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[placeholder="简介或联系方式"]');
    expect(input).not.toBeNull();
    return input!;
}

describe('HomePage template save guards', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('does not clobber editor keystrokes when a save resolves after further typing', async () => {
        let saveArgs: Record<string, unknown> | null = null;
        let resolveSave: ((value: unknown) => void) | null = null;
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'save_template') {
                saveArgs = args ?? null;
                return new Promise((resolve) => {
                    resolveSave = resolve;
                });
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        // Toggle a site: the autosave goes in flight and stays unresolved.
        const checkbox = findAcgripCheckbox(rendered.container);
        await act(async () => {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
        expect(saveArgs).not.toBeNull();

        // Type into the about field while the save is in flight.
        const aboutInput = findAboutInput(rendered.container);
        await act(async () => {
            setInputValue(aboutInput, '新简介内容');
        });
        await flushAsync();

        // The save resolves with a server-normalized template; the editor must win.
        await act(async () => {
            resolveSave!({
                name: (saveArgs as Record<string, unknown>).name,
                template: {
                    ...(saveArgs as Record<string, unknown>).template as Record<string, unknown>,
                    about: '后端改写',
                },
            });
        });
        await flushAsync();

        expect(aboutInput.value).toBe('新简介内容');
        // The save still refreshed template metadata (options reload reads get_config).
        const getConfigCalls = invokeMock.mock.calls.filter(([command]) => command === 'get_config');
        expect(getConfigCalls.length).toBeGreaterThanOrEqual(2);

        await rendered.unmount();
    });

    it('applies the saved template when the editor was untouched during the save', async () => {
        let saveArgs: Record<string, unknown> | null = null;
        let resolveSave: ((value: unknown) => void) | null = null;
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'save_template') {
                saveArgs = args ?? null;
                return new Promise((resolve) => {
                    resolveSave = resolve;
                });
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        const checkbox = findAcgripCheckbox(rendered.container);
        await act(async () => {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
        expect(saveArgs).not.toBeNull();

        // No further typing: the server-normalized template is applied.
        await act(async () => {
            resolveSave!({
                name: (saveArgs as Record<string, unknown>).name,
                template: {
                    ...(saveArgs as Record<string, unknown>).template as Record<string, unknown>,
                    about: '后端改写',
                },
            });
        });
        await flushAsync();

        expect(findAboutInput(rendered.container).value).toBe('后端改写');

        await rendered.unmount();
    });

    it('shows a notice and preserves dirty state when an autosave fails', async () => {
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'save_template') {
                return Promise.reject('磁盘已满');
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        const checkbox = findAcgripCheckbox(rendered.container);
        const savesBefore = countSaveTemplateCalls();
        await act(async () => {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        // Autosave failures surface a notice instead of console-only silence.
        expect(countSaveTemplateCalls() - savesBefore).toBe(1);
        expect(document.body.textContent).toContain('保存模板失败');
        expect(document.body.textContent).toContain('磁盘已满');
        // Dirty state is preserved: the toggle is not reverted by the failed save.
        expect(checkbox.checked).toBe(true);

        // The next change still attempts a save (dirty state re-arms the flow).
        await act(async () => {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
        expect(countSaveTemplateCalls() - savesBefore).toBe(2);

        await rendered.unmount();
    });
});
