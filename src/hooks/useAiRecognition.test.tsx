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

const BACKEND_HASH = 'sha256:backend-context-abc';
const BACKEND_GEN = 42;

function sampleResult(overrides: Partial<RecognitionResult> = {}): RecognitionResult {
    return {
        schema_version: 'recognition_v1',
        episode: { value: '01', confidence: 0.9, evidence: 'E01 in name' },
        resolution: { value: '1080p', confidence: 0.8, evidence: '1080p tag' },
        suggested_title: { value: 'Show - 01 [1080p]', confidence: 0.7, evidence: 'pattern fill' },
        request_generation: BACKEND_GEN,
        snapshot_hash: BACKEND_HASH,
        job_id: 'job-rec-1',
        ...overrides,
    };
}

function sampleView(overrides: Partial<RecognitionJobView> = {}): RecognitionJobView {
    const result = overrides.result === undefined
        ? sampleResult({
            request_generation: overrides.request_generation ?? BACKEND_GEN,
            snapshot_hash: overrides.snapshot_hash ?? BACKEND_HASH,
            job_id: overrides.job_id ?? 'job-rec-1',
        })
        : overrides.result;
    return {
        job_id: 'job-rec-1',
        state: 'succeeded',
        request_generation: BACKEND_GEN,
        snapshot_hash: BACKEND_HASH,
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
            request_generation: BACKEND_GEN,
            snapshot_hash: BACKEND_HASH,
            progress: 100,
        });
        getAiJobMock.mockResolvedValue({
            id: 'job-rec-1',
            kind: 'recognition',
            state: 'running',
            request_generation: BACKEND_GEN,
            snapshot_hash: BACKEND_HASH,
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

    it('sends content only (no client snapshot_hash or request_generation)', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'succeeded',
            request_generation: BACKEND_GEN,
            snapshot_hash: BACKEND_HASH,
            result: sampleResult(),
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
            } satisfies AiRecognizeRequest);
            const sent = startRecognitionMock.mock.calls[0][0] as Record<string, unknown>;
            expect(sent).not.toHaveProperty('snapshot_hash');
            expect(sent).not.toHaveProperty('request_generation');
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.result?.suggested_title?.value).toBe('Show - 01 [1080p]');
            expect(rendered.result.result?.job_id).toBe('job-rec-1');
            // Backend identity is tracked from start response.
            expect(rendered.result.contextHash).toBe(BACKEND_HASH);
            expect(rendered.result.contextGeneration).toBe(BACKEND_GEN);
        } finally {
            rendered.unmount();
        }
    });

    it('ignores late results after clear bumps local UI epoch', async () => {
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
                    result: sampleResult({
                        suggested_title: { value: 'STALE TITLE', confidence: 1, evidence: 'late' },
                    }),
                }));
                await recognizePromise;
            });

            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.busy).toBe(false);
            expect(cancelAiJobMock).toHaveBeenCalled();
        } finally {
            rendered.unmount();
        }
    });

    it('ignores late results when local context key no longer matches', async () => {
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
                });
            });

            act(() => {
                // Drift local context key (page draft changed); not backend hash.
                rendered.result.invalidateIfDraftMismatch('different\u0001context\u0001key\u0001here');
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.busy).toBe(false);

            await act(async () => {
                pending.resolve(sampleView({
                    state: 'succeeded',
                    result: sampleResult({
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
            });
        });
        expect(rendered.result.busy).toBe(true);
        expect(rendered.result.jobId).toBe('job-rec-1');

        rendered.unmount();
        expect(cancelAiJobMock).toHaveBeenCalledWith('job-rec-1');
    });

    it('cancel() is idempotent and blocks late success from surfacing candidates', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 10,
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock.mockResolvedValue(null);

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                });
            });
            expect(rendered.result.busy).toBe(true);

            act(() => {
                rendered.result.cancel();
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('取消');
            expect(cancelAiJobMock).toHaveBeenCalledWith('job-rec-1');

            // Idempotent second cancel.
            act(() => {
                rendered.result.cancel();
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.result).toBeNull();

            // Late poll success must not apply.
            pollRecognitionMock.mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                result: sampleResult({
                    episode: { value: '99', confidence: 1, evidence: 'late' },
                }),
            }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.adoptField('episode')).toBeNull();
        } finally {
            rendered.unmount();
        }
    });

    it('polls to a terminal validated result without holding start open', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 0,
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                result: sampleResult(),
            }));

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                });
            });
            expect(rendered.result.busy).toBe(true);
            expect(startRecognitionMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
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
            result: null,
            message: 'recognition queued',
        }));
        pollRecognitionMock.mockRejectedValueOnce('poll transport failed');
        cancelAiJobMock.mockRejectedValueOnce(new Error('cancel failed'));

        const rendered = renderHook();
        try {
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
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
            expect(rendered.result.requestGeneration).toBeGreaterThan(1);

            pollRecognitionMock.mockResolvedValueOnce(sampleView({
                state: 'succeeded',
                result: sampleResult({
                    episode: { value: '99', confidence: 1, evidence: 'late' },
                }),
            }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(rendered.result.result).toBeNull();
            expect(rendered.result.error).toContain('poll transport failed');

            // Subsequent recognize can start cleanly with new backend identity.
            const nextHash = 'sha256:retry-context';
            const nextGen = 99;
            startRecognitionMock.mockResolvedValue(sampleView({
                state: 'succeeded',
                request_generation: nextGen,
                snapshot_hash: nextHash,
                job_id: 'job-rec-2',
                result: sampleResult({
                    request_generation: nextGen,
                    snapshot_hash: nextHash,
                    job_id: 'job-rec-2',
                }),
            }));
            await act(async () => {
                await rendered.result.recognize({
                    torrentName: 'name.mkv',
                    epPattern: 'e',
                    resolutionPattern: 'r',
                    titlePattern: 't',
                });
            });
            expect(rendered.result.busy).toBe(false);
            expect(rendered.result.error).toBeNull();
            expect(rendered.result.result?.episode?.value).toBe('01');
            expect(rendered.result.contextHash).toBe(nextHash);
            expect(rendered.result.contextGeneration).toBe(nextGen);
        } finally {
            rendered.unmount();
        }
    });

    it('does not stack overlapping poll ticks while a prior poll await is in flight', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'running',
            progress: 0,
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
                });
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(pollStarts).toBe(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(800);
            });
            expect(pollStarts).toBe(1);

            await act(async () => {
                resolvePoll(null);
            });
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
        const draft = { title: 'User Draft Title', episode: '', resolution: '' };
        const frozenTitle = draft.title;

        startRecognitionMock.mockResolvedValue(sampleView({
            result: sampleResult({
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
                });
            });

            expect(rendered.result.result?.suggested_title?.value).toBe('AI Suggested');
            expect(draft.title).toBe(frozenTitle);
            expect(draft.title).not.toBe(rendered.result.result?.suggested_title?.value);
            expect(draft.episode).toBe('');
            expect(draft.resolution).toBe('');
            // No silent title adopt API — only episode/resolution adoptable.
            expect(rendered.result.adoptField('episode')).toBe('01');
            expect(draft.episode).toBe('');
        } finally {
            rendered.unmount();
        }
    });

    it('explicit per-field adopt is independent and leaves draft untouched until caller applies', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            result: sampleResult(),
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
                });
            });

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
            expect(draft.episode).toBe('manual-ep');
            draft.episode = episode!;

            let resolution: string | null = null;
            act(() => {
                resolution = rendered.result.adoptField('resolution');
            });
            expect(resolution).toBe('1080p');
            expect(rendered.result.adopted.resolution).toBe(true);
            expect(draft.resolution).toBe('manual-res');
            draft.resolution = resolution!;

            act(() => {
                rendered.result.markFieldManualEdit('episode');
            });
            expect(rendered.result.fieldOrigins.episode.origin).toBe('manual');
            expect(rendered.result.result?.episode?.value).toBe('01');
            expect(rendered.result.adopted.resolution).toBe(true);
            let reAdopt: string | null = null;
            act(() => {
                reAdopt = rendered.result.adoptField('episode');
            });
            expect(reAdopt).toBe('01');

            startRecognitionMock.mockResolvedValue(sampleView({
                state: 'failed',
                request_generation: BACKEND_GEN + 1,
                snapshot_hash: BACKEND_HASH,
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

    it('rejects empty torrent name without invoking the backend', async () => {
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

            startRecognitionMock.mockResolvedValue(sampleView({
                result: sampleResult(),
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
                }),
            );
            const sent = startRecognitionMock.mock.calls[0][0] as Record<string, unknown>;
            expect(sent).not.toHaveProperty('snapshot_hash');
            expect(sent).not.toHaveProperty('request_generation');
            expect(rendered.result.error).toBeNull();
        } finally {
            rendered.unmount();
        }
    });

    it('fails closed when succeeded view has nested result identity mismatch (does not stay busy)', async () => {
        startRecognitionMock.mockResolvedValue(sampleView({
            state: 'succeeded',
            request_generation: BACKEND_GEN,
            snapshot_hash: BACKEND_HASH,
            job_id: 'job-nested-mismatch',
            result: sampleResult({
                // Nested payload drifts from the outer view / backend binding.
                request_generation: 99,
                snapshot_hash: 'sha256:nested-stale',
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
                });
            });

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
