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
    reviewTemplateRecommendation,
    startTemplateSelection,
    writeAutoTemplateSeedHandoff,
} from '../services/ai';
import type { AiSettings, TemplateRecommendation, TemplateSelectionJobView } from '../types/ai';
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
    /** Backend-owned recommendation shown until explicit Review / Stay / manual. */
    const [recommendation, setRecommendation] = useState<TemplateRecommendation | null>(null);
    const [reviewing, setReviewing] = useState(false);

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

        if (isSuccessfulTemplateSelection(view) && view.recommendation) {
            // Stay on result view with backend recommendation — never mint/write/navigate here.
            setRecommendation(view.recommendation);
            const label = catalog[view.recommendation.template_id]?.name
                || view.recommendation.template_name
                || view.recommendation.template_id;
            setStatus(`已推荐模板“${label}”。请确认后在模板发布中审阅，或手动选择。`);
            setError('');
            return;
        }

        // Fail closed: stay on this page; never write handoff for cancel/stale/failed.
        setRecommendation(null);
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
        setRecommendation(null);
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
        setRecommendation(null);
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

    /** Explicit Review: atomic revalidate + mint seed, then write handoff and navigate. */
    const handleReviewInQuickPublish = useCallback(async () => {
        if (!recommendation?.recommendation_id || reviewing) {
            return;
        }
        setReviewing(true);
        setError('');
        try {
            const result = await reviewTemplateRecommendation(recommendation.recommendation_id);
            if (disposedRef.current) {
                return;
            }
            if (
                (result.status === 'minted' || result.status === 'already_minted')
                && result.seed?.token
                && result.seed.template_id
            ) {
                writeAutoTemplateSeedHandoff(result.seed);
                window.dispatchEvent(new CustomEvent('okpgui:navigate', { detail: 'quick_publish' }));
                setStatus('正在进入模板发布…');
                return;
            }
            if (result.status === 'already_consumed') {
                setError(result.message || '该推荐生成的种子已被模板发布消费，请重新自动选择模板。');
                setRecommendation(null);
                setStatus('');
                return;
            }
            setError(result.message || '无法生成发布种子，请重试或手动选择模板。');
        } catch (reviewError) {
            if (!disposedRef.current) {
                setError(readFriendlyError(reviewError, '审阅并进入发布失败，请重试。'));
            }
        } finally {
            if (!disposedRef.current) {
                setReviewing(false);
            }
        }
    }, [recommendation, reviewing]);

    const handleStayOnResult = useCallback(() => {
        setStatus('已保留推荐结果。需要时再点击“在模板发布中审阅”。');
    }, []);

    const handleChooseManually = useCallback(() => {
        // Never mint: discard local recommendation UI and navigate to Quick Publish empty.
        setRecommendation(null);
        setStatus('');
        setError('');
        window.dispatchEvent(new CustomEvent('okpgui:navigate', { detail: 'quick_publish' }));
    }, []);

    const clearRecommendation = useCallback(() => {
        setRecommendation(null);
        setStatus('');
        setError('');
    }, []);

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
                        由已配置的 AI 从现有模板目录中选择；成功后需你确认再进入模板发布，失败时停留本页，不会修改模板内容。
                    </p>
                </header>
                <section className="space-y-4 rounded-xl border border-slate-700 bg-slate-800/50 p-5">
                    <label className="block text-xs text-slate-500">
                        种子文件路径
                        <input
                            value={torrentPath}
                            onChange={(event) => setTorrentPath(event.target.value)}
                            placeholder="/path/to/file.torrent"
                            disabled={working || reviewing}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 disabled:opacity-60"
                        />
                    </label>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => void selectTemplate()}
                            disabled={working || reviewing}
                            className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
                        >
                            {working ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                            开始自动选择
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
                    {status ? <p className="text-xs text-emerald-300" data-testid="auto-template-status">{status}</p> : null}
                    {error ? <p className="text-xs text-rose-300" data-testid="auto-template-error">{error}</p> : null}
                </section>

                {recommendation ? (
                    <section
                        className="space-y-4 rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-5"
                        data-testid="auto-template-recommendation"
                    >
                        <div>
                            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-cyan-400/80">
                                推荐结果
                            </p>
                            <h3 className="mt-2 text-base font-semibold text-slate-100">
                                {templates[recommendation.template_id]?.name
                                    || recommendation.template_name
                                    || recommendation.template_id}
                            </h3>
                            <p className="mt-1 font-mono text-[11px] text-slate-500">
                                id {recommendation.template_id} · revision {recommendation.template_revision}
                            </p>
                            {recommendation.summary ? (
                                <p className="mt-2 text-sm text-slate-300" data-testid="auto-template-recommendation-summary">
                                    {recommendation.summary}
                                </p>
                            ) : null}
                        </div>
                        {recommendation.alternatives.length > 0 ? (
                            <div data-testid="auto-template-alternatives">
                                <p className="text-xs text-slate-500">其他可选模板</p>
                                <ul className="mt-2 space-y-1.5">
                                    {recommendation.alternatives.map((alt) => (
                                        <li
                                            key={`${alt.template_id}:${alt.template_revision}`}
                                            className="rounded-lg border border-slate-700/80 bg-slate-900/50 px-3 py-2 text-xs text-slate-300"
                                        >
                                            <span className="font-medium text-slate-200">
                                                {templates[alt.template_id]?.name || alt.name || alt.template_id}
                                            </span>
                                            <span className="text-slate-500">
                                                {' '}· rev {alt.template_revision}
                                            </span>
                                            {alt.summary ? (
                                                <p className="mt-0.5 text-slate-500">{alt.summary}</p>
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                data-testid="auto-template-review"
                                onClick={() => void handleReviewInQuickPublish()}
                                disabled={reviewing}
                                className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
                            >
                                {reviewing ? <Loader2 size={15} className="animate-spin" /> : null}
                                在模板发布中审阅
                            </button>
                            <button
                                type="button"
                                data-testid="auto-template-stay"
                                onClick={handleStayOnResult}
                                disabled={reviewing}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60 disabled:opacity-50"
                            >
                                留在此页
                            </button>
                            <button
                                type="button"
                                data-testid="auto-template-choose-manual"
                                onClick={handleChooseManually}
                                disabled={reviewing}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60 disabled:opacity-50"
                            >
                                手动选择
                            </button>
                            <button
                                type="button"
                                data-testid="auto-template-dismiss-recommendation"
                                onClick={clearRecommendation}
                                disabled={reviewing}
                                className="inline-flex items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-sm text-slate-500 hover:text-slate-300 disabled:opacity-50"
                            >
                                关闭结果
                            </button>
                        </div>
                    </section>
                ) : null}
            </div>
        </div>
    );
}
