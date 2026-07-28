import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    startDefaultMediaInfoMock,
    pollPlanMediaInfoMock,
    cancelAiJobMock,
} = vi.hoisted(() => ({
    startDefaultMediaInfoMock: vi.fn(),
    pollPlanMediaInfoMock: vi.fn(),
    cancelAiJobMock: vi.fn(),
}));

vi.mock('../services/ai', () => ({
    startDefaultMediaInfo: startDefaultMediaInfoMock,
    pollPlanMediaInfo: pollPlanMediaInfoMock,
    cancelAiJob: cancelAiJobMock,
    readFriendlyError: (error: unknown, fallback: string) => (
        error instanceof Error ? error.message : fallback
    ),
}));

import { useAutomaticMediaInfo } from './useAutomaticMediaInfo';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function terminalView(jobId: string, state: string = 'succeeded') {
    return {
        job_id: jobId,
        state,
        results: [{ relative_name: 'a.mkv', state: 'measured', summary: null, message: null }],
        request_generation: 1,
        snapshot_hash: 'sha256:x',
        error_code: null,
        plan_token: '',
    };
}

function renderAutomatic(torrent: string, folder: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current!: ReturnType<typeof useAutomaticMediaInfo>;

    const Probe = ({ torrentPath, mediaFolder }: { torrentPath: string; mediaFolder: string }) => {
        current = useAutomaticMediaInfo(torrentPath, mediaFolder);
        return null;
    };

    act(() => {
        root.render(<Probe torrentPath={torrent} mediaFolder={folder} />);
    });

    return {
        get result() {
            return current;
        },
        rerender(nextTorrent: string, nextFolder: string) {
            act(() => {
                root.render(<Probe torrentPath={nextTorrent} mediaFolder={nextFolder} />);
            });
        },
        unmount() {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

describe('useAutomaticMediaInfo', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        startDefaultMediaInfoMock.mockReset();
        pollPlanMediaInfoMock.mockReset();
        cancelAiJobMock.mockReset();
        cancelAiJobMock.mockResolvedValue({ id: 'job', state: 'cancelled' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('cancels the job when unmounted before start resolves', async () => {
        let resolveStart: (value: ReturnType<typeof terminalView>) => void = () => undefined;
        startDefaultMediaInfoMock.mockImplementation(
            () => new Promise((resolve) => {
                resolveStart = resolve;
            }),
        );

        const hook = renderAutomatic('/t.torrent', '/media');
        hook.unmount();

        await act(async () => {
            resolveStart(terminalView('job-late'));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(cancelAiJobMock).toHaveBeenCalledWith('job-late');
    });

    it('cancels once on supersession before start resolves', async () => {
        const resolvers: Array<(value: ReturnType<typeof terminalView>) => void> = [];
        startDefaultMediaInfoMock.mockImplementation(
            () => new Promise((resolve) => {
                resolvers.push(resolve);
            }),
        );

        const hook = renderAutomatic('/a.torrent', '/media');
        expect(hook.result.status).toBe('checking');
        expect(resolvers.length).toBe(1);

        hook.rerender('/b.torrent', '/media');
        expect(resolvers.length).toBe(2);

        // First generation start resolves after supersession — must cancel that job.
        await act(async () => {
            resolvers[0](terminalView('job-a'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(cancelAiJobMock).toHaveBeenCalledWith('job-a');

        // Second generation remains active until cancelled separately.
        await act(async () => {
            resolvers[1](terminalView('job-b', 'running'));
            await Promise.resolve();
        });
        hook.unmount();
        await act(async () => {
            await Promise.resolve();
        });
        expect(cancelAiJobMock).toHaveBeenCalledWith('job-b');
    });

    it('cancels exactly once when superseded during polling', async () => {
        startDefaultMediaInfoMock
            .mockResolvedValueOnce({
                ...terminalView('job-poll'),
                state: 'running',
                results: [],
            })
            .mockResolvedValueOnce({
                ...terminalView('job-next'),
                state: 'running',
                results: [],
            });
        pollPlanMediaInfoMock.mockResolvedValue(null);

        const hook = renderAutomatic('/a.torrent', '/media');
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        hook.rerender('/b.torrent', '/media');
        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(cancelAiJobMock).toHaveBeenCalledWith('job-poll');
        const pollCancels = cancelAiJobMock.mock.calls.filter((call) => call[0] === 'job-poll');
        expect(pollCancels.length).toBe(1);
        hook.unmount();
    });

    it('exposes retry after changed_during_probe and restarts the probe', async () => {
        startDefaultMediaInfoMock
            .mockResolvedValueOnce({
                ...terminalView('job-changed'),
                state: 'succeeded',
                results: [{
                    relative_name: 'a.mkv',
                    state: 'changed_during_probe',
                    summary: null,
                    message: 'changed',
                }],
            })
            .mockResolvedValueOnce({
                ...terminalView('job-retry'),
                state: 'succeeded',
                results: [{ relative_name: 'a.mkv', state: 'measured', summary: null, message: null }],
            });

        const hook = renderAutomatic('/t.torrent', '/media');
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(hook.result.status).toBe('failed');
        expect(hook.result.message).toContain('请重试');
        expect(typeof hook.result.retry).toBe('function');
        expect(startDefaultMediaInfoMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.result.retry();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(startDefaultMediaInfoMock).toHaveBeenCalledTimes(2);
        expect(hook.result.status).toBe('done');
        hook.unmount();
    });
});
