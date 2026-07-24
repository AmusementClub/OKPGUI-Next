import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveAiJobStatusStrip from './ActiveAiJobStatusStrip';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
const listenMock = vi.fn(async (_event?: string, _handler?: unknown) => () => undefined);

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, handler: unknown) => listenMock(event, handler),
}));

describe('ActiveAiJobStatusStrip', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        invokeMock.mockReset();
        listenMock.mockClear();
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_list_active_jobs') {
                return Promise.resolve([
                    {
                        job_id: 'job-audit-1',
                        kind: 'audit',
                        stage: '发布前检查',
                        progress: 40,
                        cancellable: true,
                        navigation_target: null,
                        started_at_unix: 100,
                    },
                    {
                        job_id: 'job-tpl-1',
                        kind: 'template_selection',
                        stage: '自动选模板',
                        progress: 20,
                        cancellable: true,
                        navigation_target: 'auto_template',
                        started_at_unix: 110,
                    },
                ]);
            }
            if (command === 'ai_cancel_active_job') {
                return Promise.resolve({
                    job_id: 'job-audit-1',
                    kind: 'audit',
                    job_state: 'cancelled',
                    used_preflight_session: true,
                    reconciled: true,
                });
            }
            return Promise.reject(`unexpected ${command}`);
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('lists active jobs from sanitized projection and cancels via ai_cancel_active_job', async () => {
        await act(async () => {
            root.render(<ActiveAiJobStatusStrip />);
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(container.querySelector('[data-testid="active-ai-job-status-strip"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="active-ai-job-job-audit-1"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="active-ai-job-job-tpl-1"]')).toBeTruthy();

        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[data-testid="active-ai-job-cancel-job-audit-1"]')
                ?.click();
            await Promise.resolve();
            await Promise.resolve();
        });

        const cancelCalls = invokeMock.mock.calls.filter(
            ([command]) => command === 'ai_cancel_active_job',
        );
        expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
        expect(cancelCalls[0][1]).toEqual({ jobId: 'job-audit-1' });
        // Negative: Audit strip-cancel cannot use job-only path.
        expect(invokeMock.mock.calls.some(([command]) => command === 'ai_cancel_job')).toBe(false);
        expect(invokeMock.mock.calls.some(([command]) => command === 'ai_list_jobs')).toBe(false);
    });

    it('offers navigation when navigation_target is present', async () => {
        const navigate = vi.fn();
        const onNavigate = (event: Event) => {
            navigate((event as CustomEvent).detail);
        };
        window.addEventListener('okpgui:navigate', onNavigate);
        await act(async () => {
            root.render(<ActiveAiJobStatusStrip />);
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        act(() => {
            container
                .querySelector<HTMLButtonElement>('[data-testid="active-ai-job-nav-job-tpl-1"]')
                ?.click();
        });
        expect(navigate).toHaveBeenCalledWith('auto_template');
        window.removeEventListener('okpgui:navigate', onNavigate);
    });
});
