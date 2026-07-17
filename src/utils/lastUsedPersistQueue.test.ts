import { describe, expect, it, vi } from 'vitest';
import {
    createLatestValuePersistQueue,
    shouldApplyTemplateSelection,
} from './lastUsedPersistQueue';

describe('shouldApplyTemplateSelection', () => {
    it('only applies the latest generation', () => {
        expect(shouldApplyTemplateSelection(1, 1)).toBe(true);
        expect(shouldApplyTemplateSelection(1, 2)).toBe(false);
        expect(shouldApplyTemplateSelection(3, 2)).toBe(false);
    });
});

describe('createLatestValuePersistQueue', () => {
    it('coalesces rapid enqueues so only the latest id is written', async () => {
        const writes: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let call = 0;

        const queue = createLatestValuePersistQueue({
            persist: async (id) => {
                call += 1;
                if (call === 1) {
                    await firstGate;
                }
                writes.push(id);
            },
        });

        queue.enqueue('A');
        queue.enqueue('B');
        queue.enqueue('C');
        releaseFirst();

        await vi.waitFor(() => {
            expect(writes).toEqual(['A', 'C']);
        });
        expect(queue.getGeneration()).toBe(3);
    });

    it('surfaces only the latest persist failure', async () => {
        const errors: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let call = 0;

        const queue = createLatestValuePersistQueue({
            persist: async (id) => {
                call += 1;
                if (call === 1) {
                    await gate;
                    throw new Error(`fail-${id}`);
                }
            },
            onError: (error) => {
                errors.push(error instanceof Error ? error.message : String(error));
            },
        });

        queue.enqueue('A');
        queue.enqueue('B');
        release();

        await vi.waitFor(() => {
            expect(errors).toEqual([]);
            expect(call).toBe(2);
        });
    });

    it('reports error when the final write fails', async () => {
        const errors: string[] = [];
        const queue = createLatestValuePersistQueue({
            persist: async () => {
                throw new Error('disk full');
            },
            onError: (error) => {
                errors.push(error instanceof Error ? error.message : String(error));
            },
        });

        queue.enqueue('only');
        await vi.waitFor(() => {
            expect(errors).toEqual(['disk full']);
        });
    });
});
