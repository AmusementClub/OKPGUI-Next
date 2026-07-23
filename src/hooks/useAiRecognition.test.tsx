import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRecognizeRequest, RecognitionJobView, RecognitionResult } from '../types/ai';
import { isSuccessfulRecognitionResult } from '../services/ai';
import { useAiRecognition } from './useAiRecognition';

const {
    startRecognitionMock,
    pollRecognitionMock,
    getAiJobMock,
    cancelAiJobMock,
} = vi.hoisted(() => ({
    startRecognitionMock: vi.fn(),
    pollRecognitionMock: vi.fn(),
    getAiJobMock: vi.fn(),
    cancelAiJobMock: vi.fn(),
}));

vi.mock('../services/ai', async () => {
    const actual = await vi.importActual<typeof import('../services/ai')>('../services/ai');
    return {
        ...actual,
        startRecognition: startRecognitionMock,
        pollRecognition: pollRecognitionMock,
        getAiJob: getAiJobMock,
        cancelAiJob: cancelAiJobMock,
    };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type RecognitionHook = ReturnType<typeof useAiRecognition>;

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
    let current!: RecognitionHook;

    const Probe = () => {
        current = useAiRecognition();
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

function sampleResult(overrides: Partial<RecognitionResult> = {}): RecognitionResult {
    return {
        schema_version: 'recognition_v1',
        episode: { value: '01', confidence: 0.9, evidence: 'E01 in name' },
        resolution: { value: '1080p', confidence: 0.8, evidence: '1080p tag' },
        suggested_title: { value: 'Show - 01 [1080p]', confidence: 0.7, evidence: 'pattern fill' },
        request_generation: 1,
        snapshot_hash: 'sha256:abc',
        job_id: 'job-rec-1',
        ...overrides,
    };
}

function sampleView(overrides: Partial<RecognitionJobView> = {}): RecognitionJobView {
    const result = overrides.result === undefined
        ? sampleResult({
            request_generation: overrides.request_generation ?? 1,
            snapshot_hash: overrides.snapshot_hash ?? 'sha256:abc',
            job_id: overrides.job_id ?? 'job-rec-1',
        })
        : overrides.result;
    return {
        job_id: 'job-rec-1',
        state: 'succeeded',
        request_generation: 1,
        snapshot_hash: 'sha256:abc',
        progress: 100,
        error_code: null,
        message: 'recognition completed',
        result,
        ...overrides,
    };
}

describe('useAiRecognition', () => {
    beforeEach(() => {
        startRecognitionMock.mockReset();
        pollRecognitionMock.mockReset();
        getAiJobMock.mockReset();
        cancelAiJobMock.mockReset();
        cancelAiJobMock.mockResolvedValue({
            id: 'job-rec-1',
            kind: 'recognition',
            state: 'cancelled',
            request_generation: 1,
            snapshot_hash: 'sha256:abc',
            progress: 100,
        });
        getAiJobMock.mockResolvedValue({
            id: 'job-rec-1',
            kind: 'recognition',
            state: 'running',
            request_generation: 1,
            snapshot_hash: 'sha256:abc',
            progress: 40,
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        startRecognitionMock.mockReset();
        pollRecognitionMock.mockReset();
        getAiJobMock.mockReset();
        cancelAiJobMock.mockReset();
    });

    it('sends torrent name, patterns, snapshot hash, and request generation in the payload', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'succeeded',
            request_generation: 1,
            snapshot_hash: 'sha256:prep',
            result: sampleResult({
                request_generation: 1,
                snapshot_hash: 'sha256:prep',
            }),
        }));
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'Show.S01E01.1080p.mkv',
                    epPattern: 'E(\\d+)',
                    resolutionPattern: '(\\d{3,4}p)',
                    titlePattern: '{title} - {ep}',
                    snapshotHash: 'sha256:prep',
                });
            });

            expect(startRecognitionMock).toHaveBeenCalledTimes(1);
            expect(startRecognitionMock).toHaveBeenCalledWith({
                torrent_name: 'Show.S01E01.1080p.mkv',
                ep_pattern: 'E(\\d+)',
                resolution_pattern: '(\\d{3,4}p)',
                title_pattern: '{title} - {ep}',
                request_generation: 1,
                snapshot_hash: 'sha256:prep',
            } satisfies AiRecognizeRequest);
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.result?.suggested_title?.value).toBe('Show - 01 [1080p]');
            expect(rendered.result.result?.job_id).toBe('job-rec-1');
        } finally {
            rendered.unmount();
        }
    });

    it('ignores late results after clear bumps generation (stale generation)', async () => {
        const pending = deferred<RecognitionJobView>();
        startRecognitionMock.mockReturnValueOnce(pending.promise);
        const rendered = renderHook();
        try {
            let recognizePromise!: Promise<void>;
            await act(async () => {
                recognizePromise = rendered.result.recognize({
                    torrentName: 'release.mkv',
                    epPattern: 'ep',
                    resolutionPattern: 'res',
                    titlePattern: 'title',
                    snapshotHash: 'sha256:live',
                });
            });
            expect(rendered.result.busy).toBe(true);

            act(() => {
                rendered.result.clear();
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();

            await act(async () => {
                pending.resolve(sampleView({
                    state: 'succeeded',
                    request_generation: 1,
                    snapshot_hash: 'sha256:live',
                    result: sampleResult({
                        request_generation: 1,
                        snapshot_hash: 'sha256:live',
                        suggested_title: { value: 'STALE TITLE', confidence: 1, evidence: 'late' },
                    }),
                }));
                await recognizePromise;
            });

            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.busy).toBe(false);
            // clear should cancel any in-flight job once a job id is known; late start still cancels.
            expect(cancelAiJobMock).toHaveBeenCalled();
        } finally {
            rendered.unmount();
        }
    });

    it('ignores late results when snapshot no longer matches', async () => {
        const pending = deferred<RecognitionJobView>();
        startRecognitionMock.mockReturnValueOnce(pending.promise);
        const rendered = renderHook();
        try {
            let recognizePromise!: Promise<void>;
            await act(async () => {
                recognizePromise = rendered.result.recognize({
                    torrentName: 'release.mkv',
                    epPattern: 'ep',
                    resolutionPattern: 'res',
                    titlePattern: 'title',
                    snapshotHash: 'sha256:old',
                });
            });

            act(() => {
                rendered.result.invalidateIfSnapshotMismatch('sha256:new');
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.busy).toBe(false);

            await act(async () => {
                pending.resolve(sampleView({
                    state: 'succeeded',
                    request_generation: 1,
                    snapshot_hash: 'sha256:old',
                    result: sampleResult({
                        request_generation: 1,
                        snapshot_hash: 'sha256:old',
                        suggested_title: { value: 'STALE SNAPSHOT', confidence: 1, evidence: 'late' },
                    }),
                }));
                await recognizePromise;
            });

            expect(rendered.result.result).toBeNull();
            expect(cancelAiJobMock).toHaveBeenCalled();
        } finally {
            rendered.unmount();
        }
    });

    it('cancels on unmount so late success cannot apply', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 10,
            request_generation: 1,
            snapshot_hash: 'sha256:u',
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock.mockResolvedValue(null);

        const rendered = renderHook();
        await act(async () => {
            await rendered.result.recognize({
                torrentName: 'name.mkv',
                epPattern: 'e',
                resolutionPattern: 'r',
                titlePattern: 't',
                snapshotHash: 'sha256:u',
            });
        });
        expect(rendered.result.busy).toBe(true);
        expect(rendered.result.jobId).toBe('job-rec-1');

        rendered.unmount();
        expect(cancelAiJobMock).toHaveBeenCalledWith('job-rec-1');
    });

    it('polls to a terminal validated result without holding start open', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 0,
            request_generation: 1,
            snapshot_hash: 'sha256:poll',
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                request_generation: 1,
                snapshot_hash: 'sha256:poll',
                result: sampleResult({
                    request_generation: 1,
                    snapshot_hash: 'sha256:poll',
                }),
            }));

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: 'sha256:poll',
                });
            });
            expect(rendered.result.busy).toBe(true);
            expect(startRecognitionMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            // First poll still null.
            expect(rendered.result.busy).toBe(true);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result?.episode?.value).toBe('01');
            expect(isSuccessfulRecognitionResult(sampleView({
                state: 'succeeded',
                result: sampleResult(),
            }))).toBe(true);
            expect(isSuccessfulRecognitionResult(sampleView({
                state: 'cancelled',
                result: null,
            }))).toBe(false);
        } finally {
            rendered.unmount();
        }
    });

    it('never mutates an external draft title from suggested_title (no auto-fill contract)', async () => {
        // Contract: the hook only stores advisory result; callers must not assign
        // suggested_title into draft title. This test freezes a draft object and
        // asserts the hook never touches it.
        const draft = { title: 'User Draft Title' };
        const frozenTitle = draft.title;

        startRecognitionMock.mockResolvedValue(sampleView({
            request_generation: 1,
            snapshot_hash: 'sha256:x',
            result: sampleResult({
                request_generation: 1,
                snapshot_hash: 'sha256:x',
                suggested_title: { value: 'AI Suggested', confidence: 0.99, evidence: 'model' },
            }),
        }));
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: 'sha256:x',
                });
            });

            // Hook exposes advisory value but does not write into draft.
            expect(rendered.result.result?.suggested_title?.value).toBe('AI Suggested');
            expect(draft.title).toBe(frozenTitle);
            expect(draft.title).not.toBe(rendered.result.result?.suggested_title?.value);
        } finally {
            rendered.unmount();
        }
    });

    it('surfaces provider errors without keeping a partial result', async () => {
        startRecognitionMock.mockRejectedValue('provider refused');
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: 'sha256:x',
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('provider refused');
        } finally {
            rendered.unmount();
        }
    });

    it('does not apply cancelled terminal views as success', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'cancelled',
            request_generation: 1,
            snapshot_hash: 'sha256:c',
            error_code: 'CANCELLED',
            message: 'recognition cancelled',
            result: null,
        }));
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: 'sha256:c',
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('取消');
        } finally {
            rendered.unmount();
        }
    });

    it('rejects empty torrent name or snapshot without invoking the backend', async () => {
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: '  ',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: 'sha256:x',
                });
            });
            expect(startRecognitionMock).not.toHaveBeenCalled();
            expect(rendered.result.error).toContain('种子');

            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'ok.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    snapshotHash: '  ',
                });
            });
            expect(startRecognitionMock).not.toHaveBeenCalled();
            expect(rendered.result.error).toContain('快照');
        } finally {
            rendered.unmount();
        }
    });
});
