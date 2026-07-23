import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AiRecognizeRequest,
    RecognitionJobView,
    RecognitionResult,
} from '../types/ai';
import {
    cancelAiJob,
    getAiJob,
    isSuccessfulRecognitionResult,
    pollRecognition,
    readFriendlyError,
    startRecognition,
} from '../services/ai';

export interface AiRecognitionState {
    busy: boolean;
    error: string | null;
    result: RecognitionResult | null;
    jobId: string | null;
    progress: number;
    /** Monotonic edit/request generation; late results must match this value. */
    requestGeneration: number;
}

export interface AiRecognitionRecognizeInput {
    torrentName: string;
    epPattern: string;
    resolutionPattern: string;
    titlePattern: string;
    /** Current backend preflight snapshot hash (identity binding). */
    snapshotHash: string;
}

/** Bounded poll interval for recognition job status (ms). */
const POLL_INTERVAL_MS = 400;

const initialState: AiRecognitionState = {
    busy: false,
    error: null,
    result: null,
    jobId: null,
    progress: 0,
    requestGeneration: 0,
};

/**
 * Advisory release recognition via backend-owned start / poll / cancel lifecycle.
 * Never mutates draft title/episode/resolution, never auto-fills, never changes publish decisions.
 * Cancels on clear/unmount/new request. Late results are ignored unless both request generation
 * and snapshot hash still match. Cancelled/stale jobs never apply a recognition result.
 */
export function useAiRecognition() {
    const [state, setState] = useState<AiRecognitionState>(initialState);
    const generationRef = useRef(0);
    /** Snapshot hash expected by the in-flight or last-applied recognition. */
    const expectedSnapshotRef = useRef<string | null>(null);
    const jobIdRef = useRef<string | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const disposedRef = useRef(false);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current != null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        disposedRef.current = false;
        return () => {
            disposedRef.current = true;
            // Bump so any in-flight poll cannot commit after unmount.
            generationRef.current += 1;
            expectedSnapshotRef.current = null;
            const jobId = jobIdRef.current;
            jobIdRef.current = null;
            stopPolling();
            if (jobId) {
                void cancelAiJob(jobId).catch(() => undefined);
            }
        };
    }, [stopPolling]);

    /**
     * Invalidate recognition on covered edits or snapshot drift.
     * Cancels the backend job and bumps generation so late polls cannot remain active.
     */
    const clear = useCallback(() => {
        generationRef.current += 1;
        expectedSnapshotRef.current = null;
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState({
            busy: false,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration: generationRef.current,
        });
    }, [stopPolling]);

    /**
     * Drop active result/error when the live preflight snapshot no longer matches.
     * Cancels in-flight work; bumps generation when clearing a bound snapshot.
     */
    const invalidateIfSnapshotMismatch = useCallback((currentSnapshotHash: string | null | undefined) => {
        const expected = expectedSnapshotRef.current;
        const live = currentSnapshotHash?.trim() || null;
        if (!expected) {
            return;
        }
        if (live && live === expected) {
            return;
        }
        generationRef.current += 1;
        expectedSnapshotRef.current = null;
        const jobId = jobIdRef.current;
        jobIdRef.current = null;
        stopPolling();
        if (jobId) {
            void cancelAiJob(jobId).catch(() => undefined);
        }
        setState({
            busy: false,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration: generationRef.current,
        });
    }, [stopPolling]);

    const applyTerminal = useCallback((
        view: RecognitionJobView,
        requestGeneration: number,
        snapshotHash: string,
    ) => {
        if (
            disposedRef.current
            || requestGeneration !== generationRef.current
            || expectedSnapshotRef.current !== snapshotHash
            || view.request_generation !== requestGeneration
            || view.snapshot_hash !== snapshotHash
        ) {
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
            setState({
                busy: false,
                error: friendly
                    ? readFriendlyError(friendly, 'AI 识别失败。')
                    : readFriendlyError(view.error_code, 'AI 识别失败。'),
                result: null,
                jobId: view.job_id,
                progress: 100,
                requestGeneration,
            });
            jobIdRef.current = null;
            return;
        }

        // Extra identity check on the nested result payload.
        if (
            view.result.request_generation !== requestGeneration
            || view.result.snapshot_hash !== snapshotHash
        ) {
            return;
        }

        setState({
            busy: false,
            error: null,
            result: view.result,
            jobId: view.job_id,
            progress: 100,
            requestGeneration,
        });
        jobIdRef.current = null;
    }, []);

    const startPolling = useCallback((
        jobId: string,
        requestGeneration: number,
        snapshotHash: string,
    ) => {
        stopPolling();
        pollTimerRef.current = setInterval(() => {
            void (async () => {
                if (
                    disposedRef.current
                    || requestGeneration !== generationRef.current
                    || expectedSnapshotRef.current !== snapshotHash
                    || jobIdRef.current !== jobId
                ) {
                    stopPolling();
                    return;
                }
                try {
                    // Progress from read-only job status (never forges completion).
                    const job = await getAiJob(jobId);
                    if (
                        job
                        && requestGeneration === generationRef.current
                        && jobIdRef.current === jobId
                    ) {
                        setState((current) => ({
                            ...current,
                            progress: job.progress ?? current.progress,
                        }));
                    }

                    const polled = await pollRecognition(jobId);
                    if (polled == null) {
                        return;
                    }
                    stopPolling();
                    applyTerminal(polled, requestGeneration, snapshotHash);
                } catch (error) {
                    if (
                        disposedRef.current
                        || requestGeneration !== generationRef.current
                        || jobIdRef.current !== jobId
                    ) {
                        return;
                    }
                    stopPolling();
                    jobIdRef.current = null;
                    setState({
                        busy: false,
                        error: readFriendlyError(error, 'AI 识别轮询失败。'),
                        result: null,
                        jobId,
                        progress: 0,
                        requestGeneration,
                    });
                }
            })();
        }, POLL_INTERVAL_MS);
    }, [applyTerminal, stopPolling]);

    /**
     * Start backend recognition (non-blocking IPC) and poll until terminal.
     * Cancels any prior in-flight job; rejects stale generation/snapshot results.
     */
    const recognize = useCallback(async (input: AiRecognitionRecognizeInput): Promise<void> => {
        const snapshotHash = input.snapshotHash.trim();
        const torrentName = input.torrentName.trim();
        if (!snapshotHash || !torrentName) {
            setState((current) => ({
                ...current,
                busy: false,
                error: !torrentName
                    ? '识别需要有效的种子显示名称。'
                    : '识别需要当前发布前检查快照。',
            }));
            return;
        }

        // Cancel any prior in-flight job; bump generation so late polls cannot commit.
        const previousJob = jobIdRef.current;
        if (previousJob) {
            void cancelAiJob(previousJob).catch(() => undefined);
        }
        stopPolling();

        const requestGeneration = ++generationRef.current;
        expectedSnapshotRef.current = snapshotHash;
        jobIdRef.current = null;
        setState({
            busy: true,
            error: null,
            result: null,
            jobId: null,
            progress: 0,
            requestGeneration,
        });

        const request: AiRecognizeRequest = {
            torrent_name: torrentName,
            ep_pattern: input.epPattern ?? '',
            resolution_pattern: input.resolutionPattern ?? '',
            title_pattern: input.titlePattern ?? '',
            request_generation: requestGeneration,
            snapshot_hash: snapshotHash,
        };

        try {
            const started = await startRecognition(request);
            if (
                disposedRef.current
                || requestGeneration !== generationRef.current
                || expectedSnapshotRef.current !== snapshotHash
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
                applyTerminal(started, requestGeneration, snapshotHash);
                return;
            }

            setState({
                busy: true,
                error: null,
                result: null,
                jobId: started.job_id,
                progress: started.progress ?? 0,
                requestGeneration,
            });
            startPolling(started.job_id, requestGeneration, snapshotHash);
        } catch (error) {
            if (
                disposedRef.current
                || requestGeneration !== generationRef.current
                || expectedSnapshotRef.current !== snapshotHash
            ) {
                return;
            }
            setState({
                busy: false,
                error: readFriendlyError(error, 'AI 识别失败。'),
                result: null,
                jobId: null,
                progress: 0,
                requestGeneration,
            });
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
        recognize,
        clear,
        invalidateIfSnapshotMismatch,
    };
}
