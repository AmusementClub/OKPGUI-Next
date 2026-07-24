import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiPreflightState } from '../hooks/useAiPreflight';
import AiPreflightPanel from './AiPreflightPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function baseState(overrides: Partial<AiPreflightState> = {}): AiPreflightState {
    return {
        settings: {
            provider: 'open_ai',
            endpoint: 'https://api.example.test/v1',
            model: 'm',
            mode: 'auto',
            auth_mode: 'none',
            enabled: true,
        },
        audit: null,
        decision: 'PENDING',
        lifecycle: 'auditing',
        acknowledgements: { warning: false, critical: false, pending: false },
        acknowledgementsBound: false,
        checking: false,
        token: 'plan-token',
        snapshot_hash: 'sha256:x',
        job_id: 'job-1',
        error: null,
        vision: {
            status: 'idle',
            candidates: [],
            selectedUrls: [],
            maxImages: 5,
            boundImages: [],
            warnings: [],
            error: null,
        },
        ...overrides,
    };
}

function renderPanel(props: {
    state: AiPreflightState;
    canConfirm?: boolean;
    onCancel?: () => void;
    onRetry?: () => void;
    onRetryReconciliation?: () => void;
    onToggleVisionSelection?: (url: string) => void;
    onSelectAllVision?: () => void;
    onConfirmVisionSelection?: () => void;
    onContinueTextOnlyVision?: () => void;
}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(
            <AiPreflightPanel
                state={props.state}
                configured
                canConfirm={props.canConfirm ?? false}
                onAcknowledgementChange={() => undefined}
                onToggleVisionSelection={props.onToggleVisionSelection}
                onSelectAllVision={props.onSelectAllVision}
                onConfirmVisionSelection={props.onConfirmVisionSelection}
                onContinueTextOnlyVision={props.onContinueTextOnlyVision}
                onCancel={props.onCancel}
                onRetry={props.onRetry}
                onRetryReconciliation={props.onRetryReconciliation}
            />,
        );
    });
    return {
        container,
        unmount() {
            act(() => {
                root.unmount();
            });
            container.remove();
        },
    };
}

describe('AiPreflightPanel', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('shows advisory disclaimer and cancel during active audit', () => {
        const onCancel = vi.fn();
        const { container, unmount } = renderPanel({
            state: baseState(),
            onCancel,
        });
        expect(container.querySelector('[data-testid="ai-preflight-advisory-disclaimer"]')?.textContent)
            .toMatch(/仅供参考/);
        const cancel = container.querySelector('[data-testid="ai-preflight-cancel"]') as HTMLButtonElement;
        expect(cancel).toBeTruthy();
        expect(cancel.getAttribute('aria-label')).toBe('取消发布前检查');
        act(() => {
            cancel.click();
        });
        expect(onCancel).toHaveBeenCalled();
        unmount();
    });

    it('shows retry reconciliation only while reconciling and never live error-free pending', () => {
        const onRetryReconciliation = vi.fn();
        const { container, unmount } = renderPanel({
            state: baseState({
                lifecycle: 'reconciling',
                decision: 'IDLE',
                token: null,
                job_id: null,
                error: '会话对账失败，请重试对账。',
            }),
            onRetryReconciliation,
            onCancel: vi.fn(),
            onRetry: vi.fn(),
        });

        expect(container.querySelector('[data-testid="ai-preflight-retry-reconciliation"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="ai-preflight-cancel"]')).toBeNull();
        expect(container.querySelector('[data-testid="ai-preflight-retry"]')).toBeNull();
        expect(container.querySelector('[data-testid="ai-preflight-error"]')?.textContent)
            .toMatch(/对账/);
        expect(container.querySelector('[data-testid="ai-preflight-title"]')?.textContent)
            .toMatch(/对账中/);
        // Must not present acknowledgements as if still live PENDING.
        expect(container.querySelector('[data-testid="ai-preflight-acknowledgements"]')).toBeNull();

        act(() => {
            (container.querySelector('[data-testid="ai-preflight-retry-reconciliation"]') as HTMLButtonElement).click();
        });
        expect(onRetryReconciliation).toHaveBeenCalled();
        unmount();
    });

    it('shows retry after unavailable terminal failure', () => {
        const onRetry = vi.fn();
        const { container, unmount } = renderPanel({
            state: baseState({
                lifecycle: 'unavailable',
                decision: 'IDLE',
                token: null,
                job_id: null,
                error: '检查状态不可用。请重试发布前检查。',
            }),
            onRetry,
            onCancel: vi.fn(),
        });
        const retry = container.querySelector('[data-testid="ai-preflight-retry"]') as HTMLButtonElement;
        expect(retry).toBeTruthy();
        expect(retry.getAttribute('aria-label')).toBe('重试发布前检查');
        act(() => {
            retry.click();
        });
        expect(onRetry).toHaveBeenCalled();
        unmount();
    });

    it('vision disclosure shows select-all, use-selected, and text-only actions', () => {
        const onSelectAllVision = vi.fn();
        const onConfirmVisionSelection = vi.fn();
        const onContinueTextOnlyVision = vi.fn();
        const onToggleVisionSelection = vi.fn();
        const { container, unmount } = renderPanel({
            state: baseState({
                lifecycle: 'awaiting_vision',
                decision: 'PENDING',
                job_id: null,
                vision: {
                    status: 'needs_selection',
                    candidates: [
                        { url: 'https://cdn.example.test/a.jpg', source: 'poster' },
                        { url: 'https://cdn.example.test/b.jpg', source: 'markdown' },
                    ],
                    selectedUrls: ['https://cdn.example.test/a.jpg'],
                    maxImages: 5,
                    boundImages: [],
                    warnings: [],
                    error: null,
                },
            }),
            onSelectAllVision,
            onConfirmVisionSelection,
            onContinueTextOnlyVision,
            onToggleVisionSelection,
            onCancel: vi.fn(),
        });

        const disclosure = container.querySelector('[data-testid="ai-preflight-vision-disclosure"]');
        expect(disclosure?.textContent).toMatch(/候选图片 2 张/);
        expect(disclosure?.textContent).toMatch(/最多可选 5 张/);
        expect(disclosure?.textContent).toMatch(/AI 服务商/);

        const selectAll = container.querySelector(
            '[data-testid="ai-preflight-vision-select-all"]',
        ) as HTMLButtonElement;
        const useSelected = container.querySelector(
            '[data-testid="ai-preflight-vision-use-selected"]',
        ) as HTMLButtonElement;
        const textOnly = container.querySelector(
            '[data-testid="ai-preflight-vision-text-only"]',
        ) as HTMLButtonElement;
        expect(selectAll).toBeTruthy();
        expect(useSelected).toBeTruthy();
        expect(textOnly).toBeTruthy();
        expect(useSelected.disabled).toBe(false);

        act(() => {
            selectAll.click();
            useSelected.click();
            textOnly.click();
        });
        expect(onSelectAllVision).toHaveBeenCalled();
        expect(onConfirmVisionSelection).toHaveBeenCalled();
        expect(onContinueTextOnlyVision).toHaveBeenCalled();
        unmount();
    });
});
