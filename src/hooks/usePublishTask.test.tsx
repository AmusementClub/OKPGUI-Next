import { StrictMode, act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flushAsync, renderElement } from '../test-utils/react';
import { createPublishConsoleSiteMap, usePublishTask } from './usePublishTask';

const { listenMock } = vi.hoisted(() => ({
    listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: listenMock,
}));

function Probe() {
    usePublishTask();
    return null;
}

describe('usePublishTask listener lifecycle', () => {
    beforeEach(() => {
        listenMock.mockReset();
    });

    it('detaches listeners that resolve after unmount', async () => {
        const registrations = [deferred<() => void>(), deferred<() => void>(), deferred<() => void>()];
        listenMock.mockImplementation(() => {
            const registration = registrations[listenMock.mock.calls.length - 1];
            if (!registration) {
                throw new Error('unexpected extra listen call');
            }
            return registration.promise;
        });

        const rendered = await renderElement(<Probe />);
        // setupListeners awaits each registration sequentially.
        expect(listenMock).toHaveBeenCalledTimes(1);

        await rendered.unmount();

        // Each late-resolving registration must be detached as soon as it lands,
        // and the setup chain must keep detaching the remaining registrations.
        const unlistenSpies = [vi.fn(), vi.fn(), vi.fn()];
        for (let index = 0; index < registrations.length; index += 1) {
            expect(listenMock).toHaveBeenCalledTimes(index + 1);
            registrations[index].resolve(unlistenSpies[index]);
            await flushAsync();
            expect(unlistenSpies[index]).toHaveBeenCalledTimes(1);
        }
        expect(listenMock).toHaveBeenCalledTimes(3);
    });

    it('keeps exactly one active listener set under StrictMode double-mount', async () => {
        const unlistenSpies: Array<ReturnType<typeof vi.fn>> = [];
        const registeredEvents: string[] = [];
        listenMock.mockImplementation((eventName: string) => {
            registeredEvents.push(eventName);
            const unlisten = vi.fn();
            unlistenSpies.push(unlisten);
            return Promise.resolve(unlisten);
        });

        const rendered = await renderElement(
            <StrictMode>
                <Probe />
            </StrictMode>,
        );
        await flushAsync();

        // Both StrictMode mounts register, but the first mount's set is detached.
        expect(listenMock).toHaveBeenCalledTimes(6);
        const detachedCount = unlistenSpies.filter((spy) => spy.mock.calls.length > 0).length;
        expect(detachedCount).toBe(3);

        // Exactly one active listener per event name.
        for (const eventName of ['publish-output', 'publish-site-complete', 'publish-complete']) {
            const indices = registeredEvents
                .map((name, index) => (name === eventName ? index : -1))
                .filter((index) => index >= 0);
            const activeIndices = indices.filter((index) => unlistenSpies[index].mock.calls.length === 0);
            expect(activeIndices).toHaveLength(1);
        }

        // Unmount detaches the surviving set.
        await rendered.unmount();
        for (const spy of unlistenSpies) {
            expect(spy).toHaveBeenCalledTimes(1);
        }
    });
});

interface PublishTaskApi {
    publishSites: ReturnType<typeof usePublishTask>['publishSites'];
    publishResult: ReturnType<typeof usePublishTask>['publishResult'];
    publishCompletion: ReturnType<typeof usePublishTask>['publishCompletion'];
    isPublishing: boolean;
    isPublishComplete: boolean;
    startPublishTask: ReturnType<typeof usePublishTask>['startPublishTask'];
    failActivePublish: ReturnType<typeof usePublishTask>['failActivePublish'];
}

type EventHandler = (event: { payload: Record<string, unknown> }) => void;

describe('usePublishTask event-authoritative completion', () => {
    let api: PublishTaskApi | null;
    let handlers: Record<string, EventHandler>;

    function ApiProbe() {
        api = usePublishTask();
        return null;
    }

    function startTwoSitePublish(publishId: string) {
        api!.startPublishTask(
            publishId,
            createPublishConsoleSiteMap([
                { siteCode: 'site1', siteLabel: '站点一', status: 'running', message: '发布中...' },
                { siteCode: 'site2', siteLabel: '站点二', status: 'running', message: '发布中...' },
            ]),
        );
    }

    beforeEach(async () => {
        api = null;
        handlers = {};
        listenMock.mockReset();
        listenMock.mockImplementation((eventName: string, handler: EventHandler) => {
            handlers[eventName] = handler;
            return Promise.resolve(vi.fn());
        });
    });

    async function mount() {
        const rendered = await renderElement(<ApiProbe />);
        await flushAsync();
        return rendered;
    }

    it('keeps succeeded sites and marks only absent sites as error on partial failure', async () => {
        const rendered = await mount();

        await act(async () => {
            startTwoSitePublish('pub-1');
        });
        await act(async () => {
            handlers['publish-site-complete']({
                payload: {
                    publish_id: 'pub-1',
                    site_code: 'site1',
                    site_label: '站点一',
                    success: true,
                    message: '发布成功',
                },
            });
        });
        await act(async () => {
            handlers['publish-complete']({
                payload: { publish_id: 'pub-1', success: false, message: '站点二发布失败' },
            });
        });

        // site1 succeeded and keeps its status; site2 never ran and is marked error.
        expect(api?.publishSites.site1.status).toBe('success');
        expect(api?.publishSites.site1.message).toBe('发布成功');
        expect(api?.publishSites.site2.status).toBe('error');
        expect(api?.publishSites.site2.message).toBe('站点二发布失败');
        // Completion is retained with the per-site backfill for history.
        expect(api?.publishCompletion?.publishId).toBe('pub-1');
        expect(api?.publishCompletion?.siteSuccess).toEqual({ site1: true });
        expect(api?.publishResult?.success).toBe(false);

        await rendered.unmount();
    });

    it('still consumes publish-complete when it arrives after failActivePublish', async () => {
        const rendered = await mount();

        await act(async () => {
            startTwoSitePublish('pub-2');
        });
        await act(async () => {
            handlers['publish-site-complete']({
                payload: {
                    publish_id: 'pub-2',
                    site_code: 'site1',
                    site_label: '站点一',
                    success: true,
                    message: '发布成功',
                },
            });
        });

        // The invoke rejects first (standalone failure result)...
        await act(async () => {
            api!.failActivePublish('发布任务执行失败');
        });
        expect(api?.isPublishComplete).toBe(true);
        expect(api?.publishResult?.success).toBe(false);

        // ...but the backend emitted publish-complete before rejecting, and the
        // event must still be consumed (refs were not cleared).
        await act(async () => {
            handlers['publish-complete']({
                payload: { publish_id: 'pub-2', success: false, message: '站点二发布失败' },
            });
        });

        expect(api?.publishSites.site1.status).toBe('success');
        expect(api?.publishSites.site2.status).toBe('error');
        expect(api?.publishSites.site2.message).toBe('站点二发布失败');
        expect(api?.publishResult?.message).toBe('站点二发布失败');
        expect(api?.publishCompletion?.siteSuccess).toEqual({ site1: true });

        await rendered.unmount();
    });

    it('sets a standalone failure result when no publish-complete will arrive', async () => {
        const rendered = await mount();

        await act(async () => {
            startTwoSitePublish('pub-3');
        });
        await act(async () => {
            api!.failActivePublish('请求序列化失败');
        });

        expect(api?.isPublishing).toBe(false);
        expect(api?.isPublishComplete).toBe(true);
        expect(api?.publishResult).toEqual({
            publish_id: 'pub-3',
            success: false,
            message: '请求序列化失败',
        });

        await rendered.unmount();
    });
});
