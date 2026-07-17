/**
 * Serializes last-used template persistence so concurrent user selections
 * always end with the latest requested id on disk (single consumer).
 */
export function createLatestValuePersistQueue(options: {
    persist: (id: string) => Promise<void>;
    onError?: (error: unknown, id: string) => void;
}) {
    let generation = 0;
    let pendingId: string | null = null;
    let running = false;

    const pump = async () => {
        if (running) {
            return;
        }

        running = true;
        try {
            while (pendingId !== null) {
                const id = pendingId;
                const writeGeneration = generation;
                pendingId = null;

                try {
                    await options.persist(id);
                } catch (error) {
                    // Only surface errors for the latest request.
                    if (writeGeneration === generation) {
                        options.onError?.(error, id);
                    }
                }
            }
        } finally {
            running = false;
            if (pendingId !== null) {
                void pump();
            }
        }
    };

    return {
        /** Bump generation and schedule a write of `id` (latest wins). */
        enqueue(id: string): number {
            generation += 1;
            pendingId = id;
            void pump();
            return generation;
        },
        getGeneration(): number {
            return generation;
        },
        /** True when a completed async step still matches the latest selection. */
        isCurrent(requestGeneration: number): boolean {
            return requestGeneration === generation;
        },
    };
}

/** Pure guard used by HomePage before applying async load results to UI. */
export function shouldApplyTemplateSelection(
    requestGeneration: number,
    currentGeneration: number,
): boolean {
    return requestGeneration === currentGeneration;
}
