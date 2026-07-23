import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiRecognizeRequest,
    FieldEditMeta,
    RecognitionAdoptableField,
    RecognitionJobView,
    RecognitionResult,
} from '../types/ai';
import {
    buildRecognitionDraftIdentity,
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
    /** Monotonic edit/request generation; late results must match this value. */
    requestGeneration: number;
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
    /**
     * Optional override for the draft-identity binding sent as snapshot_hash.
     * Default: `buildRecognitionDraftIdentity` from torrent + template patterns.
     * Never a publish-plan token.
     */
    draftIdentity?: string;
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
    adopted: emptyAdopted,
    fieldOrigins: emptyFieldOrigins,
};

/**
 * Advisory release recognition via backend-owned start / poll / cancel lifecycle.
 * Never mutates draft title/episode/resolution, never auto-fills, never changes publish decisions.
 * Cancels on clear/unmount/new request. Late results are ignored unless both request generation
 * and draft identity still match. Cancelled/stale jobs never apply a recognition result.
 * Episode/resolution adoption is explicit and per-field; title is never adopted.
 */
export function useAiRecognition() {
    const [state, setState] = useState<AiRecognitionState>(initialState);
    const stateRef = useRef(state);
    stateRef.current = state;
    const generationRef = useRef(0);
    /** Draft identity expected by the in-flight or last-applied recognition. */
    const expectedDraftIdentityRef = useRef<string | null>(null);
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
            generationRef.current += 1;
            expectedDraftIdentityRef.current = null;
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
     * Invalidate recognition on covered edits or draft-identity drift.
     * Cancels the backend job and bumps generation so late polls cannot remain active.
     * Resets adopt flags; leaves field origin generations intact unless resetOrigins.
     */
    const clear = useCallback((options?: { resetOrigins?: boolean }) => {
        generationRef.current += 1;
        expectedDraftIdentityRef.current = null;
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
            requestGeneration: generationRef.current,
            adopted: emptyAdopted,
            fieldOrigins: options?.resetOrigins ? emptyFieldOrigins : current.fieldOrigins,
        }));
    }, [stopPolling]);

    /**
     * Drop active result/error when the live draft identity no longer matches.
     * Cancels in-flight work; bumps generation when clearing a bound identity.
     */
    const invalidateIfDraftMismatch = useCallback((currentDraftIdentity: string | null | undefined) => {
        const expected = expectedDraftIdentityRef.current;
        const live = currentDraftIdentity?.trim() || null;
        if (!expected) {
            return;
        }
        if (live && live === expected) {
            return;
        }
        generationRef.current += 1;
        expectedDraftIdentityRef.current = null;
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
            requestGeneration: generationRef.current,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));
    }, [stopPolling]);

    /** @deprecated Prefer invalidateIfDraftMismatch — same binding semantics. */
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
     * Blocks when busy, no current result, generation/identity mismatch, or missing candidate.
     * Manual edits never auto-apply recognition; explicit adopt is always user-initiated and
     * only touches the requested field (other manually edited fields stay intact).
     * Callers apply the returned value to their own draft.
     */
    const adoptField = useCallback((field: RecognitionAdoptableField): string | null => {
        const current = stateRef.current;
        const { result, busy, requestGeneration } = current;
        if (
            busy
            || !result
            || requestGeneration !== generationRef.current
            || expectedDraftIdentityRef.current !== result.snapshot_hash
            || result.request_generation !== requestGeneration
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
        requestGeneration: number,
        draftIdentity: string,
    ) => {
        // Superseded request (clear / new recognize / unmount / identity drift): leave state alone.
        if (
            disposedRef.current
            || requestGeneration !== generationRef.current
            || expectedDraftIdentityRef.current !== draftIdentity
        ) {
            return;
        }

        // Fail closed when a still-active terminal view's identity does not match this request.
        // Never leave busy=true after a terminal poll/start settles.
        if (
            view.request_generation !== requestGeneration
            || view.snapshot_hash !== draftIdentity
        ) {
            jobIdRef.current = null;
            setState((current) => ({
                busy: false,
                error: 'AI 识别已过期。',
                result: null,
                jobId: null,
                progress: 100,
                requestGeneration,
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
                requestGeneration,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            jobIdRef.current = null;
            return;
        }

        // Nested result identity must match; otherwise fail closed (stop busy, no result).
        if (
            view.result.request_generation !== requestGeneration
            || view.result.snapshot_hash !== draftIdentity
        ) {
            jobIdRef.current = null;
            setState((current) => ({
                busy: false,
                error: 'AI 识别已过期。',
                result: null,
                jobId: null,
                progress: 100,
                requestGeneration,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            return;
        }

        // Advisory only — never writes episode/resolution/title into any draft.
        setState((current) => ({
            busy: false,
            error: null,
            result: view.result ?? null,
            jobId: view.job_id,
            progress: 100,
            requestGeneration,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));
        jobIdRef.current = null;
    }, []);

    const startPolling = useCallback((
        jobId: string,
        requestGeneration: number,
        draftIdentity: string,
    ) => {
        stopPolling();
        pollInFlightRef.current = false;

        const isActiveTick = () =>
            !disposedRef.current
            && requestGeneration === generationRef.current
            && expectedDraftIdentityRef.current === draftIdentity
            && jobIdRef.current === jobId;

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
                applyTerminal(polled, requestGeneration, draftIdentity);
            } catch (error) {
                // Stale/superseded ticks must not clear a newer generation or replace its UI.
                if (!isActiveTick()) {
                    return;
                }
                // Fail closed like clear/invalidate: cancel backend job, drop identity binding,
                // and bump generation so a later recognize cannot orphan or reuse this job.
                // Capture jobId from the tick closure before clearing refs.
                stopPolling();
                generationRef.current += 1;
                expectedDraftIdentityRef.current = null;
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
                    requestGeneration: generationRef.current,
                    adopted: emptyAdopted,
                    fieldOrigins: current.fieldOrigins,
                }));
            } finally {
                // Release latch when this request generation is still current.
                // (jobId may already be cleared by applyTerminal on success; poll-error
                // path bumps generation and releases the latch itself above.)
                if (requestGeneration === generationRef.current) {
                    pollInFlightRef.current = false;
                }
            }
        };

        scheduleNext();
    }, [applyTerminal, stopPolling]);

    /**
     * Start backend recognition (non-blocking IPC) and poll until terminal.
     * Uses draft identity from torrent + template patterns (not a publish-plan snapshot).
     * Cancels any prior in-flight job; rejects stale generation/identity results.
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

        const draftIdentity = (input.draftIdentity?.trim()
            || buildRecognitionDraftIdentity({
                torrentName,
                epPattern: input.epPattern ?? '',
                resolutionPattern: input.resolutionPattern ?? '',
                titlePattern: input.titlePattern ?? '',
            })).trim();

        if (!draftIdentity) {
            setState((current) => ({
                ...current,
                busy: false,
                error: '识别需要有效的草稿身份绑定。',
            }));
            return;
        }

        // Cancel any prior in-flight job; bump generation so late polls cannot commit.
        const previousJob = jobIdRef.current;
        if (previousJob) {
            void cancelAiJob(previousJob).catch(() => undefined);
        }
        stopPolling();
        pollInFlightRef.current = false;

        const requestGeneration = ++generationRef.current;
        expectedDraftIdentityRef.current = draftIdentity;
        jobIdRef.current = null;

        setState((current) => ({
            busy: true,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration,
            adopted: emptyAdopted,
            fieldOrigins: current.fieldOrigins,
        }));

        const request: AiRecognizeRequest = {
            torrent_name: torrentName,
            ep_pattern: input.epPattern ?? '',
            resolution_pattern: input.resolutionPattern ?? '',
            title_pattern: input.titlePattern ?? '',
            request_generation: requestGeneration,
            snapshot_hash: draftIdentity,
        };

        try {
            const started = await startRecognition(request);
            if (
                disposedRef.current
                || requestGeneration !== generationRef.current
                || expectedDraftIdentityRef.current !== draftIdentity
            ) {
                if (started.job_id) {
                    void cancelAiJob(started.job_id).catch(() => undefined);
                }
                return;
            }

            jobIdRef.current = started.job_id;

            if (
                started.state === 'succeeded'
                || started.state === 'failed'
                || started.state === 'cancelled'
                || started.state === 'stale'
            ) {
                applyTerminal(started, requestGeneration, draftIdentity);
                return;
            }

            setState((current) => ({
                busy: true,
                error: null,
                result: null,
                jobId: started.job_id,
                progress: started.progress ?? 0,
                requestGeneration,
                adopted: emptyAdopted,
                fieldOrigins: current.fieldOrigins,
            }));
            startPolling(started.job_id, requestGeneration, draftIdentity);
        } catch (error) {
            if (
                disposedRef.current
                || requestGeneration !== generationRef.current
                || expectedDraftIdentityRef.current !== draftIdentity
            ) {
                return;
            }
            setState((current) => ({
                busy: false,
                error: readFriendlyError(error, 'AI 识别失败。'),
                result: null,
                jobId: null,
                progress: 0,
                requestGeneration,
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
        adopted: state.adopted,
        fieldOrigins: state.fieldOrigins,
        recognize,
        clear,
        adoptField,
        markFieldManualEdit,
        invalidateIfDraftMismatch,
        invalidateIfSnapshotMismatch,
    };
}
