import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
import { AUTOSAVE_DEBOUNCE_MS } from '../utils/constants';
import {
    QuickPublishTemplate,
    createDefaultQuickPublishTemplate,
} from '../utils/quickPublish';
import {
    TemplateManagerState,
    quickPublishTemplateManagerConfig,
    useTemplateManager,
} from './useTemplateManager';

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(() => Promise.resolve(null)),
    save: vi.fn(() => Promise.resolve(null)),
}));

let manager: TemplateManagerState<QuickPublishTemplate> | null = null;

function Probe() {
    manager = useTemplateManager(quickPublishTemplateManagerConfig);
    return null;
}

async function actOn(action: () => void | Promise<void>): Promise<void> {
    await act(async () => {
        await action();
    });
}

function makeTemplate(id: string, name: string): QuickPublishTemplate {
    return {
        ...createDefaultQuickPublishTemplate(),
        id,
        name,
    };
}

const configPayload = {
    quick_publish_templates: {
        a: makeTemplate('a', '模板A'),
        b: makeTemplate('b', '模板B'),
    },
    content_templates: {},
    okp_executable_path: '',
    last_used_quick_publish_template: null,
};

interface SaveCall {
    template: QuickPublishTemplate;
    expectedRevision: number | null;
}

let saveCalls: SaveCall[];
let saveResolvers: Array<(value: { id: string; template: unknown }) => void>;
let saveRejecters: Array<(reason?: unknown) => void>;
let deleteCalls: Array<{ id: string }>;
let invokeOrder: string[];

function routeInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    switch (command) {
        case 'get_config':
            return Promise.resolve(configPayload);
        case 'get_config_load_error':
            return Promise.resolve(null);
        case 'save_quick_publish_template':
            saveCalls.push(args as unknown as SaveCall);
            invokeOrder.push('save');
            return new Promise((resolve, reject) => {
                saveResolvers.push(resolve);
                saveRejecters.push(reject);
            });
        case 'delete_quick_publish_template':
            deleteCalls.push(args as unknown as { id: string });
            invokeOrder.push('delete');
            return Promise.resolve(null);
        default:
            return Promise.resolve(null);
    }
}

describe('useTemplateManager stale-async guards', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        manager = null;
        saveCalls = [];
        saveResolvers = [];
        saveRejecters = [];
        deleteCalls = [];
        invokeOrder = [];
        invokeMock.mockReset();
        invokeMock.mockImplementation(routeInvoke);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushes the pending autosave before switching templates', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        let switchPromise: Promise<void> | null = null;
        await actOn(() => {
            switchPromise = manager!.selectTemplate('b');
        });

        // The pending edit for A is persisted before the switch completes.
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0].template.name).toBe('A改');
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(async () => {
            saveResolvers[0]({ id: 'a', template: saveCalls[0].template });
            await switchPromise;
        });

        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.draft.id).toBe('b');
        expect(manager?.draft.name).toBe('模板B');

        await rendered.unmount();
    });

    it('serializes and coalesces edits while a save is in flight before switching', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A-1' })));
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0].expectedRevision).toBe(0);

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A-2' })));
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A-3' })));
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });

        // B and C are coalesced behind unresolved save A; no overlapping request starts.
        expect(saveCalls).toHaveLength(1);
        expect(manager?.draft.name).toBe('A-3');

        let switchSettled = false;
        await actOn(() => {
            void manager!.selectTemplate('b').then(() => {
                switchSettled = true;
            });
        });
        expect(switchSettled).toBe(false);

        await actOn(async () => {
            saveResolvers[0]({
                id: 'a',
                template: {
                    ...saveCalls[0].template,
                    revision: 1,
                    updated_at: '2026-07-22T06:00:00.000Z',
                },
            });
            await flushAsync();
        });

        // The latest queued content receives A's backend metadata and is the only
        // follow-up request. The switch still waits for that request to settle.
        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[1].template.name).toBe('A-3');
        expect(saveCalls[1].template.revision).toBe(1);
        expect(saveCalls[1].expectedRevision).toBe(1);
        expect(manager?.draft.name).toBe('A-3');
        expect(manager?.draft.revision).toBe(1);
        expect(manager?.draft.updated_at).toBe('2026-07-22T06:00:00.000Z');
        expect(switchSettled).toBe(false);
        expect(manager?.conflictState).toBeNull();

        await actOn(async () => {
            saveResolvers[1]({
                id: 'a',
                template: {
                    ...saveCalls[1].template,
                    revision: 2,
                    updated_at: '2026-07-22T06:00:01.000Z',
                },
            });
            await flushAsync();
        });

        expect(switchSettled).toBe(true);
        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.conflictState).toBeNull();

        await rendered.unmount();
    });

    it('flushes an edit made after switching starts before applying the target', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A-1' })));

        let switchSettled = false;
        await actOn(() => {
            void manager!.selectTemplate('b').then(() => {
                switchSettled = true;
            });
        });
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0].expectedRevision).toBe(0);

        // The editor remains live while the switch flush is awaiting save A.
        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A-2' })));
        expect(manager?.draft.name).toBe('A-2');
        expect(saveCalls).toHaveLength(1);

        await actOn(async () => {
            saveResolvers[0]({
                id: 'a',
                template: {
                    ...saveCalls[0].template,
                    revision: 1,
                    updated_at: '2026-07-22T06:01:00.000Z',
                },
            });
            await flushAsync();
        });

        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[1].template.name).toBe('A-2');
        expect(saveCalls[1].template.revision).toBe(1);
        expect(saveCalls[1].expectedRevision).toBe(1);
        expect(switchSettled).toBe(false);
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(async () => {
            saveResolvers[1]({
                id: 'a',
                template: {
                    ...saveCalls[1].template,
                    revision: 2,
                    updated_at: '2026-07-22T06:01:01.000Z',
                },
            });
            await flushAsync();
        });

        expect(switchSettled).toBe(true);
        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.draft.name).toBe('模板B');
        expect(manager?.conflictState).toBeNull();

        await rendered.unmount();
    });

    it('ignores a rapid second switch during an in-flight flush', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        let firstSwitch: Promise<void> | null = null;
        let secondSwitch: Promise<void> | null = null;
        await actOn(() => {
            firstSwitch = manager!.selectTemplate('b');
            secondSwitch = manager!.selectTemplate('a');
        });

        expect(saveCalls).toHaveLength(1);

        await actOn(async () => {
            saveResolvers[0]({ id: 'a', template: saveCalls[0].template });
            await Promise.all([firstSwitch, secondSwitch]);
        });

        // Single flush, no torn state: the first switch wins, the second was ignored.
        expect(saveCalls).toHaveLength(1);
        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.draft.id).toBe('b');

        await rendered.unmount();
    });

    it('keeps the new selection when a save resolves after the user moved on', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        // Fire the debounced autosave for A, then move to B while it is in flight.
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);

        await actOn(async () => {
            await manager!.loadData('b');
        });
        expect(manager?.selectedTemplateId).toBe('b');

        await actOn(() => {
            saveResolvers[0]({ id: 'a', template: saveCalls[0].template });
        });

        // Selection stays on B; A's saved data is still merged into the map.
        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.draft.id).toBe('b');
        expect(manager?.templates.a.name).toBe('A改');

        // A delete in this state targets B, the visible selection.
        await actOn(async () => {
            await manager!.deleteTemplate();
        });
        expect(deleteCalls).toEqual([{ id: 'b' }]);

        await rendered.unmount();
    });

    it('follows the saved id when the selection did not change mid-save', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);

        // Backend persists under a new id (rename); no switch happened meanwhile.
        await actOn(() => {
            saveResolvers[0]({
                id: 'a-renamed',
                template: { ...saveCalls[0].template, id: 'a-renamed' },
            });
        });

        expect(manager?.selectedTemplateId).toBe('a-renamed');
        expect(manager?.templates['a-renamed']?.name).toBe('A改');
        expect(manager?.templates.a).toBeUndefined();
        expect(manager?.draft.name).toBe('A改');

        await rendered.unmount();
    });

    it('sets a load error when the config request fails', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_config') {
                return Promise.reject('后端不可用');
            }
            return Promise.resolve(null);
        });

        const rendered = await renderElement(<Probe />);
        await flushAsync();

        expect(manager?.loadError).toBe('后端不可用');

        await rendered.unmount();
    });

    it('surfaces the corrupt-config warning reported by the backend', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'get_config') {
                return Promise.resolve(configPayload);
            }
            if (command === 'get_config_load_error') {
                return Promise.resolve('第 3 行 JSON 解析失败');
            }
            return Promise.resolve(null);
        });

        const rendered = await renderElement(<Probe />);
        await flushAsync();

        expect(manager?.loadError).toContain('配置文件损坏');
        // Data still loads from the default config.
        expect(manager?.selectedTemplateId).toBe('a');

        await rendered.unmount();
    });

    it('disarms the pending autosave before deleting so the timer cannot resurrect the template', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));
        expect(manager?.hasPendingAutosave).toBe(true);

        await actOn(async () => {
            await manager!.deleteTemplate();
        });

        // The doomed template's pending edit is discarded, not saved; the debounce
        // timer is disarmed so it cannot fire after the delete round-trip.
        expect(invokeOrder).toEqual(['delete']);
        expect(deleteCalls).toEqual([{ id: 'a' }]);
        expect(manager?.hasPendingAutosave).toBe(false);

        await rendered.unmount();
    });

    it('awaits an in-flight save before the delete round-trip', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);

        let deleteSettled = false;
        await actOn(() => {
            void manager!.deleteTemplate().then(() => {
                deleteSettled = true;
            });
        });

        // The delete round-trip waits for the in-flight save to land first.
        expect(deleteSettled).toBe(false);
        expect(deleteCalls).toHaveLength(0);

        await actOn(async () => {
            saveResolvers[0]({ id: 'a', template: saveCalls[0].template });
            await flushAsync();
        });

        expect(invokeOrder).toEqual(['save', 'delete']);
        expect(deleteCalls).toEqual([{ id: 'a' }]);

        await rendered.unmount();
    });

    it('targets the delete at the current selection after a mid-save switch', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();
        expect(manager?.selectedTemplateId).toBe('a');

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        // Save of A in flight; user moves to B; save resolves; delete must target B.
        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);

        await actOn(async () => {
            await manager!.loadData('b');
        });
        await actOn(() => {
            saveResolvers[0]({ id: 'a', template: saveCalls[0].template });
        });
        expect(manager?.selectedTemplateId).toBe('b');

        await actOn(async () => {
            await manager!.deleteTemplate();
        });
        expect(deleteCalls).toEqual([{ id: 'b' }]);

        await rendered.unmount();
    });

    it('keeps the dirty state armed when an autosave fails and retries on switch', async () => {
        const rendered = await renderElement(<Probe />);
        await flushAsync();

        await actOn(() => manager?.updateDraft((current) => ({ ...current, name: 'A改' })));

        await actOn(() => {
            vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS + 1);
        });
        expect(saveCalls).toHaveLength(1);

        await actOn(() => {
            saveRejecters[0]('磁盘写入失败');
        });

        // Failure leaves the draft dirty and armed instead of silently disarming.
        expect(manager?.hasPendingAutosave).toBe(true);
        expect(manager?.saveState).toBe('failed');
        expect(manager?.errorMessage).toBe('磁盘写入失败');

        // Flushing on switch retries the failed save before completing the switch.
        let switchPromise: Promise<void> | null = null;
        await actOn(() => {
            switchPromise = manager!.selectTemplate('b');
        });
        expect(saveCalls).toHaveLength(2);

        await actOn(async () => {
            saveResolvers[1]({ id: 'a', template: saveCalls[1].template });
            await switchPromise;
        });
        expect(manager?.selectedTemplateId).toBe('b');
        expect(manager?.hasPendingAutosave).toBe(false);

        await rendered.unmount();
    });
});
