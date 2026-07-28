import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiAcknowledgements,
    AiAuditResult,
    AiDecision,
    AiPreflightLifecycle,
    AiSettings,
    CancelPreflightSessionResult,
    PreflightSessionChangedPayload,
    PublishRequestPayload,
} from '../types/ai';
import {
    canPublishAudit,
    cancelAiJob,
    cancelPendingAuditForPublish as cancelPendingAuditForPublishIpc,
    cancelPreflightSession,
    disabledAiSettings,
    getAiSettings,
    invalidatePublishPlan,
    isAiConfigured,
    pollFormalAudit,
    pollPlanMediaInfo,
    preparePublishPlan,
    readFriendlyError,
    setPlanAcknowledgements,
    startFormalAudit,
    startPlanMediaInfo,
    subscribePreflightSessionChanged,
} from '../services/ai';

export interface AiPreflightState {
    settings: AiSettings;
    audit: AiAuditResult | null;
    decision: AiDecision | 'IDLE';
    /**
     * Explicit frontend audit lifecycle, separate from the authoritative decision.
     * `reconciling` always forces canConfirm=false until Rust returns reconciled=true.
     */
    lifecycle: AiPreflightLifecycle;
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
}

export interface AiPreflightPrepareResult {
    token: string;
    snapshotHash: string;
    audit: AiAuditResult;
    requestGeneration: number;
}

export const PREPARE_SUPERSEDED_CODE = 'PREPARE_SUPERSEDED';
export const PREPARE_RECONCILING_CODE = 'PREPARE_RECONCILING';

export function isPrepareSupersededError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: string }).code === PREPARE_SUPERSEDED_CODE;
}

export function isPrepareReconcilingError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: string }).code === PREPARE_RECONCILING_CODE;
}

function createSupersededError(): Error {
    const error = new Error('发布前检查已被更新的请求取代。') as Error & { code: string };
    error.code = PREPARE_SUPERSEDED_CODE;
    return error;
}

function createReconcilingError(message?: string): Error {
    const error = new Error(message ?? '先前的发布前检查会话尚未对账完成，请先完成对账。') as Error & {
        code: string;
    };
    error.code = PREPARE_RECONCILING_CODE;
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
    lifecycle: 'idle',
    acknowledgements: idleAcknowledgements,
    acknowledgementsBound: true,
    checking: false,
    token: null,
    snapshot_hash: null,
    job_id: null,
    error: null,
};

const FORMAL_POLL_INTERVAL_MS = 400;

function clearTokenSideEffects(token: string | null) {
    if (token) {
        void invalidatePublishPlan(token).catch(() => undefined);
    }
}

export function useAiPreflight() {
    const [state, setState] = useState<AiPreflightState>(initialState);
    const generationRef = useRef(0);
    const tokenRef = useRef<string | null>(null);
    const jobIdRef = useRef<string | null>(null);
    /** Current decision for publish-time cancel without relying on a stale callback closure. */
    const decisionRef = useRef<AiPreflightState['decision']>(initialState.decision);
    decisionRef.current = state.decision;
    const lifecycleRef = useRef<AiPreflightLifecycle>(initialState.lifecycle);
    lifecycleRef.current = state.lifecycle;
    /** Latest acknowledgements for pure IPC scheduling outside setState updaters. */
    const acknowledgementsRef = useRef<AiAcknowledgements>(initialState.acknowledgements);
    acknowledgementsRef.current = state.acknowledgements;
    /** When true, late poll/completion must not replace UI or re-bind a consumed plan. */
    const suppressAuditUpdatesRef = useRef(false);
    const disposedRef = useRef(false);
    const ackWriteRef = useRef(0);
    /** Per-token FIFO of acknowledgement write promises; only the newest success may bind. */
    const ackQueueByTokenRef = useRef<Map<string, Promise<void>>>(new Map());
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Last draft used by prepare; retry reuses it after reconciliation. */
    const lastPrepareRequestRef = useRef<{
        request: PublishRequestPayload;
        localBlockers: string[];
    } | null>(null);
    /** Token/job retained while reconciling (generation already invalidated). */
    const reconcileTargetRef = useRef<{ token: string | null; jobId: string | null }>({
        token: null,
        jobId: null,
    });
    const reconcilingRef = useRef(false);

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

    /**
     * Atomic Rust cancel/reconcile for a retained plan token / job.
     * Leaves lifecycle as reconciling until reconciled=true (or stays reconciling on IPC error).
     */
    const reconcileSession = useCallback(async (
        token: string | null,
        jobId: string | null,
        terminalLifecycle: 'cancelled' | 'unavailable',
        errorMessage: string | null,
    ): Promise<CancelPreflightSessionResult | null> => {
        if (!token?.trim()) {
            reconcilingRef.current = false;
            reconcileTargetRef.current = { token: null, jobId: null };
            setState((current) => ({
                ...current,
                checking: false,
                lifecycle: terminalLifecycle,
                decision: 'IDLE',
                audit: null,
                acknowledgements: { ...idleAcknowledgements },
                acknowledgementsBound: true,
                token: null,
                snapshot_hash: null,
                job_id: null,
                error: errorMessage,
            }));
            return {
                job_state: null,
                token_state: 'already_missing',
                reconciled: true,
            };
        }

        reconcilingRef.current = true;
        reconcileTargetRef.current = { token, jobId };
        try {
            const result = await cancelPreflightSession(token, jobId);
            if (disposedRef.current) {
                return result;
            }
            if (result.reconciled) {
                reconcilingRef.current = false;
                reconcileTargetRef.current = { token: null, jobId: null };
                tokenRef.current = null;
                jobIdRef.current = null;
                setState((current) => ({
                    ...current,
                    checking: false,
                    lifecycle: terminalLifecycle,
                    decision: 'IDLE',
                    audit: null,
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    token: null,
                    snapshot_hash: null,
                    job_id: null,
                    error: errorMessage,
                }));
            } else {
                setState((current) => ({
                    ...current,
                    checking: false,
                    lifecycle: 'reconciling',
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    error: errorMessage
                        ?? '会话对账尚未完成，请重试对账。',
                }));
            }
            return result;
        } catch (error) {
            if (disposedRef.current) {
                return null;
            }
            // Stay reconciling; only Retry Reconciliation is enabled.
            reconcilingRef.current = true;
            setState((current) => ({
                ...current,
                checking: false,
                lifecycle: 'reconciling',
                acknowledgements: { ...idleAcknowledgements },
                acknowledgementsBound: true,
                error: readFriendlyError(error, '会话对账失败，请重试对账。'),
            }));
            return null;
        }
    }, []);

    const retryReconciliation = useCallback(async (): Promise<boolean> => {
        const target = reconcileTargetRef.current;
        const token = target.token ?? tokenRef.current;
        const jobId = target.jobId ?? jobIdRef.current;
        if (!token && !reconcilingRef.current && lifecycleRef.current !== 'reconciling') {
            return true;
        }
        generationRef.current += 1;
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        setState((current) => ({
            ...current,
            checking: false,
            lifecycle: 'reconciling',
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            error: null,
        }));
        const result = await reconcileSession(
            token,
            jobId,
            'unavailable',
            '发布前检查会话已结束，请重试。',
        );
        return Boolean(result?.reconciled);
    }, [reconcileSession, stopPolling]);

    useEffect(() => {
        disposedRef.current = false;
        let disposed = false;
        const unlistens: Array<() => void> = [];

        void getAiSettings().then((settings) => {
            if (!disposed && !disposedRef.current) {
                setState((current) => ({ ...current, settings }));
            }
        });

        void subscribePreflightSessionChanged((payload: PreflightSessionChangedPayload) => {
            if (disposedRef.current) {
                return;
            }
            const currentToken = tokenRef.current ?? reconcileTargetRef.current.token;
            const currentJob = jobIdRef.current ?? reconcileTargetRef.current.jobId;
            const tokenMatches = Boolean(
                payload.plan_token
                && currentToken
                && payload.plan_token === currentToken,
            );
            const jobMatches = Boolean(
                payload.job_id
                && currentJob
                && payload.job_id === currentJob,
            );
            // Accept only events for the active token/job (or retained reconciling target).
            if (!tokenMatches && !jobMatches) {
                return;
            }

            generationRef.current += 1;
            suppressAuditUpdatesRef.current = true;
            stopPolling();
            tokenRef.current = null;
            jobIdRef.current = null;

            if (payload.reconciled) {
                reconcilingRef.current = false;
                reconcileTargetRef.current = { token: null, jobId: null };
                const lifecycle: AiPreflightLifecycle =
                    payload.lifecycle === 'cancelled' ? 'cancelled' : 'unavailable';
                setState((current) => ({
                    ...current,
                    checking: false,
                    lifecycle,
                    decision: 'IDLE',
                    audit: null,
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    token: null,
                    snapshot_hash: null,
                    job_id: null,
                    error: lifecycle === 'cancelled'
                        ? '发布前检查已取消。'
                        : (current.error ?? '发布前检查会话已不可用。'),
                }));
            } else {
                reconcilingRef.current = true;
                setState((current) => ({
                    ...current,
                    checking: false,
                    lifecycle: 'reconciling',
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    error: current.error ?? '会话对账中…',
                }));
            }
        }).then((unlisten) => {
            if (disposed || disposedRef.current) {
                unlisten();
                return;
            }
            unlistens.push(unlisten);
        }).catch(() => {
            // Event bridge unavailable (tests / non-Tauri) — ignore.
        });

        return () => {
            disposed = true;
            disposedRef.current = true;
            generationRef.current += 1;
            suppressAuditUpdatesRef.current = true;
            stopPolling();
            for (const unlisten of unlistens) {
                unlisten();
            }
            const jobId = jobIdRef.current;
            const token = tokenRef.current;
            jobIdRef.current = null;
            tokenRef.current = null;
            if (token) {
                void cancelPreflightSession(token, jobId).catch(() => {
                    if (jobId) {
                        void cancelAiJob(jobId).catch(() => undefined);
                    }
                    clearTokenSideEffects(token);
                });
            } else if (jobId) {
                void cancelAiJob(jobId).catch(() => undefined);
            }
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
                lifecycle: 'terminal',
                snapshot_hash: audit.snapshot_hash ?? fallbackSnapshotHash,
                job_id: audit.job_id ?? null,
                acknowledgements: { ...idleAcknowledgements },
                acknowledgementsBound: audit.decision === 'GO',
            };
        });
    }, [clearActiveJob]);

    const beginPollFailureReconciliation = useCallback((
        token: string,
        jobId: string | null,
        requestGeneration: number,
    ) => {
        if (
            disposedRef.current
            || requestGeneration !== generationRef.current
            || tokenRef.current !== token
        ) {
            return;
        }
        // Invalidate local generation immediately; refuse later terminal adoption.
        generationRef.current += 1;
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        jobIdRef.current = null;
        tokenRef.current = null;
        reconcilingRef.current = true;
        reconcileTargetRef.current = { token, jobId };
        setState((current) => ({
            ...current,
            checking: false,
            lifecycle: 'reconciling',
            decision: 'IDLE',
            audit: null,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            token: null,
            snapshot_hash: null,
            job_id: null,
            error: '检查状态同步失败，正在对账会话…',
        }));
        void reconcileSession(
            token,
            jobId,
            'unavailable',
            '检查状态不可用。请重试发布前检查。',
        );
    }, [reconcileSession, stopPolling]);

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
                .catch((error) => {
                    if (
                        disposedRef.current
                        || requestGeneration !== generationRef.current
                        || tokenRef.current !== token
                    ) {
                        return;
                    }
                    // Transport/IPC failure: never leave error-free live PENDING.
                    // Job cancelled/stale messages also enter reconciliation.
                    void error;
                    beginPollFailureReconciliation(token, jobId, requestGeneration);
                });
        };

        pollTimerRef.current = setTimeout(tick, FORMAL_POLL_INTERVAL_MS);
    }, [applyTerminalAudit, beginPollFailureReconciliation, stopPolling]);

    const invalidate = useCallback(() => {
        // Cancel overlapping prepares/polls and drop their later commits.
        const jobId = jobIdRef.current;
        const token = tokenRef.current;
        generationRef.current += 1;
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        jobIdRef.current = null;
        tokenRef.current = null;
        reconcilingRef.current = false;
        reconcileTargetRef.current = { token: null, jobId: null };
        if (token) {
            void cancelPreflightSession(token, jobId).catch(() => {
                if (jobId) {
                    void cancelAiJob(jobId).catch(() => undefined);
                }
                clearTokenSideEffects(token);
            });
        } else if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState((current) => ({
            ...current,
            audit: null,
            decision: 'IDLE',
            lifecycle: 'idle',
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            checking: false,
            token: null,
            snapshot_hash: null,
            job_id: null,
            error: null,
        }));
    }, [stopPolling]);

    /**
     * User Cancel: invalidate generation immediately, atomic Rust path,
     * stay reconciling until reconciled=true → cancelled.
     */
    const cancel = useCallback(async (): Promise<boolean> => {
        if (lifecycleRef.current === 'reconciling' && reconcilingRef.current) {
            // Already reconciling — only Retry Reconciliation is allowed.
            return false;
        }
        const token = tokenRef.current ?? reconcileTargetRef.current.token;
        const jobId = jobIdRef.current ?? reconcileTargetRef.current.jobId;
        generationRef.current += 1;
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        tokenRef.current = null;
        jobIdRef.current = null;
        reconcilingRef.current = true;
        reconcileTargetRef.current = { token, jobId };
        setState((current) => ({
            ...current,
            checking: false,
            lifecycle: 'reconciling',
            decision: 'IDLE',
            audit: null,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
            token: null,
            snapshot_hash: null,
            job_id: null,
            error: null,
        }));
        const result = await reconcileSession(
            token,
            jobId,
            'cancelled',
            '发布前检查已取消。',
        );
        return Boolean(result?.reconciled);
    }, [reconcileSession, stopPolling]);

    const commitFormalAudit = useCallback((
        token: string,
        requestGeneration: number,
        auditBase: AiAuditResult,
        fallbackSnapshotHash: string,
        localBlockers: string[],
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
        const lifecycle: AiPreflightLifecycle = audit.decision === 'PENDING' && jobId
            ? 'auditing'
            : 'terminal';

        setState((current) => ({
            ...current,
            checking: false,
            error: null,
            audit,
            decision: audit.decision,
            lifecycle,
            token,
            snapshot_hash: audit.snapshot_hash ?? fallbackSnapshotHash,
            job_id: jobIdRef.current,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: audit.decision === 'GO',
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

    const runFormalAudit = useCallback(async (
        token: string,
        requestGeneration: number,
        snapshotHash: string,
        localBlockers: string[],
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
        );
    }, [commitFormalAudit]);

    const runPlanMediaInfo = useCallback(async (
        token: string,
        requestGeneration: number,
        snapshotHash: string,
    ): Promise<string> => {
        let started;
        try {
            started = await startPlanMediaInfo(token);
        } catch {
            // Formal audit will truthfully add MEDIA_NOT_TESTED when local probing cannot start.
            return snapshotHash;
        }
        if (!started?.job_id) {
            return snapshotHash;
        }

        const jobId = started.job_id;
        let terminal = started.state === 'queued' || started.state === 'running'
            ? null
            : started;
        while (!terminal) {
            if (requestGeneration !== generationRef.current) {
                void cancelAiJob(jobId).catch(() => undefined);
                throw createSupersededError();
            }
            await new Promise((resolve) => setTimeout(resolve, FORMAL_POLL_INTERVAL_MS));
            terminal = await pollPlanMediaInfo(jobId);
        }
        if (requestGeneration !== generationRef.current) {
            void cancelAiJob(jobId).catch(() => undefined);
            throw createSupersededError();
        }
        return terminal.state === 'succeeded' && terminal.snapshot_hash.trim()
            ? terminal.snapshot_hash
            : snapshotHash;
    }, []);

    const prepare = useCallback(async (
        request: PublishRequestPayload,
        localBlockers: string[] = [],
    ): Promise<AiPreflightPrepareResult> => {
        lastPrepareRequestRef.current = { request, localBlockers: [...localBlockers] };

        // Retained-session guard: refuse prepare_plan until prior token/job is reconciled.
        if (lifecycleRef.current === 'reconciling' || reconcilingRef.current) {
            const err = createReconcilingError();
            setState((current) => ({
                ...current,
                error: err.message,
                lifecycle: 'reconciling',
            }));
            throw err;
        }

        const previousJobId = jobIdRef.current;
        const previousToken = tokenRef.current;
        if (previousToken || previousJobId) {
            stopPolling();
            jobIdRef.current = null;
            tokenRef.current = null;
            reconcilingRef.current = true;
            setState((current) => ({
                ...current,
                checking: false,
                lifecycle: 'reconciling',
                acknowledgements: { ...idleAcknowledgements },
                acknowledgementsBound: true,
                error: null,
            }));
            const prior = await reconcileSession(
                previousToken,
                previousJobId,
                'unavailable',
                null,
            );
            if (!prior?.reconciled) {
                const err = createReconcilingError('先前会话对账失败，请先完成对账后再试。');
                setState((current) => ({
                    ...current,
                    lifecycle: 'reconciling',
                    error: err.message,
                }));
                throw err;
            }
        }

        const requestGeneration = ++generationRef.current;
        suppressAuditUpdatesRef.current = false;
        reconcilingRef.current = false;
        reconcileTargetRef.current = { token: null, jobId: null };
        setState((current) => ({
            ...current,
            checking: true,
            error: null,
            decision: 'PENDING',
            lifecycle: 'preparing',
            audit: null,
            token: null,
            snapshot_hash: null,
            job_id: null,
            acknowledgements: { ...idleAcknowledgements },
            acknowledgementsBound: true,
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

            if (requestGeneration !== generationRef.current) {
                clearTokenSideEffects(token);
                preparedToken = null;
                throw createSupersededError();
            }

            if (request.content_root?.trim()) {
                // Empty relative_entries instructs Rust to resolve and probe every media
                // file declared by the bound torrent. Successful per-file outcomes roll
                // the plan hash and become part of the formal audit context.
                nextSnapshotHash = await runPlanMediaInfo(
                    token,
                    requestGeneration,
                    nextSnapshotHash,
                );
            }

            // Start formal audit only after the automatic MediaInfo pass has settled.
            // Keep the token armed until the audit has committed so a start failure
            // still invalidates the prepared plan in the catch path.
            setState((current) => (
                current.lifecycle === 'preparing'
                    ? { ...current, lifecycle: 'auditing' }
                    : current
            ));
            const result = await runFormalAudit(
                token,
                requestGeneration,
                nextSnapshotHash,
                prepared.local_blockers,
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
                    lifecycle: 'idle',
                    token: null,
                    snapshot_hash: null,
                    job_id: null,
                    acknowledgements: { ...idleAcknowledgements },
                    acknowledgementsBound: true,
                    error: readFriendlyError(error, '无法准备发布前检查。'),
                }));
            }
            throw error;
        }
    }, [reconcileSession, runFormalAudit, runPlanMediaInfo, stopPolling]);

    /**
     * Retry: refuse while reconciling unknown; reconcile any retained session, then
     * prepare a fresh plan from the last draft.
     */
    const retry = useCallback(async (): Promise<AiPreflightPrepareResult | null> => {
        if (lifecycleRef.current === 'reconciling' || reconcilingRef.current) {
            setState((current) => ({
                ...current,
                error: '会话对账尚未完成，请先使用「重试对账」。',
            }));
            return null;
        }
        const draft = lastPrepareRequestRef.current;
        if (!draft) {
            setState((current) => ({
                ...current,
                error: '没有可重试的草稿，请重新发起发布前检查。',
            }));
            return null;
        }
        // prepare() already runs the retained-session guard.
        return prepare(draft.request, draft.localBlockers);
    }, [prepare]);

    /**
     * When confirm is clicked while formal audit is still PENDING and pending ack is bound,
     * cooperatively cancel the backend job before publishing the already-frozen plan.
     * Uses a publish-safe Rust path that must NOT invalidate the plan token
     * (unlike ai_cancel_job escalation / preflight session cancel).
     * Late completion must not replace UI after this point.
     */
    const cancelPendingAuditForPublish = useCallback(async (): Promise<void> => {
        const jobId = jobIdRef.current;
        const token = tokenRef.current;
        // Read through a ref so a stale callback closure cannot skip cancellation.
        const decision = decisionRef.current;
        if (decision !== 'PENDING') {
            return;
        }
        suppressAuditUpdatesRef.current = true;
        stopPolling();
        jobIdRef.current = null;
        if (!token) {
            // Cannot safely cancel-for-publish without a plan token; refuse so callers fail closed.
            throw new Error('prepared plan token is missing or expired');
        }
        const result = await cancelPendingAuditForPublishIpc(token, jobId);
        if (!result.plan_token_live) {
            throw new Error('prepared plan token is missing or expired');
        }
        // Any IPC/string rejection must propagate — entry points must not publish after cancel failure.
        setState((current) => (
            current.job_id === jobId || current.decision === 'PENDING'
                ? { ...current, job_id: null }
                : current
        ));
    }, [stopPolling]);

    const setAcknowledgement = useCallback((key: keyof AiAcknowledgements, checked: boolean) => {
        // Use refs for lifecycle/token/acks so IPC scheduling does not depend on setState
        // updater timing (updaters must stay pure and may run deferred concurrently).
        if (
            lifecycleRef.current === 'reconciling'
            || lifecycleRef.current === 'unavailable'
            || lifecycleRef.current === 'cancelled'
        ) {
            return;
        }
        const token = tokenRef.current;
        const acknowledgements = { ...acknowledgementsRef.current, [key]: checked };
        acknowledgementsRef.current = acknowledgements;
        setState((current) => ({
            ...current,
            acknowledgements,
            // Non-GO decisions require a successful backend bind before confirm.
            acknowledgementsBound: token ? false : true,
        }));
        if (!token) {
            return;
        }

        // Persist acks on the backend plan so publish never trusts caller-only checkboxes.
        // Serialize writes per token so rapid toggles cannot race; only the newest
        // successful snapshot for the current token may set acknowledgementsBound=true.
        const writeId = ++ackWriteRef.current;
        const previous = ackQueueByTokenRef.current.get(token) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                try {
                    await setPlanAcknowledgements(token, acknowledgements);
                    if (ackWriteRef.current !== writeId || disposedRef.current) {
                        return;
                    }
                    setState((latest) => (
                        latest.token === token
                            ? { ...latest, acknowledgementsBound: true }
                            : latest
                    ));
                } catch {
                    if (ackWriteRef.current !== writeId || disposedRef.current) {
                        return;
                    }
                    setState((latest) => (
                        latest.token === token
                            ? { ...latest, acknowledgementsBound: false }
                            : latest
                    ));
                }
            })
            .finally(() => {
                if (ackQueueByTokenRef.current.get(token) === next) {
                    ackQueueByTokenRef.current.delete(token);
                }
            });
        ackQueueByTokenRef.current.set(token, next);
    }, []);

    const decision = state.decision;
    const lifecycle = state.lifecycle;
    const needsBoundAcks = decision === 'WARNING'
        || decision === 'NO_GO'
        || decision === 'PENDING';
    const lifecycleBlocksConfirm = lifecycle === 'reconciling'
        || lifecycle === 'unavailable'
        || lifecycle === 'cancelled'
        || lifecycle === 'idle'
        || lifecycle === 'preparing';
    // checking is only true during prepare/start — PENDING background audit still allows confirm.
    // Unavailable/cancelled cannot inherit pending ack or older terminal.
    const canConfirm = !state.checking
        && !state.error
        && !lifecycleBlocksConfirm
        && Boolean(state.token)
        && Boolean(state.snapshot_hash)
        && decision !== 'IDLE'
        && decision !== 'LOCAL_BLOCKED'
        && (lifecycle === 'terminal' || lifecycle === 'auditing')
        && canPublishAudit(decision as AiDecision, state.acknowledgements)
        && (!needsBoundAcks || state.acknowledgementsBound);

    return {
        state,
        isConfigured: isAiConfigured(state.settings),
        prepare,
        invalidate,
        cancel,
        retry,
        retryReconciliation,
        setAcknowledgement,
        cancelPendingAuditForPublish,
        canConfirm,
    };
}
