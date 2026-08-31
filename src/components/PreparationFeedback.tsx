import { useEffect, useRef } from 'react';
import { AlertCircle, RotateCcw, X } from 'lucide-react';

export interface PreparationFeedbackProps {
    /** User-visible error (already sanitized; never secrets/paths/provider bodies). */
    error: string | null | undefined;
    /** Optional non-error status line shown when no error. */
    status?: string | null;
    /** Optional page-specific action rendered alongside retry/dismiss (e.g. navigate to settings). */
    errorAction?: { label: string; onClick: () => void } | null;
    /** Retry prepare / re-run the failed preparation step. */
    onRetry?: (() => void) | null;
    /** Dismiss the error banner without retrying. */
    onDismiss?: (() => void) | null;
    /** When true, focus the banner for accessibility after an error appears. */
    autoFocus?: boolean;
    /** Disable retry while prepare is in flight or reconciling. */
    retryDisabled?: boolean;
    className?: string;
}

/**
 * Shared preparation feedback surface for HomePage and QuickPublishPage.
 * Same error presentation contract: error text, optional Retry / Dismiss, focus target.
 * Page-specific preparation ordering stays in the pages.
 */
export default function PreparationFeedback({
    error,
    status,
    errorAction,
    onRetry,
    onDismiss,
    autoFocus = true,
    retryDisabled = false,
    className = '',
}: PreparationFeedbackProps) {
    const bannerRef = useRef<HTMLDivElement | null>(null);
    const hasError = Boolean(error?.trim());
    const hasStatus = Boolean(status?.trim()) && !hasError;

    useEffect(() => {
        if (hasError && autoFocus && bannerRef.current) {
            bannerRef.current.focus();
        }
    }, [autoFocus, error, hasError]);

    if (!hasError && !hasStatus) {
        return null;
    }

    if (hasStatus) {
        return (
            <div
                className={`rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100${
                    className ? ` ${className}` : ''
                }`}
                data-testid="preparation-feedback-status"
                role="status"
            >
                {status}
            </div>
        );
    }

    return (
        <div
            ref={bannerRef}
            tabIndex={-1}
            role="alert"
            data-testid="preparation-feedback-error"
            className={`rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60${
                className ? ` ${className}` : ''
            }`}
        >
            <div className="flex items-start gap-3">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-300" aria-hidden />
                <div className="min-w-0 flex-1 space-y-2">
                    <p data-testid="preparation-feedback-message">{error}</p>
                    {(errorAction || onRetry || onDismiss) ? (
                        <div className="flex flex-wrap items-center gap-2">
                            {errorAction ? (
                                <button
                                    type="button"
                                    data-testid="preparation-feedback-action"
                                    onClick={errorAction.onClick}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-100 hover:bg-rose-500/20"
                                >
                                    {errorAction.label}
                                </button>
                            ) : null}
                            {onRetry ? (
                                <button
                                    type="button"
                                    data-testid="preparation-feedback-retry"
                                    onClick={onRetry}
                                    disabled={retryDisabled}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-100 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <RotateCcw size={12} aria-hidden />
                                    重试
                                </button>
                            ) : null}
                            {onDismiss ? (
                                <button
                                    type="button"
                                    data-testid="preparation-feedback-dismiss"
                                    onClick={onDismiss}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600/60 bg-slate-900/40 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
                                >
                                    <X size={12} aria-hidden />
                                    关闭
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
