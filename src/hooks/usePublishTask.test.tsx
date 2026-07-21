import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flushAsync, renderElement } from '../test-utils/react';
import { usePublishTask } from './usePublishTask';

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
