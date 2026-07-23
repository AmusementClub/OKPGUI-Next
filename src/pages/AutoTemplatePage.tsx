import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainCircuit, FileSearch, Loader2, Send, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import {
    cancelAiJob,
    getAiJob,
    getAiSettings,
    isAiConfigured,
    isSuccessfulTemplateSelection,
    pollTemplateSelection,
    readFriendlyError,
    startTemplateSelection,
    writeAutoTemplateSeedHandoff,
} from '../services/ai';
import type { AiSettings, TemplateSelectionJobView } from '../types/ai';
import type { QuickPublishConfigPayload, QuickPublishTemplate } from '../utils/quickPublish';

const POLL_INTERVAL_MS = 400;
/** Fail closed after this wall-clock budget; cancel backend job and do not hand off. */
const SELECTION_TIMEOUT_MS = 90_000;

export default function AutoTemplatePage() {
    const [torrentPath, setTorrentPath] = useState('');
    const [settings, setSettings] = useState<AiSettings | null>(null);
    const [templates, setTemplates] = useState<Record<string, Partial<QuickPublishTemplate>>>({});
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [working, setWorking] = useState(false);
    const [progress, setProgress] = useState(0);
    const [jobId, setJobId] = useState<string | null>(null);

    const disposedRef = useRef(false);
    const jobIdRef = useRef<string | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Monotonic claim epoch: cancel/timeout/unmount/terminal apply bump this so late polls cannot hand off. */
    const generationRef = useRef(0);
    /** Prevents overlapping async poll ticks from applying terminal state concurrently. */
    const pollInFlightRef = useRef(false);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current != null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
        if (timeoutTimerRef.current != null) {
            clearTimeout(timeoutTimerRef.current);
            timeoutTimerRef.current = null;
        }
        // Do not clear pollInFlightRef here: an already-awaiting tick must keep the latch
        // until its finally runs (or a new startPolling/invalidateClaim resets it).
    }, []);

    const clearActiveJob = useCallback(() => {
        jobIdRef.current = null;
        setJobId(null);
    }, []);

    /** Invalidate any in-flight poll/start so a late success cannot claim handoff. */
    const invalidateClaim = useCallback(() => {
        generationRef.current += 1;
        pollInFlightRef.current = false;
    }, []);

    const isClaimActive = useCallback((generation: number, activeJobId?: string | null) => {
        if (disposedRef.current || generation !== generationRef.current) {
            return false;
        }
        if (activeJobId !== undefined && jobIdRef.current !== activeJobId) {
            return false;
        }
        return true;
    }, []);

    useEffect(() => {
        disposedRef.current = false;
        let disposed = false;
        void Promise.all([getAiSettings(), invoke<QuickPublishConfigPayload>('get_config')]).then(([nextSettings, config]) => {
            if (disposed) return;
            setSettings(nextSettings);
            setTemplates(config.quick_publish_templates ?? {});
        }).catch((loadError) => {
            if (!disposed) setError(readFriendlyError(loadError, '加载自动选模板数据失败。'));
        });
        return () => {
            disposed = true;
            disposedRef.current = true;
            // Invalidate claim before teardown so an already-awaiting poll cannot hand off.
            generationRef.current += 1;
            pollInFlightRef.current = false;
            stopPolling();
            // Cancel any in-flight job on unmount so late completion cannot hand off.
            const active = jobIdRef.current;
            if (active) {
                void cancelAiJob(active).catch(() => undefined);
            }
            jobIdRef.current = null;
        };
    }, [stopPolling]);

    const applyTerminal = useCallback((
        view: TemplateSelectionJobView,
        generation: number,
        catalog: Record<string, Partial<QuickPublishTemplate>>,
    ) => {
        // Single-flight terminal claim: refuse if cancelled/timed out/unmounted/already claimed.
        if (disposedRef.current || generation !== generationRef.current) {
            return;
        }
        // Consume the claim immediately so overlapping ticks cannot also succeed/navigate.
        generationRef.current += 1;
        pollInFlightRef.current = false;
        stopPolling();
        clearActiveJob();
        setProgress(100);
        setWorking(false);

        if (isSuccessfulTemplateSelection(view) && view.seed) {
            // Opaque handoff only after validated succeeded result — token + public template id.
            writeAutoTemplateSeedHandoff(view.seed);
            window.dispatchEvent(new CustomEvent('okpgui:navigate', { detail: 'quick_publish' }));
            const label = catalog[view.seed.template_id]?.name || view.seed.template_id;
            setStatus(`已选择模板“${label}”，正在进入模板发布。`);
            setError('');
            return;
        }

        // Fail closed: stay on this page; never write handoff for cancel/stale/failed.
        if (view.state === 'cancelled') {
            setError(view.message || '自动选择已取消。');
            setStatus('');
            return;
        }
        if (view.state === 'stale') {
            setError(view.message || '自动选择结果已过期，请重试。');
            setStatus('');
            return;
        }
        const detail = view.message
            || view.error_code
            || '自动选择未返回有效模板，请手动选择模板发布。';
        setError(detail);
        setStatus('');
    }, [clearActiveJob, stopPolling]);

    const startPolling = useCallback((
        activeJobId: string,
        generation: number,
        catalog: Record<string, Partial<QuickPublishTemplate>>,
    ) => {
        stopPolling();
        pollInFlightRef.current = false;
        pollTimerRef.current = setInterval(() => {
            // Serialize ticks: skip while a previous poll cycle is still awaiting IPC.
            if (pollInFlightRef.current) {
                return;
            }
            if (!isClaimActive(generation, activeJobId)) {
                stopPolling();
                return;
            }
            pollInFlightRef.current = true;
            void (async () => {
                try {
                    if (!isClaimActive(generation, activeJobId)) {
                        stopPolling();
                        return;
                    }
                    const job = await getAiJob(activeJobId);
                    if (isClaimActive(generation, activeJobId) && job) {
                        setProgress(job.progress ?? 0);
                        if (job.state === 'running' || job.state === 'queued') {
                            setStatus(
                                job.state === 'queued'
                                    ? '自动选择排队中…'
                                    : `正在自动选择模板… ${job.progress ?? 0}%`,
                            );
                        }
                    }

                    if (!isClaimActive(generation, activeJobId)) {
                        return;
                    }
                    const polled = await pollTemplateSelection(activeJobId);
                    // Re-check after every await: cancel/timeout/unmount must refuse late success.
                    if (!isClaimActive(generation, activeJobId)) {
                        return;
                    }
                    if (polled == null) {
                        return;
                    }
                    applyTerminal(polled, generation, catalog);
                } catch (pollError) {
                    if (!isClaimActive(generation, activeJobId)) {
                        return;
                    }
                    // Consume claim so a concurrent late success cannot hand off after poll error.
                    generationRef.current += 1;
                    stopPolling();
                    clearActiveJob();
                    setWorking(false);
                    setError(readFriendlyError(pollError, '自动选择轮询失败。'));
                    setStatus('');
                } finally {
                    // Only release the latch if this tick still owns the claim epoch.
                    // A cancel/timeout/new selection may have started a different cycle.
                    if (generation === generationRef.current && jobIdRef.current === activeJobId) {
                        pollInFlightRef.current = false;
                    }
                }
            })();
        }, POLL_INTERVAL_MS);

        timeoutTimerRef.current = setTimeout(() => {
            void (async () => {
                if (!isClaimActive(generation, activeJobId)) {
                    return;
                }
                // Invalidate claim first so any already-awaiting poll cannot hand off or navigate.
                invalidateClaim();
                stopPolling();
                const timedOutId = activeJobId;
                clearActiveJob();
                setWorking(false);
                setProgress(0);
                if (timedOutId) {
                    void cancelAiJob(timedOutId).catch(() => undefined);
                }
                // Timeout must never write handoff or navigate.
                setError('自动选择超时，请重试或手动选择模板发布。');
                setStatus('');
            })();
        }, SELECTION_TIMEOUT_MS);
    }, [applyTerminal, clearActiveJob, invalidateClaim, isClaimActive, stopPolling]);

    const cancelSelection = useCallback(async () => {
        const active = jobIdRef.current;
        stopPolling();
        // Invalidate claim immediately so an already-awaiting poll cannot hand off or navigate.
        // Use the new generation only for this cancel cycle's own cancelled-state UI.
        // Release the poll latch: the abandoned tick's finally will no longer own this epoch.
        const generation = ++generationRef.current;
        pollInFlightRef.current = false;
        clearActiveJob();
        setWorking(false);
        setProgress(0);
        setStatus('');
        if (!active) {
            setError('自动选择已取消。');
            return;
        }
        try {
            const cancelled = await cancelAiJob(active);
            if (disposedRef.current || generation !== generationRef.current) {
                return;
            }
            // Best-effort terminal read; cancel must not hand off a seed.
            // Always surface the intended cancelled UI (Chinese product copy), never a late success.
            try {
                const terminal = await pollTemplateSelection(active);
                if (disposedRef.current || generation !== generationRef.current) {
                    return;
                }
                if (terminal && isSuccessfulTemplateSelection(terminal)) {
                    // Backend should not report success after cancel; still refuse handoff.
                    setError('自动选择已取消。');
                    return;
                }
                if (terminal && (terminal.state === 'cancelled' || cancelled.state === 'cancelled')) {
                    setError('自动选择已取消。');
                    return;
                }
                if (terminal && terminal.state !== 'succeeded') {
                    // Non-success terminal (failed/stale): reuse applyTerminal for consistent fail-closed UI.
                    applyTerminal(terminal, generation, templates);
                    return;
                }
            } catch {
                // fall through
            }
            setError(
                cancelled.state === 'cancelled'
                    ? '自动选择已取消。'
                    : `自动选择已停止（${cancelled.state}）。`,
            );
        } catch (cancelError) {
            if (!disposedRef.current && generation === generationRef.current) {
                setError(readFriendlyError(cancelError, '取消自动选择失败。'));
            }
        }
    }, [applyTerminal, clearActiveJob, stopPolling, templates]);

    const selectTemplate = async () => {
        setError('');
        setStatus('');
        setProgress(0);
        if (!torrentPath.trim()) {
            setError('请先输入种子路径。');
            return;
        }
        if (!settings || !isAiConfigured(settings)) {
            setError('请先在 AI 设置中完成连接和模型配置。');
            return;
        }
        if (Object.keys(templates).length === 0) {
            setError('没有可用于自动选择的发布模板。');
            return;
        }

        // Cancel any prior in-flight job; bump generation so late polls cannot hand off.
        const previousJob = jobIdRef.current;
        if (previousJob) {
            void cancelAiJob(previousJob).catch(() => undefined);
        }
        stopPolling();

        const generation = ++generationRef.current;
        pollInFlightRef.current = false;
        jobIdRef.current = null;
        setJobId(null);
        setWorking(true);
        setStatus('正在启动自动选择…');

        try {
            // Provider-backed selection lives entirely in Rust. The page never picks
            // the first catalog entry or invents a recommendation client-side.
            const started = await startTemplateSelection({ torrent_path: torrentPath.trim() });
            if (disposedRef.current || generation !== generationRef.current) {
                if (started.job_id) {
                    void cancelAiJob(started.job_id).catch(() => undefined);
                }
                return;
            }

            jobIdRef.current = started.job_id;
            setJobId(started.job_id);
            setProgress(started.progress ?? 0);

            if (
                started.state === 'succeeded'
                || started.state === 'failed'
                || started.state === 'cancelled'
                || started.state === 'stale'
            ) {
                applyTerminal(started, generation, templates);
                return;
            }

            setStatus(
                started.state === 'queued'
                    ? '自动选择排队中…'
                    : '正在自动选择模板…',
            );
            startPolling(started.job_id, generation, templates);
        } catch (selectError) {
            if (disposedRef.current || generation !== generationRef.current) {
                return;
            }
            // Fail closed: stay on this page; templates are unmodified; no handoff.
            setWorking(false);
            clearActiveJob();
            setError(readFriendlyError(selectError, '自动选择模板失败。'));
            setStatus('');
        }
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 p-6">
                <header>
                    <div className="flex items-center gap-2 text-cyan-300">
                        <BrainCircuit size={18} />
                        <span className="font-mono text-[11px] uppercase tracking-[0.18em]">AUTO TEMPLATE</span>
                    </div>
                    <h2 className="mt-2 text-xl font-semibold text-slate-100">自动选择模板</h2>
                    <p className="mt-1 text-sm text-slate-500">
                        由已配置的 AI 从现有模板目录中选择；失败时停留本页，不会修改模板内容。
                    </p>
                </header>
                <section className="space-y-4 rounded-xl border border-slate-700 bg-slate-800/50 p-5">
                    <label className="block text-xs text-slate-500">
                        种子文件路径
                        <input
                            value={torrentPath}
                            onChange={(event) => setTorrentPath(event.target.value)}
                            placeholder="/path/to/file.torrent"
                            disabled={working}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 disabled:opacity-60"
                        />
                    </label>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => void selectTemplate()}
                            disabled={working}
                            className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
                        >
                            {working ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                            选择并进入发布
                        </button>
                        {working ? (
                            <button
                                type="button"
                                onClick={() => void cancelSelection()}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60"
                            >
                                <X size={15} />
                                取消
                            </button>
                        ) : null}
                        <span className="text-xs text-slate-500">
                            <FileSearch size={13} className="mr-1 inline" />
                            {Object.keys(templates).length} 个现有模板
                        </span>
                    </div>
                    {working ? (
                        <div className="space-y-1">
                            <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                                <div
                                    className="h-full rounded-full bg-cyan-500 transition-all"
                                    style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
                                />
                            </div>
                            {jobId ? (
                                <p className="font-mono text-[10px] text-slate-600">job {jobId}</p>
                            ) : null}
                        </div>
                    ) : null}
                    {status ? <p className="text-xs text-emerald-300">{status}</p> : null}
                    {error ? <p className="text-xs text-rose-300">{error}</p> : null}
                </section>
            </div>
        </div>
    );
}
