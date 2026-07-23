import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiAcknowledgements,
    AiAuditResult,
    AiDecision,
    AiSettings,
    PublishRequestPayload,
} from '../types/ai';
import {
    canPublishAudit,
    cancelAiJob,
    disabledAiSettings,
    getAiSettings,
    invalidatePublishPlan,
    isAiConfigured,
    pollFormalAudit,
    preparePublishPlan,
    readFriendlyError,
    setPlanAcknowledgements,
    startFormalAudit,
} from '../services/ai';

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
        }));
    }, [stopPolling]);

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
            const nextSnapshotHash = prepared.snapshot_hash;
            if (!nextSnapshotHash?.trim()) {
                clearTokenSideEffects(token);
                preparedToken = null;
                throw new Error('发布前检查未返回有效快照标识，请重试。');
            }

            // Client localBlockers are not merged into the formal result when the backend
            // returns local_blockers (plan-token blockers are authoritative).
            void localBlockers;

            // Start formal audit with plan_token only: provider prompt is projected from
            // the plan binding server-side (never client title/torrent_name/sites/blockers).
            // Local/disabled paths return terminal immediately; configured AI returns
            // PENDING+job_id so the confirm modal can open now.
            const auditBase = await startFormalAudit({
                plan_token: token,
            });
            if (requestGeneration !== generationRef.current) {
                if (auditBase.job_id) {
                    void cancelAiJob(auditBase.job_id).catch(() => undefined);
                }
                clearTokenSideEffects(token);
                preparedToken = null;
                throw createSupersededError();
            }

            const audit: AiAuditResult = {
                ...auditBase,
                // Prefer backend plan blockers when present (including empty array).
                local_blockers: auditBase.local_blockers ?? prepared.local_blockers,
                plan_token: auditBase.plan_token ?? token,
                snapshot_hash: auditBase.snapshot_hash ?? nextSnapshotHash,
            };

            // Commit token after a successful, generation-matched start (PENDING or terminal).
            preparedToken = null;
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
                snapshot_hash: audit.snapshot_hash ?? nextSnapshotHash,
                job_id: jobIdRef.current,
                acknowledgements: { ...idleAcknowledgements },
                // GO needs no acks; other decisions start unbound until the user checks boxes.
                acknowledgementsBound: audit.decision === 'GO',
            }));

            if (audit.decision === 'PENDING' && jobIdRef.current) {
                startFormalPolling(
                    token,
                    jobIdRef.current,
                    requestGeneration,
                    audit.snapshot_hash ?? nextSnapshotHash,
                );
            }

            return {
                token,
                snapshotHash: audit.snapshot_hash ?? nextSnapshotHash,
                audit,
                requestGeneration,
            };
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
                }));
            }
            throw error;
        }
    }, [startFormalPolling, stopPolling]);

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
    // checking is only true during prepare/start — PENDING background audit still allows confirm.
    const canConfirm = !state.checking
        && !state.error
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
        canConfirm,
    };
}
