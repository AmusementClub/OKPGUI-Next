import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiAcknowledgements,
    AiAuditResult,
    AiDecision,
    AiSettings,
    PublishRequestPayload,
    VisionPreflightState,
} from '../types/ai';
import {
    bindPlanVision,
    canPublishAudit,
    cancelAiJob,
    disabledAiSettings,
    getAiSettings,
    invalidatePublishPlan,
    isAiConfigured,
    listPlanVisionCandidates,
    pollFormalAudit,
    preparePublishPlan,
    readFriendlyError,
    setPlanAcknowledgements,
    startFormalAudit,
} from '../services/ai';

const idleVisionState: VisionPreflightState = {
    status: 'idle',
    candidates: [],
    selectedUrls: [],
    maxImages: 5,
    boundImages: [],
    warnings: [],
    error: null,
};

export interface AiPreflightState {
    settings: AiSettings;
    audit: AiAuditResult | null;
    decision: AiDecision | 'IDLE';
    acknowledgements: AiAcknowledgements;
    /** True when the latest non-GO acknowledgements are bound on the backend plan. */
    acknowledgementsBound: boolean;
    /**
     * True only while prepare_plan (and the immediate start-formal call) is in flight.
     * Background formal audit uses decision === 'PENDING' so the modal can open and
     * pending-ack confirm remains available.
     */
    checking: boolean;
    token: string | null;
    snapshot_hash: string | null;
    /** Backend formal-audit job id while PENDING; null for local/terminal decisions. */
    job_id: string | null;
    error: string | null;
    /** Shared plan-token Vision disclosure state (HomePage + QuickPublish). */
    vision: VisionPreflightState;
}

export interface AiPreflightPrepareResult {
    token: string;
    snapshotHash: string;
    audit: AiAuditResult;
    requestGeneration: number;
}

export const PREPARE_SUPERSEDED_CODE = 'PREPARE_SUPERSEDED';

export function isPrepareSupersededError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: string }).code === PREPARE_SUPERSEDED_CODE;
}

function createSupersededError(): Error {
    const error = new Error('发布前检查已被更新的请求取代。') as Error & { code: string };
    error.code = PREPARE_SUPERSEDED_CODE;
    return error;
}

const idleAcknowledgements: AiAcknowledgements = {
    warning: false,
    critical: false,
    pending: false,
};

const initialState: AiPreflightState = {
    settings: disabledAiSettings,
    audit: null,
    decision: 'IDLE',
    acknowledgements: idleAcknowledgements,
    acknowledgementsBound: true,
    checking: false,
    token: null,
    snapshot_hash: null,
    job_id: null,
    error: null,
    vision: { ...idleVisionState },
};

const FORMAL_POLL_INTERVAL_MS = 400;

function clearTokenSideEffects(token: string | null) {
    if (token) {
        void invalidatePublishPlan(token).catch(() => undefined);
    }
}

export function useAiPreflight() {
    const [state, setState] = useState<AiPreflightState>(initialState);
    const stateRef = useRef<AiPreflightState>(initialState);
    stateRef.current = state;
    const generationRef = useRef(0);
    const tokenRef = useRef<string | null>(null);
    const jobIdRef = useRef<string | null>(null);
    /** Current decision for publish-time cancel without relying on a stale callback closure. */
    const decisionRef = useRef<AiPreflightState['decision']>(initialState.decision);
    decisionRef.current = state.decision;
    /** When true, late poll/completion must not replace UI or re-bind a consumed plan. */
    const suppressAuditUpdatesRef = useRef(false);
    const disposedRef = useRef(false);
    const ackWriteRef = useRef(0);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current !== null) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    const clearActiveJob = useCallback(() => {
        stopPolling();
        jobIdRef.current = null;
    }, [stopPolling]);

    useEffect(() => {
        disposedRef.current = false;
        let disposed = false;
        void getAiSettings().then((settings) => {
            if (!disposed && !disposedRef.current) {
                setState((current) => ({ ...current, settings }));
            }
        });
        return () => {
            disposed = true;
            disposedRef.current = true;
            // Bump generation so any in-flight prepare/poll cannot commit after unmount.
            generationRef.current += 1;
            suppressAuditUpdatesRef.current = true;
            stopPolling();
            const jobId = jobIdRef.current;
            jobIdRef.current = null;
            if (jobId) {
                void cancelAiJob(jobId).catch(() => undefined);
            }
            const token = tokenRef.current;
            tokenRef.current = null;
            clearTokenSideEffects(token);
        };
    }, [stopPolling]);

    const applyTerminalAudit = useCallback((
        token: string,
        requestGeneration: number,
        auditBase: AiAuditResult,
        fallbackSnapshotHash: string,
    ) => {
        if (
            disposedRef.current
            || suppressAuditUpdatesRef.current
            || requestGeneration !== generationRef.current
            || tokenRef.current !== token
        ) {
            return;
        }

        const audit: AiAuditResult = {
            ...auditBase,
            plan_token: auditBase.plan_token ?? token,
            snapshot_hash: auditBase.snapshot_hash ?? fallbackSnapshotHash,
        };
        clearActiveJob();
        setState((current) => {
            if (current.token !== token) {
                return current;
            }
            return {
                ...current,
                checking: false,
                error: null,
                audit,
                decision: audit.decision,
                snapshot_hash: audit.snapshot_hash ?? fallbackSnapshotHash,
                job_id: audit.job_id ?? null,
                acknowledgements: { ...idleAcknowledgements },
                acknowledgementsBound: audit.decision === 'GO',
            };
        });
    }, [clearActiveJob]);

    const startFormalPolling = useCallback((
        token: string,
        jobId: string,
        requestGeneration: number,
        fallbackSnapshotHash: string,
    ) => {
        stopPolling();

        const tick = () => {
            if (
                disposedRef.current
                || suppressAuditUpdatesRef.current
                || requestGeneration !== generationRef.current
                || tokenRef.current !== token
                || jobIdRef.current !== jobId
            ) {
                return;
            }

            void pollFormalAudit(token, jobId)
                .then((result) => {
                    if (
                        disposedRef.current
                        || suppressAuditUpdatesRef.current
                        || requestGeneration !== generationRef.current
                        || tokenRef.current !== token
                        || jobIdRef.current !== jobId
                    ) {
                        return;
                    }
                    if (result) {
                        applyTerminalAudit(token, requestGeneration, result, fallbackSnapshotHash);
                        return;
                    }
                    // Still running — schedule next poll.
                    pollTimerRef.current = setTimeout(tick, FORMAL_POLL_INTERVAL_MS);
                })
                .catch(() => {
                    // Cancelled/stale/consumed: leave prepare-time PENDING, stop polling.
                    if (
                        disposedRef.current
                        || requestGeneration !== generationRef.current
                        || tokenRef.current !== token
                    ) {
                        return;
                    }
                    clearActiveJob();
                    setState((current) => (
                        current.token === token
                            ? { ...current, job_id: null }
                            : current
                    ));
                });
        };

        pollTimerRef.current = setTimeout(tick, FORMAL_POLL_INTERVAL_MS);
    }, [applyTerminalAudit, clearActiveJob, stopPolling]);

    const invalidate = useCallback(() => {
        // Cancel overlapping prepares/polls and drop their later commits.
        generationRef.current += 1;
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        const token = tokenRef.current;
        tokenRef.current = null;
        clearTokenSideEffects(token);
        setState((current) => ({
            ...current,
            audit: null,
            decision: 'IDLE',
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            checking: false,
            token: null,
            snapshot_hash: null,
            job_id: null,
            error: null,
            vision: { ...idleVisionState },
        }));
    }, [stopPolling]);

    const commitFormalAudit = useCallback((
        token: string,
        requestGeneration: number,
        auditBase: AiAuditResult,
        fallbackSnapshotHash: string,
        localBlockers: string[],
        vision: VisionPreflightState,
    ): AiPreflightPrepareResult => {
        const audit: AiAuditResult = {
            ...auditBase,
            local_blockers: auditBase.local_blockers ?? localBlockers,
            plan_token: auditBase.plan_token ?? token,
            snapshot_hash: auditBase.snapshot_hash ?? fallbackSnapshotHash,
        };

        tokenRef.current = token;
        const jobId = audit.job_id?.trim() ? audit.job_id : null;
        jobIdRef.current = audit.decision === 'PENDING' ? jobId : null;

        setState((current) => ({
            ...current,
            checking: false,
            error: null,
            audit,
            decision: audit.decision,
            token,
            snapshot_hash: audit.snapshot_hash ?? fallbackSnapshotHash,
            job_id: jobIdRef.current,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: audit.decision === 'GO',
            vision,
        }));

        if (audit.decision === 'PENDING' && jobIdRef.current) {
            startFormalPolling(
                token,
                jobIdRef.current,
                requestGeneration,
                audit.snapshot_hash ?? fallbackSnapshotHash,
            );
        }

        return {
            token,
            snapshotHash: audit.snapshot_hash ?? fallbackSnapshotHash,
            audit,
            requestGeneration,
        };
    }, [startFormalPolling]);

    const runFormalAfterVision = useCallback(async (
        token: string,
        requestGeneration: number,
        snapshotHash: string,
        localBlockers: string[],
        vision: VisionPreflightState,
    ): Promise<AiPreflightPrepareResult> => {
        const auditBase = await startFormalAudit({
            plan_token: token,
        });
        if (requestGeneration !== generationRef.current) {
            if (auditBase.job_id) {
                void cancelAiJob(auditBase.job_id).catch(() => undefined);
            }
            throw createSupersededError();
        }
        return commitFormalAudit(
            token,
            requestGeneration,
            auditBase,
            auditBase.snapshot_hash ?? snapshotHash,
            localBlockers,
            vision,
        );
    }, [commitFormalAudit]);

    const prepare = useCallback(async (
        request: PublishRequestPayload,
        localBlockers: string[] = [],
    ): Promise<AiPreflightPrepareResult> => {
        // Drop any previous token/job before starting a new generation.
        const previousJobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        if (previousJobId) {
            void cancelAiJob(previousJobId).catch(() => undefined);
        }
        const previousToken = tokenRef.current;
        tokenRef.current = null;
        clearTokenSideEffects(previousToken);

        const requestGeneration = ++generationRef.current;
        suppressAuditUpdatesRef.current = false;
        setState((current) => ({
            ...current,
            checking: true,
            error: null,
            decision: 'PENDING',
            audit: null,
            token: null,
            snapshot_hash: null,
            job_id: null,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            vision: { ...idleVisionState, status: 'listing' },
        }));

        // Track the prepared token so any failure / non-commit path can invalidate it.
        let preparedToken: string | null = null;
        try {
            const prepared = await preparePublishPlan(request, requestGeneration);
            preparedToken = prepared.token;
            if (requestGeneration !== generationRef.current) {
                clearTokenSideEffects(preparedToken);
                preparedToken = null;
                throw createSupersededError();
            }

            const token = prepared.token;
            // Backend-authoritative snapshot hash — never computed on the client.
            let nextSnapshotHash = prepared.snapshot_hash;
            if (!nextSnapshotHash?.trim()) {
                clearTokenSideEffects(token);
                preparedToken = null;
                throw new Error('发布前检查未返回有效快照标识，请重试。');
            }

            // Client localBlockers are not merged into the formal result when the backend
            // returns local_blockers (plan-token blockers are authoritative).
            void localBlockers;

            // AI-disabled / unconfigured: skip Vision entirely (zero image/network side effects).
            const settings = await getAiSettings();
            if (requestGeneration !== generationRef.current) {
                clearTokenSideEffects(token);
                preparedToken = null;
                throw createSupersededError();
            }

            let vision: VisionPreflightState = {
                ...idleVisionState,
                status: 'skipped',
            };

            if (isAiConfigured(settings)) {
                // Plan-token Vision: list candidates from bound final content only.
                let listed;
                try {
                    listed = await listPlanVisionCandidates(token);
                } catch {
                    // Listing failure must not invent images; continue text-only formal audit.
                    listed = null;
                }
                if (requestGeneration !== generationRef.current) {
                    clearTokenSideEffects(token);
                    preparedToken = null;
                    throw createSupersededError();
                }

                if (listed && listed.requires_selection) {
                    // Explicit selection required — do not silently choose the first five.
                    preparedToken = null;
                    tokenRef.current = token;
                    vision = {
                        status: 'needs_selection',
                        candidates: listed.candidates,
                        selectedUrls: [],
                        maxImages: listed.max_images ?? 5,
                        boundImages: [],
                        warnings: [],
                        error: null,
                    };
                    setState((current) => ({
                        ...current,
                        checking: false,
                        error: null,
                        audit: null,
                        decision: 'PENDING',
                        token,
                        snapshot_hash: listed.snapshot_hash || nextSnapshotHash,
                        job_id: null,
                        acknowledgements: { ...idleAcknowledgements },
                        acknowledgementsBound: false,
                        vision,
                    }));
                    return {
                        token,
                        snapshotHash: listed.snapshot_hash || nextSnapshotHash,
                        audit: {
                            decision: 'PENDING',
                            findings: [],
                            unknown_codes: [],
                            local_blockers: prepared.local_blockers,
                            formal_ran: false,
                            job_id: null,
                            plan_token: token,
                            snapshot_hash: listed.snapshot_hash || nextSnapshotHash,
                            request_generation: requestGeneration,
                        },
                        requestGeneration,
                    };
                }

                const candidateUrls = (listed?.candidates ?? []).map((item) => item.url);
                if (candidateUrls.length > 0) {
                    setState((current) => ({
                        ...current,
                        vision: {
                            ...idleVisionState,
                            status: 'binding',
                            candidates: listed?.candidates ?? [],
                            selectedUrls: candidateUrls,
                            maxImages: listed?.max_images ?? 5,
                        },
                    }));
                    try {
                        const bound = await bindPlanVision({
                            plan_token: token,
                            selected_urls: candidateUrls,
                        });
                        if (requestGeneration !== generationRef.current) {
                            clearTokenSideEffects(token);
                            preparedToken = null;
                            throw createSupersededError();
                        }
                        if (bound.snapshot_hash?.trim()) {
                            nextSnapshotHash = bound.snapshot_hash;
                        }
                        vision = {
                            status: 'bound',
                            candidates: listed?.candidates ?? [],
                            selectedUrls: candidateUrls,
                            maxImages: listed?.max_images ?? 5,
                            boundImages: bound.images ?? [],
                            warnings: bound.warnings ?? [],
                            error: null,
                        };
                    } catch (visionError) {
                        if (requestGeneration !== generationRef.current) {
                            clearTokenSideEffects(token);
                            preparedToken = null;
                            throw createSupersededError();
                        }
                        // Soft-fail Vision: continue text formal audit without mutating UI to error.
                        vision = {
                            status: 'failed',
                            candidates: listed?.candidates ?? [],
                            selectedUrls: candidateUrls,
                            maxImages: listed?.max_images ?? 5,
                            boundImages: [],
                            warnings: [],
                            error: readFriendlyError(visionError, '图片检查未能完成，将继续文本审核。'),
                        };
                    }
                } else {
                    vision = {
                        ...idleVisionState,
                        status: 'bound',
                        candidates: listed?.candidates ?? [],
                        maxImages: listed?.max_images ?? 5,
                    };
                }
            }

            // Start formal audit with plan_token only after Vision bind (or skip).
            // Keep the token armed until the audit has committed so a start failure
            // still invalidates the prepared plan in the catch path.
            const result = await runFormalAfterVision(
                token,
                requestGeneration,
                nextSnapshotHash,
                prepared.local_blockers,
                vision,
            );
            preparedToken = null;
            return result;
        } catch (error) {
            // Failed or uncommitted preflight must not leave a publishable orphan token.
            if (preparedToken) {
                clearTokenSideEffects(preparedToken);
                preparedToken = null;
            }
            // Superseded prepares must not clobber a newer generation's state or surface a false error.
            if (requestGeneration === generationRef.current && !isPrepareSupersededError(error)) {
                tokenRef.current = null;
                jobIdRef.current = null;
                stopPolling();
                setState((current) => ({
                    ...current,
                    checking: false,
                    audit: null,
                    decision: 'IDLE',
                    token: null,
                    snapshot_hash: null,
                    job_id: null,
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    error: readFriendlyError(error, '无法准备发布前检查。'),
                    vision: { ...idleVisionState },
                }));
            }
            throw error;
        }
    }, [runFormalAfterVision, stopPolling]);

    /**
     * Toggle a Vision candidate URL for explicit over-cap selection.
     * Never auto-fills beyond maxImages; user must choose up to the cap.
     */
    const toggleVisionSelection = useCallback((url: string) => {
        setState((current) => {
            if (current.vision.status !== 'needs_selection') {
                return current;
            }
            const exists = current.vision.selectedUrls.includes(url);
            let selectedUrls: string[];
            if (exists) {
                selectedUrls = current.vision.selectedUrls.filter((item) => item !== url);
            } else if (current.vision.selectedUrls.length >= current.vision.maxImages) {
                // Do not silently replace or exceed the cap.
                return current;
            } else {
                selectedUrls = [...current.vision.selectedUrls, url];
            }
            return {
                ...current,
                vision: {
                    ...current.vision,
                    selectedUrls,
                    error: null,
                },
            };
        });
    }, []);

    /**
     * After the user picks ≤5 images, bind them to the plan token and start formal audit.
     * Generation-guarded so stale selections cannot publish a drifted plan.
     */
    const confirmVisionSelection = useCallback(async (): Promise<void> => {
        const requestGeneration = generationRef.current;
        const token = tokenRef.current;

        const current = stateRef.current;
        if (
            !token
            || current.vision.status !== 'needs_selection'
            || !current.token
            || current.token !== token
        ) {
            return;
        }
        const selection: {
            urls: string[];
            maxImages: number;
            candidates: VisionPreflightState['candidates'];
            fallbackHash: string;
        } = {
            urls: [...current.vision.selectedUrls],
            maxImages: current.vision.maxImages,
            candidates: current.vision.candidates,
            fallbackHash: current.snapshot_hash ?? '',
        };
        setState((current) => {
            if (
                current.vision.status !== 'needs_selection'
                || !current.token
                || current.token !== token
            ) {
                return current;
            }
            return {
                ...current,
                checking: true,
                vision: {
                    ...current.vision,
                    status: 'binding',
                    error: null,
                },
            };
        });

        if (!token || !selection) {
            return;
        }
        const { urls, maxImages, candidates, fallbackHash } = selection;

        if (urls.length === 0 || urls.length > maxImages) {
            setState((current) => (
                current.token === token
                    ? {
                        ...current,
                        checking: false,
                        vision: {
                            ...current.vision,
                            status: 'needs_selection',
                            error: `请明确选择 1–${maxImages} 张图片后再继续。`,
                        },
                    }
                    : current
            ));
            return;
        }

        try {
            const bound = await bindPlanVision({
                plan_token: token,
                selected_urls: urls,
            });
            if (
                requestGeneration !== generationRef.current
                || tokenRef.current !== token
            ) {
                clearTokenSideEffects(token);
                throw createSupersededError();
            }
            const vision: VisionPreflightState = {
                status: 'bound',
                candidates,
                selectedUrls: urls,
                maxImages,
                boundImages: bound.images ?? [],
                warnings: bound.warnings ?? [],
                error: null,
            };
            await runFormalAfterVision(
                token,
                requestGeneration,
                bound.snapshot_hash || fallbackHash,
                [],
                vision,
            );
        } catch (error) {
            if (isPrepareSupersededError(error)) {
                return;
            }
            if (requestGeneration !== generationRef.current || tokenRef.current !== token) {
                return;
            }
            setState((current) => (
                current.token === token
                    ? {
                        ...current,
                        checking: false,
                        vision: {
                            ...current.vision,
                            status: 'needs_selection',
                            error: readFriendlyError(error, '无法绑定所选图片，请重试。'),
                        },
                    }
                    : current
            ));
        }
    }, [runFormalAfterVision]);

    /**
     * When confirm is clicked while formal audit is still PENDING and pending ack is bound,
     * cooperatively cancel the backend job before publishing the already-frozen plan.
     * Late completion must not replace UI after this point.
     */
    const cancelPendingAuditForPublish = useCallback(async (): Promise<void> => {
        const jobId = jobIdRef.current;
        // Read through a ref so a stale callback closure cannot skip cancellation.
        const decision = decisionRef.current;
        if (decision !== 'PENDING' || !jobId) {
            // Still suppress late polls once publish begins for this token.
            if (decision === 'PENDING') {
                suppressAuditUpdatesRef.current = true;
                stopPolling();
            }
            return;
        }
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        jobIdRef.current = null;
        try {
            await cancelAiJob(jobId);
        } catch {
            // Job may already be terminal; publish still uses prepare-time PENDING + ack.
        }
        setState((current) => (
            current.job_id === jobId || current.decision === 'PENDING'
                ? { ...current, job_id: null }
                : current
        ));
    }, [stopPolling]);

    const setAcknowledgement = useCallback((key: keyof AiAcknowledgements, checked: boolean) => {
        setState((current) => {
            const acknowledgements = { ...current.acknowledgements, [key]: checked };
            const token = current.token;
            // Persist acks on the backend plan so publish never trusts caller-only checkboxes.
            if (token) {
                const writeId = ++ackWriteRef.current;
                void setPlanAcknowledgements(token, acknowledgements)
                    .then(() => {
                        if (ackWriteRef.current !== writeId || disposedRef.current) {
                            return;
                        }
                        setState((latest) => (
                            latest.token === token
                                ? { ...latest, acknowledgementsBound: true }
                                : latest
                        ));
                    })
                    .catch(() => {
                        if (ackWriteRef.current !== writeId || disposedRef.current) {
                            return;
                        }
                        setState((latest) => (
                            latest.token === token
                                ? { ...latest, acknowledgementsBound: false }
                                : latest
                        ));
                    });
            }
            return {
                ...current,
                acknowledgements,
                // Non-GO decisions require a successful backend bind before confirm.
                acknowledgementsBound: token ? false : true,
            };
        });
    }, []);

    const decision = state.decision;
    const needsBoundAcks = decision === 'WARNING'
        || decision === 'NO_GO'
        || decision === 'PENDING';
    const visionBlocksConfirm = state.vision.status === 'needs_selection'
        || state.vision.status === 'binding'
        || state.vision.status === 'listing';
    // checking is only true during prepare/start — PENDING background audit still allows confirm.
    // Vision over-cap selection must complete before confirm (no silent first-five).
    const canConfirm = !state.checking
        && !state.error
        && !visionBlocksConfirm
        && Boolean(state.token)
        && Boolean(state.snapshot_hash)
        && decision !== 'IDLE'
        && decision !== 'LOCAL_BLOCKED'
        && canPublishAudit(decision as AiDecision, state.acknowledgements)
        && (!needsBoundAcks || state.acknowledgementsBound);

    return {
        state,
        isConfigured: isAiConfigured(state.settings),
        prepare,
        invalidate,
        setAcknowledgement,
        cancelPendingAuditForPublish,
        toggleVisionSelection,
        confirmVisionSelection,
        canConfirm,
    };
}
