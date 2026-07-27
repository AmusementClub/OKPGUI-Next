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
        ...overrides,
    };
}

function renderPanel(props: {
    state: AiPreflightState;
    canConfirm?: boolean;
    onCancel?: () => void;
    onRetry?: () => void;
    onRetryReconciliation?: () => void;
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

    it('shows the provider audit description for a terminal result', () => {
        const description = '标题、视频 MediaInfo 与种子文件信息符合预期。';
        const { container, unmount } = renderPanel({
            state: baseState({
                decision: 'GO',
                lifecycle: 'terminal',
                job_id: null,
                audit: {
                    decision: 'GO',
                    description,
                    findings: [],
                    unknown_codes: [],
                    formal_ran: true,
                    plan_token: 'plan-token',
                    snapshot_hash: 'sha256:x',
                    request_generation: 1,
                },
            }),
            canConfirm: true,
        });

        const summary = container.querySelector('[data-testid="ai-preflight-description"]');
        expect(summary?.textContent).toContain('AI 审核说明');
        expect(summary?.textContent).toContain(description);
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

});
