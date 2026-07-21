import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
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
