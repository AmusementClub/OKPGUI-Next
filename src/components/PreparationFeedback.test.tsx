import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PreparationFeedback from './PreparationFeedback';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('PreparationFeedback', () => {
    let container: HTMLDivElement;
    let root: Root;

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('renders error with retry and dismiss actions', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const onRetry = vi.fn();
        const onDismiss = vi.fn();
        act(() => {
            root.render(
                <PreparationFeedback
                    error="无法准备发布前检查。"
                    onRetry={onRetry}
                    onDismiss={onDismiss}
                    autoFocus={false}
                />,
            );
        });
        expect(container.querySelector('[data-testid="preparation-feedback-error"]')).toBeTruthy();
        expect(
            container.querySelector('[data-testid="preparation-feedback-message"]')?.textContent,
        ).toContain('无法准备');
        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="preparation-feedback-retry"]')?.click();
            container.querySelector<HTMLButtonElement>('[data-testid="preparation-feedback-dismiss"]')?.click();
        });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders status without error chrome', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root.render(<PreparationFeedback error={null} status="准备完成" autoFocus={false} />);
        });
        expect(container.querySelector('[data-testid="preparation-feedback-status"]')?.textContent)
            .toContain('准备完成');
        expect(container.querySelector('[data-testid="preparation-feedback-error"]')).toBeNull();
    });
});
