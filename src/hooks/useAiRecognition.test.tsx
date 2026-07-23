import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRecognizeRequest, RecognitionJobView, RecognitionResult } from '../types/ai';
import { buildRecognitionDraftIdentity } from '../types/ai';
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

    it('sends torrent name, patterns, draft identity, and request generation (no plan token)', async () => {
        const draftIdentity = buildRecognitionDraftIdentity({
            torrentName: 'Show.S01E01.1080p.mkv',
            epPattern: 'E(\\d+)',
            resolutionPattern: '(\\d{3,4}p)',
            titlePattern: '{title} - {ep}',
        });
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'succeeded',
            request_generation: 1,
            snapshot_hash: draftIdentity,
            result: sampleResult({
                request_generation: 1,
                snapshot_hash: draftIdentity,
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
                });
            });

            expect(startRecognitionMock).toHaveBeenCalledTimes(1);
            expect(startRecognitionMock).toHaveBeenCalledWith({
                torrent_name: 'Show.S01E01.1080p.mkv',
                ep_pattern: 'E(\\d+)',
                resolution_pattern: '(\\d{3,4}p)',
                title_pattern: '{title} - {ep}',
                request_generation: 1,
                snapshot_hash: draftIdentity,
            } satisfies AiRecognizeRequest);
            expect(draftIdentity.startsWith('rec:')).toBe(true);
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
                    draftIdentity: 'rec:live',
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
                    snapshot_hash: 'rec:live',
                    result: sampleResult({
                        request_generation: 1,
                        snapshot_hash: 'rec:live',
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

    it('ignores late results when draft identity no longer matches', async () => {
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
                    draftIdentity: 'rec:old',
                });
            });

            act(() => {
                rendered.result.invalidateIfDraftMismatch('rec:new');
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.busy).toBe(false);

            await act(async () => {
                pending.resolve(sampleView({
                    state: 'succeeded',
                    request_generation: 1,
                    snapshot_hash: 'rec:old',
                    result: sampleResult({
                        request_generation: 1,
                        snapshot_hash: 'rec:old',
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
            snapshot_hash: 'rec:u',
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
                draftIdentity: 'rec:u',
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
            snapshot_hash: 'rec:poll',
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                request_generation: 1,
                snapshot_hash: 'rec:poll',
                result: sampleResult({
                    request_generation: 1,
                    snapshot_hash: 'rec:poll',
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
                    draftIdentity: 'rec:poll',
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

    it('cancels backend job and invalidates identity when an active poll tick rejects', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 0,
            request_generation: 1,
            snapshot_hash: 'rec:poll-fail',
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock.mockRejectedValueOnce('poll transport failed');
        // Cancellation failure must not replace the original poll UI error.
        cancelAiJobMock.mockRejectedValueOnce(new Error('cancel failed'));

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: 'rec:poll-fail',
                });
            });
            expect(rendered.result.busy).toBe(true);
            expect(rendered.result.jobId).toBe('job-rec-1');

            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });

            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.jobId).toBeNull();
            expect(rendered.result.error).toContain('poll transport failed');
            expect(rendered.result.error).not.toContain('cancel failed');
            expect(cancelAiJobMock).toHaveBeenCalledWith('job-rec-1');
            // Generation bumped so a later recognize cannot orphan/reuse the failed job binding.
            expect(rendered.result.requestGeneration).toBeGreaterThan(1);

            // Late terminal result for the failed generation must not apply (fail closed).
            pollRecognitionMock.mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                request_generation: 1,
                snapshot_hash: 'rec:poll-fail',
                result: sampleResult({
                    request_generation: 1,
                    snapshot_hash: 'rec:poll-fail',
                    episode: { value: '99', confidence: 1, evidence: 'late' },
                }),
            }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('poll transport failed');

            // A subsequent recognize can start cleanly with a new generation/identity.
            const nextIdentity = 'rec:poll-fail-retry';
            startRecognitionMock.mockResolvedValue(sampleView({
                state: 'succeeded',
                request_generation: rendered.result.requestGeneration + 1,
                snapshot_hash: nextIdentity,
                result: sampleResult({
                    request_generation: rendered.result.requestGeneration + 1,
                    snapshot_hash: nextIdentity,
                }),
            }));
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: nextIdentity,
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.result?.episode?.value).toBe('01');
        } finally {
            rendered.unmount();
        }
    });

    it('does not stack overlapping poll ticks while a prior poll await is in flight', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 0,
            request_generation: 1,
            snapshot_hash: 'rec:overlap',
            result: null,
            message: 'recognition queued',
        }));

        let pollStarts = 0;
        let resolvePoll!: (value: RecognitionJobView | null) => void;
        pollRecognitionMock.mockImplementation(() => {
            pollStarts += 1;
            return new Promise<RecognitionJobView | null>((resolve) => {
                resolvePoll = resolve;
            });
        });

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: 'rec:overlap',
                });
            });

            // First scheduled poll tick.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(pollStarts).toBe(1);

            // While first poll is held open, advancing time must not start a second concurrent poll.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(800);
            });
            expect(pollStarts).toBe(1);

            await act(async () => {
                resolvePoll(null);
            });
            // After the in-flight tick settles null, the next recursive timeout may run.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(pollStarts).toBe(2);

            act(() => {
                rendered.result.clear();
            });
            expect(cancelAiJobMock).toHaveBeenCalled();
        } finally {
            rendered.unmount();
        }
    });

    it('never mutates an external draft title from suggested_title (no auto-fill contract)', async () => {
        // Contract: the hook only stores advisory result; callers must not assign
        // suggested_title into draft title. This test freezes a draft object and
        // asserts the hook never touches it.
        const draft = { title: 'User Draft Title', episode: '', resolution: '' };
        const frozenTitle = draft.title;

        startRecognitionMock.mockResolvedValue(sampleView({
            request_generation: 1,
            snapshot_hash: 'rec:x',
            result: sampleResult({
                request_generation: 1,
                snapshot_hash: 'rec:x',
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
                    draftIdentity: 'rec:x',
                });
            });

            // Hook exposes advisory value but does not write into draft.
            expect(rendered.result.result?.suggested_title?.value).toBe('AI Suggested');
            expect(draft.title).toBe(frozenTitle);
            expect(draft.title).not.toBe(rendered.result.result?.suggested_title?.value);
            expect(draft.episode).toBe('');
            expect(draft.resolution).toBe('');
            // No silent title adopt API.
            expect(rendered.result.adoptField('episode')).toBe('01');
            expect(draft.episode).toBe('');
        } finally {
            rendered.unmount();
        }
    });

    it('explicit per-field adopt is independent and leaves draft untouched until caller applies', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            request_generation: 1,
            snapshot_hash: 'rec:adopt',
            result: sampleResult({
                request_generation: 1,
                snapshot_hash: 'rec:adopt',
            }),
        }));
        const draft = { episode: 'manual-ep', resolution: 'manual-res', title: 'manual-title' };
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: 'rec:adopt',
                });
            });

            // Success is advisory only — draft untouched until explicit adopt + caller apply.
            expect(draft.episode).toBe('manual-ep');
            expect(draft.resolution).toBe('manual-res');
            expect(draft.title).toBe('manual-title');

            let episode: string | null = null;
            act(() => {
                episode = rendered.result.adoptField('episode');
            });
            expect(episode).toBe('01');
            expect(rendered.result.adopted.episode).toBe(true);
            expect(rendered.result.fieldOrigins.episode.origin).toBe('adopted');
            // Hook still does not write the draft; caller decides.
            expect(draft.episode).toBe('manual-ep');
            draft.episode = episode!;

            // Resolution still adoptable independently; episode adopt did not touch it.
            let resolution: string | null = null;
            act(() => {
                resolution = rendered.result.adoptField('resolution');
            });
            expect(resolution).toBe('1080p');
            expect(rendered.result.adopted.resolution).toBe(true);
            expect(draft.resolution).toBe('manual-res');
            draft.resolution = resolution!;

            // Manual mark preserves provenance without clearing advisory result.
            act(() => {
                rendered.result.markFieldManualEdit('episode');
            });
            expect(rendered.result.fieldOrigins.episode.origin).toBe('manual');
            expect(rendered.result.result?.episode?.value).toBe('01');
            // Explicit re-adopt remains available (user intent); other field stays adopted.
            expect(rendered.result.adopted.resolution).toBe(true);
            let reAdopt: string | null = null;
            act(() => {
                reAdopt = rendered.result.adoptField('episode');
            });
            expect(reAdopt).toBe('01');

            // Failure/cancel path never yields adopt values.
            startRecognitionMock.mockResolvedValue(sampleView({
                state: 'failed',
                request_generation: 2,
                snapshot_hash: 'rec:adopt',
                error_code: 'PROVIDER',
                message: 'boom',
                result: null,
            }));
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: 'rec:adopt',
                });
            });
            expect(rendered.result.adoptField('episode')).toBeNull();
            expect(draft.title).toBe('manual-title');
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
                    draftIdentity: 'rec:x',
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('provider refused');
            expect(rendered.result.adoptField('episode')).toBeNull();
        } finally {
            rendered.unmount();
        }
    });

    it('does not apply cancelled terminal views as success', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'cancelled',
            request_generation: 1,
            snapshot_hash: 'rec:c',
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
                    draftIdentity: 'rec:c',
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('取消');
            expect(rendered.result.adoptField('episode')).toBeNull();
        } finally {
            rendered.unmount();
        }
    });

    it('rejects empty torrent name without invoking the backend; derives draft identity when ready', async () => {
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: '  ',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                });
            });
            expect(startRecognitionMock).not.toHaveBeenCalled();
            expect(rendered.result.error).toContain('种子');

            const draftIdentity = buildRecognitionDraftIdentity({
                torrentName: 'ok.mkv',
                epPattern: 'e',
                resolutionPattern: 'r',
                titlePattern: 't',
            });
            startRecognitionMock.mockResolvedValue(sampleView({
                request_generation: 1,
                snapshot_hash: draftIdentity,
                result: sampleResult({
                    request_generation: 1,
                    snapshot_hash: draftIdentity,
                }),
            }));
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'ok.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                });
            });
            expect(startRecognitionMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    torrent_name: 'ok.mkv',
                    snapshot_hash: draftIdentity,
                }),
            );
            expect(rendered.result.error).toBeNull();
        } finally {
            rendered.unmount();
        }
    });

    it('fails closed when succeeded view has nested result identity mismatch (does not stay busy)', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'succeeded',
            request_generation: 1,
            snapshot_hash: 'rec:nested-ok',
            job_id: 'job-nested-mismatch',
            result: sampleResult({
                // Nested payload drifts from the outer view / request binding.
                request_generation: 99,
                snapshot_hash: 'rec:nested-stale',
                job_id: 'job-nested-mismatch',
                episode: { value: '77', confidence: 1, evidence: 'bad' },
            }),
        }));
        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'show.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                    draftIdentity: 'rec:nested-ok',
                });
            });

            // Must not leave the hook permanently busy or apply the mismatched result.
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.jobId).toBeNull();
            expect(rendered.result.error).toContain('过期');
            expect(rendered.result.adoptField('episode')).toBeNull();
            expect(rendered.result.progress).toBe(100);
        } finally {
            rendered.unmount();
        }
    });
});
