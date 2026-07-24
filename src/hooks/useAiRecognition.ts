import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiRecognizeRequest,
    FieldEditMeta,
    RecognitionAdoptableField,
    RecognitionJobView,
    RecognitionResult,
} from '../types/ai';
import {
    buildRecognitionLocalContextKey,
    createEmptyFieldEditMeta,
    markFieldAdopted,
    markFieldManual,
} from '../types/ai';
import {
    cancelAiJob,
    getAiJob,
    isSuccessfulRecognitionResult,
    pollRecognition,
    readFriendlyError,
    startRecognition,
} from '../services/ai';

export interface RecognitionAdoptedState {
    episode: boolean;
    resolution: boolean;
}

export interface RecognitionFieldOrigins {
    episode: FieldEditMeta;
    resolution: FieldEditMeta;
}

export interface AiRecognitionState {
    busy: boolean;
    error: string | null;
    result: RecognitionResult | null;
    jobId: string | null;
    progress: number;
    /**
     * Local UI epoch only — never serialized as wire authority.
     * Bumped on clear / new recognize / cancel / unmount / draft drift.
     */
    requestGeneration: number;
    /**
     * Backend context identity from the active start/result (null when idle).
     * Correlation authority: job_id + contextHash + contextGeneration.
     */
    contextHash: string | null;
    contextGeneration: number | null;
    /** Explicit per-field adopt flags for the current result (never auto-fill). */
    adopted: RecognitionAdoptedState;
    /** Page-mirrored field provenance + edit generation for manual-edit protection. */
    fieldOrigins: RecognitionFieldOrigins;
}

export interface AiRecognitionRecognizeInput {
    torrentName: string;
    epPattern: string;
    resolutionPattern: string;
    titlePattern: string;
}

/** Bounded poll interval for recognition job status (ms). */
const POLL_INTERVAL_MS = 400;

const emptyAdopted: RecognitionAdoptedState = {
    episode: false,
    resolution: false,
};

const emptyFieldOrigins: RecognitionFieldOrigins = {
    episode: createEmptyFieldEditMeta(),
    resolution: createEmptyFieldEditMeta(),
};

const initialState: AiRecognitionState = {
    busy: false,
    error: null,
    result: null,
    jobId: null,
    progress: 0,
    requestGeneration: 0,
    contextHash: null,
    contextGeneration: null,
    adopted: emptyAdopted,
    fieldOrigins: emptyFieldOrigins,
};

interface BackendContextIdentity {
    contextHash: string;
    contextGeneration: number;
    jobId: string;
}

/**
 * Advisory release recognition via backend-owned start / poll / cancel lifecycle.
 * Never mutates draft title/episode/resolution, never auto-fills, never changes publish decisions.
 * Cancels on clear/unmount/new request. Late results are ignored unless the local UI epoch and
 * backend context identity still match. Cancelled/stale jobs never apply a recognition result.
 * Episode/resolution adoption is explicit and per-field; title is never adopted.
 * Frontend local epoch is a stale UI guard only — never wire authority.
 */
export function useAiRecognition() {
    const [state, setState] = useState<AiRecognitionState>(initialState);
    const stateRef = useRef(state);
    stateRef.current = state;
    /** Local UI epoch — never sent to the backend. */
    const uiEpochRef = useRef(0);
    /**
     * Local content key for the in-flight request (torrent + patterns).
     * Used only to detect page draft drift; never wire identity.
     */
    const expectedLocalContextKeyRef = useRef<string | null>(null);
    /** Backend context identity captured from start response (authority for adopt/correlation). */
    const backendIdentityRef = useRef<BackendContextIdentity | null>(null);
    const jobIdRef = useRef<string | null>(null);
    /** Recursive timeout id (not interval) so polls never overlap. */
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** True while a poll tick is awaiting IPC — blocks scheduling a concurrent tick. */
    const pollInFlightRef = useRef(false);
    const disposedRef = useRef(false);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current != null) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
        // Do not clear pollInFlightRef here: an already-awaiting tick must keep the latch
        // until it settles (or startPolling / clear paths reset it).
    }, []);

    useEffect(() => {
        disposedRef.current = false;
        return () => {
            disposedRef.current = true;
            // Bump so any in-flight poll cannot commit after unmount.
            uiEpochRef.current += 1;
            expectedLocalContextKeyRef.current = null;
            backendIdentityRef.current = null;
            const jobId = jobIdRef.current;
            jobIdRef.current = null;
            stopPolling();
            pollInFlightRef.current = false;
            if (jobId) {
                void cancelAiJob(jobId).catch(() => undefined);
            }
        };
    }, [stopPolling]);

    /**
     * Invalidate recognition on covered edits or local context drift.
     * Cancels the backend job and bumps UI epoch so late polls cannot remain active.
     * Resets adopt flags; leaves field origin generations intact unless resetOrigins.
     */
    const clear = useCallback((options?: { resetOrigins?: boolean }) => {
        uiEpochRef.current += 1;
        expectedLocalContextKeyRef.current = null;
        backendIdentityRef.current = null;
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        pollInFlightRef.current = false;
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState((current) => ({
            busy: false,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration: uiEpochRef.current,
            contextHash: null,
            contextGeneration: null,
            adopted: emptyAdopted,
            fieldOrigins: options?.resetOrigins ? emptyFieldOrigins : current.fieldOrigins,
        }));
    }, [stopPolling]);

    /**
     * Explicit cancel while queued/running. Idempotent: safe if already terminal/cleared.
     * Late success after cancel cannot surface candidates.
     */
    const cancel = useCallback(() => {
        uiEpochRef.current += 1;
        expectedLocalContextKeyRef.current = null;
        backendIdentityRef.current = null;
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        pollInFlightRef.current = false;
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState((current) => ({
            busy: false,
            error: 'AI 识别已取消。',
            result: null,
            jobId: null,
            progress: 100,
            requestGeneration: uiEpochRef.current,
            contextHash: null,
            contextGeneration: null,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));
    }, [stopPolling]);

    /**
     * Drop active result/error when the live local context key no longer matches.
     * Cancels in-flight work; bumps UI epoch when clearing a bound identity.
     * `currentLocalContextKey` is page-local content only — never backend hash authority.
     */
    const invalidateIfDraftMismatch = useCallback((currentLocalContextKey: string | null | undefined) => {
        const expected = expectedLocalContextKeyRef.current;
        const live = currentLocalContextKey?.trim() || null;
        if (!expected) {
            return;
        }
        if (live && live === expected) {
            return;
        }
        uiEpochRef.current += 1;
        expectedLocalContextKeyRef.current = null;
        backendIdentityRef.current = null;
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        pollInFlightRef.current = false;
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState((current) => ({
            busy: false,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration: uiEpochRef.current,
            contextHash: null,
            contextGeneration: null,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));
    }, [stopPolling]);

    /** @deprecated Prefer invalidateIfDraftMismatch — same local-context drift semantics. */
    const invalidateIfSnapshotMismatch = invalidateIfDraftMismatch;

    /**
     * Mark episode/resolution as manually edited.
     * Bumps edit generation so late silent paths cannot treat the field as pristine.
     * Does not clear advisory candidates (user may still explicitly adopt).
     */
    const markFieldManualEdit = useCallback((field: RecognitionAdoptableField) => {
        setState((current) => ({
            ...current,
            fieldOrigins: {
                ...current.fieldOrigins,
                [field]: markFieldManual(current.fieldOrigins[field]),
            },
            adopted: {
                ...current.adopted,
                [field]: false,
            },
        }));
    }, []);

    /**
     * Explicit per-field adopt. Returns the candidate value when allowed; never mutates draft itself.
     * Blocks when busy, no current result, UI epoch / backend identity mismatch, or missing candidate.
     * Manual edits never auto-apply recognition; explicit adopt is always user-initiated and
     * only touches the requested field (other manually edited fields stay intact).
     * Callers apply the returned value to their own draft.
     */
    const adoptField = useCallback((field: RecognitionAdoptableField): string | null => {
        const current = stateRef.current;
        const { result, busy, requestGeneration, contextHash, contextGeneration } = current;
        const backend = backendIdentityRef.current;
        if (
            busy
            || !result
            || !backend
            || requestGeneration !== uiEpochRef.current
            || contextHash !== backend.contextHash
            || contextGeneration !== backend.contextGeneration
            || result.snapshot_hash !== backend.contextHash
            || result.request_generation !== backend.contextGeneration
            || result.job_id !== backend.jobId
        ) {
            return null;
        }
        const candidate = result[field];
        const value = candidate?.value?.trim() ?? '';
        if (!value) {
            return null;
        }
        setState((prev) => ({
            ...prev,
            adopted: {
                ...prev.adopted,
                [field]: true,
            },
            fieldOrigins: {
                ...prev.fieldOrigins,
                [field]: markFieldAdopted(prev.fieldOrigins[field]),
            },
        }));
        return value;
    }, []);

    const applyTerminal = useCallback((
        view: RecognitionJobView,
        uiEpoch: number,
        localContextKey: string,
        expectedBackend: BackendContextIdentity | null,
    ) => {
        // Superseded request (clear / new recognize / unmount / identity drift): leave state alone.
        if (
            disposedRef.current
            || uiEpoch !== uiEpochRef.current
            || expectedLocalContextKeyRef.current !== localContextKey
        ) {
            return;
        }

        // Prefer backend identity from start; fall back to view identity when start was already terminal.
        const identity: BackendContextIdentity = expectedBackend ?? {
            contextHash: view.snapshot_hash,
            contextGeneration: view.request_generation,
            jobId: view.job_id,
        };

        // Fail closed when terminal view identity does not match the active backend binding.
        // Never leave busy=true after a terminal poll/start settles.
        if (
            view.snapshot_hash !== identity.contextHash
            || view.request_generation !== identity.contextGeneration
            || view.job_id !== identity.jobId
        ) {
            jobIdRef.current = null;
            backendIdentityRef.current = null;
            setState((current) => ({
                busy: false,
                error: 'AI 识别已过期。',
                result: null,
                jobId: null,
                progress: 100,
                requestGeneration: uiEpoch,
                contextHash: null,
                contextGeneration: null,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            return;
        }

        if (!isSuccessfulRecognitionResult(view) || !view.result) {
            // Terminal codes are the stable UI contract; provider/backend messages may
            // be English or otherwise diagnostic and must not override localized states.
            const friendly = view.error_code === 'CANCELLED'
                ? 'AI 识别已取消。'
                : view.error_code === 'STALE'
                    ? 'AI 识别已过期。'
                    : view.message;
            setState((current) => ({
                busy: false,
                error: friendly
                    ? readFriendlyError(friendly, 'AI 识别失败。')
                    : readFriendlyError(view.error_code, 'AI 识别失败。'),
                result: null,
                jobId: view.job_id,
                progress: 100,
                requestGeneration: uiEpoch,
                contextHash: identity.contextHash,
                contextGeneration: identity.contextGeneration,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            jobIdRef.current = null;
            backendIdentityRef.current = null;
            return;
        }

        // Nested result identity must match backend binding; otherwise fail closed.
        if (
            view.result.request_generation !== identity.contextGeneration
            || view.result.snapshot_hash !== identity.contextHash
            || view.result.job_id !== identity.jobId
        ) {
            jobIdRef.current = null;
            backendIdentityRef.current = null;
            setState((current) => ({
                busy: false,
                error: 'AI 识别已过期。',
                result: null,
                jobId: null,
                progress: 100,
                requestGeneration: uiEpoch,
                contextHash: null,
                contextGeneration: null,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            return;
        }

        // Advisory only — never writes episode/resolution/title into any draft.
        backendIdentityRef.current = identity;
        setState((current) => ({
            busy: false,
            error: null,
            result: view.result ?? null,
            jobId: view.job_id,
            progress: 100,
            requestGeneration: uiEpoch,
            contextHash: identity.contextHash,
            contextGeneration: identity.contextGeneration,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));
        jobIdRef.current = null;
    }, []);

    const startPolling = useCallback((
        jobId: string,
        uiEpoch: number,
        localContextKey: string,
        backendIdentity: BackendContextIdentity,
    ) => {
        stopPolling();
        pollInFlightRef.current = false;

        const isActiveTick = () =>
            !disposedRef.current
            && uiEpoch === uiEpochRef.current
            && expectedLocalContextKeyRef.current === localContextKey
            && jobIdRef.current === jobId
            && backendIdentityRef.current?.jobId === jobId
            && backendIdentityRef.current?.contextHash === backendIdentity.contextHash
            && backendIdentityRef.current?.contextGeneration === backendIdentity.contextGeneration;

        const scheduleNext = () => {
            // Stale ticks must not clear timers owned by a newer generation.
            if (!isActiveTick()) {
                return;
            }
            pollTimerRef.current = setTimeout(() => {
                void runPollTick();
            }, POLL_INTERVAL_MS);
        };

        const runPollTick = async () => {
            if (!isActiveTick()) {
                return;
            }
            // Single-flight: never stack overlapping get/poll awaits.
            // The in-flight tick schedules the next one when it settles.
            if (pollInFlightRef.current) {
                return;
            }
            pollInFlightRef.current = true;
            try {
                // Progress from read-only job status (never forges completion).
                const job = await getAiJob(jobId);
                if (isActiveTick() && job) {
                    setState((current) => ({
                        ...current,
                        progress: job.progress ?? current.progress,
                    }));
                }

                if (!isActiveTick()) {
                    return;
                }

                const polled = await pollRecognition(jobId);
                if (!isActiveTick()) {
                    return;
                }
                if (polled == null) {
                    scheduleNext();
                    return;
                }
                stopPolling();
                applyTerminal(polled, uiEpoch, localContextKey, backendIdentity);
            } catch (error) {
                // Stale/superseded ticks must not clear a newer generation or replace its UI.
                if (!isActiveTick()) {
                    return;
                }
                // Fail closed like clear/invalidate: cancel backend job, drop identity binding,
                // and bump UI epoch so a later recognize cannot orphan or reuse this job.
                stopPolling();
                uiEpochRef.current += 1;
                expectedLocalContextKeyRef.current = null;
                backendIdentityRef.current = null;
                jobIdRef.current = null;
                pollInFlightRef.current = false;
                // Cancellation failures must never replace the original poll UI error.
                void cancelAiJob(jobId).catch(() => undefined);
                setState((current) => ({
                    busy: false,
                    error: readFriendlyError(error, 'AI 识别轮询失败。'),
                    result: null,
                    jobId: null,
                    progress: 0,
                    requestGeneration: uiEpochRef.current,
                    contextHash: null,
                    contextGeneration: null,
                    adopted: emptyAdopted,
                    fieldOrigins: current.fieldOrigins,
                }));
            } finally {
                // Release latch when this UI epoch is still current.
                if (uiEpoch === uiEpochRef.current) {
                    pollInFlightRef.current = false;
                }
            }
        };

        scheduleNext();
    }, [applyTerminal, stopPolling]);

    /**
     * Start backend recognition (non-blocking IPC) and poll until terminal.
     * Sends content only; Rust allocates context hash + generation.
     * Cancels any prior in-flight job; rejects stale UI-epoch / identity results.
     */
    const recognize = useCallback(async (input: AiRecognitionRecognizeInput): Promise<void> => {
        const torrentName = input.torrentName.trim();
        if (!torrentName) {
            setState((current) => ({
                ...current,
                busy: false,
                error: '识别需要有效的种子显示名称。',
            }));
            return;
        }

        const localContextKey = buildRecognitionLocalContextKey({
            torrentName,
            epPattern: input.epPattern ?? '',
            resolutionPattern: input.resolutionPattern ?? '',
            titlePattern: input.titlePattern ?? '',
        });

        // Cancel any prior in-flight job; bump UI epoch so late polls cannot commit.
        const previousJob = jobIdRef.current;
        if (previousJob) {
            void cancelAiJob(previousJob).catch(() => undefined);
        }
        stopPolling();
        pollInFlightRef.current = false;

        const uiEpoch = ++uiEpochRef.current;
        expectedLocalContextKeyRef.current = localContextKey;
        backendIdentityRef.current = null;
        jobIdRef.current = null;

        setState((current) => ({
            busy: true,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration: uiEpoch,
            contextHash: null,
            contextGeneration: null,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));

        // Content only — never client snapshot_hash / request_generation.
        const request: AiRecognizeRequest = {
            torrent_name: torrentName,
            ep_pattern: input.epPattern ?? '',
            resolution_pattern: input.resolutionPattern ?? '',
            title_pattern: input.titlePattern ?? '',
        };

        try {
            const started = await startRecognition(request);
            if (
                disposedRef.current
                || uiEpoch !== uiEpochRef.current
                || expectedLocalContextKeyRef.current !== localContextKey
            ) {
                if (started.job_id) {
                    void cancelAiJob(started.job_id).catch(() => undefined);
                }
                return;
            }

            const backendIdentity: BackendContextIdentity = {
                contextHash: started.snapshot_hash,
                contextGeneration: started.request_generation,
                jobId: started.job_id,
            };
            backendIdentityRef.current = backendIdentity;
            jobIdRef.current = started.job_id;

            if (
                started.state === 'succeeded'
                || started.state === 'failed'
                || started.state === 'cancelled'
                || started.state === 'stale'
            ) {
                applyTerminal(started, uiEpoch, localContextKey, backendIdentity);
                return;
            }

            setState((current) => ({
                busy: true,
                error: null,
                result: null,
                jobId: started.job_id,
                progress: started.progress ?? 0,
                requestGeneration: uiEpoch,
                contextHash: backendIdentity.contextHash,
                contextGeneration: backendIdentity.contextGeneration,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            startPolling(started.job_id, uiEpoch, localContextKey, backendIdentity);
        } catch (error) {
            if (
                disposedRef.current
                || uiEpoch !== uiEpochRef.current
                || expectedLocalContextKeyRef.current !== localContextKey
            ) {
                return;
            }
            setState((current) => ({
                busy: false,
                error: readFriendlyError(error, 'AI 识别失败。'),
                result: null,
                jobId: null,
                progress: 0,
                requestGeneration: uiEpoch,
                contextHash: null,
                contextGeneration: null,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
        }
    }, [applyTerminal, startPolling, stopPolling]);

    return {
        state,
        busy: state.busy,
        error: state.error,
        result: state.result,
        jobId: state.jobId,
        progress: state.progress,
        requestGeneration: state.requestGeneration,
        contextHash: state.contextHash,
        contextGeneration: state.contextGeneration,
        adopted: state.adopted,
        fieldOrigins: state.fieldOrigins,
        recognize,
        clear,
        cancel,
        adoptField,
        markFieldManualEdit,
        invalidateIfDraftMismatch,
        invalidateIfSnapshotMismatch,
    };
}
