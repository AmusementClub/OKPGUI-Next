import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
import { emptySiteCookies } from '../utils/cookieUtils';
import { createDefaultQuickPublishTemplate } from '../utils/quickPublish';
import QuickPublishPage from './QuickPublishPage';

const { invokeMock, onDragDropEventMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    onDragDropEventMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(() => Promise.resolve(vi.fn())),
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

        // The confirm modal opens; confirming must be blocked by content validation.
        const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
            (button) => button.textContent?.trim() === '确认发布',
        );
        expect(confirmButton).toBeTruthy();
        await act(async () => {
            confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await flushAsync();

        // Blocked client-side with a per-site message; the backend is never invoked.
        const publishCalls = invokeMock.mock.calls.filter(([command]) => command === 'publish');
        expect(publishCalls).toHaveLength(0);
        expect(document.body.textContent).toContain('需要 Markdown 发布内容');

        await rendered.unmount();
    });
});
