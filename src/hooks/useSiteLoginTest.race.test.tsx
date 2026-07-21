import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { emptySiteCookies } from '../utils/cookieUtils';
import {
    siteDefinitions,
    useSiteLoginTest,
    type ProfileLike,
} from './useSiteLoginTest';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.mocked(invoke);

type LoginTestHook = ReturnType<typeof useSiteLoginTest>;

const dmhySite = siteDefinitions.find((site) => site.key === 'dmhy')!;
const nyaaSite = siteDefinitions.find((site) => site.key === 'nyaa')!;
const acgripSite = siteDefinitions.find((site) => site.key === 'acgrip')!;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createProfile(siteKeys: string[]): ProfileLike {
    const siteCookies = emptySiteCookies();
    for (const key of siteKeys) {
        (siteCookies as unknown as Record<string, { raw_text: string }>)[key] = {
            raw_text: `# HTTP Cookie File\n.${key}.example\tTRUE\t/\tFALSE\t0\tsession\tvalue`,
        };
    }
    return {
        user_agent: '',
        site_cookies: siteCookies,
    };
}

function renderHook() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current!: LoginTestHook;

    const Probe = () => {
        current = useSiteLoginTest();
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

describe('useSiteLoginTest generation guard', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('writes the result when no profile switch happens mid-test', async () => {
        invokeMock.mockResolvedValue({ success: true, message: '已登录' });

        const harness = renderHook();

        await act(async () => {
            await harness.result.handleSiteLoginTest(dmhySite, createProfile(['dmhy']));
        });

        expect(harness.result.siteLoginTests.dmhy).toEqual({
            status: 'success',
            message: '已登录',
        });

        harness.unmount();
    });

    it('discards an in-flight result when the profile switches mid-test', async () => {
        const slot = deferred<{ success: boolean; message: string }>();
        invokeMock.mockImplementation(() => slot.promise);

        const harness = renderHook();

        let pending!: Promise<void>;
        await act(async () => {
            pending = harness.result.handleSiteLoginTest(dmhySite, createProfile(['dmhy']));
            await Promise.resolve();
        });
        expect(harness.result.siteLoginTests.dmhy.status).toBe('testing');

        // Profile switch signal: every page calls clearAllSiteLoginTests on switch.
        act(() => {
            harness.result.clearAllSiteLoginTests();
        });

        await act(async () => {
            slot.resolve({ success: true, message: '旧身份的登录结果' });
            await pending;
        });

        expect(harness.result.siteLoginTests.dmhy).toBeUndefined();

        harness.unmount();
    });

    it('discards an in-flight rejection when the profile switches mid-test', async () => {
        const slot = deferred<{ success: boolean; message: string }>();
        invokeMock.mockImplementation(() => slot.promise);

        const harness = renderHook();

        let pending!: Promise<void>;
        await act(async () => {
            pending = harness.result.handleSiteLoginTest(dmhySite, createProfile(['dmhy']));
            await Promise.resolve();
        });

        act(() => {
            harness.result.clearAllSiteLoginTests();
        });

        await act(async () => {
            slot.reject('网络错误');
            await pending;
        });

        expect(harness.result.siteLoginTests.dmhy).toBeUndefined();

        harness.unmount();
    });

    it('stops the test-all loop at a profile boundary', async () => {
        const first = deferred<{ success: boolean; message: string }>();
        let callCount = 0;
        invokeMock.mockImplementation(() => {
            callCount += 1;
            return callCount === 1
                ? first.promise
                : Promise.resolve({ success: true, message: 'ok' });
        });

        const harness = renderHook();
        const profile = createProfile(['dmhy', 'nyaa', 'acgrip']);

        let pending!: Promise<void>;
        await act(async () => {
            pending = harness.result.handleTestAllSiteLogins(
                [dmhySite, nyaaSite, acgripSite],
                profile,
            );
            await Promise.resolve();
        });
        expect(harness.result.isTestingAllSiteLogins).toBe(true);
        expect(callCount).toBe(1);

        // Switch profiles while the first site test is still in flight.
        act(() => {
            harness.result.clearAllSiteLoginTests();
        });

        await act(async () => {
            first.resolve({ success: true, message: '旧身份结果' });
            await pending;
        });

        // The loop must stop: nyaa/acgrip were never tested against the old profile.
        expect(callCount).toBe(1);
        expect(harness.result.isTestingAllSiteLogins).toBe(false);
        expect(harness.result.siteLoginTests).toEqual({});

        harness.unmount();
    });

    it('continues the test-all loop when no profile switch occurs', async () => {
        invokeMock.mockResolvedValue({ success: true, message: 'ok' });

        const harness = renderHook();
        const profile = createProfile(['dmhy', 'nyaa', 'acgrip']);

        await act(async () => {
            await harness.result.handleTestAllSiteLogins(
                [dmhySite, nyaaSite, acgripSite],
                profile,
            );
        });

        expect(invokeMock).toHaveBeenCalledTimes(3);
        expect(harness.result.siteLoginTests.dmhy.status).toBe('success');
        expect(harness.result.siteLoginTests.nyaa.status).toBe('success');
        expect(harness.result.siteLoginTests.acgrip.status).toBe('success');

        harness.unmount();
    });
});
