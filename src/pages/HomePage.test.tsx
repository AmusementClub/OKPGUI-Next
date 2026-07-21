import { act, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
import { emptySiteCookies } from '../utils/cookieUtils';
import { renderMarkdownToHtml } from '../utils/markdown';
import HomePage from './HomePage';

const { invokeMock, openMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    openMock: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
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
    open: openMock,
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

describe('HomePage publish content pipeline', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        openMock.mockReset();
        openMock.mockResolvedValue('/tmp/a.torrent');
    });

    function mountWithTemplate(
        templateOverrides: Record<string, unknown>,
        profileOverrides: Record<string, unknown>,
        options: {
            extraProfiles?: Record<string, Record<string, unknown>>;
            saveTemplateResult?: (args: Record<string, unknown>) => unknown;
        } = {},
    ) {
        const extraProfiles = options.extraProfiles ?? {};
        invokeMock.mockImplementation((command: string, args) => {
            const typedArgs = args as Record<string, unknown> | undefined;
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        last_used_template: 'default',
                        okp_executable_path: '/okp',
                        templates: {
                            default: {
                                profile: 'p1',
                                description: '**markdown 简介**',
                                description_html: '',
                                ...templateOverrides,
                            },
                        },
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1', ...Object.keys(extraProfiles)]);
                case 'get_profiles':
                    return Promise.resolve({
                        profiles: { p1: { ...buildProfile(), ...profileOverrides }, ...extraProfiles },
                    });
                case 'save_template':
                    return Promise.resolve(
                        options.saveTemplateResult
                            ? options.saveTemplateResult(typedArgs ?? {})
                            : { name: typedArgs?.name, template: typedArgs?.template },
                    );
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: '发布标题', episode: '01', resolution: '1080p' });
                default:
                    return Promise.resolve(null);
            }
        });
    }

    function findInvokeArgs(command: string): Record<string, unknown>[] {
        return invokeMock.mock.calls
            .filter(([called]) => called === command)
            .map(([, args]) => args as Record<string, unknown>);
    }

    async function selectTorrentAndPublish(container: HTMLElement, siteLabel: string) {
        // Toggle the site on after the profile loads (selectable rows only).
        const checkbox = container.querySelector<HTMLInputElement>(
            `input[type="checkbox"][title="选择 ${siteLabel}"]`,
        );
        expect(checkbox).not.toBeNull();
        expect(checkbox!.disabled).toBe(false);
        await act(async () => {
            checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        const picker = container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]');
        expect(picker).not.toBeNull();
        await act(async () => {
            picker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        const publishButton = Array.from(container.querySelectorAll('button')).find((button) =>
            button.textContent?.includes('发布已选站点'),
        );
        expect(publishButton).toBeTruthy();
        expect(publishButton!.disabled).toBe(false);
        await act(async () => {
            publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync(20);
    }

    it('back-fills rendered HTML into the persisted and published template for HTML-preferring sites', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await selectTorrentAndPublish(rendered.container, 'ACGNx Asia');

        const expectedHtml = renderMarkdownToHtml('**markdown 简介**');
        const saveCalls = findInvokeArgs('save_template');
        const publishCalls = findInvokeArgs('publish');
        expect(saveCalls.length).toBeGreaterThanOrEqual(1);
        expect(publishCalls).toHaveLength(1);

        const persistedTemplate = (saveCalls[saveCalls.length - 1] as { template: { description_html: string } }).template;
        expect(persistedTemplate.description_html).toBe(expectedHtml);

        const publishRequest = (publishCalls[0] as { request: { template: { description_html: string; description: string } } }).request;
        expect(publishRequest.template.description).toBe('**markdown 简介**');
        expect(publishRequest.template.description_html).toBe(expectedHtml);

        await rendered.unmount();
    });

    it('leaves description_html empty when only markdown-required sites are selected', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        mountWithTemplate({}, { site_cookies: nyaaCookies });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await selectTorrentAndPublish(rendered.container, 'Nyaa');

        const publishCalls = findInvokeArgs('publish');
        expect(publishCalls).toHaveLength(1);
        const publishRequest = (publishCalls[0] as { request: { template: { description_html: string } } }).request;
        expect(publishRequest.template.description_html).toBe('');

        await rendered.unmount();
    });

    it('keeps the back-filled html on the next editor-driven save after publish', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await selectTorrentAndPublish(rendered.container, 'ACGNx Asia');

        const expectedHtml = renderMarkdownToHtml('**markdown 简介**');
        const savesBefore = findInvokeArgs('save_template').length;

        // A subsequent editor-driven save (site toggle autosave) must carry the
        // back-filled html, not revert it to empty.
        const checkbox = rendered.container.querySelector<HTMLInputElement>(
            'input[type="checkbox"][title="选择 ACG.RIP"]',
        );
        expect(checkbox).not.toBeNull();
        expect(checkbox!.disabled).toBe(false);
        await act(async () => {
            checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        const saveCalls = findInvokeArgs('save_template');
        expect(saveCalls.length).toBeGreaterThan(savesBefore);
        const lastSave = saveCalls[saveCalls.length - 1] as { template: { description_html: string } };
        expect(lastSave.template.description_html).toBe(expectedHtml);

        await rendered.unmount();
    });

    it('applies the saved template after a profile switch (same augmentation on both sides)', async () => {
        mountWithTemplate(
            {},
            {},
            {
                extraProfiles: { p2: buildProfile() },
                saveTemplateResult: (args) => ({
                    name: args.name,
                    template: { ...(args.template as Record<string, unknown>), about: '后端改写' },
                }),
            },
        );

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        // Switch the profile: the autosave carries profile p2 while the editor
        // template still says p1 — the guard must compare like-for-like.
        const profileSelect = Array.from(rendered.container.querySelectorAll('select')).find(
            (candidate) => candidate.textContent?.includes('选择身份配置'),
        ) as HTMLSelectElement | undefined;
        expect(profileSelect).toBeTruthy();

        const valueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            'value',
        )!.set!;
        await act(async () => {
            valueSetter.call(profileSelect, 'p2');
            profileSelect!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flushAsync();

        // The server-normalized template is applied, not silently dropped.
        expect(findAboutInput(rendered.container).value).toBe('后端改写');

        await rendered.unmount();
    });
});
