import { act, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flushAsync, renderElement } from '../test-utils/react';
import { emptySiteCookies } from '../utils/cookieUtils';
import { AUTOSAVE_DEBOUNCE_MS } from '../utils/constants';
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
    default: ({ markdown, onMarkdownChange }: { markdown: string; onMarkdownChange: (value: string) => void }) => (
        <textarea
            aria-label="模板描述"
            value={markdown}
            onChange={(event) => onMarkdownChange(event.target.value)}
        />
    ),
}));

vi.mock('../components/TagInput', () => ({
    default: () => null,
}));

vi.mock('../components/TemplateSelect', () => ({
    default: ({
        options,
        value,
        onChange,
    }: {
        options: Array<{ name: string; label: string }>;
        value: string;
        onChange: (value: string) => void;
    }) => (
        <select
            aria-label="选择模板"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.name} value={option.name}>{option.label}</option>
            ))}
        </select>
    ),
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

function setTextareaValue(input: HTMLTextAreaElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
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

    it('drains description edits made while switching before beta is applied', async () => {
        vi.useFakeTimers();
        const firstDescriptionSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const secondDescriptionSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const saveRequests: Record<string, unknown>[] = [];
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', description: '旧描述', about: '模板 A' },
                beta: { profile: 'p1', description: '模板 B 描述', about: '模板 B' },
            },
        };
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') return Promise.resolve(config);
            if (command === 'save_template') {
                saveRequests.push(args ?? {});
                return saveRequests.length === 1
                    ? firstDescriptionSave.promise
                    : secondDescriptionSave.promise;
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            const description = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="模板描述"]',
            )!;
            await act(async () => {
                setTextareaValue(description, '未到防抖时间的新描述');
            });

            const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
                'select[aria-label="选择模板"]',
            )!;
            await act(async () => {
                templateSelect.value = 'beta';
                templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await flushAsync();

            expect(saveRequests[0]).toMatchObject({
                name: 'alpha',
                template: { description: '未到防抖时间的新描述' },
            });
            expect(templateSelect.value).toBe('alpha');
            expect(findAboutInput(rendered.container).value).toBe('模板 A');

            await act(async () => {
                setTextareaValue(description, '保存途中继续编辑的描述');
            });
            await act(async () => {
                firstDescriptionSave.resolve({
                    name: 'alpha',
                    template: saveRequests[0].template as Record<string, unknown>,
                });
            });
            await flushAsync();

            expect(saveRequests).toHaveLength(2);
            expect(saveRequests[1]).toMatchObject({
                name: 'alpha',
                template: { description: '保存途中继续编辑的描述' },
            });
            expect(templateSelect.value).toBe('alpha');
            expect(findAboutInput(rendered.container).value).toBe('模板 A');

            await act(async () => {
                secondDescriptionSave.resolve({
                    name: 'alpha',
                    template: saveRequests[1].template as Record<string, unknown>,
                });
            });
            await flushAsync();

            expect(templateSelect.value).toBe('beta');
            expect(findAboutInput(rendered.container).value).toBe('模板 B');
            expect(saveRequests).toHaveLength(2);
        } finally {
            await rendered.unmount();
            vi.useRealTimers();
        }
    });

    it('aborts switching when a later description drain save fails', async () => {
        vi.useFakeTimers();
        const firstSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const secondSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const saveRequests: Record<string, unknown>[] = [];
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', description: '旧描述', about: '模板 A' },
                beta: { profile: 'p1', description: '模板 B 描述', about: '模板 B' },
            },
        };
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') return Promise.resolve(config);
            if (command === 'save_template') {
                saveRequests.push(args ?? {});
                return saveRequests.length === 1 ? firstSave.promise : secondSave.promise;
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            const description = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="模板描述"]',
            )!;
            const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
                'select[aria-label="选择模板"]',
            )!;
            await act(async () => setTextareaValue(description, '第一次编辑'));
            await act(async () => {
                templateSelect.value = 'beta';
                templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await flushAsync();
            await act(async () => setTextareaValue(description, '保存途中第二次编辑'));
            await act(async () => firstSave.resolve({
                name: 'alpha',
                template: saveRequests[0].template as Record<string, unknown>,
            }));
            await flushAsync();
            expect(saveRequests).toHaveLength(2);

            await act(async () => secondSave.reject('第二次保存失败'));
            await flushAsync();
            expect(templateSelect.value).toBe('alpha');
            expect(findAboutInput(rendered.container).value).toBe('模板 A');
            expect(description.value).toBe('保存途中第二次编辑');
            expect(document.body.textContent).toContain('保存模板失败');
        } finally {
            await rendered.unmount();
            vi.useRealTimers();
        }
    });

    it('re-drains alpha edits made while the beta config fetch is pending', async () => {
        vi.useFakeTimers();
        const saveRequests: Record<string, unknown>[] = [];
        let getConfigCalls = 0;
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', description: '已保存描述', about: '模板 A' },
                beta: { profile: 'p1', description: '模板 B 描述', about: '模板 B' },
            },
        };
        const targetConfig = deferred<typeof config>();
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                getConfigCalls += 1;
                return getConfigCalls === 2 ? targetConfig.promise : Promise.resolve(config);
            }
            if (command === 'save_template') {
                saveRequests.push(args ?? {});
                return Promise.resolve({ name: args?.name, template: args?.template });
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            const description = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="模板描述"]',
            )!;
            const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
                'select[aria-label="选择模板"]',
            )!;
            await act(async () => {
                templateSelect.value = 'beta';
                templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await flushAsync();
            expect(templateSelect.value).toBe('alpha');
            expect(saveRequests).toHaveLength(0);

            await act(async () => setTextareaValue(description, '目标加载期间的新描述'));
            await act(async () => targetConfig.resolve(config));
            await flushAsync();

            expect(saveRequests).toHaveLength(1);
            expect(saveRequests[0]).toMatchObject({
                name: 'alpha',
                template: { description: '目标加载期间的新描述' },
            });
            expect(templateSelect.value).toBe('beta');
            expect(findAboutInput(rendered.container).value).toBe('模板 B');
        } finally {
            await rendered.unmount();
            vi.useRealTimers();
        }
    });

    it('aborts when re-draining an alpha edit made during beta fetch fails', async () => {
        vi.useFakeTimers();
        let getConfigCalls = 0;
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', description: '已保存描述', about: '模板 A' },
                beta: { profile: 'p1', description: '模板 B 描述', about: '模板 B' },
            },
        };
        const targetConfig = deferred<typeof config>();
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                getConfigCalls += 1;
                return getConfigCalls === 2 ? targetConfig.promise : Promise.resolve(config);
            }
            if (command === 'save_template') return Promise.reject('加载期间保存失败');
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            const description = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[aria-label="模板描述"]',
            )!;
            const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
                'select[aria-label="选择模板"]',
            )!;
            await act(async () => {
                templateSelect.value = 'beta';
                templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await flushAsync();
            await act(async () => setTextareaValue(description, '不能丢失的加载期编辑'));
            await act(async () => targetConfig.resolve(config));
            await flushAsync();

            expect(templateSelect.value).toBe('alpha');
            expect(findAboutInput(rendered.container).value).toBe('模板 A');
            expect(description.value).toBe('不能丢失的加载期编辑');
            expect(document.body.textContent).toContain('保存模板失败');
        } finally {
            await rendered.unmount();
            vi.useRealTimers();
        }
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

    it('keeps template B identity and body when template A save resolves late', async () => {
        const firstSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const saveCalls: Record<string, unknown>[] = [];
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', about: '模板 A' },
                beta: { profile: 'p1', about: '模板 B' },
            },
        };
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                return Promise.resolve(config);
            }
            if (command === 'save_template') {
                const saveArgs = args ?? {};
                saveCalls.push(saveArgs);
                if (saveCalls.length === 1) {
                    return firstSave.promise;
                }
                return Promise.resolve({ name: saveArgs.name, template: saveArgs.template });
            }
            return routeInvoke(command, args);
        });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await act(async () => {
            findAcgripCheckbox(rendered.container).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        await flushAsync();
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0].name).toBe('alpha');

        const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
            'select[aria-label="选择模板"]',
        );
        expect(templateSelect).not.toBeNull();
        await act(async () => {
            templateSelect!.value = 'beta';
            templateSelect!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flushAsync();
        expect(templateSelect!.value).toBe('alpha');
        expect(findAboutInput(rendered.container).value).toBe('模板 A');

        await act(async () => {
            firstSave.resolve({
                name: 'alpha',
                template: saveCalls[0].template as Record<string, unknown>,
            });
        });
        await flushAsync();
        expect(templateSelect!.value).toBe('beta');
        expect(findAboutInput(rendered.container).value).toBe('模板 B');

        await act(async () => {
            findAcgripCheckbox(rendered.container).dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            );
        });
        await flushAsync();

        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[1].name).toBe('beta');
        expect(saveCalls[1].previousName).toBe('beta');
        expect((saveCalls[1].template as { about: string }).about).toBe('模板 B');

        await rendered.unmount();
    });

    it('aborts the switch and keeps alpha selected when its pending save rejects', async () => {
        const firstSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const saveCalls: Record<string, unknown>[] = [];
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: { profile: 'p1', about: '模板 A' },
                beta: { profile: 'p1', about: '模板 B' },
            },
        };
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                return Promise.resolve(config);
            }
            if (command === 'save_template') {
                const saveArgs = args ?? {};
                saveCalls.push(saveArgs);
                if (saveCalls.length === 1) {
                    return firstSave.promise;
                }
                return Promise.resolve({ name: saveArgs.name, template: saveArgs.template });
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
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0].name).toBe('alpha');

        const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
            'select[aria-label="选择模板"]',
        );
        expect(templateSelect).not.toBeNull();
        await act(async () => {
            templateSelect!.value = 'beta';
            templateSelect!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flushAsync();
        expect(templateSelect!.value).toBe('alpha');
        expect(findAboutInput(rendered.container).value).toBe('模板 A');

        await act(async () => {
            firstSave.reject('stale alpha rejection');
        });
        await flushAsync();
        expect(templateSelect!.value).toBe('alpha');
        expect(findAboutInput(rendered.container).value).toBe('模板 A');
        expect(document.body.textContent).toContain('保存模板失败');

        await act(async () => {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[1].name).toBe('alpha');
        expect(saveCalls[1].previousName).toBe('alpha');
        expect((saveCalls[1].template as { about: string }).about).toBe('模板 A');

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

describe('HomePage async selection guards', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        openMock.mockReset();
    });

    it.each([
        ['resolves', false],
        ['rejects', true],
    ])('keeps fast torrent B when slow torrent A %s later', async (_label, rejectA) => {
        const parseA = deferred<Record<string, unknown>>();
        const parseB = deferred<Record<string, unknown>>();
        openMock.mockResolvedValueOnce('/tmp/a.torrent').mockResolvedValueOnce('/tmp/b.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'parse_torrent') {
                return args?.path === '/tmp/a.torrent' ? parseA.promise : parseB.promise;
            }
            if (command === 'parse_title_details') return Promise.resolve({ title: '' });
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;

        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => {
            parseB.resolve({
                name: 'b.mkv',
                total_size: 2,
                file_tree: { name: 'b.mkv', size: 2, children: [], is_file: true },
            });
        });
        await flushAsync();
        expect(picker.textContent).toContain('/tmp/b.torrent');

        await act(async () => {
            if (rejectA) parseA.reject('A parse failed');
            else parseA.resolve({
                name: 'a.mkv',
                total_size: 1,
                file_tree: { name: 'a.mkv', size: 1, children: [], is_file: true },
            });
        });
        await flushAsync();
        expect(picker.textContent).toContain('/tmp/b.torrent');
        expect(document.body.textContent).not.toContain('A parse failed');
        await rendered.unmount();
    });

    it('keeps B rejection visible when slow torrent A succeeds later', async () => {
        const parseA = deferred<Record<string, unknown>>();
        const parseB = deferred<Record<string, unknown>>();
        openMock.mockResolvedValueOnce('/tmp/a.torrent').mockResolvedValueOnce('/tmp/b.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'parse_torrent') {
                return args?.path === '/tmp/a.torrent' ? parseA.promise : parseB.promise;
            }
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => parseB.reject('B parse failed'));
        await flushAsync();
        expect(document.body.textContent).toContain('B parse failed');

        await act(async () => parseA.resolve({
            name: 'a.mkv',
            total_size: 1,
            file_tree: { name: 'a.mkv', size: 1, children: [], is_file: true },
        }));
        await flushAsync();
        expect(document.body.textContent).toContain('B parse failed');
        expect(picker.textContent).not.toContain('/tmp/a.torrent');
        await rendered.unmount();
    });

    it('clears the previous torrent while a replacement parse is pending', async () => {
        const parseB = deferred<Record<string, unknown>>();
        openMock.mockResolvedValueOnce('/tmp/a.torrent').mockResolvedValueOnce('/tmp/b.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'parse_torrent' && args?.path === '/tmp/a.torrent') {
                return Promise.resolve({
                    name: 'a.mkv',
                    total_size: 1,
                    file_tree: { name: 'a.mkv', size: 1, children: [], is_file: true },
                });
            }
            if (command === 'parse_torrent') return parseB.promise;
            if (command === 'parse_title_details') return Promise.resolve({ title: '' });
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        expect(picker.textContent).toContain('/tmp/a.torrent');

        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        expect(picker.textContent).not.toContain('/tmp/a.torrent');
        expect(document.body.textContent).not.toContain('a.mkv');
        await rendered.unmount();
    });

    it('does not apply an automatic title after a manual edit returns to empty', async () => {
        const automaticTitle = deferred<{ title: string; episode: string; resolution: string }>();
        openMock.mockResolvedValue('/tmp/a.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'parse_torrent') {
                return Promise.resolve({
                    name: 'a.mkv',
                    total_size: 1,
                    file_tree: { name: 'a.mkv', size: 1, children: [], is_file: true },
                });
            }
            if (command === 'parse_title_details') return automaticTitle.promise;
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        const title = rendered.container.querySelector<HTMLTextAreaElement>(
            'textarea[placeholder^="最终发布标题"]',
        )!;

        await act(async () => setTextareaValue(title, 'A'));
        await flushAsync();
        await act(async () => setTextareaValue(title, ''));
        await flushAsync();
        await act(async () => automaticTitle.resolve({
            title: '迟到的自动标题',
            episode: '1',
            resolution: '1080p',
        }));
        await flushAsync();

        expect(title.value).toBe('');
        await rendered.unmount();
    });

    it('does not overwrite a title manually edited after generation starts', async () => {
        const titleRequest = deferred<{ title: string; episode: string; resolution: string }>();
        openMock.mockResolvedValue('/tmp/a.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                return Promise.resolve({
                    last_used_template: 'default',
                    okp_executable_path: '/okp',
                    templates: { default: { profile: 'p1', title: '初始标题' } },
                });
            }
            if (command === 'parse_torrent') {
                return Promise.resolve({
                    name: 'a.mkv',
                    total_size: 1,
                    file_tree: { name: 'a.mkv', size: 1, children: [], is_file: true },
                });
            }
            if (command === 'parse_title_details') return titleRequest.promise;
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        const generateButton = Array.from(rendered.container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('重新生成标题'),
        )!;
        await act(async () => generateButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        const title = rendered.container.querySelector<HTMLTextAreaElement>(
            'textarea[placeholder^="最终发布标题"]',
        )!;
        await act(async () => setTextareaValue(title, '用户新标题'));
        await act(async () => titleRequest.resolve({ title: '迟到生成标题', episode: '1', resolution: '1080p' }));
        await flushAsync();
        expect(title.value).toBe('用户新标题');
        expect(generateButton.disabled).toBe(false);
        await rendered.unmount();
    });

    it('does not let stale title rejection clear the current generation loading state', async () => {
        const titleA = deferred<{ title: string; episode: string; resolution: string }>();
        const titleB = deferred<{ title: string; episode: string; resolution: string }>();
        let titleRequest = 0;
        openMock.mockResolvedValueOnce('/tmp/a.torrent').mockResolvedValueOnce('/tmp/b.torrent');
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_config') {
                return Promise.resolve({
                    last_used_template: 'default',
                    okp_executable_path: '/okp',
                    templates: { default: { profile: 'p1', title: '初始标题' } },
                });
            }
            if (command === 'parse_torrent') {
                const filename = args?.path === '/tmp/a.torrent' ? 'a.mkv' : 'b.mkv';
                return Promise.resolve({
                    name: filename,
                    total_size: 1,
                    file_tree: { name: filename, size: 1, children: [], is_file: true },
                });
            }
            if (command === 'parse_title_details') {
                titleRequest += 1;
                return titleRequest === 1 ? titleA.promise : titleB.promise;
            }
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]')!;
        const generateButton = () => Array.from(rendered.container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('重新生成标题'),
        )!;

        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => generateButton().dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        await act(async () => generateButton().dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await flushAsync();
        expect(generateButton().disabled).toBe(true);

        await act(async () => titleA.reject('stale title failure'));
        await flushAsync();
        expect(generateButton().disabled).toBe(true);

        await act(async () => titleB.resolve({ title: 'B 标题', episode: '2', resolution: '1080p' }));
        await flushAsync();
        const title = rendered.container.querySelector<HTMLTextAreaElement>(
            'textarea[placeholder^="最终发布标题"]',
        )!;
        expect(title.value).toBe('B 标题');
        expect(generateButton().disabled).toBe(false);
        await rendered.unmount();
    });

    it('keeps profile controls disabled until the selected profile response arrives', async () => {
        const profileP1 = deferred<{ profiles: Record<string, ReturnType<typeof buildProfile>> }>();
        const profileP2 = deferred<{ profiles: Record<string, ReturnType<typeof buildProfile>> }>();
        let profileRequest = 0;
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
            if (command === 'get_profile_list') return Promise.resolve(['p1', 'p2']);
            if (command === 'get_profiles') {
                profileRequest += 1;
                return profileRequest === 1 ? profileP1.promise : profileP2.promise;
            }
            return routeInvoke(command, args);
        });
        const rendered = await renderElement(<HomePage />);
        await flushAsync();
        const profileSelect = Array.from(rendered.container.querySelectorAll('select')).find(
            (candidate) => candidate.textContent?.includes('选择身份配置'),
        )!;
        const valueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            'value',
        )!.set!;
        await act(async () => {
            valueSetter.call(profileSelect, 'p2');
            profileSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flushAsync();
        const loginButton = Array.from(rendered.container.querySelectorAll('button')).find(
            (button) => button.textContent === '测试登录',
        )!;
        expect(loginButton.disabled).toBe(true);

        await act(async () => profileP1.resolve({ profiles: { p1: buildProfile() } }));
        await flushAsync();
        expect(loginButton.disabled).toBe(true);

        await act(async () => profileP2.resolve({ profiles: { p2: buildProfile() } }));
        await flushAsync();
        expect(loginButton.disabled).toBe(false);
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
            aiSettings?: Record<string, unknown> | null;
            auditDecision?: string;
        } = {},
    ) {
        const extraProfiles = options.extraProfiles ?? {};
        const auditDecision = options.auditDecision ?? 'GO';
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
                                title: '发布标题',
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
                case 'ai_get_settings':
                    return Promise.resolve(
                        options.aiSettings === undefined
                            ? {
                                provider: 'open_ai',
                                endpoint: 'https://api.openai.com/v1',
                                model: '',
                                mode: 'auto',
                                auth_mode: 'bearer',
                                custom_header_name: null,
                                credential_ref: null,
                                enabled: false,
                            }
                            : options.aiSettings,
                    );
                case 'prepare_plan':
                    return Promise.resolve({
                        token: 'prepared-token',
                        snapshot_hash: 'sha256:backend-authoritative',
                        request_generation: 1,
                        local_blockers: [],
                        has_blockers: false,
                    });
                case 'ai_compute_audit':
                case 'ai_start_formal_audit':
                    return Promise.resolve({
                        decision: auditDecision,
                        findings: auditDecision === 'WARNING'
                            ? [{ code: 'W1', severity: 'WARNING', message: '标题可能不完整' }]
                            : [],
                        unknown_codes: [],
                        local_blockers: [],
                        formal_ran: auditDecision !== 'GO',
                        job_id: auditDecision === 'GO' ? null : 'job-1',
                        plan_token: 'prepared-token',
                        snapshot_hash: 'sha256:backend-authoritative',
                        request_generation: 1,
                    });
                case 'set_plan_acknowledgements':
                    return Promise.resolve(null);
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-1',
                        kind: 'audit',
                        state: 'cancelled',
                        request_generation: 1,
                        snapshot_hash: 'sha256:backend-authoritative',
                        progress: 100,
                    });
                case 'invalidate_plan':
                    return Promise.resolve(true);
                case 'publish_prepared_plan':
                    return Promise.resolve(null);
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

    async function selectTorrentAndOpenConfirm(container: HTMLElement, siteLabel: string) {
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

    async function confirmPublishInModal() {
        const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('确认发布'),
        );
        expect(confirmButton).toBeTruthy();
        expect(confirmButton!.disabled).toBe(false);
        await act(async () => {
            confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync(20);
    }

    it('does not publish before explicit confirmation and wires prepared token + audit', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');

            const prepareCalls = findInvokeArgs('prepare_plan');
            const auditCalls = findInvokeArgs('ai_start_formal_audit');
            const publishPreparedCalls = findInvokeArgs('publish_prepared_plan');
            expect(prepareCalls).toHaveLength(1);
            expect(auditCalls).toHaveLength(1);
            expect(publishPreparedCalls).toHaveLength(0);

            const prepareArgs = prepareCalls[0] as {
                request: {
                    request_generation?: number;
                    snapshot_hash?: string;
                    request: { template: { description_html: string } };
                };
            };
            // Client must not supply a snapshot_hash; backend owns plan identity.
            expect(prepareArgs.request.snapshot_hash).toBeUndefined();
            expect(prepareArgs.request.request_generation).toEqual(expect.any(Number));

            const auditArgs = auditCalls[0] as {
                request: { plan_token?: string; snapshot_hash?: string };
            };
            expect(auditArgs.request.plan_token).toBe('prepared-token');
            // Formal audit is token-bound; client snapshot authority is not accepted.
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();

            await confirmPublishInModal();
            expect(findInvokeArgs('publish_prepared_plan')).toEqual([{ token: 'prepared-token' }]);
        } finally {
            await rendered.unmount();
        }
    });

    it('invalidates the prepared token on cancel and never leaves it live', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');
            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);

            const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.trim() === '取消',
            );
            expect(cancelButton).toBeTruthy();
            await act(async () => {
                cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            // Security invariants remain valid during the modal leave transition;
            // do not assert ai-preflight-panel unmount (Headless UI leave keeps DOM briefly).
            const invalidateCalls = findInvokeArgs('invalidate_plan');
            expect(invalidateCalls.some((args) => args.token === 'prepared-token')).toBe(true);
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
        } finally {
            await rendered.unmount();
        }
    });

    it('invalidates the prepared token when a covered site selection changes', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc', acgrip_api_token: 'token-acgrip' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');
            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);

            const acgrip = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 ACG.RIP"]',
            );
            expect(acgrip).not.toBeNull();
            await act(async () => {
                acgrip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            expect(findInvokeArgs('invalidate_plan').some((args) => args.token === 'prepared-token')).toBe(true);
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
        } finally {
            await rendered.unmount();
        }
    });

    it('requires acknowledgement for WARNING before publishing the frozen token', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' }, { auditDecision: 'WARNING' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');

            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeTruthy();
            expect(confirmButton!.disabled).toBe(true);

            const warningAck = Array.from(document.body.querySelectorAll('label')).find(
                (label) => label.textContent?.includes('我已阅读提醒'),
            );
            expect(warningAck).toBeTruthy();
            const checkbox = warningAck!.querySelector<HTMLInputElement>('input[type="checkbox"]');
            expect(checkbox).not.toBeNull();
            await act(async () => {
                checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            expect(findInvokeArgs('set_plan_acknowledgements').length).toBeGreaterThanOrEqual(1);
            expect(confirmButton!.disabled).toBe(false);

            await confirmPublishInModal();
            expect(findInvokeArgs('publish_prepared_plan')).toEqual([{ token: 'prepared-token' }]);
        } finally {
            await rendered.unmount();
        }
    });

    it('keeps AI-disabled publish compatible via local GO audit without inventing client hashes', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' }, {
            aiSettings: {
                provider: 'open_ai',
                endpoint: '',
                model: '',
                mode: 'auto',
                auth_mode: 'bearer',
                custom_header_name: null,
                credential_ref: null,
                enabled: false,
            },
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');

            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);
            expect(findInvokeArgs('ai_start_formal_audit')).toHaveLength(1);
            expect(document.body.textContent).toContain('AI 未启用');

            await confirmPublishInModal();
            expect(findInvokeArgs('publish_prepared_plan')).toEqual([{ token: 'prepared-token' }]);
            // No client snapshot_hash authority in prepare.
            const prepareArgs = findInvokeArgs('prepare_plan')[0] as {
                request: { snapshot_hash?: string };
            };
            expect(prepareArgs.request.snapshot_hash).toBeUndefined();
        } finally {
            await rendered.unmount();
        }
    });

    it('back-fills rendered HTML into the persisted and published template for HTML-preferring sites', async () => {
        vi.useFakeTimers();
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();

            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');
            await confirmPublishInModal();

            const expectedHtml = renderMarkdownToHtml('**markdown 简介**');
            const saveCalls = findInvokeArgs('save_template');
            const prepareCalls = findInvokeArgs('prepare_plan');
            const publishPreparedCalls = findInvokeArgs('publish_prepared_plan');
            expect(saveCalls.length).toBeGreaterThanOrEqual(1);
            expect(prepareCalls).toHaveLength(1);
            expect(publishPreparedCalls).toEqual([{ token: 'prepared-token' }]);

            const persistedTemplate = (saveCalls[saveCalls.length - 1] as { template: { description_html: string } }).template;
            expect(persistedTemplate.description_html).toBe(expectedHtml);

            const prepareArgs = prepareCalls[0] as {
                request: {
                    request_generation?: number;
                    snapshot_hash?: string;
                    request: { template: { description_html: string; description: string } };
                };
            };
            // Client must not supply a snapshot_hash; backend owns plan identity.
            expect(prepareArgs.request.snapshot_hash).toBeUndefined();
            const publishRequest = prepareArgs.request.request;
            expect(publishRequest.template.description).toBe('**markdown 简介**');
            expect(publishRequest.template.description_html).toBe(expectedHtml);

            const savesAfterPublish = saveCalls.length;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
            });
            expect(findInvokeArgs('save_template')).toHaveLength(savesAfterPublish);
        } finally {
            await rendered.unmount();
            vi.useRealTimers();
        }
    });

    it('leaves description_html empty when only markdown-required sites are selected', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        mountWithTemplate({}, { site_cookies: nyaaCookies });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await selectTorrentAndOpenConfirm(rendered.container, 'Nyaa');
        await confirmPublishInModal();

        const prepareCalls = findInvokeArgs('prepare_plan');
        const publishPreparedCalls = findInvokeArgs('publish_prepared_plan');
        expect(prepareCalls).toHaveLength(1);
        expect(publishPreparedCalls).toEqual([{ token: 'prepared-token' }]);
        const prepareArgs = prepareCalls[0] as {
            request: {
                snapshot_hash?: string;
                request: { template: { description_html: string } };
            };
        };
        expect(prepareArgs.request.snapshot_hash).toBeUndefined();
        const publishRequest = prepareArgs.request.request;
        expect(publishRequest.template.description_html).toBe('');

        await rendered.unmount();
    });

    it('keeps the back-filled html on the next editor-driven save after publish', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        await flushAsync();

        await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');
        await confirmPublishInModal();

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

    it('builds the prepare payload from the backend-normalized saved template', async () => {
        mountWithTemplate(
            { about: '编辑器侧 about' },
            { acgnx_asia_token: 'token-abc' },
            {
                saveTemplateResult: (args) => ({
                    name: args.name,
                    template: {
                        ...(args.template as Record<string, unknown>),
                        about: '后端规范化 about',
                        tags: 'backend,normalized',
                    },
                }),
            },
        );

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');

            const prepareCalls = findInvokeArgs('prepare_plan');
            expect(prepareCalls).toHaveLength(1);
            const prepareArgs = prepareCalls[0] as {
                request: {
                    request: { template: { about: string; tags: string } };
                };
            };
            expect(prepareArgs.request.request.template.about).toBe('后端规范化 about');
            expect(prepareArgs.request.request.template.tags).toBe('backend,normalized');
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
        } finally {
            await rendered.unmount();
        }
    });

    it('suppresses stale confirmation when a covered edit happens during save or prepare', async () => {
        const pendingSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        let holdPublishSave = false;
        let publishSaveHeld = false;

        // Custom mount so save_template / prepare_plan can race a covered editor edit.
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
                                title: '发布标题',
                            },
                        },
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: { ...buildProfile(), acgnx_asia_token: 'token-abc' } } });
                case 'save_template':
                    if (holdPublishSave && !publishSaveHeld) {
                        publishSaveHeld = true;
                        return pendingSave.promise;
                    }
                    return Promise.resolve({ name: typedArgs?.name, template: typedArgs?.template });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: '发布标题', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: '',
                        model: '',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: null,
                        enabled: false,
                    });
                case 'prepare_plan':
                    return pendingPrepare.promise;
                case 'ai_compute_audit':
                case 'ai_start_formal_audit':
                    return Promise.resolve({
                        decision: 'GO',
                        findings: [],
                        unknown_codes: [],
                        local_blockers: [],
                        formal_ran: false,
                        job_id: null,
                        plan_token: 'prepared-token',
                        snapshot_hash: 'sha256:backend-authoritative',
                        request_generation: 1,
                    });
                case 'set_plan_acknowledgements':
                    return Promise.resolve(null);
                case 'invalidate_plan':
                    return Promise.resolve(true);
                case 'publish_prepared_plan':
                    return Promise.resolve(null);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();

            const checkbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 ACGNx Asia"]',
            );
            expect(checkbox).not.toBeNull();
            await act(async () => {
                checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]');
            expect(picker).not.toBeNull();
            await act(async () => {
                picker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            // Hold only the next save (publish path); site-toggle autosave already completed.
            holdPublishSave = true;
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
                button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(5);
            expect(publishSaveHeld).toBe(true);

            // Covered editor mutation while publish save is in flight.
            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder^="最终发布标题"]',
            );
            expect(title).not.toBeNull();
            await act(async () => {
                setTextareaValue(title!, 'covered-edit-during-save');
            });
            await flushAsync();

            const saveCalls = findInvokeArgs('save_template');
            const heldSaveArgs = saveCalls[saveCalls.length - 1] as {
                name?: string;
                template?: Record<string, unknown>;
            } | undefined;
            await act(async () => {
                pendingSave.resolve({
                    name: String(heldSaveArgs?.name ?? 'default'),
                    template: heldSaveArgs?.template ?? {},
                });
            });
            // If prepare was reached despite the generation guard, resolve it so the race settles.
            await act(async () => {
                pendingPrepare.resolve({
                    token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            });
            await flushAsync(20);

            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeUndefined();
        } finally {
            await rendered.unmount();
        }
    });

    it('suppresses stale confirmation when TemplateSelect switches identity during held publish save', async () => {
        const pendingSave = deferred<{ name: string; template: Record<string, unknown> }>();
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        let holdPublishSave = false;
        let publishSaveHeld = false;
        const config = {
            last_used_template: 'alpha',
            okp_executable_path: '/okp',
            templates: {
                alpha: {
                    profile: 'p1',
                    description: '**markdown 简介**',
                    description_html: '',
                    title: '发布标题',
                    about: '模板 A',
                },
                beta: {
                    profile: 'p1',
                    description: '模板 B 描述',
                    description_html: '',
                    title: '模板 B 标题',
                    about: '模板 B',
                },
            },
        };

        invokeMock.mockImplementation((command: string, args) => {
            const typedArgs = args as Record<string, unknown> | undefined;
            switch (command) {
                case 'get_config':
                    return Promise.resolve(config);
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({
                        profiles: { p1: { ...buildProfile(), acgnx_asia_token: 'token-abc' } },
                    });
                case 'save_template':
                    if (holdPublishSave && !publishSaveHeld) {
                        publishSaveHeld = true;
                        return pendingSave.promise;
                    }
                    return Promise.resolve({ name: typedArgs?.name, template: typedArgs?.template });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: '发布标题', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: '',
                        model: '',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: null,
                        enabled: false,
                    });
                case 'prepare_plan':
                    return pendingPrepare.promise;
                case 'ai_compute_audit':
                case 'ai_start_formal_audit':
                    return Promise.resolve({
                        decision: 'GO',
                        findings: [],
                        unknown_codes: [],
                        local_blockers: [],
                        formal_ran: false,
                        job_id: null,
                        plan_token: 'stale-prepared-token',
                        snapshot_hash: 'sha256:stale',
                        request_generation: 1,
                    });
                case 'set_plan_acknowledgements':
                    return Promise.resolve(null);
                case 'invalidate_plan':
                    return Promise.resolve(true);
                case 'publish_prepared_plan':
                    return Promise.resolve(null);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();

            const checkbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 ACGNx Asia"]',
            );
            expect(checkbox).not.toBeNull();
            await act(async () => {
                checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]');
            expect(picker).not.toBeNull();
            await act(async () => {
                picker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            // Hold only the publish-path save; site-toggle autosave already finished.
            holdPublishSave = true;
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
                button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(5);
            expect(publishSaveHeld).toBe(true);

            // Template identity switch while publish preparation is mid-save.
            const templateSelect = rendered.container.querySelector<HTMLSelectElement>(
                'select[aria-label="选择模板"]',
            );
            expect(templateSelect).not.toBeNull();
            await act(async () => {
                templateSelect!.value = 'beta';
                templateSelect!.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await flushAsync();

            const saveCalls = findInvokeArgs('save_template');
            const heldSaveArgs = saveCalls[saveCalls.length - 1] as {
                name?: string;
                template?: Record<string, unknown>;
            } | undefined;
            await act(async () => {
                pendingSave.resolve({
                    name: String(heldSaveArgs?.name ?? 'alpha'),
                    template: heldSaveArgs?.template ?? {},
                });
            });
            // Settle any prepare that might have been reached before the generation guard.
            await act(async () => {
                pendingPrepare.resolve({
                    token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            });
            await flushAsync(20);

            // Identity switch supersedes the in-flight prepare: no confirm UI, no publish.
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeUndefined();
            // Selection should land on beta after the held save drains.
            expect(templateSelect!.value).toBe('beta');
            expect(findAboutInput(rendered.container).value).toBe('模板 B');
        } finally {
            await rendered.unmount();
        }
    });

    it('suppresses stale confirmation when a covered edit happens during deferred prepare_plan', async () => {
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        const pendingAudit = deferred<{
            decision: string;
            findings: unknown[];
            unknown_codes: unknown[];
            local_blockers: unknown[];
            formal_ran: boolean;
            job_id: string | null;
            plan_token: string;
            snapshot_hash: string;
            request_generation: number;
        }>();
        let prepareHeld = false;

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
                                title: '发布标题',
                            },
                        },
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({
                        profiles: { p1: { ...buildProfile(), acgnx_asia_token: 'token-abc' } },
                    });
                case 'save_template':
                    // Save completes immediately so publish reaches prepare_plan.
                    return Promise.resolve({ name: typedArgs?.name, template: typedArgs?.template });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: '发布标题', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: '',
                        model: '',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: null,
                        enabled: false,
                    });
                case 'prepare_plan':
                    prepareHeld = true;
                    return pendingPrepare.promise;
                case 'ai_compute_audit':
                case 'ai_start_formal_audit':
                    return pendingAudit.promise;
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-x',
                        kind: 'audit',
                        state: 'cancelled',
                        request_generation: 1,
                        snapshot_hash: 'sha256:x',
                        progress: 100,
                    });
                case 'set_plan_acknowledgements':
                    return Promise.resolve(null);
                case 'invalidate_plan':
                    return Promise.resolve(true);
                case 'publish_prepared_plan':
                    return Promise.resolve(null);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();

            const checkbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 ACGNx Asia"]',
            );
            expect(checkbox).not.toBeNull();
            await act(async () => {
                checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]');
            expect(picker).not.toBeNull();
            await act(async () => {
                picker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
                button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            expect(prepareHeld).toBe(true);
            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);

            // Covered editor mutation while prepare_plan is still pending.
            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder^="最终发布标题"]',
            );
            expect(title).not.toBeNull();
            await act(async () => {
                setTextareaValue(title!, 'covered-edit-during-prepare');
            });
            await flushAsync();

            await act(async () => {
                pendingPrepare.resolve({
                    token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            });
            // If audit is reached despite the generation guard, resolve it so the race settles.
            await act(async () => {
                pendingAudit.resolve({
                    decision: 'GO',
                    findings: [],
                    unknown_codes: [],
                    local_blockers: [],
                    formal_ran: false,
                    job_id: null,
                    plan_token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale',
                    request_generation: 1,
                });
            });
            await flushAsync(20);

            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeUndefined();
        } finally {
            await rendered.unmount();
        }
    });

    it('suppresses stale confirmation when late auto-title applies during in-flight publish preparation', async () => {
        // Race: title generation starts (pending parse_title_details), publish save/prepare
        // begins while that request is still open, then the late generated title applies and
        // must supersede the covered in-flight preflight (apply-time generation bump).
        const pendingTitle = deferred<{ title: string; episode: string; resolution: string }>();
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        const pendingAudit = deferred<{
            decision: string;
            findings: unknown[];
            unknown_codes: unknown[];
            local_blockers: unknown[];
            formal_ran: boolean;
            job_id: string | null;
            plan_token: string;
            snapshot_hash: string;
            request_generation: number;
        }>();
        let titleGenerationHeld = false;
        let prepareHeld = false;

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
                                // Non-empty so torrent parse does not auto-call parse_title_details;
                                // only the explicit generate-title path holds the deferred request.
                                title: '发布标题',
                            },
                        },
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({
                        profiles: { p1: { ...buildProfile(), acgnx_asia_token: 'token-abc' } },
                    });
                case 'save_template':
                    return Promise.resolve({ name: typedArgs?.name, template: typedArgs?.template });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details': {
                    // Title generation matches the torrent filename; publish metadata parsing
                    // uses the current title string when non-empty. Hold only the generation path
                    // so publish can reach prepare while title generation is still pending.
                    const filename = String(typedArgs?.filename ?? '');
                    if (filename === 'release.mkv') {
                        titleGenerationHeld = true;
                        return pendingTitle.promise;
                    }
                    return Promise.resolve({
                        title: filename || '发布标题',
                        episode: '01',
                        resolution: '1080p',
                    });
                }
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: '',
                        model: '',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: null,
                        enabled: false,
                    });
                case 'prepare_plan':
                    prepareHeld = true;
                    return pendingPrepare.promise;
                case 'ai_compute_audit':
                case 'ai_start_formal_audit':
                    return pendingAudit.promise;
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-x',
                        kind: 'audit',
                        state: 'cancelled',
                        request_generation: 1,
                        snapshot_hash: 'sha256:x',
                        progress: 100,
                    });
                case 'set_plan_acknowledgements':
                    return Promise.resolve(null);
                case 'invalidate_plan':
                    return Promise.resolve(true);
                case 'publish_prepared_plan':
                    return Promise.resolve(null);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();

            const checkbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 ACGNx Asia"]',
            );
            expect(checkbox).not.toBeNull();
            await act(async () => {
                checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const picker = rendered.container.querySelector<HTMLElement>('div[aria-label="选择种子文件"]');
            expect(picker).not.toBeNull();
            await act(async () => {
                picker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder^="最终发布标题"]',
            );
            expect(title).not.toBeNull();
            expect(title!.value).toBe('发布标题');

            // Start title generation and keep parse_title_details pending.
            const generateButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('重新生成标题'),
            );
            expect(generateButton).toBeTruthy();
            await act(async () => {
                generateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            expect(titleGenerationHeld).toBe(true);
            expect(generateButton!.disabled).toBe(true);

            // Publish preparation starts while title generation is still in flight.
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find((button) =>
                button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            // Reach prepare (not merely an unstarted click): save + resolve must have completed.
            expect(prepareHeld).toBe(true);
            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);
            expect(findInvokeArgs('save_template').length).toBeGreaterThanOrEqual(1);

            // Late generated title applies mid-prepare; apply-time covered mutation must win.
            await act(async () => {
                pendingTitle.resolve({
                    title: '迟到自动生成标题',
                    episode: '02',
                    resolution: '1080p',
                });
            });
            await flushAsync();

            // Settle any prepare/audit that raced past the generation guard.
            await act(async () => {
                pendingPrepare.resolve({
                    token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale-title-race',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            });
            await act(async () => {
                pendingAudit.resolve({
                    decision: 'GO',
                    findings: [],
                    unknown_codes: [],
                    local_blockers: [],
                    formal_ran: false,
                    job_id: null,
                    plan_token: 'stale-prepared-token',
                    snapshot_hash: 'sha256:stale-title-race',
                    request_generation: 1,
                });
            });
            await flushAsync(20);

            // Generated title applied; in-flight prepare must not leave confirm UI live.
            expect(title!.value).toBe('迟到自动生成标题');
            expect(generateButton!.disabled).toBe(false);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();
            expect(findInvokeArgs('publish_prepared_plan')).toHaveLength(0);
            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeUndefined();
        } finally {
            await rendered.unmount();
        }
    });

    it('keeps the frozen publish token valid after history-only episode/resolution edits', async () => {
        mountWithTemplate({}, { acgnx_asia_token: 'token-abc' });

        const rendered = await renderElement(<HomePage />);
        try {
            await flushAsync();
            await selectTorrentAndOpenConfirm(rendered.container, 'ACGNx Asia');
            expect(findInvokeArgs('prepare_plan')).toHaveLength(1);

            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            expect(episodeInput).not.toBeNull();
            expect(resolutionInput).not.toBeNull();

            const invalidateBefore = findInvokeArgs('invalidate_plan').length;
            await act(async () => {
                setInputValue(episodeInput!, '12');
                setInputValue(resolutionInput!, '2160p');
            });
            await flushAsync();

            // History-only fields must not kill the prepared token or close the modal.
            expect(findInvokeArgs('invalidate_plan')).toHaveLength(invalidateBefore);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
            expect(episodeInput!.value).toBe('12');
            expect(resolutionInput!.value).toBe('2160p');

            await confirmPublishInModal();
            expect(findInvokeArgs('publish_prepared_plan')).toEqual([{ token: 'prepared-token' }]);
        } finally {
            await rendered.unmount();
        }
    });
});
