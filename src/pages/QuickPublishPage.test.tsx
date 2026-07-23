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
            request_generation: 3,
            snapshot_hash: 'sha256:rec',
        });

        expect(invokeMock).toHaveBeenCalledWith('ai_recognize', {
            request: {
                torrent_name: 'Show.E01.mkv',
                ep_pattern: 'E(\\d+)',
                resolution_pattern: '(\\d{3,4}p)',
                title_pattern: '{title}',
                request_generation: 3,
                snapshot_hash: 'sha256:rec',
            },
        });
        expect(result.suggested_title?.value).toBe('Suggested');
        expect(result.job_id).toBe('job-r1');
    });

    it('recognition is runnable pre-confirm when Ready + torrent + patterns; adopt is explicit', async () => {
        const { buildRecognitionDraftIdentity } = await import('../types/ai');
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
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'release.mkv',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
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
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    // Echo client request_generation so clear-before-recognize gen bumps still apply.
                    const request = (args as { request?: { request_generation?: number } } | undefined)?.request;
                    const reqGen = request?.request_generation ?? 1;
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
                    snapshot_hash: string;
                    plan_token?: string;
                };
            };
            expect(request.request.torrent_name).toBe('release.mkv');
            expect(request.request.snapshot_hash).toBe(draftIdentity);
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
        const { buildRecognitionDraftIdentity } = await import('../types/ai');
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
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'release.mkv',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
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
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    const request = (args as { request?: { request_generation?: number } } | undefined)?.request;
                    const reqGen = request?.request_generation ?? 1;
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
        const { buildRecognitionDraftIdentity } = await import('../types/ai');
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
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'release.mkv',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        let recognitionGeneration = 0;
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
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
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    const request = (args as { request?: { request_generation?: number } } | undefined)?.request;
                    const reqGen = request?.request_generation ?? gen;
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
        const { buildRecognitionDraftIdentity } = await import('../types/ai');
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
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'release.mkv',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        let recognitionGeneration = 0;
        let holdPrepareParse = false;
        const heldParses: Array<{
            resolve: (value: { title: string; episode: string; resolution: string }) => void;
        }> = [];
        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
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
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    const request = (args as { request?: { request_generation?: number } } | undefined)?.request;
                    const reqGen = request?.request_generation ?? gen;
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
        const { buildRecognitionDraftIdentity } = await import('../types/ai');
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
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'release.mkv',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        let recognitionGeneration = 0;
        const pendingPrepare = deferred<{
            token: string;
            snapshot_hash: string;
            request_generation: number;
            local_blockers: string[];
            has_blockers: boolean;
        }>();
        let prepareHeld = false;

        invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
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
                            identity_digest: 'dig',
                            message: 'ready',
                            identity_matches: true,
                        },
                    });
                case 'ai_start_recognition': {
                    recognitionGeneration += 1;
                    const gen = recognitionGeneration;
                    const request = (args as { request?: { request_generation?: number } } | undefined)?.request;
                    const reqGen = request?.request_generation ?? gen;
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

    it('recognition stays disabled when capability is not Ready even with torrent inputs', async () => {
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
            expect(recognizeButton!.disabled).toBe(true);
            expect(invokeMock.mock.calls.filter(([command]) => command === 'ai_start_recognition')).toHaveLength(0);
            expect(document.body.querySelector('[data-testid="ai-recognition-panel"]')).toBeNull();
        } finally {
            await rendered.unmount();
        }
    });
});

describe('AI preflight backend identity contracts', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('computeAiAudit sends plan_token and never invents a client snapshot authority', async () => {
        const { computeAiAudit, setPlanAcknowledgements, canPublishAudit } = await import('../services/ai');
        invokeMock.mockResolvedValue({
            decision: 'WARNING',
            findings: [],
            unknown_codes: [],
            local_blockers: [],
            formal_ran: true,
            job_id: 'job-1',
            plan_token: 'plan_abc',
            snapshot_hash: 'sha256:backend',
            request_generation: 2,
        });

        const result = await computeAiAudit({
            plan_token: 'plan_abc',
            title: 't',
            torrent_name: 'x.torrent',
            sites: ['nyaa'],
        });

        expect(invokeMock).toHaveBeenCalledWith('ai_compute_audit', {
            request: {
                plan_token: 'plan_abc',
                title: 't',
                torrent_name: 'x.torrent',
                sites: ['nyaa'],
            },
        });
        expect(result.plan_token).toBe('plan_abc');
        expect(result.snapshot_hash).toBe('sha256:backend');
        expect(canPublishAudit('WARNING', { warning: false, critical: false, pending: false })).toBe(false);
        expect(canPublishAudit('WARNING', { warning: true, critical: false, pending: false })).toBe(true);
        expect(canPublishAudit('LOCAL_BLOCKED', { warning: true, critical: true, pending: true })).toBe(false);

        invokeMock.mockResolvedValue(null);
        await setPlanAcknowledgements('plan_abc', { warning: true, critical: false, pending: false });
        expect(invokeMock).toHaveBeenLastCalledWith('set_plan_acknowledgements', {
            token: 'plan_abc',
            acknowledgements: { warning: true, critical: false, pending: false },
        });
    });

    it('useAiPreflight opens PENDING after start and cancels job before publish ack path', async () => {
        const { useAiPreflight } = await import('../hooks/useAiPreflight');
        type UseAiPreflightApi = ReturnType<typeof useAiPreflight>;
        // Stable exported prepare result type (avoids fragile NonNullable<typeof api> indexing).
        type Prepared = import('../hooks/useAiPreflight').AiPreflightPrepareResult;
        const { createElement } = await import('react');
        const pendingPoll = deferred<null>();

        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_get_settings') {
                return Promise.resolve({
                    provider: 'open_ai',
                    endpoint: 'https://api.openai.com/v1',
                    model: 'gpt-test',
                    mode: 'auto',
                    auth_mode: 'bearer',
                    custom_header_name: null,
                    credential_ref: { id: 'cred-1' },
                    enabled: true,
                });
            }
            if (command === 'prepare_plan') {
                return Promise.resolve({
                    token: 'plan-pending',
                    snapshot_hash: 'sha256:pending',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            }
            if (command === 'ai_start_formal_audit') {
                return Promise.resolve({
                    decision: 'PENDING',
                    findings: [],
                    unknown_codes: [],
                    local_blockers: [],
                    formal_ran: false,
                    job_id: 'job-audit-1',
                    plan_token: 'plan-pending',
                    snapshot_hash: 'sha256:pending',
                    request_generation: 1,
                });
            }
            if (command === 'ai_poll_formal_audit') {
                return pendingPoll.promise;
            }
            if (command === 'ai_cancel_job') {
                return Promise.resolve({
                    id: 'job-audit-1',
                    kind: 'audit',
                    state: 'cancelled',
                    request_generation: 1,
                    snapshot_hash: 'sha256:pending',
                    progress: 100,
                });
            }
            if (command === 'set_plan_acknowledgements') {
                return Promise.resolve(null);
            }
            if (command === 'invalidate_plan') {
                return Promise.resolve(true);
            }
            return Promise.resolve(null);
        });

        let api: UseAiPreflightApi | null = null;
        function Probe() {
            api = useAiPreflight();
            return null;
        }

        const rendered = await renderElement(createElement(Probe));
        await flushAsync();
        expect(api).not.toBeNull();

        const defaultTemplate = createDefaultQuickPublishTemplate();
        // Wrap prepare + commit in act/flush so Probe re-renders before state assertions
        // (avoids reading a stale pre-prepare api snapshot from the prior render).
        let prepared!: Prepared;
        await act(async () => {
            prepared = await api!.prepare({
                publish_id: 'p1',
                torrent_path: '/tmp/a.torrent',
                profile_name: 'profile',
                template: {
                    ep_pattern: defaultTemplate.ep_pattern,
                    resolution_pattern: defaultTemplate.resolution_pattern,
                    title_pattern: defaultTemplate.title_pattern,
                    poster: defaultTemplate.poster,
                    about: defaultTemplate.about,
                    tags: defaultTemplate.tags,
                    description: defaultTemplate.body_markdown,
                    description_html: defaultTemplate.body_html,
                    profile: defaultTemplate.default_profile,
                    title: 't',
                    publish_history: defaultTemplate.publish_history,
                    sites: {
                        dmhy: false,
                        nyaa: true,
                        acgrip: false,
                        bangumi: false,
                        acgnx_asia: false,
                        acgnx_global: false,
                    },
                },
            });
        });
        await flushAsync();

        expect(prepared.token).toBe('plan-pending');
        expect(prepared.audit.decision).toBe('PENDING');
        expect(api!.state.decision).toBe('PENDING');
        expect(api!.state.checking).toBe(false);
        expect(api!.state.job_id).toBe('job-audit-1');
        expect(api!.canConfirm).toBe(false);

        await act(async () => {
            api!.setAcknowledgement('pending', true);
        });
        await flushAsync();
        expect(api!.canConfirm).toBe(true);

        await act(async () => {
            await api!.cancelPendingAuditForPublish();
        });
        await flushAsync();

        const cancelCalls = invokeMock.mock.calls.filter(([command]) => command === 'ai_cancel_job');
        expect(cancelCalls.some(([, args]) => (args as { id?: string }).id === 'job-audit-1')).toBe(true);
        // Late poll completion must not replace UI after cancel-for-publish.
        await act(async () => {
            pendingPoll.resolve(null);
        });
        await flushAsync(5);
        expect(api!.state.decision).toBe('PENDING');
        expect(api!.state.token).toBe('plan-pending');

        await rendered.unmount();
    });

    it('useAiPreflight invalidates prepared tokens when formal audit start fails', async () => {
        const { useAiPreflight } = await import('../hooks/useAiPreflight');
        const { createElement } = await import('react');

        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_get_settings') {
                return Promise.resolve({
                    provider: 'open_ai',
                    endpoint: 'https://api.openai.com/v1',
                    model: '',
                    mode: 'auto',
                    auth_mode: 'bearer',
                    custom_header_name: null,
                    credential_ref: null,
                    enabled: false,
                });
            }
            if (command === 'prepare_plan') {
                return Promise.resolve({
                    token: 'orphan-token',
                    snapshot_hash: 'sha256:prepared',
                    request_generation: 1,
                    local_blockers: [],
                    has_blockers: false,
                });
            }
            if (command === 'ai_start_formal_audit' || command === 'ai_compute_audit') {
                return Promise.reject(new Error('provider down'));
            }
            if (command === 'invalidate_plan') {
                return Promise.resolve(true);
            }
            return Promise.resolve(null);
        });

        let api: ReturnType<typeof useAiPreflight> | null = null;
        function Probe() {
            api = useAiPreflight();
            return null;
        }

        const rendered = await renderElement(createElement(Probe));
        await flushAsync();
        expect(api).not.toBeNull();

        const defaultTemplate = createDefaultQuickPublishTemplate();
        await expect(
            api!.prepare({
                publish_id: 'p1',
                torrent_path: '/tmp/a.torrent',
                profile_name: 'profile',
                template: {
                    ep_pattern: defaultTemplate.ep_pattern,
                    resolution_pattern: defaultTemplate.resolution_pattern,
                    title_pattern: defaultTemplate.title_pattern,
                    poster: defaultTemplate.poster,
                    about: defaultTemplate.about,
                    tags: defaultTemplate.tags,
                    description: defaultTemplate.body_markdown,
                    description_html: defaultTemplate.body_html,
                    profile: defaultTemplate.default_profile,
                    title: 't',
                    publish_history: defaultTemplate.publish_history,
                    sites: {
                        dmhy: false,
                        nyaa: true,
                        acgrip: false,
                        bangumi: false,
                        acgnx_asia: false,
                        acgnx_global: false,
                    },
                },
            }),
        ).rejects.toThrow(/provider down|无法准备|发布前检查/);

        await flushAsync();
        const invalidateCalls = invokeMock.mock.calls.filter(([command]) => command === 'invalidate_plan');
        expect(invalidateCalls.some(([, args]) => (args as { token?: string }).token === 'orphan-token')).toBe(true);
        expect(api!.state.token).toBeNull();
        expect(api!.state.decision).toBe('IDLE');

        await rendered.unmount();
    });
});

describe('AutoTemplate selection and seed hydration', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockImplementation(() => Promise.resolve(vi.fn()));
        window.localStorage.clear();
    });

    function mockAutoTemplateSettingsAndCatalog() {
        return {
            ai_get_settings: {
                provider: 'open_ai',
                endpoint: 'https://api.openai.com/v1',
                model: 'gpt-test',
                mode: 'auto',
                auth_mode: 'bearer',
                custom_header_name: null,
                credential_ref: { id: 'cred-1' },
                enabled: true,
            },
            get_config: {
                quick_publish_templates: {
                    'aaa-first': {
                        ...createDefaultQuickPublishTemplate(),
                        id: 'aaa-first',
                        name: 'First',
                        revision: 1,
                    },
                    'zzz-last': {
                        ...createDefaultQuickPublishTemplate(),
                        id: 'zzz-last',
                        name: 'Last',
                        revision: 2,
                    },
                },
                content_templates: {},
            },
        } as const;
    }

    async function fillTorrentAndStart(rendered: { container: HTMLElement }) {
        const input = rendered.container.querySelector<HTMLInputElement>(
            'input[placeholder="/path/to/file.torrent"]',
        );
        expect(input).not.toBeNull();
        await act(async () => {
            const valueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value',
            )!.set!;
            valueSetter.call(input!, '/tmp/show.torrent');
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const button = Array.from(rendered.container.querySelectorAll('button')).find(
            (node) => node.textContent?.includes('选择并进入发布'),
        );
        expect(button).toBeTruthy();
        await act(async () => {
            button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();
    }

    it('never selects the first catalog entry client-side; uses start/poll only', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');
        const fixtures = mockAutoTemplateSettingsAndCatalog();
        let pollCount = 0;

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return Promise.resolve(fixtures.ai_get_settings);
                case 'get_config':
                    return Promise.resolve(fixtures.get_config);
                case 'ai_start_template_selection':
                    // Start returns non-terminal; seed must wait for succeeded poll.
                    return Promise.resolve({
                        job_id: 'job-template-1',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:catalog',
                        progress: 10,
                        error_code: null,
                        message: 'requesting provider selection',
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-template-1',
                        kind: 'template_selection',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:catalog',
                        progress: 55,
                    });
                case 'ai_poll_template_selection':
                    pollCount += 1;
                    if (pollCount < 2) {
                        return Promise.resolve(null);
                    }
                    return Promise.resolve({
                        job_id: 'job-template-1',
                        state: 'succeeded',
                        request_generation: 0,
                        snapshot_hash: 'sha256:catalog',
                        progress: 100,
                        error_code: null,
                        message: 'selected template zzz-last revision 2',
                        seed: {
                            token: 'seed_opaque_1',
                            template_id: 'zzz-last',
                            template_revision: 2,
                            template_digest: 'sha256:zzz',
                            torrent_name: 'show.mkv',
                        },
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<AutoTemplatePage />);
        await flushAsync();
        await fillTorrentAndStart(rendered);

        const startCalls = invokeMock.mock.calls.filter(
            ([command]) => command === 'ai_start_template_selection',
        );
        expect(startCalls).toHaveLength(1);
        expect(startCalls[0][1]).toEqual({
            request: { torrent_path: '/tmp/show.torrent' },
        });
        // One-shot product path must not be used.
        expect(
            invokeMock.mock.calls.filter(([command]) => command === 'ai_select_template'),
        ).toHaveLength(0);
        // Must never call prepare with the first catalog entry from the client.
        expect(
            invokeMock.mock.calls.filter(([command]) => command === 'ai_prepare_template_seed'),
        ).toHaveLength(0);
        // Handoff must wait for succeeded poll — not start alone.
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();

        // Drive poll interval (400ms) until terminal succeeded result.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 450));
        });
        await flushAsync();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 450));
        });
        await flushAsync();

        const handoffRaw = window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
        expect(handoffRaw).toBeTruthy();
        const handoff = JSON.parse(handoffRaw!) as { token: string; template_id: string; torrent_path?: string };
        expect(handoff.token).toBe('seed_opaque_1');
        expect(handoff.template_id).toBe('zzz-last');
        expect(handoff.torrent_path).toBeUndefined();

        await rendered.unmount();
    });

    it('failed provider selection stays on page and does not write handoff', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
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
                    });
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: { ...createDefaultQuickPublishTemplate(), id: 't1', name: 'T1', revision: 1 },
                        },
                        content_templates: {},
                    });
                case 'ai_start_template_selection':
                    return Promise.resolve({
                        job_id: 'job-fail',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 10,
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-fail',
                        kind: 'template_selection',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 40,
                    });
                case 'ai_poll_template_selection':
                    return Promise.resolve({
                        job_id: 'job-fail',
                        state: 'failed',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'SELECTION_INVALID',
                        message: 'provider selected an invalid or stale template id/revision/digest',
                        seed: null,
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<AutoTemplatePage />);
        await flushAsync();
        await fillTorrentAndStart(rendered);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 450));
        });
        await flushAsync();

        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
        expect(document.body.textContent).toMatch(/invalid|stale|失败/);
        await rendered.unmount();
    });

    it('user cancel does not write handoff or navigate', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');
        const fixtures = mockAutoTemplateSettingsAndCatalog();
        let cancelled = false;
        const navigateSpy = vi.fn();
        window.addEventListener('okpgui:navigate', navigateSpy);

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return Promise.resolve(fixtures.ai_get_settings);
                case 'get_config':
                    return Promise.resolve(fixtures.get_config);
                case 'ai_start_template_selection':
                    return Promise.resolve({
                        job_id: 'job-cancel',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 5,
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-cancel',
                        kind: 'template_selection',
                        state: cancelled ? 'cancelled' : 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: cancelled ? 100 : 20,
                        error_code: cancelled ? 'CANCELLED' : null,
                    });
                case 'ai_poll_template_selection':
                    if (!cancelled) {
                        return Promise.resolve(null);
                    }
                    return Promise.resolve({
                        job_id: 'job-cancel',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                        message: 'template selection cancelled',
                        seed: null,
                    });
                case 'ai_cancel_job':
                    cancelled = true;
                    return Promise.resolve({
                        id: 'job-cancel',
                        kind: 'template_selection',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<AutoTemplatePage />);
        try {
            await flushAsync();
            await fillTorrentAndStart(rendered);

            const cancelButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (node) => node.textContent?.includes('取消'),
            );
            expect(cancelButton).toBeTruthy();
            await act(async () => {
                cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();

            const cancelCalls = invokeMock.mock.calls.filter(([command]) => command === 'ai_cancel_job');
            expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
            expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
            // Cancelled UI is user-visible and non-empty (Chinese copy).
            expect(document.body.textContent).toContain('自动选择已取消');
            expect(navigateSpy).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('okpgui:navigate', navigateSpy);
            await rendered.unmount();
        }
    });

    it('late success after cancel never writes handoff or navigates', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');
        const fixtures = mockAutoTemplateSettingsAndCatalog();
        const pendingPoll = deferred<{
            job_id: string;
            state: string;
            request_generation: number;
            snapshot_hash: string;
            progress: number;
            error_code: string | null;
            message: string;
            seed: {
                token: string;
                template_id: string;
                template_revision: number;
                template_digest: string;
                torrent_name: string;
            } | null;
        }>();
        let pollHeld = false;
        const navigateSpy = vi.fn();
        window.addEventListener('okpgui:navigate', navigateSpy);

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return Promise.resolve(fixtures.ai_get_settings);
                case 'get_config':
                    return Promise.resolve(fixtures.get_config);
                case 'ai_start_template_selection':
                    return Promise.resolve({
                        job_id: 'job-late-cancel',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 5,
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-late-cancel',
                        kind: 'template_selection',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 40,
                    });
                case 'ai_poll_template_selection':
                    if (!pollHeld) {
                        pollHeld = true;
                        return pendingPoll.promise;
                    }
                    // Cancel path's best-effort terminal read after user cancel.
                    return Promise.resolve({
                        job_id: 'job-late-cancel',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                        message: 'template selection cancelled',
                        seed: null,
                    });
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-late-cancel',
                        kind: 'template_selection',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<AutoTemplatePage />);
        try {
            await flushAsync();
            await fillTorrentAndStart(rendered);

            // Drive one poll interval so an in-flight poll is held open.
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 450));
            });
            await flushAsync();
            expect(pollHeld).toBe(true);

            const cancelButton = Array.from(rendered.container.querySelectorAll('button')).find(
                (node) => node.textContent?.includes('取消'),
            );
            expect(cancelButton).toBeTruthy();
            await act(async () => {
                cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await flushAsync();
            expect(document.body.textContent).toContain('自动选择已取消');

            // Late success after cancel must be refused: no handoff, no navigate.
            await act(async () => {
                pendingPoll.resolve({
                    job_id: 'job-late-cancel',
                    state: 'succeeded',
                    request_generation: 0,
                    snapshot_hash: 'sha256:c',
                    progress: 100,
                    error_code: null,
                    message: 'late success after cancel',
                    seed: {
                        token: 'seed_late_cancel',
                        template_id: 'zzz-last',
                        template_revision: 2,
                        template_digest: 'sha256:zzz',
                        torrent_name: 'show.mkv',
                    },
                });
            });
            await flushAsync(20);

            expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
            expect(navigateSpy).not.toHaveBeenCalled();
            expect(document.body.textContent).toContain('自动选择已取消');
            expect(document.body.textContent).not.toMatch(/已选择模板/);
        } finally {
            window.removeEventListener('okpgui:navigate', navigateSpy);
            await rendered.unmount();
        }
    });

    it('timeout cancels job and does not write handoff', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');
        const fixtures = mockAutoTemplateSettingsAndCatalog();

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return Promise.resolve(fixtures.ai_get_settings);
                case 'get_config':
                    return Promise.resolve(fixtures.get_config);
                case 'ai_start_template_selection':
                    return Promise.resolve({
                        job_id: 'job-timeout',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 5,
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-timeout',
                        kind: 'template_selection',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 15,
                    });
                case 'ai_poll_template_selection':
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-timeout',
                        kind: 'template_selection',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        // Fake only timers so Promise-based IPC still settles; advance the 90s budget.
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
        try {
            const rendered = await renderElement(<AutoTemplatePage />);
            await flushAsync();
            await fillTorrentAndStart(rendered);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(90_000);
            });
            await flushAsync();

            expect(
                invokeMock.mock.calls.some(([command]) => command === 'ai_cancel_job'),
            ).toBe(true);
            expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
            expect(document.body.textContent).toMatch(/超时/);

            await rendered.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('late success after timeout never writes handoff or navigates', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');
        const fixtures = mockAutoTemplateSettingsAndCatalog();
        const pendingPoll = deferred<{
            job_id: string;
            state: string;
            request_generation: number;
            snapshot_hash: string;
            progress: number;
            error_code: string | null;
            message: string;
            seed: {
                token: string;
                template_id: string;
                template_revision: number;
                template_digest: string;
                torrent_name: string;
            } | null;
        }>();
        let pollHeld = false;
        const navigateSpy = vi.fn();
        window.addEventListener('okpgui:navigate', navigateSpy);

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'ai_get_settings':
                    return Promise.resolve(fixtures.ai_get_settings);
                case 'get_config':
                    return Promise.resolve(fixtures.get_config);
                case 'ai_start_template_selection':
                    return Promise.resolve({
                        job_id: 'job-late-timeout',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 5,
                        seed: null,
                    });
                case 'ai_get_job':
                    return Promise.resolve({
                        id: 'job-late-timeout',
                        kind: 'template_selection',
                        state: 'running',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 20,
                    });
                case 'ai_poll_template_selection':
                    if (!pollHeld) {
                        pollHeld = true;
                        return pendingPoll.promise;
                    }
                    return Promise.resolve(null);
                case 'ai_cancel_job':
                    return Promise.resolve({
                        id: 'job-late-timeout',
                        kind: 'template_selection',
                        state: 'cancelled',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: 'CANCELLED',
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
        try {
            const rendered = await renderElement(<AutoTemplatePage />);
            try {
                await flushAsync();
                await fillTorrentAndStart(rendered);

                // Hold one poll open, then fire the 90s timeout while it is still awaiting.
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(450);
                });
                await flushAsync();
                expect(pollHeld).toBe(true);

                await act(async () => {
                    await vi.advanceTimersByTimeAsync(90_000);
                });
                await flushAsync();
                expect(document.body.textContent).toMatch(/超时/);
                expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();

                // Late success after timeout must be refused.
                await act(async () => {
                    pendingPoll.resolve({
                        job_id: 'job-late-timeout',
                        state: 'succeeded',
                        request_generation: 0,
                        snapshot_hash: 'sha256:c',
                        progress: 100,
                        error_code: null,
                        message: 'late success after timeout',
                        seed: {
                            token: 'seed_late_timeout',
                            template_id: 'zzz-last',
                            template_revision: 2,
                            template_digest: 'sha256:zzz',
                            torrent_name: 'show.mkv',
                        },
                    });
                });
                await flushAsync(20);

                expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
                expect(navigateSpy).not.toHaveBeenCalled();
                expect(document.body.textContent).toMatch(/超时/);
                expect(document.body.textContent).not.toMatch(/已选择模板/);
            } finally {
                await rendered.unmount();
            }
        } finally {
            window.removeEventListener('okpgui:navigate', navigateSpy);
            vi.useRealTimers();
        }
    });

    it('start rejection does not write handoff', async () => {
        const { default: AutoTemplatePage } = await import('./AutoTemplatePage');
        const { AUTO_TEMPLATE_SEED_STORAGE_KEY } = await import('../services/ai');

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
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
                    });
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: { ...createDefaultQuickPublishTemplate(), id: 't1', name: 'T1', revision: 1 },
                        },
                        content_templates: {},
                    });
                case 'ai_start_template_selection':
                    return Promise.reject('请先在 AI 设置中启用并完成连接和模型配置。');
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<AutoTemplatePage />);
        await flushAsync();
        await fillTorrentAndStart(rendered);

        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
        expect(document.body.textContent).toMatch(/AI 设置|失败|启用/);
        await rendered.unmount();
    });

    it('hydrates QuickPublish only when consume metadata matches the loaded catalog revision', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');

        writeAutoTemplateSeedHandoff({ token: 'seed_ok', template_id: 't1' });

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
                                revision: 3,
                                default_profile: 'p1',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: {} });
                case 'ai_consume_template_seed':
                    return Promise.resolve({
                        template_id: 't1',
                        template_revision: 3,
                        template_digest: 'sha256:t1',
                        torrent_name: 'seeded.mkv',
                        torrent_path: '/tmp/seeded.torrent',
                    });
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'seeded.mkv',
                        total_size: 1,
                        file_tree: { name: 'seeded.mkv', size: 1, children: [], is_file: true },
                    });
                case 'parse_title_details':
                    return Promise.resolve({ title: '发布标题', episode: '01', resolution: '1080p' });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync(30);

        const consumeCalls = invokeMock.mock.calls.filter(
            ([command]) => command === 'ai_consume_template_seed',
        );
        expect(consumeCalls.length).toBeGreaterThanOrEqual(1);
        const parseCalls = invokeMock.mock.calls.filter(([command]) => command === 'parse_torrent');
        expect(parseCalls.some(([, args]) => (args as { path?: string }).path === '/tmp/seeded.torrent')).toBe(true);
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();

        await rendered.unmount();
    });

    it('does not hydrate or acknowledge success when consume fails or revision drifts', async () => {
        const { writeAutoTemplateSeedHandoff } = await import('../services/ai');
        writeAutoTemplateSeedHandoff({ token: 'seed_stale', template_id: 't1' });

        let parseTorrentCalls = 0;
        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                revision: 5,
                            },
                            t2: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't2',
                                name: '模板二',
                                revision: 1,
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '',
                        last_used_quick_publish_template: 't2',
                    });
                case 'get_profile_list':
                    return Promise.resolve([]);
                case 'ai_consume_template_seed':
                    // Backend reports an older revision than the live catalog.
                    return Promise.resolve({
                        template_id: 't1',
                        template_revision: 1,
                        template_digest: 'sha256:old',
                        torrent_name: 'old.mkv',
                        torrent_path: '/tmp/old.torrent',
                    });
                case 'parse_torrent':
                    parseTorrentCalls += 1;
                    return Promise.resolve({
                        name: 'old.mkv',
                        total_size: 1,
                        file_tree: { name: 'old.mkv', size: 1, children: [], is_file: true },
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync(30);

        // Failed/stale hydration must not parse the seed torrent path as a success path.
        const seededParse = invokeMock.mock.calls.filter(
            ([command, args]) =>
                command === 'parse_torrent'
                && (args as { path?: string }).path === '/tmp/old.torrent',
        );
        expect(seededParse).toHaveLength(0);
        expect(parseTorrentCalls).toBe(0);
        // Visible, sanitized fail-closed error (no absolute path leakage).
        expect(document.body.textContent).toMatch(/不存在或已变更|重新选择模板/);
        expect(document.body.textContent).not.toContain('/tmp/old.torrent');

        await rendered.unmount();
    });

    it('surfaces visible hydration failure on terminal consume rejection', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');
        writeAutoTemplateSeedHandoff({ token: 'seed_expired_ui', template_id: 't1' });

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                revision: 1,
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve([]);
                case 'ai_consume_template_seed':
                    return Promise.reject('template seed is missing, expired, or already consumed');
                case 'parse_torrent':
                    return Promise.resolve({
                        name: 'x.mkv',
                        total_size: 1,
                        file_tree: { name: 'x.mkv', size: 1, children: [], is_file: true },
                    });
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync(30);

        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
        expect(document.body.textContent).toMatch(/已失效或无法使用|重新选择模板/);
        // Sanitized: raw backend rejection text must not be the only/primary user message surface.
        expect(document.body.textContent).not.toMatch(/already consumed/);

        await rendered.unmount();
    });

    it('consumeTemplateSeed returns null on backend rejection (TTL/replay/stale)', async () => {
        const { consumeTemplateSeed } = await import('../services/ai');
        invokeMock.mockRejectedValue('template seed is missing, expired, or already consumed');
        await expect(consumeTemplateSeed('seed_replay')).resolves.toBeNull();

        invokeMock.mockResolvedValue({
            template_id: 't1',
            // Missing revision/digest must fail closed.
            torrent_path: '/tmp/x.torrent',
        });
        await expect(consumeTemplateSeed('seed_partial')).resolves.toBeNull();
    });

    it('consumeTemplateSeed rethrows transport failures (non-terminal)', async () => {
        const { consumeTemplateSeed } = await import('../services/ai');
        invokeMock.mockRejectedValue('Failed to communicate with command');
        await expect(consumeTemplateSeed('seed_transport')).rejects.toBe(
            'Failed to communicate with command',
        );
    });

    it('keeps handoff recoverable until backend consume succeeds', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            takeAndConsumeAutoTemplateSeed,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');

        writeAutoTemplateSeedHandoff({ token: 'seed_recover', template_id: 't1' });
        const pendingConsume = deferred<Record<string, unknown>>();
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_consume_template_seed') {
                return pendingConsume.promise;
            }
            return Promise.resolve(null);
        });

        const first = takeAndConsumeAutoTemplateSeed();
        // While consume is in flight the opaque handoff must still be recoverable.
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeTruthy();

        await act(async () => {
            pendingConsume.resolve({
                template_id: 't1',
                template_revision: 1,
                template_digest: 'sha256:t1',
                torrent_path: '/tmp/recover.torrent',
            });
        });
        await expect(first).resolves.toMatchObject({
            template_id: 't1',
            torrent_path: '/tmp/recover.torrent',
        });
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
    });

    it('preserves opaque handoff when consume transport fails so remount can retry', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            peekAutoTemplateSeedHandoff,
            takeAndConsumeAutoTemplateSeed,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');

        writeAutoTemplateSeedHandoff({ token: 'seed_transport', template_id: 't1' });
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_consume_template_seed') {
                return Promise.reject('Failed to communicate with command');
            }
            return Promise.resolve(null);
        });

        await expect(takeAndConsumeAutoTemplateSeed()).resolves.toBeNull();
        // Transport rejection must not clear the opaque handoff (no torrent path either).
        const handoffRaw = window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
        expect(handoffRaw).toBeTruthy();
        const handoff = JSON.parse(handoffRaw!) as { token: string; template_id: string; torrent_path?: string };
        expect(handoff.token).toBe('seed_transport');
        expect(handoff.template_id).toBe('t1');
        expect(handoff.torrent_path).toBeUndefined();
        expect(peekAutoTemplateSeedHandoff()).toEqual({
            token: 'seed_transport',
            template_id: 't1',
        });

        // After transport recovery, a later attempt must be able to consume the same handoff.
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_consume_template_seed') {
                return Promise.resolve({
                    template_id: 't1',
                    template_revision: 1,
                    template_digest: 'sha256:t1',
                    torrent_path: '/tmp/transport-retry.torrent',
                });
            }
            return Promise.resolve(null);
        });
        await expect(takeAndConsumeAutoTemplateSeed()).resolves.toMatchObject({
            template_id: 't1',
            torrent_path: '/tmp/transport-retry.torrent',
        });
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
    });

    it('clears handoff only on explicit terminal consume rejection', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            takeAndConsumeAutoTemplateSeed,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');

        writeAutoTemplateSeedHandoff({ token: 'seed_expired', template_id: 't1' });
        invokeMock.mockRejectedValue('template seed is missing, expired, or already consumed');
        await expect(takeAndConsumeAutoTemplateSeed()).resolves.toBeNull();
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
    });

    it('does not acknowledge seed hydration when torrent parse fails', async () => {
        const {
            AUTO_TEMPLATE_SEED_STORAGE_KEY,
            writeAutoTemplateSeedHandoff,
        } = await import('../services/ai');

        writeAutoTemplateSeedHandoff({ token: 'seed_bad_torrent', template_id: 't1' });
        let parseCalls = 0;

        invokeMock.mockImplementation((command: string) => {
            switch (command) {
                case 'get_config':
                    return Promise.resolve({
                        quick_publish_templates: {
                            t1: {
                                ...createDefaultQuickPublishTemplate(),
                                id: 't1',
                                name: '模板一',
                                revision: 2,
                                default_profile: 'p1',
                            },
                        },
                        content_templates: {},
                        okp_executable_path: '',
                        last_used_quick_publish_template: null,
                    });
                case 'get_profile_list':
                    return Promise.resolve(['p1']);
                case 'get_profiles':
                    return Promise.resolve({ profiles: {} });
                case 'ai_consume_template_seed':
                    return Promise.resolve({
                        template_id: 't1',
                        template_revision: 2,
                        template_digest: 'sha256:t1',
                        torrent_name: 'bad.mkv',
                        torrent_path: '/tmp/bad.torrent',
                    });
                case 'parse_torrent':
                    parseCalls += 1;
                    return Promise.reject('invalid torrent');
                default:
                    return Promise.resolve(null);
            }
        });

        const rendered = await renderElement(<QuickPublishPage />);
        await flushAsync(30);

        // Gate parse is attempted; terminal failure must not leave a successful seed handoff.
        expect(parseCalls).toBeGreaterThanOrEqual(1);
        expect(window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY)).toBeNull();
        // Visible, sanitized fail-closed error — no absolute path or raw parse body.
        expect(document.body.textContent).toMatch(/种子文件无法解析|重新选择/);
        expect(document.body.textContent).not.toContain('/tmp/bad.torrent');
        expect(document.body.textContent).not.toContain('invalid torrent');
        // No successful torrent path should remain selected from the failed seed.
        const torrentInput = rendered.container.querySelector<HTMLInputElement>(
            'input[readonly], input[value*="bad.torrent"]',
        );
        if (torrentInput) {
            expect(torrentInput.value.includes('bad.torrent')).toBe(false);
        }

        await rendered.unmount();
    });
});
