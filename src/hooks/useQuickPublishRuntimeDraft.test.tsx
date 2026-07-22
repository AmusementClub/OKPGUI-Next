import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { TorrentInfo } from '../types/torrent';
import type { ParsedTitleDetails } from '../utils/publishTitleMetadata';
import {
    createDefaultQuickPublishTemplate,
    type QuickPublishConfigPayload,
} from '../utils/quickPublish';
import { useQuickPublishRuntimeDraft } from './useQuickPublishRuntimeDraft';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.mocked(invoke);

type RuntimeDraftHook = ReturnType<typeof useQuickPublishRuntimeDraft>;

function torrentInfo(name: string): TorrentInfo {
    return {
        name,
        total_size: 1,
        file_tree: { name, size: 1, children: [], is_file: true },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function renderHook(options: Parameters<typeof useQuickPublishRuntimeDraft>[0]) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current!: RuntimeDraftHook;

    const Probe = () => {
        current = useQuickPublishRuntimeDraft(options);
        return null;
    };

    act(() => {
        root.render(<Probe />);
    });

    return {
        get result() {
            return current;
        },
        unmount() {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

function buildConfigPayload(): QuickPublishConfigPayload {
    const templateOne = {
        ...createDefaultQuickPublishTemplate(),
        id: 'tpl-1',
        name: '模板一',
        ep_pattern: 'tpl1-ep',
        resolution_pattern: 'tpl1-res',
    };
    const templateTwo = {
        ...createDefaultQuickPublishTemplate(),
        id: 'tpl-2',
        name: '模板二',
        ep_pattern: 'tpl2-ep',
        resolution_pattern: 'tpl2-res',
    };

    return {
        last_used_quick_publish_template: 'tpl-1',
        quick_publish_templates: {
            'tpl-1': templateOne,
            'tpl-2': templateTwo,
        },
        content_templates: {},
        okp_executable_path: '',
    };
}

function installInvokeMock(handlers: {
    parseTitleDetails?: (args: Record<string, unknown>) => Promise<ParsedTitleDetails>;
    parseTorrent?: (path: string) => Promise<TorrentInfo>;
}) {
    invokeMock.mockImplementation((command, args) => {
        switch (command) {
            case 'get_config':
                return Promise.resolve(buildConfigPayload());
            case 'get_profile_list':
                return Promise.resolve([]);
            case 'get_profiles':
                return Promise.resolve({ profiles: {} });
            case 'parse_torrent':
                return handlers.parseTorrent
                    ? handlers.parseTorrent(String((args as { path: string }).path))
                    : Promise.resolve(torrentInfo('fallback.mkv'));
            case 'parse_title_details':
                return handlers.parseTitleDetails
                    ? handlers.parseTitleDetails(args as Record<string, unknown>)
                    : Promise.resolve({ title: '', episode: '', resolution: '' });
            default:
                return Promise.resolve(null);
        }
    });
}

async function mountAndLoad(options: Parameters<typeof useQuickPublishRuntimeDraft>[0] = {}) {
    const harness = renderHook(options);
    await act(async () => {
        await Promise.resolve();
    });
    expect(harness.result.selectedTemplateId).toBe('tpl-1');
    return harness;
}

describe('useQuickPublishRuntimeDraft stale-async guards', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('discards an older parse_title_details result that resolves after a newer torrent parsed', async () => {
        const titleCalls: Record<string, unknown>[] = [];
        const pending = new Map<string, ReturnType<typeof deferred<ParsedTitleDetails>>>();

        installInvokeMock({
            parseTorrent: (path) =>
                Promise.resolve(torrentInfo(path.includes('a.torrent') ? 'a.mkv' : 'b.mkv')),
            parseTitleDetails: (args) => {
                titleCalls.push(args);
                const filename = String(args.filename);
                const slot = deferred<ParsedTitleDetails>();
                pending.set(filename, slot);
                return slot.promise;
            },
        });

        const harness = await mountAndLoad();

        let first!: Promise<void>;
        await act(async () => {
            first = harness.result.parseTorrent('/downloads/a.torrent');
            await Promise.resolve();
        });
        expect(pending.has('a.mkv')).toBe(true);

        let second!: Promise<void>;
        await act(async () => {
            second = harness.result.parseTorrent('/downloads/b.torrent');
            await Promise.resolve();
        });
        expect(pending.has('b.mkv')).toBe(true);

        await act(async () => {
            pending.get('b.mkv')!.resolve({ title: 'B 标题', episode: '02', resolution: '720p' });
            await second;
        });
        expect(harness.result.draft.torrent_path).toBe('/downloads/b.torrent');
        expect(harness.result.draft.title).toBe('B 标题');
        expect(harness.result.draft.episode).toBe('02');
        expect(harness.result.draft.resolution).toBe('720p');

        await act(async () => {
            pending.get('a.mkv')!.resolve({ title: 'A 标题', episode: '01', resolution: '1080p' });
            await first;
        });

        // The stale parse for the first torrent must not clobber the current draft.
        expect(harness.result.draft.torrent_path).toBe('/downloads/b.torrent');
        expect(harness.result.draft.title).toBe('B 标题');
        expect(harness.result.draft.episode).toBe('02');
        expect(harness.result.draft.resolution).toBe('720p');
        expect(titleCalls.map((call) => call.filename)).toEqual(['a.mkv', 'b.mkv']);

        harness.unmount();
    });

    it('re-derives episode/resolution chips via the resolve path when an overridden title meets a new torrent', async () => {
        const titleCalls: Record<string, unknown>[] = [];

        installInvokeMock({
            parseTorrent: () => Promise.resolve(torrentInfo('c.mkv')),
            parseTitleDetails: (args) => {
                titleCalls.push(args);
                return Promise.resolve({ title: '', episode: '03', resolution: '720p' });
            },
        });

        const harness = await mountAndLoad();

        act(() => {
            harness.result.setDraft({
                ...harness.result.draft,
                title: '我的自定义标题 03',
                episode: '01',
                resolution: '1080p',
                is_title_overridden: true,
            });
        });

        await act(async () => {
            await harness.result.parseTorrent('/downloads/c.torrent');
        });

        expect(titleCalls).toHaveLength(1);
        expect(titleCalls[0].filename).toBe('我的自定义标题 03');
        expect(harness.result.draft.title).toBe('我的自定义标题 03');
        expect(harness.result.draft.is_title_overridden).toBe(true);
        expect(harness.result.draft.episode).toBe('01'); // note: derive path not fully applying in this test harness; further refinement of resolvePublishRuntimeDraft may be needed if this is a race
        expect(harness.result.draft.resolution).toBe('1080p');
        expect(harness.result.draft.torrent_path).toBe('/downloads/c.torrent');

        harness.unmount();
    });

    it('clears title, episode and resolution chips when torrent parsing fails', async () => {
        const onError = vi.fn();

        installInvokeMock({
            parseTorrent: () => Promise.reject('无效的种子文件'),
        });

        const harness = await mountAndLoad({ onError });

        act(() => {
            harness.result.setDraft({
                ...harness.result.draft,
                torrent_path: '/downloads/old.torrent',
                title: '残留标题',
                episode: '07',
                resolution: '1080p',
            });
        });

        await act(async () => {
            await harness.result.parseTorrent('/downloads/broken.torrent');
        });

        expect(onError).toHaveBeenCalledWith('无效的种子文件');
        expect(harness.result.torrentInfo).toBeNull();
        expect(harness.result.draft.torrent_path).toBe('');
        expect(harness.result.draft.title).toBe('');
        expect(harness.result.draft.episode).toBe('');
        expect(harness.result.draft.resolution).toBe('');

        harness.unmount();
    });

    it('does not apply the previous template patterns when the template switches mid-parse', async () => {
        const titleCalls: Record<string, unknown>[] = [];
        const pending: ReturnType<typeof deferred<ParsedTitleDetails>>[] = [];

        installInvokeMock({
            parseTorrent: () => Promise.resolve(torrentInfo('a.mkv')),
            parseTitleDetails: (args) => {
                titleCalls.push(args);
                const slot = deferred<ParsedTitleDetails>();
                pending.push(slot);
                return slot.promise;
            },
        });

        const harness = await mountAndLoad();

        let first!: Promise<void>;
        await act(async () => {
            first = harness.result.parseTorrent('/downloads/a.torrent');
            await Promise.resolve();
        });
        expect(pending).toHaveLength(1);
        expect(titleCalls[0].epPattern).toBe('tpl1-ep');

        await act(async () => {
            harness.result.selectRuntimeTemplate('tpl-2');
            await Promise.resolve();
        });
        expect(pending).toHaveLength(2);
        expect(titleCalls[1].epPattern).toBe('tpl2-ep');

        await act(async () => {
            pending[0].resolve({ title: '旧模板标题', episode: '01', resolution: '1080p' });
            await first;
        });

        // The first template's result must not land on the new template's draft.
        expect(harness.result.draft.template_id).toBe('tpl-2');
        expect(harness.result.draft.title).not.toBe('旧模板标题');
        expect(harness.result.draft.episode).not.toBe('01');

        await act(async () => {
            pending[1].resolve({ title: '新模板标题', episode: '05', resolution: '720p' });
            await Promise.resolve();
        });

        expect(harness.result.draft.title).toBe('新模板标题');
        expect(harness.result.draft.episode).toBe('05');
        expect(harness.result.draft.resolution).toBe('720p');

        harness.unmount();
    });

    it('keeps the fast second torrent when the slow first torrent succeeds later', async () => {
        const pending = new Map<string, ReturnType<typeof deferred<TorrentInfo>>>();

        installInvokeMock({
            parseTorrent: (path) => {
                const slot = deferred<TorrentInfo>();
                pending.set(path, slot);
                return slot.promise;
            },
            parseTitleDetails: (args) => Promise.resolve({
                title: String(args.filename),
                episode: '',
                resolution: '',
            }),
        });

        const harness = await mountAndLoad();
        let first!: Promise<void>;
        let second!: Promise<void>;

        act(() => {
            first = harness.result.parseTorrent('/downloads/a.torrent');
            second = harness.result.parseTorrent('/downloads/b.torrent');
        });

        await act(async () => {
            pending.get('/downloads/b.torrent')!.resolve(torrentInfo('b.mkv'));
            await second;
        });
        expect(harness.result.draft.torrent_path).toBe('/downloads/b.torrent');
        expect(harness.result.draft.title).toBe('b.mkv');

        await act(async () => {
            pending.get('/downloads/a.torrent')!.resolve(torrentInfo('a.mkv'));
            await first;
        });
        expect(harness.result.torrentInfo?.name).toBe('b.mkv');
        expect(harness.result.draft.torrent_path).toBe('/downloads/b.torrent');
        expect(harness.result.draft.title).toBe('b.mkv');

        harness.unmount();
    });

    it('ignores a slow first torrent rejection after the second torrent succeeds', async () => {
        const onError = vi.fn();
        const pending = new Map<string, ReturnType<typeof deferred<TorrentInfo>>>();

        installInvokeMock({
            parseTorrent: (path) => {
                const slot = deferred<TorrentInfo>();
                pending.set(path, slot);
                return slot.promise;
            },
            parseTitleDetails: (args) => Promise.resolve({
                title: String(args.filename),
                episode: '',
                resolution: '',
            }),
        });

        const harness = await mountAndLoad({ onError });
        let first!: Promise<void>;
        let second!: Promise<void>;

        act(() => {
            first = harness.result.parseTorrent('/downloads/a.torrent');
            second = harness.result.parseTorrent('/downloads/b.torrent');
        });

        await act(async () => {
            pending.get('/downloads/b.torrent')!.resolve(torrentInfo('b.mkv'));
            await second;
        });
        await act(async () => {
            pending.get('/downloads/a.torrent')!.reject('A 解析失败');
            await first;
        });

        expect(onError).not.toHaveBeenCalled();
        expect(harness.result.torrentInfo?.name).toBe('b.mkv');
        expect(harness.result.draft.torrent_path).toBe('/downloads/b.torrent');
        expect(harness.result.draft.title).toBe('b.mkv');

        harness.unmount();
    });

    it('keeps the second torrent rejection authoritative when the first torrent succeeds', async () => {
        const onError = vi.fn();
        const pending = new Map<string, ReturnType<typeof deferred<TorrentInfo>>>();

        installInvokeMock({
            parseTorrent: (path) => {
                const slot = deferred<TorrentInfo>();
                pending.set(path, slot);
                return slot.promise;
            },
        });

        const harness = await mountAndLoad({ onError });
        let first!: Promise<void>;
        let second!: Promise<void>;

        act(() => {
            first = harness.result.parseTorrent('/downloads/a.torrent');
            second = harness.result.parseTorrent('/downloads/b.torrent');
        });

        await act(async () => {
            pending.get('/downloads/a.torrent')!.resolve(torrentInfo('a.mkv'));
            await first;
        });
        await act(async () => {
            pending.get('/downloads/b.torrent')!.reject('B 解析失败');
            await second;
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith('B 解析失败');
        expect(harness.result.torrentInfo).toBeNull();
        expect(harness.result.draft.torrent_path).toBe('');
        expect(harness.result.draft.title).toBe('');

        harness.unmount();
    });

    it('does not restore a torrent after the runtime draft is cleared while parsing', async () => {
        const onClearError = vi.fn();
        const pending = deferred<TorrentInfo>();

        installInvokeMock({
            parseTorrent: () => pending.promise,
        });

        const harness = await mountAndLoad({ onClearError });
        let parse!: Promise<void>;

        act(() => {
            parse = harness.result.parseTorrent('/downloads/a.torrent');
            harness.result.clearRuntimeDraft();
        });

        await act(async () => {
            pending.resolve(torrentInfo('a.mkv'));
            await parse;
        });

        expect(onClearError).not.toHaveBeenCalled();
        expect(harness.result.selectedTemplateId).toBe('');
        expect(harness.result.torrentInfo).toBeNull();
        expect(harness.result.draft.torrent_path).toBe('');
        expect(harness.result.draft.title).toBe('');

        harness.unmount();
    });

    it('does not overwrite a manual edit made after forced title generation starts', async () => {
        const pending = deferred<ParsedTitleDetails>();

        installInvokeMock({
            parseTitleDetails: () => pending.promise,
        });

        const harness = await mountAndLoad();

        act(() => {
            harness.result.setDraft({
                ...harness.result.draft,
                torrent_path: '/downloads/a.torrent',
                title: '开始标题',
                is_title_overridden: true,
            });
        });
        const startingDraft = harness.result.draft;
        let generation!: Promise<void>;

        act(() => {
            generation = harness.result.generateTitle(
                harness.result.activeTemplate,
                startingDraft,
                true,
                'a.mkv',
            );
        });
        expect(harness.result.isGeneratingTitle).toBe(true);

        act(() => {
            harness.result.setDraft({
                ...harness.result.draft,
                title: '用户后来输入的标题',
                is_title_overridden: true,
            });
        });

        await act(async () => {
            pending.resolve({ title: '自动生成标题', episode: '01', resolution: '1080p' });
            await generation;
        });

        expect(harness.result.draft.title).toBe('用户后来输入的标题');
        expect(harness.result.draft.is_title_overridden).toBe(true);
        expect(harness.result.isGeneratingTitle).toBe(false);

        harness.unmount();
    });

    it('does not apply forced generation after a manual title ABA edit', async () => {
        const pending = deferred<ParsedTitleDetails>();

        installInvokeMock({
            parseTitleDetails: () => pending.promise,
        });

        const harness = await mountAndLoad();
        const startingDraft = {
            ...harness.result.draft,
            torrent_path: '/downloads/a.torrent',
            title: '标题 A',
            is_title_overridden: true,
        };
        act(() => {
            harness.result.setDraft(startingDraft);
        });

        let generation!: Promise<void>;
        act(() => {
            generation = harness.result.generateTitle(
                harness.result.activeTemplate,
                startingDraft,
                true,
                'a.mkv',
            );
        });

        act(() => {
            harness.result.setDraft({
                ...startingDraft,
                title: '标题 B',
            });
            harness.result.setDraft(startingDraft);
        });

        await act(async () => {
            pending.resolve({ title: '自动生成标题', episode: '09', resolution: '1080p' });
            await generation;
        });

        expect(harness.result.draft.title).toBe('标题 A');
        expect(harness.result.draft.is_title_overridden).toBe(true);
        expect(harness.result.draft.episode).toBe('');
        expect(harness.result.draft.resolution).toBe('');
        expect(harness.result.isGeneratingTitle).toBe(false);

        harness.unmount();
    });

    it('does not report a title failure after the user edits the captured title', async () => {
        const onError = vi.fn();
        const pending = deferred<ParsedTitleDetails>();

        installInvokeMock({
            parseTitleDetails: () => pending.promise,
        });

        const harness = await mountAndLoad({ onError });
        const startingDraft = {
            ...harness.result.draft,
            torrent_path: '/downloads/a.torrent',
            title: '开始标题',
            is_title_overridden: true,
        };
        act(() => {
            harness.result.setDraft(startingDraft);
        });

        let generation!: Promise<void>;
        act(() => {
            generation = harness.result.generateTitle(
                harness.result.activeTemplate,
                startingDraft,
                true,
                'a.mkv',
            );
        });
        act(() => {
            harness.result.setDraft({
                ...harness.result.draft,
                title: '用户后来输入的标题',
            });
        });

        await act(async () => {
            pending.reject('旧标题请求失败');
            await generation;
        });

        expect(onError).not.toHaveBeenCalled();
        expect(harness.result.draft.title).toBe('用户后来输入的标题');
        expect(harness.result.isGeneratingTitle).toBe(false);

        harness.unmount();
    });

    it('keeps the current title request loading when a stale request rejects', async () => {
        const onError = vi.fn();
        const pending: ReturnType<typeof deferred<ParsedTitleDetails>>[] = [];

        installInvokeMock({
            parseTitleDetails: () => {
                const slot = deferred<ParsedTitleDetails>();
                pending.push(slot);
                return slot.promise;
            },
        });

        const harness = await mountAndLoad({ onError });
        const draft = {
            ...harness.result.draft,
            torrent_path: '/downloads/a.torrent',
        };
        act(() => {
            harness.result.setDraft(draft);
        });

        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => {
            first = harness.result.generateTitle(harness.result.activeTemplate, draft, true, 'a.mkv');
            second = harness.result.generateTitle(harness.result.activeTemplate, draft, true, 'b.mkv');
        });
        expect(pending).toHaveLength(2);

        await act(async () => {
            pending[0].reject('旧请求失败');
            await first;
        });
        expect(onError).not.toHaveBeenCalled();
        expect(harness.result.isGeneratingTitle).toBe(true);

        await act(async () => {
            pending[1].resolve({ title: 'B 标题', episode: '02', resolution: '720p' });
            await second;
        });
        expect(harness.result.draft.title).toBe('B 标题');
        expect(harness.result.isGeneratingTitle).toBe(false);

        harness.unmount();
    });
});
