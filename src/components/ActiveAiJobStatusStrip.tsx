import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
    cancelActiveAiJob,
    listActiveAiJobs,
    PREFLIGHT_SESSION_CHANGED_EVENT,
    readFriendlyError,
} from '../services/ai';
import type { ActiveAiJobSummary } from '../types/ai';
import { listen } from '@tauri-apps/api/event';

const POLL_INTERVAL_MS = 1200;

function kindLabel(kind: ActiveAiJobSummary['kind']): string {
    switch (kind) {
        case 'audit':
            return '发布前检查';
        case 'recognition':
            return '识别';
        case 'template_selection':
            return '自动选模板';
        case 'media_info':
            return '媒体信息';
        case 'vision':
            return '视觉';
        case 'capability_probe':
            return '能力探测';
        default:
            return 'AI 任务';
    }
}

/**
 * Lightweight global strip of active AI jobs only.
 * Not a task center: completed items disappear; no secrets/paths/provider bodies.
 */
export default function ActiveAiJobStatusStrip() {
    const [jobs, setJobs] = useState<ActiveAiJobSummary[]>([]);
    const [cancellingIds, setCancellingIds] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);
    const disposedRef = useRef(false);

    const refresh = useCallback(async () => {
        try {
            const next = await listActiveAiJobs();
            if (disposedRef.current) return;
            setJobs(Array.isArray(next) ? next : []);
            setError(null);
        } catch (loadError) {
            if (!disposedRef.current) {
                // Keep prior list on transient poll failure; surface a brief note.
                setError(readFriendlyError(loadError, '无法刷新后台 AI 任务。'));
            }
        }
    }, []);

    useEffect(() => {
        disposedRef.current = false;
        void refresh();
        const timer = setInterval(() => {
            void refresh();
        }, POLL_INTERVAL_MS);

        let unlisten: (() => void) | undefined;
        void listen(PREFLIGHT_SESSION_CHANGED_EVENT, () => {
            void refresh();
        }).then((fn) => {
            if (disposedRef.current) {
                fn();
                return;
            }
            unlisten = fn;
        }).catch(() => undefined);

        return () => {
            disposedRef.current = true;
            clearInterval(timer);
            unlisten?.();
        };
    }, [refresh]);

    const handleCancel = useCallback(async (jobId: string) => {
        setCancellingIds((current) => ({ ...current, [jobId]: true }));
        try {
            await cancelActiveAiJob(jobId);
            await refresh();
        } catch (cancelError) {
            if (!disposedRef.current) {
                setError(readFriendlyError(cancelError, '取消后台任务失败。'));
            }
        } finally {
            if (!disposedRef.current) {
                setCancellingIds((current) => {
                    const next = { ...current };
                    delete next[jobId];
                    return next;
                });
            }
        }
    }, [refresh]);

    const handleNavigate = useCallback((target: string) => {
        window.dispatchEvent(new CustomEvent('okpgui:navigate', { detail: target }));
    }, []);

    if (jobs.length === 0 && !error) {
        return null;
    }

    return (
        <div
            data-testid="active-ai-job-status-strip"
            className="border-b border-slate-800 bg-slate-950/90 px-3 py-1.5"
            role="status"
            aria-live="polite"
        >
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    AI 后台
                </span>
                {jobs.map((job) => {
                    const busy = Boolean(cancellingIds[job.job_id]);
                    return (
                        <div
                            key={job.job_id}
                            data-testid={`active-ai-job-${job.job_id}`}
                            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200"
                        >
                            <Loader2 size={12} className="shrink-0 animate-spin text-cyan-400" aria-hidden />
                            <span className="truncate">
                                <span className="font-medium text-slate-100">{kindLabel(job.kind)}</span>
                                <span className="text-slate-500"> · </span>
                                <span className="text-slate-300">{job.stage}</span>
                                {job.progress > 0 ? (
                                    <span className="text-slate-500"> {Math.min(100, job.progress)}%</span>
                                ) : null}
                            </span>
                            {job.navigation_target ? (
                                <button
                                    type="button"
                                    data-testid={`active-ai-job-nav-${job.job_id}`}
                                    onClick={() => handleNavigate(job.navigation_target!)}
                                    className="shrink-0 text-[11px] text-cyan-300 hover:text-cyan-200"
                                >
                                    查看
                                </button>
                            ) : null}
                            {job.cancellable ? (
                                <button
                                    type="button"
                                    data-testid={`active-ai-job-cancel-${job.job_id}`}
                                    onClick={() => void handleCancel(job.job_id)}
                                    disabled={busy}
                                    aria-label={`取消${kindLabel(job.kind)}`}
                                    className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                                >
                                    <X size={11} aria-hidden />
                                    取消
                                </button>
                            ) : null}
                        </div>
                    );
                })}
                {error ? (
                    <span className="text-[11px] text-rose-300" data-testid="active-ai-job-strip-error">
                        {error}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
