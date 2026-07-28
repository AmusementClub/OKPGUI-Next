import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flushAsync, renderElement } from '../test-utils/react';
import { emptySiteCookies } from '../utils/cookieUtils';
import { createDefaultQuickPublishTemplate } from '../utils/quickPublish';
import QuickPublishPage from './QuickPublishPage';

function setTextareaValue(input: HTMLTextAreaElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
    )!.set!;
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
    )!.set!;
    valueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

const { invokeMock, onDragDropEventMock, listenMock, publishEventHandlers } = vi.hoisted(() => {
    const publishEventHandlers: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};
    return {
        invokeMock: vi.fn(),
        onDragDropEventMock: vi.fn(),
        publishEventHandlers,
        listenMock: vi.fn((eventName: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
            publishEventHandlers[eventName] = handler;
            return Promise.resolve(vi.fn());
        }),
    };
});
vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: listenMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onDragDropEvent: onDragDropEventMock,
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

interface DragDropHandler {
    (event: { payload: { type: string; paths: string[] } }): void;
}

function routeInvoke(command: string): Promise<unknown> {
    switch (command) {
        case 'get_config':
            return Promise.resolve({
                quick_publish_templates: {},
                content_templates: {},
                okp_executable_path: '',
                last_used_quick_publish_template: null,
            });
        case 'get_profile_list':
            return Promise.resolve([]);
        case 'parse_torrent':
            return Promise.resolve({
                name: 'dropped.mkv',
                total_size: 1,
                file_tree: { name: 'dropped.mkv', size: 1, children: [], is_file: true },
            });
        default:
            return Promise.resolve(null);
    }
}

describe('QuickPublishPage drag-drop listener', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockImplementation(routeInvoke);
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
    });

    it('keeps one listener across re-renders and parses a single drop exactly once', async () => {
        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync();

        expect(onDragDropEventMock).toHaveBeenCalledTimes(1);

        // Re-renders must not re-register the listener: parseTorrent depends on
        // a stable onClearError callback.
        for (let index = 0; index < 3; index += 1) {
            await rendered.rerender(<QuickPublishPage />);
        }
        await flushAsync();
        expect(onDragDropEventMock).toHaveBeenCalledTimes(1);

        const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
        await act(async () => {
            handler({ payload: { type: 'drop', paths: ['/tmp/dropped.torrent'] } });
        });
        await flushAsync();

        const parseCalls = invokeMock.mock.calls.filter(([command]) => command === 'parse_torrent');
        expect(parseCalls).toHaveLength(1);
        expect(parseCalls[0][1]).toEqual({ path: '/tmp/dropped.torrent' });

        await rendered.unmount();
    });

    it('validates a dropped directory when no torrent is present', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'validate_media_content_root') {
                return Promise.resolve('/canonical/media/release');
            }
            return routeInvoke(command);
        });
        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync();

        const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
        await act(async () => {
            handler({ payload: { type: 'drop', paths: ['/media/release'] } });
        });
        await flushAsync();

        expect(invokeMock.mock.calls.filter(([command]) => command === 'parse_torrent')).toHaveLength(0);
        expect(invokeMock.mock.calls.filter(([command]) => command === 'validate_media_content_root'))
            .toEqual([['validate_media_content_root', { path: '/media/release' }]]);
        expect(rendered.container.textContent).toContain('/canonical/media/release');

        await rendered.unmount();
    });

    it('recommends a unique local template after a torrent drop without AI IPC', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_config') {
                return Promise.resolve({
                    quick_publish_templates: {
                        frieren: {
                            ...createDefaultQuickPublishTemplate(),
                            id: 'frieren',
                            name: 'Sousou no Frieren',
                        },
                        apothecary: {
                            ...createDefaultQuickPublishTemplate(),
                            id: 'apothecary',
                            name: 'Kusuriya no Hitorigoto',
                        },
                    },
                    content_templates: {},
                    last_used_quick_publish_template: 'apothecary',
                    okp_executable_path: '',
                    default_media_search_folder: '/media/library',
                });
            }
            if (command === 'parse_torrent') {
                return Promise.resolve({
                    name: '[Group] Sousou no Frieren - 28 [1080p][HEVC].mkv',
                    total_size: 1,
                    file_tree: { name: 'episode.mkv', size: 1, children: [], is_file: true },
                });
            }
            if (command === 'parse_title_details') {
                return Promise.resolve({
                    title: 'Sousou no Frieren',
                    episode: '28',
                    resolution: '1080p',
                });
            }
            if (command === 'ai_start_default_media_info') {
                return Promise.resolve({
                    job_id: 'job-media-auto',
                    plan_token: '',
                    state: 'succeeded',
                    request_generation: 1,
                    snapshot_hash: 'sha256:media-preview-1',
                    progress: 100,
                    error_code: null,
                    results: [{ relative_path: 'episode.mkv', state: 'measured' }],
                });
            }
            return routeInvoke(command);
        });
        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync();

        const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
        await act(async () => {
            handler({ payload: { type: 'drop', paths: ['/tmp/frieren.torrent'] } });
        });
        await flushAsync();

        const recommendation = rendered.container.querySelector('[data-testid="local-template-recommendation"]');
        expect(recommendation?.textContent).toContain('Sousou no Frieren');
        expect(invokeMock.mock.calls.some(([command]) => command === 'ai_start_template_selection')).toBe(false);
        expect(invokeMock.mock.calls.filter(([command]) => command === 'ai_start_default_media_info'))
            .toEqual([['ai_start_default_media_info', { torrentPath: '/tmp/frieren.torrent' }]]);
        expect(rendered.container.querySelector('[data-testid="automatic-media-info-status"]')?.textContent)
            .toContain('已检查 1 个文件');

        const applyButton = Array.from(rendered.container.querySelectorAll('button'))
            .find((button) => button.textContent?.includes('应用推荐'));
        expect(applyButton).toBeTruthy();
        await act(async () => {
            applyButton!.click();
        });
        expect(rendered.container.textContent).toContain('当前已应用');

        await rendered.unmount();
    });
});
describe('QuickPublishPage publish content validation', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
    });

    it('blocks publish client-side when a markdown-required site has no content', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                title: '发布标题',
                                default_profile: 'p1',
                                body_markdown: '',
                                body_html: '',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
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

        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync();

        // Select Nyaa (selectable via cookies) after the profile has loaded.
        const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
            'input[type="checkbox"][title="选择 Nyaa"]',
        );
        expect(nyaaCheckbox).not.toBeNull();
        expect(nyaaCheckbox!.disabled).toBe(false);
        await act(async () => {
            nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
        expect(nyaaCheckbox!.checked).toBe(true);

        // Drop a torrent so the draft has a torrent path.
        const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
        await act(async () => {
            handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
        });
        await flushAsync();

        const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('发布已选站点'),
        );
        expect(publishButton).toBeTruthy();
        await act(async () => {
            publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        // Content validation blocks before a prepared plan or confirmation is created.
        const prepareCalls = invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan');
        const publishCalls = invokeMock.mock.calls.filter(([command]) => command === 'publish' || command === 'publish_prepared_plan');
        expect(prepareCalls).toHaveLength(0);
        expect(publishCalls).toHaveLength(0);
        expect(document.body.textContent).toContain('需要 Markdown 发布内容');

        await rendered.unmount();
    });
});

describe('QuickPublishPage covered-edit preflight generation', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
    });

    it('suppresses stale confirmation when a covered edit happens during held prepare_plan', async () => {
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

        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                title: '发布标题',
                                default_profile: 'p1',
                                body_markdown: '**markdown 简介**',
                                body_html: '',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
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
                        snapshot_hash: 'sha256:stale',
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

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();

            const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 Nyaa"]',
            );
            expect(nyaaCheckbox).not.toBeNull();
            await act(async () => {
                nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            expect(nyaaCheckbox!.checked).toBe(true);

            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            expect(prepareHeld).toBe(true);
            const prepareCalls = invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan');
            expect(prepareCalls).toHaveLength(1);

            // Covered title mutation while prepare_plan is still pending.
            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder="最终发布标题"]',
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
            const publishPreparedCalls = invokeMock.mock.calls.filter(
                ([command]) => command === 'publish_prepared_plan',
            );
            expect(publishPreparedCalls).toHaveLength(0);
            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeUndefined();
        } finally {
            await rendered.unmount();
        }
    });
});

describe('QuickPublishPage confirmation parity', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
        listenMock.mockClear();
        for (const key of Object.keys(publishEventHandlers)) {
            delete publishEventHandlers[key];
        }
    });

    function buildSelectableProfile() {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        return {
            user_agent: '',
            site_cookies: nyaaCookies,
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

    async function selectSiteDropTorrentAndGetPublishButton(rendered: {
        container: HTMLElement;
    }) {
        await flushAsync();

        const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
            'input[type="checkbox"][title="选择 Nyaa"]',
        );
        expect(nyaaCheckbox).not.toBeNull();
        await act(async () => {
            nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
        expect(nyaaCheckbox!.checked).toBe(true);

        const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
        await act(async () => {
            handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
        });
        await flushAsync();

        const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('发布已选站点'),
        );
        expect(publishButton).toBeTruthy();
        return publishButton!;
    }

    it('keeps the frozen publish token valid after history-only episode/resolution edits', async () => {
        const profile = buildSelectableProfile();

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                title: '发布标题',
                                default_profile: 'p1',
                                body_markdown: '**markdown 简介**',
                                body_html: '',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
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

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            const publishButton = await selectSiteDropTorrentAndGetPublishButton(rendered);
            await act(async () => {
                publishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);

            const prepareCalls = invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan');
            expect(prepareCalls).toHaveLength(1);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();

            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            expect(episodeInput).not.toBeNull();
            expect(resolutionInput).not.toBeNull();

            const invalidateBefore = invokeMock.mock.calls.filter(
                ([command]) => command === 'invalidate_plan',
            ).length;
            await act(async () => {
                setInputValue(episodeInput!, '12');
                setInputValue(resolutionInput!, '2160p');
            });
            await flushAsync();

            // History-only fields must not kill the prepared token or close the modal.
            const invalidateAfter = invokeMock.mock.calls.filter(
                ([command]) => command === 'invalidate_plan',
            ).length;
            expect(invalidateAfter).toBe(invalidateBefore);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
            expect(episodeInput!.value).toBe('12');
            expect(resolutionInput!.value).toBe('2160p');

            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeTruthy();
            expect(confirmButton!.disabled).toBe(false);
            await act(async () => {
                confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);

            const publishPreparedCalls = invokeMock.mock.calls.filter(
                ([command]) => command === 'publish_prepared_plan',
            );
            expect(publishPreparedCalls).toEqual([['publish_prepared_plan', { token: 'prepared-token' }]]);

            // Successful publish path must write the manually edited history values, not only the plan token.
            // prepareCalls entries are invoke tuples [command, args]; extract args before reading publish_id.
            const prepareArgs = prepareCalls[0][1] as {
                request: { request: { publish_id: string } };
            };
            const publishId = prepareArgs.request.request.publish_id;
            expect(publishId).toBeTruthy();
            expect(publishEventHandlers['publish-site-complete']).toBeTypeOf('function');
            expect(publishEventHandlers['publish-complete']).toBeTypeOf('function');

            await act(async () => {
                publishEventHandlers['publish-site-complete']!({
                    payload: {
                        publish_id: publishId,
                        site_code: 'nyaa',
                        site_label: 'Nyaa',
                        success: true,
                        message: '发布成功',
                    },
                });
                publishEventHandlers['publish-complete']!({
                    payload: {
                        publish_id: publishId,
                        success: true,
                        message: '发布完成',
                    },
                });
            });
            await flushAsync(20);

            const historyCalls = invokeMock.mock.calls
                .filter(([command]) => command === 'update_quick_publish_template_publish_history')
                .map(([, args]) => args as Record<string, unknown>);
            expect(historyCalls).toHaveLength(1);
            expect(historyCalls[0]).toEqual({
                id: 't1',
                updates: [
                    expect.objectContaining({
                        site_key: 'nyaa',
                        last_published_episode: '12',
                        last_published_resolution: '2160p',
                    }),
                ],
            });
        } finally {
            await rendered.unmount();
        }
    });

    it('rejects a concurrent second publish click while prepare is deferred', async () => {
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
        const profile = buildSelectableProfile();

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                title: '发布标题',
                                default_profile: 'p1',
                                body_markdown: '**markdown 简介**',
                                body_html: '',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
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
                        snapshot_hash: 'sha256:held',
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

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            const publishButton = await selectSiteDropTorrentAndGetPublishButton(rendered);

            await act(async () => {
                publishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            expect(prepareHeld).toBe(true);
            expect(
                invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan'),
            ).toHaveLength(1);

            // While resolve/prepare is in flight the bar must stay disabled and confirm closed.
            expect(publishButton.disabled).toBe(true);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();
            const confirmDuringPrepare = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmDuringPrepare).toBeUndefined();

            // A second click must not start another prepare.
            await act(async () => {
                publishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(5);
            expect(
                invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan'),
            ).toHaveLength(1);
            expect(publishButton.disabled).toBe(true);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).toBeNull();

            // Settle prepare + audit once; still only one prepare_plan.
            await act(async () => {
                pendingPrepare.resolve({
                    token: 'prepared-token',
                    snapshot_hash: 'sha256:held',
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
                    plan_token: 'prepared-token',
                    snapshot_hash: 'sha256:held',
                    request_generation: 1,
                });
            });
            await flushAsync(20);

            expect(
                invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan'),
            ).toHaveLength(1);
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
            expect(publishButton.disabled).toBe(false);

            const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('确认发布'),
            );
            expect(confirmButton).toBeTruthy();
            // Preparing finished; with GO audit the confirm action is enabled.
            expect(confirmButton!.disabled).toBe(false);
        } finally {
            await rendered.unmount();
        }
    });
});

describe('AI recognition advisory contracts', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
    });

    it('recognizeWithAi invokes ai_recognize with structured request fields only', async () => {
        const { recognizeWithAi } = await import('../services/ai');
        invokeMock.mockResolvedValue({
            schema_version: 'recognition_v1',
            episode: { value: '01', confidence: 0.9, evidence: 'E01' },
            resolution: null,
            suggested_title: { value: 'Suggested', confidence: 0.5, evidence: 'hint' },
            request_generation: 3,
            snapshot_hash: 'sha256:rec',
            job_id: 'job-r1',
        });

        const result = await recognizeWithAi({
            torrent_name: 'Show.E01.mkv',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title}',
        });

        expect(invokeMock).toHaveBeenCalledWith('ai_recognize', {
            request: {
                torrent_name: 'Show.E01.mkv',
                ep_pattern: 'E(\\d+)',
                resolution_pattern: '(\\d{3,4}p)',
                title_pattern: '{title}',
            },
        });
        expect(result.suggested_title?.value).toBe('Suggested');
        expect(result.job_id).toBe('job-r1');
    });

    it('recognition is runnable pre-confirm when Ready + torrent + patterns; adopt is explicit', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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
        const template = {
            ...createDefaultQuickPublishTemplate(),
            id: 't1',
            name: '模板一',
            title: 'User Title Stays',
            default_profile: 'p1',
            body_markdown: 'body',
            body_html: '',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title} - {ep}',
        };
        const draftIdentity = 'sha256:backend-recognition-context';

        invokeMock.mockImplementation((command: string, _args?: Record<string, unknown>) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: { t1: template },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: 'User Title Stays', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'ready',
                            output_capability: 'strict_schema',
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    // Echo client request_generation so clear-before-recognize gen bumps still apply.
                    // Backend owns generation; client content only.
                    const reqGen = 1;
                    return Promise.resolve({
                        job_id: 'job-rec-1',
                        state: 'succeeded',
                        request_generation: reqGen,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                        error_code: null,
                        message: 'ok',
                        result: {
                            schema_version: 'recognition_v1',
                            episode: { value: '07', confidence: 0.9, evidence: 'E07' },
                            resolution: { value: '2160p', confidence: 0.8, evidence: '4K' },
                            suggested_title: { value: 'SHOULD NOT AUTO FILL', confidence: 1, evidence: 'x' },
                            request_generation: reqGen,
                            snapshot_hash: draftIdentity,
                            job_id: 'job-rec-1',
                        },
                    });
                }
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-rec-1',
                        kind: 'recognition',
                        state: 'cancelled',
                        request_generation: 1,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();

            // Without torrent, recognition stays disabled (no plan token involved).
            let recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            expect(recognizeButton).not.toBeNull();
            expect(recognizeButton!.disabled).toBe(true);

            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            expect(recognizeButton).not.toBeNull();
            // Pre-confirm editor: Ready + torrent + patterns → enabled without prepare_plan.
            expect(recognizeButton!.disabled).toBe(false);
            expect(invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan')).toHaveLength(0);

            const titleBefore = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder="最终发布标题"]',
            );
            expect(titleBefore?.value).toBe('User Title Stays');

            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            const startCalls = invokeMock.mock.calls.filter(([command]) => command === 'ai_start_recognition');
            expect(startCalls.length).toBeGreaterThanOrEqual(1);
            const request = startCalls[0][1] as {
                request: {
                    torrent_name: string;
                    snapshot_hash?: string;
                    request_generation?: number;
                    plan_token?: string;
                };
            };
            expect(request.request.torrent_name).toBe('release.mkv');
            expect(request.request.snapshot_hash).toBeUndefined();
            expect((request.request as { request_generation?: number }).request_generation).toBeUndefined();
            expect(request.request.plan_token).toBeUndefined();
            expect(invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan')).toHaveLength(0);

            // Title never auto-filled from suggested_title.
            expect(titleBefore?.value).toBe('User Title Stays');

            const episodeValue = document.body.querySelector('[data-testid="ai-recognition-episode-value"]');
            expect(episodeValue?.textContent).toContain('07');

            const adoptEpisode = document.body.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognition-episode-adopt"]',
            );
            expect(adoptEpisode).not.toBeNull();
            await act(async () => {
                adoptEpisode!.click();
            });
            await flushAsync();
            expect(adoptEpisode!.textContent).toContain('已采用');

            // Suggested title has no adopt control (deterministic title path only).
            expect(document.body.querySelector('[data-testid="ai-recognition-suggested-title-adopt"]')).toBeNull();
        } finally {
            await rendered.unmount();
        }
    });

    it('preserves explicit episode adopt through title override into confirm (no reparse clobber)', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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
        const template = {
            ...createDefaultQuickPublishTemplate(),
            id: 't1',
            name: '模板一',
            title: 'User Title Stays',
            default_profile: 'p1',
            body_markdown: 'body',
            body_html: '',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title} - {ep}',
        };
        const draftIdentity = 'sha256:backend-recognition-context';

        invokeMock.mockImplementation((command: string, _args?: Record<string, unknown>) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: { t1: template },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    // Deterministic reparse would yield 01/1080p — adopt must win over this.
                    return Promise.resolve({ title: 'Overridden Title', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'ready',
                            output_capability: 'strict_schema',
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    // Backend owns generation; client content only.
                    const reqGen = 1;
                    return Promise.resolve({
                        job_id: 'job-rec-adopt-title',
                        state: 'succeeded',
                        request_generation: reqGen,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                        error_code: null,
                        message: 'ok',
                        result: {
                            schema_version: 'recognition_v1',
                            episode: { value: '07', confidence: 0.9, evidence: 'E07' },
                            resolution: { value: '2160p', confidence: 0.8, evidence: '4K' },
                            suggested_title: { value: 'SHOULD NOT AUTO FILL', confidence: 1, evidence: 'x' },
                            request_generation: reqGen,
                            snapshot_hash: draftIdentity,
                            job_id: 'job-rec-adopt-title',
                        },
                    });
                }
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
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-rec-adopt-title',
                        kind: 'recognition',
                        state: 'cancelled',
                        request_generation: 1,
                        snapshot_hash: draftIdentity,
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

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();

            // Select site + drop torrent.
            const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 Nyaa"]',
            );
            expect(nyaaCheckbox).not.toBeNull();
            await act(async () => {
                nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            expect(recognizeButton).not.toBeNull();
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            const adoptEpisode = document.body.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognition-episode-adopt"]',
            );
            const adoptResolution = document.body.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognition-resolution-adopt"]',
            );
            expect(adoptEpisode).not.toBeNull();
            expect(adoptResolution).not.toBeNull();
            await act(async () => {
                adoptEpisode!.click();
                adoptResolution!.click();
            });
            await flushAsync();
            expect(adoptEpisode!.textContent).toContain('已采用');
            expect(adoptResolution!.textContent).toContain('已采用');

            // Title override is a covered edit: candidates clear, but applied history adopts stay.
            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder="最终发布标题"]',
            );
            expect(title).not.toBeNull();
            await act(async () => {
                setTextareaValue(title!, 'Manual Title Override');
            });
            await flushAsync();

            // Live chips should still show adopted values (not wiped by covered title edit).
            const chipText = rendered.container.textContent ?? '';
            expect(chipText).toContain('EP 07');
            expect(chipText).toContain('2160p');

            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);

            // Confirm history must keep explicit adopts, not deterministic reparse 01/1080p.
            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            expect(episodeInput?.value).toBe('07');
            expect(resolutionInput?.value).toBe('2160p');

            // Live draft must not have been mutated by prepare-time reparse to lose adopts.
            expect(rendered.container.textContent).toContain('EP 07');
            expect(rendered.container.textContent).toContain('2160p');
        } finally {
            await rendered.unmount();
        }
    });

    it('re-recognize clears prior adopt so confirm does not reuse stale history values', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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
        const template = {
            ...createDefaultQuickPublishTemplate(),
            id: 't1',
            name: '模板一',
            title: 'User Title Stays',
            default_profile: 'p1',
            body_markdown: 'body',
            body_html: '',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title} - {ep}',
        };
        const draftIdentity = 'sha256:backend-recognition-context';

        let recognitionGeneration = 0;
        invokeMock.mockImplementation((command: string, _args?: Record<string, unknown>) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: { t1: template },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: 'User Title Stays', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'ready',
                            output_capability: 'strict_schema',
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    // Backend owns generation; client content only.
                    const reqGen = gen;
                    return Promise.resolve({
                        job_id: `job-rec-rerun-${gen}`,
                        state: 'succeeded',
                        request_generation: reqGen,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                        error_code: null,
                        message: 'ok',
                        result: {
                            schema_version: 'recognition_v1',
                            episode: {
                                value: gen === 1 ? '07' : '99',
                                confidence: 0.9,
                                evidence: `E${gen === 1 ? '07' : '99'}`,
                            },
                            resolution: { value: '2160p', confidence: 0.8, evidence: '4K' },
                            suggested_title: { value: 'AI', confidence: 1, evidence: 'x' },
                            request_generation: reqGen,
                            snapshot_hash: draftIdentity,
                            job_id: `job-rec-rerun-${gen}`,
                        },
                    });
                }
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
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-rec-rerun',
                        kind: 'recognition',
                        state: 'cancelled',
                        request_generation: recognitionGeneration,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                    });
                case 'invalidate_plan':
                    return Promise.resolve(true);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();
            const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 Nyaa"]',
            );
            await act(async () => {
                nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            await act(async () => {
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-episode-adopt"]',
                )!.click();
            });
            await flushAsync();
            expect(rendered.container.textContent).toContain('EP 07');

            // Re-recognize without re-adopting: page-side adopt cleared and live chips matching
            // that adopt are dropped. Confirm history must use deterministic reparse (not stale
            // adopt 07, not unadopted candidate 99) — HomePage parity.
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            const adoptAfter = document.body.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognition-episode-adopt"]',
            );
            expect(adoptAfter!.textContent).not.toContain('已采用');
            expect(document.body.querySelector('[data-testid="ai-recognition-episode-value"]')?.textContent)
                .toContain('99');
            // Live chips that matched the cleared AI adopt must not remain visible.
            expect(rendered.container.textContent).not.toContain('EP 07');

            // Panel flags reset; explicit re-adopt still required for the new candidate.
            expect(adoptAfter!.disabled).toBe(false);

            // Open confirm without re-adopting and assert history metadata is deterministic reparse.
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('发布已选站点'),
            );
            expect(publishButton).toBeTruthy();
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);

            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            expect(episodeInput).not.toBeNull();
            expect(resolutionInput).not.toBeNull();
            // Deterministic reparse from parse_title_details mock — not stale adopt 07, not 99.
            expect(episodeInput!.value).toBe('01');
            expect(resolutionInput!.value).toBe('1080p');
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
        } finally {
            await rendered.unmount();
        }
    });

    it('does not re-seed mid-prepare re-recognize-cleared adopts into live draft chips', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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
        const template = {
            ...createDefaultQuickPublishTemplate(),
            id: 't1',
            name: '模板一',
            title: 'User Title Stays',
            default_profile: 'p1',
            body_markdown: 'body',
            body_html: '',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title} - {ep}',
        };
        const draftIdentity = 'sha256:backend-recognition-context';

        let recognitionGeneration = 0;
        let holdPrepareParse = false;
        const heldParses: Array<{
            resolve: (value: { title: string; episode: string; resolution: string }) => void;
        }> = [];
        invokeMock.mockImplementation((command: string, _args?: Record<string, unknown>) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: { t1: template },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    if (holdPrepareParse) {
                        return new Promise<{ title: string; episode: string; resolution: string }>((resolve) => {
                            heldParses.push({ resolve });
                        });
                    }
                    // Title-override reparse yields deterministic chips; adopt must not reappear after clear.
                    return Promise.resolve({ title: 'Manual Title Override', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'ready',
                            output_capability: 'strict_schema',
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    // Backend owns generation; client content only.
                    const reqGen = gen;
                    return Promise.resolve({
                        job_id: `job-rec-mid-prepare-${gen}`,
                        state: 'succeeded',
                        request_generation: reqGen,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                        error_code: null,
                        message: 'ok',
                        result: {
                            schema_version: 'recognition_v1',
                            episode: {
                                value: gen === 1 ? '07' : '99',
                                confidence: 0.9,
                                evidence: `E${gen === 1 ? '07' : '99'}`,
                            },
                            resolution: { value: '2160p', confidence: 0.8, evidence: '4K' },
                            suggested_title: { value: 'AI', confidence: 1, evidence: 'x' },
                            request_generation: reqGen,
                            snapshot_hash: draftIdentity,
                            job_id: `job-rec-mid-prepare-${gen}`,
                        },
                    });
                }
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
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-rec-mid-prepare',
                        kind: 'recognition',
                        state: 'cancelled',
                        request_generation: recognitionGeneration,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                    });
                case 'invalidate_plan':
                    return Promise.resolve(true);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();
            const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 Nyaa"]',
            );
            await act(async () => {
                nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            await act(async () => {
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-episode-adopt"]',
                )!.click();
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-resolution-adopt"]',
                )!.click();
            });
            await flushAsync();
            expect(rendered.container.textContent).toContain('EP 07');
            expect(rendered.container.textContent).toContain('2160p');

            // Title override makes resolve reparse live draft chips during prepare.
            const title = rendered.container.querySelector<HTMLTextAreaElement>(
                'textarea[placeholder="最终发布标题"]',
            );
            await act(async () => {
                setTextareaValue(title!, 'Manual Title Override');
            });
            await flushAsync();

            holdPrepareParse = true;
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('发布已选站点'),
            );
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            expect(heldParses.length).toBeGreaterThan(0);

            // Mid-prepare re-recognize clears page-side adopts while resolve/reparse is held.
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();
            expect(
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-episode-adopt"]',
                )!.textContent,
            ).not.toContain('已采用');

            holdPrepareParse = false;
            await act(async () => {
                for (const held of heldParses.splice(0, heldParses.length)) {
                    held.resolve({ title: 'Manual Title Override', episode: '01', resolution: '1080p' });
                }
            });
            await flushAsync(20);
            // Any follow-up parse that raced after release should settle immediately.
            await act(async () => {
                for (const held of heldParses.splice(0, heldParses.length)) {
                    held.resolve({ title: 'Manual Title Override', episode: '01', resolution: '1080p' });
                }
            });
            await flushAsync(20);

            // Live draft chips must reflect reparse (01), not the cleared start-of-prepare adopt 07.
            // (Resolution candidate text may still appear in the advisory panel after re-recognize.)
            expect(rendered.container.textContent).toContain('EP 01');
            expect(rendered.container.textContent).not.toContain('EP 07');

            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            // Final confirm history stays on current reparse, never the cleared adopt.
            expect(episodeInput?.value).toBe('01');
            expect(resolutionInput?.value).toBe('1080p');
        } finally {
            await rendered.unmount();
        }
    });

    it('re-recognize during held prepare_plan does not leave stale AI adopt chips after prepare', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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
        const template = {
            ...createDefaultQuickPublishTemplate(),
            id: 't1',
            name: '模板一',
            title: 'User Title Stays',
            default_profile: 'p1',
            body_markdown: 'body',
            body_html: '',
            ep_pattern: 'E(\\d+)',
            resolution_pattern: '(\\d{3,4}p)',
            title_pattern: '{title} - {ep}',
        };
        const draftIdentity = 'sha256:backend-recognition-context';

        let recognitionGeneration = 0;
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        let prepareHeld = false;

        invokeMock.mockImplementation((command: string, _args?: Record<string, unknown>) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: { t1: template },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    // Deterministic reparse after re-recognize must win over cleared adopt 07.
                    return Promise.resolve({ title: 'User Title Stays', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'ready',
                            output_capability: 'strict_schema',
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    // Backend owns generation; client content only.
                    const reqGen = gen;
                    return Promise.resolve({
                        job_id: `job-rec-prepare-hold-${gen}`,
                        state: 'succeeded',
                        request_generation: reqGen,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                        error_code: null,
                        message: 'ok',
                        result: {
                            schema_version: 'recognition_v1',
                            episode: {
                                value: gen === 1 ? '07' : '99',
                                confidence: 0.9,
                                evidence: `E${gen === 1 ? '07' : '99'}`,
                            },
                            resolution: { value: '2160p', confidence: 0.8, evidence: '4K' },
                            suggested_title: { value: 'AI', confidence: 1, evidence: 'x' },
                            request_generation: reqGen,
                            snapshot_hash: draftIdentity,
                            job_id: `job-rec-prepare-hold-${gen}`,
                        },
                    });
                }
                case 'prepare_plan':
                    if (prepareHeld) {
                        return pendingPrepare.promise;
                    }
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
                case 'ai_poll_formal_audit':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-rec-prepare-hold',
                        kind: 'recognition',
                        state: 'cancelled',
                        request_generation: recognitionGeneration,
                        snapshot_hash: draftIdentity,
                        progress: 100,
                    });
                case 'invalidate_plan':
                    return Promise.resolve(true);
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();
            const nyaaCheckbox = rendered.container.querySelector<HTMLInputElement>(
                'input[type="checkbox"][title="选择 Nyaa"]',
            );
            await act(async () => {
                nyaaCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();

            await act(async () => {
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-episode-adopt"]',
                )!.click();
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-resolution-adopt"]',
                )!.click();
            });
            await flushAsync();
            expect(rendered.container.textContent).toContain('EP 07');
            expect(rendered.container.textContent).toContain('2160p');

            // Hold prepare_plan so post-parse live sync can complete, then re-recognize in that window.
            prepareHeld = true;
            const publishButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (button) => button.textContent?.includes('发布已选站点'),
            );
            await act(async () => {
                publishButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync(20);
            expect(invokeMock.mock.calls.filter(([command]) => command === 'prepare_plan').length)
                .toBeGreaterThan(0);
            // Post-parse sync still reflects explicit adopts while prepare is pending.
            expect(rendered.container.textContent).toContain('EP 07');
            expect(rendered.container.textContent).toContain('2160p');

            // Re-recognize after post-parse sync: clears page-side adopts (not covered-edit generation).
            await act(async () => {
                recognizeButton!.click();
            });
            await flushAsync();
            expect(
                document.body.querySelector<HTMLButtonElement>(
                    '[data-testid="ai-recognition-episode-adopt"]',
                )!.textContent,
            ).not.toContain('已采用');
            // Selective clear drops live chips that matched the cleared AI adopt immediately.
            expect(rendered.container.textContent).not.toContain('EP 07');

            prepareHeld = false;
            await act(async () => {
                pendingPrepare.resolve({
                    token: 'prepared-token',
                    snapshot_hash: 'sha256:backend-authoritative',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            });
            await flushAsync(20);

            // After prepare: live chips + confirm history use deterministic reparse, never EP 07.
            // (Resolution candidate text may still appear in the advisory panel after re-recognize.)
            expect(rendered.container.textContent).toContain('EP 01');
            expect(rendered.container.textContent).not.toContain('EP 07');
            expect(rendered.container.textContent).toContain('1080p');

            const episodeInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录集数"]',
            );
            const resolutionInput = document.body.querySelector<HTMLInputElement>(
                'input[aria-label="本地发布记录分辨率"]',
            );
            expect(episodeInput?.value).toBe('01');
            expect(resolutionInput?.value).toBe('1080p');
            expect(document.body.querySelector('[data-testid="ai-preflight-panel"]')).not.toBeNull();
        } finally {
            await rendered.unmount();
        }
    });

    it('recognition is enabled for a complete saved connection without a capability probe', async () => {
        const nyaaCookies = emptySiteCookies();
        nyaaCookies.nyaa.raw_text = 'https://nyaa.si/\tsession=value';
        const profile = {
            user_agent: '',
            site_cookies: nyaaCookies,
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

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                title: 'User Title Stays',
                                default_profile: 'p1',
                                body_markdown: 'body',
                                body_html: '',
                                ep_pattern: 'E(\\d+)',
                                resolution_pattern: '(\\d{3,4}p)',
                                title_pattern: '{title}',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '/okp',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: { p1: profile } });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'release.mkv',
                        total_size: 1,
                        file_tree: { name: 'release.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: 'User Title Stays', episode: '01', resolution: '1080p' });
                case 'ai_get_settings':
                    return Promise.resolve({
                        provider: 'open_ai',
                        endpoint: 'https://api.openai.com/v1',
                        model: 'gpt-test',
                        mode: 'auto',
                        auth_mode: 'bearer',
                        custom_header_name: null,
                        credential_ref: { id: 'cred-1' },
                        enabled: true,
                        capability: {
                            state: 'failed',
                            identity_digest: 'dig',
                            message: 'not ready',
                            identity_matches: false,
                        },
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        try {
            await flushAsync();
            const handler = onDragDropEventMock.mock.calls[0][0] as DragDropHandler;
            await act(async () => {
                handler({ payload: { type: 'drop', paths: ['/tmp/release.torrent'] } });
            });
            await flushAsync();

            const recognizeButton = rendered.container.querySelector<HTMLButtonElement>(
                '[data-testid="ai-recognize-button"]',
            );
            expect(recognizeButton).not.toBeNull();
            expect(recognizeButton!.disabled).toBe(false);
        } finally {
            await rendered.unmount();
        }
    });
});
