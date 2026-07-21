import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderedElement {
    container: HTMLDivElement;
    root: Root;
    rerender: (element: ReactElement) => Promise<void>;
    unmount: () => Promise<void>;
}

export async function renderElement(element: ReactElement): Promise<RenderedElement> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(element);
    });

    return {
        container,
        root,
        rerender: async (nextElement) => {
            await act(async () => {
                root.render(nextElement);
            });
        },
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        },
    };
}

/** Flush pending microtasks (and the React work they schedule) inside act(). */
export async function flushAsync(rounds = 10): Promise<void> {
    await act(async () => {
        for (let index = 0; index < rounds; index += 1) {
            await Promise.resolve();
        }
    });
}

export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
