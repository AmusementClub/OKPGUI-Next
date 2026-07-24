import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAuditResult, CancelPreflightSessionResult, PublishRequestPayload } from '../types/ai';
import {
    isPrepareReconcilingError,
    useAiPreflight,
} from './useAiPreflight';

const {
    getAiSettingsMock,
    preparePublishPlanMock,
    startFormalAuditMock,
    pollFormalAuditMock,
    cancelPreflightSessionMock,
    cancelAiJobMock,
    invalidatePublishPlanMock,
    listPlanVisionCandidatesMock,
    bindPlanVisionMock,
    setPlanAcknowledgementsMock,
    subscribePreflightSessionChangedMock,
} = vi.hoisted(() => ({
    getAiSettingsMock: vi.fn(),
    preparePublishPlanMock: vi.fn(),
    startFormalAuditMock: vi.fn(),
    pollFormalAuditMock: vi.fn(),
    cancelPreflightSessionMock: vi.fn(),
    cancelAiJobMock: vi.fn(),
    invalidatePublishPlanMock: vi.fn(),
    listPlanVisionCandidatesMock: vi.fn(),
    bindPlanVisionMock: vi.fn(),
    setPlanAcknowledgementsMock: vi.fn(),
    subscribePreflightSessionChangedMock: vi.fn(),
}));

vi.mock('../services/ai', async () => {
    const actual = await vi.importActual<typeof import('../services/ai')>('../services/ai');
    return {
        ...actual,
        getAiSettings: getAiSettingsMock,
        preparePublishPlan: preparePublishPlanMock,
        startFormalAudit: startFormalAuditMock,
        pollFormalAudit: pollFormalAuditMock,
        cancelPreflightSession: cancelPreflightSessionMock,
        cancelAiJob: cancelAiJobMock,
        invalidatePublishPlan: invalidatePublishPlanMock,
        listPlanVisionCandidates: listPlanVisionCandidatesMock,
        bindPlanVision: bindPlanVisionMock,
        setPlanAcknowledgements: setPlanAcknowledgementsMock,
        subscribePreflightSessionChanged: subscribePreflightSessionChangedMock,
    };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type PreflightHook = ReturnType<typeof useAiPreflight>;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function renderHook() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let current!: PreflightHook;

    const Probe = () => {
        current = useAiPreflight();
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

const emptyHistoryEntry = {
    last_published_at: '',
    last_published_episode: '',
    last_published_resolution: '',
};

const sampleRequest: PublishRequestPayload = {
    publish_id: 'pub-1',
    torrent_path: '/tmp/a.torrent',
    profile_name: 'profile',
    template: {
        ep_pattern: '',
        resolution_pattern: '',
        title_pattern: '',
        poster: '',
        about: '',
        tags: '',
        description: 'Desc',
        description_html: '',
        profile: 'profile',
        title: 'Title',
        publish_history: {
            dmhy: emptyHistoryEntry,
            nyaa: emptyHistoryEntry,
            acgrip: emptyHistoryEntry,
            bangumi: emptyHistoryEntry,
            acgnx_asia: emptyHistoryEntry,
            acgnx_global: emptyHistoryEntry,
        },
        sites: {
            dmhy: false,
            nyaa: false,
            acgrip: false,
            bangumi: false,
            acgnx_asia: false,
            acgnx_global: false,
        },
    },
};

function pendingAudit(overrides: Partial<AiAuditResult> = {}): AiAuditResult {
    return {
        decision: 'PENDING',
        findings: [],
        unknown_codes: [],
        local_blockers: [],
        formal_ran: false,
        job_id: 'job-audit-1',
        plan_token: 'plan-token-1',
        snapshot_hash: 'sha256:snap',
        request_generation: 1,
        ...overrides,
    };
}

function cancelResult(
    overrides: Partial<CancelPreflightSessionResult> = {},
): CancelPreflightSessionResult {
    return {
        job_state: 'cancelled',
        token_state: 'invalidated',
        reconciled: true,
        ...overrides,
    };
}

describe('useAiPreflight', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        getAiSettingsMock.mockResolvedValue({
            provider: 'open_ai',
            endpoint: 'https://api.example.test/v1',
            model: 'gpt-test',
            mode: 'auto',
            auth_mode: 'none',
            custom_header_name: null,
            credential_ref: null,
            enabled: true,
            capability: null,
            discovered_models: [],
            models_fetched_at_unix: null,
        });
        preparePublishPlanMock.mockResolvedValue({
            token: 'plan-token-1',
            snapshot_hash: 'sha256:snap',
            request_generation: 1,
            local_blockers: [],
            has_blockers: false,
        });
        startFormalAuditMock.mockResolvedValue(pendingAudit());
        pollFormalAuditMock.mockResolvedValue(null);
        cancelPreflightSessionMock.mockResolvedValue(cancelResult());
        cancelAiJobMock.mockResolvedValue({
            id: 'job-audit-1',
            kind: 'audit',
            state: 'cancelled',
            request_generation: 1,
            snapshot_hash: 'sha256:snap',
            progress: 100,
        });
        invalidatePublishPlanMock.mockResolvedValue(undefined);
        listPlanVisionCandidatesMock.mockResolvedValue({
            plan_token: 'plan-token-1',
            snapshot_hash: 'sha256:snap',
            request_generation: 1,
            candidates: [],
            requires_selection: false,
            max_images: 5,
        });
        bindPlanVisionMock.mockResolvedValue({
            plan_token: 'plan-token-1',
            snapshot_hash: 'sha256:snap',
            request_generation: 1,
            batch_hash: 'sha256:batch',
            images: [],
            warnings: [],
        });
        setPlanAcknowledgementsMock.mockResolvedValue(undefined);
        subscribePreflightSessionChangedMock.mockResolvedValue(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('starts formal audit and enters auditing lifecycle', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        expect(hook.result.state.lifecycle).toBe('auditing');
        expect(hook.result.state.decision).toBe('PENDING');
        expect(hook.result.state.token).toBe('plan-token-1');
        expect(hook.result.state.job_id).toBe('job-audit-1');
        hook.unmount();
    });

    it('poll transport failure enters reconciling then unavailable after reconcile', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        pollFormalAuditMock.mockRejectedValueOnce(new Error('ipc transport lost'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(cancelPreflightSessionMock).toHaveBeenCalledWith('plan-token-1', 'job-audit-1');
        expect(hook.result.state.lifecycle).toBe('unavailable');
        expect(hook.result.canConfirm).toBe(false);
        expect(hook.result.state.acknowledgements.pending).toBe(false);
        expect(hook.result.state.error).toBeTruthy();
        hook.unmount();
    });

    it('cancel invalidates generation and ends in cancelled when reconciled', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        let ok = false;
        await act(async () => {
            ok = await hook.result.cancel();
        });

        expect(ok).toBe(true);
        expect(cancelPreflightSessionMock).toHaveBeenCalledWith('plan-token-1', 'job-audit-1');
        expect(hook.result.state.lifecycle).toBe('cancelled');
        expect(hook.result.canConfirm).toBe(false);
        expect(hook.result.state.token).toBeNull();
        hook.unmount();
    });

    it('stays reconciling when cancel IPC fails and only retry reconciliation is viable', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        cancelPreflightSessionMock.mockRejectedValueOnce(new Error('cancel ipc failed'));

        await act(async () => {
            await hook.result.cancel();
        });

        expect(hook.result.state.lifecycle).toBe('reconciling');
        expect(hook.result.canConfirm).toBe(false);

        await act(async () => {
            await expect(hook.result.prepare(sampleRequest)).rejects.toSatisfy(isPrepareReconcilingError);
        });

        cancelPreflightSessionMock.mockResolvedValueOnce(cancelResult());
        let reconciled = false;
        await act(async () => {
            reconciled = await hook.result.retryReconciliation();
        });
        expect(reconciled).toBe(true);
        expect(hook.result.state.lifecycle).toBe('unavailable');
        hook.unmount();
    });

    it('retry is refused while reconciling and prepare reconciles prior session first', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        // Force reconciling without finishing.
        cancelPreflightSessionMock.mockRejectedValueOnce(new Error('still down'));
        await act(async () => {
            await hook.result.cancel();
        });
        expect(hook.result.state.lifecycle).toBe('reconciling');

        await act(async () => {
            const retryResult = await hook.result.retry();
            expect(retryResult).toBeNull();
        });
        expect(hook.result.state.error).toMatch(/对账/);

        cancelPreflightSessionMock.mockResolvedValue(cancelResult());
        await act(async () => {
            await hook.result.retryReconciliation();
        });

        preparePublishPlanMock.mockResolvedValue({
            token: 'plan-token-2',
            snapshot_hash: 'sha256:snap2',
            request_generation: 2,
            local_blockers: [],
            has_blockers: false,
        });
        startFormalAuditMock.mockResolvedValue(pendingAudit({
            job_id: 'job-audit-2',
            plan_token: 'plan-token-2',
            snapshot_hash: 'sha256:snap2',
            request_generation: 2,
        }));

        await act(async () => {
            await hook.result.retry();
        });

        expect(preparePublishPlanMock).toHaveBeenCalled();
        expect(hook.result.state.token).toBe('plan-token-2');
        hook.unmount();
    });

    it('prepare retained-session guard reconciles prior live token before prepare_plan', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });
        expect(preparePublishPlanMock).toHaveBeenCalledTimes(1);

        preparePublishPlanMock.mockResolvedValue({
            token: 'plan-token-2',
            snapshot_hash: 'sha256:snap2',
            request_generation: 2,
            local_blockers: [],
            has_blockers: false,
        });
        startFormalAuditMock.mockResolvedValue(pendingAudit({
            job_id: 'job-2',
            plan_token: 'plan-token-2',
            snapshot_hash: 'sha256:snap2',
        }));

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        expect(cancelPreflightSessionMock).toHaveBeenCalledWith('plan-token-1', 'job-audit-1');
        expect(preparePublishPlanMock).toHaveBeenCalledTimes(2);
        expect(hook.result.state.token).toBe('plan-token-2');
        hook.unmount();
    });

    it('unavailable cannot inherit pending acknowledgement for canConfirm', async () => {
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        await act(async () => {
            hook.result.setAcknowledgement('pending', true);
        });

        // Simulate ack bound.
        await act(async () => {
            // acknowledgementsBound flips async via mock
            await Promise.resolve();
        });

        pollFormalAuditMock.mockRejectedValueOnce(new Error('gone'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.result.state.lifecycle).toBe('unavailable');
        expect(hook.result.state.acknowledgements.pending).toBe(false);
        expect(hook.result.canConfirm).toBe(false);
        hook.unmount();
    });

    it('late terminal poll is ignored after cancel generation bump', async () => {
        const pollGate = deferred<AiAuditResult | null>();
        pollFormalAuditMock.mockReturnValueOnce(pollGate.promise);

        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });

        await act(async () => {
            await hook.result.cancel();
        });

        await act(async () => {
            pollGate.resolve({
                decision: 'GO',
                findings: [],
                unknown_codes: [],
                formal_ran: true,
                job_id: 'job-audit-1',
                plan_token: 'plan-token-1',
                snapshot_hash: 'sha256:snap',
                request_generation: 1,
            });
            await Promise.resolve();
        });

        expect(hook.result.state.lifecycle).toBe('cancelled');
        expect(hook.result.state.decision).not.toBe('GO');
        expect(hook.result.canConfirm).toBe(false);
        hook.unmount();
    });

    function visionCandidates(count: number, requiresSelection = count > 5) {
        return {
            plan_token: 'plan-token-1',
            snapshot_hash: 'sha256:snap',
            request_generation: 1,
            candidates: Array.from({ length: count }, (_, index) => ({
                url: `https://cdn.example.test/img-${index}.jpg`,
                source: index % 2 === 0 ? 'poster' : 'markdown',
            })),
            requires_selection: requiresSelection,
            max_images: 5,
        };
    }

    it('under-cap candidates require consent and never auto-bind', async () => {
        listPlanVisionCandidatesMock.mockResolvedValueOnce(visionCandidates(3, false));
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        expect(hook.result.state.lifecycle).toBe('awaiting_vision');
        expect(hook.result.state.vision.status).toBe('needs_selection');
        expect(hook.result.state.vision.candidates).toHaveLength(3);
        expect(hook.result.state.vision.selectedUrls).toEqual([]);
        expect(bindPlanVisionMock).not.toHaveBeenCalled();
        expect(startFormalAuditMock).not.toHaveBeenCalled();
        expect(hook.result.canConfirm).toBe(false);
        hook.unmount();
    });

    it('select all then confirm binds only the selected URLs', async () => {
        listPlanVisionCandidatesMock.mockResolvedValueOnce(visionCandidates(3, false));
        bindPlanVisionMock.mockResolvedValueOnce({
            plan_token: 'plan-token-1',
            snapshot_hash: 'sha256:post-vision',
            request_generation: 1,
            batch_hash: 'sha256:batch',
            images: [
                {
                    source: 'poster',
                    content_hash: 'sha256:a',
                    mime_type: 'image/jpeg',
                    normalized_bytes: 10,
                    width: 1,
                    height: 1,
                },
            ],
            warnings: [],
        });
        startFormalAuditMock.mockResolvedValueOnce(pendingAudit({
            decision: 'GO',
            formal_ran: true,
            job_id: null,
            snapshot_hash: 'sha256:post-vision',
        }));

        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });
        expect(bindPlanVisionMock).not.toHaveBeenCalled();

        await act(async () => {
            hook.result.selectAllVisionCandidates();
        });
        expect(hook.result.state.vision.selectedUrls).toHaveLength(3);

        await act(async () => {
            await hook.result.confirmVisionSelection();
        });

        expect(bindPlanVisionMock).toHaveBeenCalledTimes(1);
        expect(bindPlanVisionMock).toHaveBeenCalledWith({
            plan_token: 'plan-token-1',
            selected_urls: [
                'https://cdn.example.test/img-0.jpg',
                'https://cdn.example.test/img-1.jpg',
                'https://cdn.example.test/img-2.jpg',
            ],
        });
        expect(startFormalAuditMock).toHaveBeenCalledTimes(1);
        expect(hook.result.state.vision.status).toBe('bound');
        expect(hook.result.state.lifecycle).toBe('terminal');
        hook.unmount();
    });

    it('text-only continues formal audit without bind and records skipped vision', async () => {
        listPlanVisionCandidatesMock.mockResolvedValueOnce(visionCandidates(2, false));
        startFormalAuditMock.mockResolvedValueOnce(pendingAudit({
            decision: 'GO',
            formal_ran: true,
            job_id: null,
        }));

        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });
        expect(hook.result.state.vision.status).toBe('needs_selection');

        await act(async () => {
            await hook.result.continueTextOnlyVision();
        });

        expect(bindPlanVisionMock).not.toHaveBeenCalled();
        expect(startFormalAuditMock).toHaveBeenCalledTimes(1);
        expect(startFormalAuditMock).toHaveBeenCalledWith({ plan_token: 'plan-token-1' });
        expect(hook.result.state.vision.status).toBe('skipped');
        expect(hook.result.state.vision.boundImages).toEqual([]);
        expect(hook.result.state.vision.selectedUrls).toEqual([]);
        expect(hook.result.state.vision.warnings.some((item) => item.includes('仅文本'))).toBe(true);
        expect(hook.result.state.lifecycle).toBe('terminal');
        hook.unmount();
    });

    it('over-cap candidates still require selection of at most max images', async () => {
        listPlanVisionCandidatesMock.mockResolvedValueOnce(visionCandidates(6, true));
        const hook = renderHook();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await hook.result.prepare(sampleRequest);
        });

        expect(hook.result.state.vision.status).toBe('needs_selection');
        expect(hook.result.state.vision.candidates).toHaveLength(6);
        expect(bindPlanVisionMock).not.toHaveBeenCalled();
        expect(startFormalAuditMock).not.toHaveBeenCalled();

        await act(async () => {
            hook.result.selectAllVisionCandidates();
        });
        expect(hook.result.state.vision.selectedUrls).toHaveLength(5);
        expect(hook.result.state.vision.selectedUrls).not.toContain(
            'https://cdn.example.test/img-5.jpg',
        );

        // Sixth toggle must not exceed the cap.
        await act(async () => {
            hook.result.toggleVisionSelection('https://cdn.example.test/img-5.jpg');
        });
        expect(hook.result.state.vision.selectedUrls).toHaveLength(5);
        expect(hook.result.state.vision.selectedUrls).not.toContain(
            'https://cdn.example.test/img-5.jpg',
        );
        hook.unmount();
    });
});
