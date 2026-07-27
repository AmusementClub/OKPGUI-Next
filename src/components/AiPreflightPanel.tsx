import { AlertTriangle, CheckCircle2, CircleDot, ShieldAlert } from 'lucide-react';
import type { AiPreflightState } from '../hooks/useAiPreflight';
import type { AiPreflightLifecycle } from '../types/ai';

interface AiPreflightPanelProps {
    state: AiPreflightState;
    configured: boolean;
    canConfirm: boolean;
    onAcknowledgementChange: (key: 'warning' | 'critical' | 'pending', checked: boolean) => void;
    onCancel?: () => void;
    onRetry?: () => void;
    onRetryReconciliation?: () => void;
}

function decisionLabel(decision: AiPreflightState['decision']): string {
    switch (decision) {
        case 'GO': return '通过';
        case 'WARNING': return '有提醒';
        case 'NO_GO': return '需要确认';
        case 'PENDING': return '检查中';
        case 'LOCAL_BLOCKED': return '本地阻断';
        default: return '未检查';
    }
}

function lifecycleLabel(lifecycle: AiPreflightLifecycle): string | null {
    switch (lifecycle) {
        case 'preparing':
            return '正在准备发布前检查…';
        case 'auditing':
            return '正在审核冻结草稿…';
        case 'reconciling':
            return '正在对账会话，请稍候…';
        case 'unavailable':
            return '检查状态不可用';
        case 'cancelled':
            return '检查已取消';
        default:
            return null;
    }
}

function isActiveCheck(lifecycle: AiPreflightLifecycle): boolean {
    return lifecycle === 'preparing'
        || lifecycle === 'auditing';
}

export default function AiPreflightPanel({
    state,
    configured,
    canConfirm,
    onAcknowledgementChange,
    onCancel,
    onRetry,
    onRetryReconciliation,
}: AiPreflightPanelProps) {
    const decision = state.decision;
    const lifecycle = state.lifecycle;
    const reconciling = lifecycle === 'reconciling';
    const terminalFailure = lifecycle === 'unavailable' || lifecycle === 'cancelled';
    const showLivePending = decision === 'PENDING'
        && !reconciling
        && !terminalFailure
        && (lifecycle === 'auditing' || lifecycle === 'preparing');

    const tone = reconciling || terminalFailure
        ? 'border-rose-400/30 bg-rose-500/5'
        : decision === 'GO' && lifecycle === 'terminal'
          ? 'border-emerald-400/30 bg-emerald-500/5'
          : decision === 'LOCAL_BLOCKED' || decision === 'NO_GO'
            ? 'border-rose-400/30 bg-rose-500/5'
            : 'border-amber-400/30 bg-amber-500/5';

    const statusLine = lifecycleLabel(lifecycle)
        ?? (!configured
            ? 'AI 未启用，发布沿用本地校验。'
            : state.checking || showLivePending
                ? '正在检查当前冻结草稿。'
                : '检查结果只对应当前冻结草稿。');

    const showCancel = Boolean(onCancel) && isActiveCheck(lifecycle) && !reconciling;
    const showRetry = Boolean(onRetry)
        && (terminalFailure || (Boolean(state.error) && lifecycle === 'idle'))
        && !reconciling;
    const showRetryReconciliation = Boolean(onRetryReconciliation) && reconciling;

    return (
        <section className={`rounded-xl border px-4 py-3 ${tone}`} data-testid="ai-preflight-panel">
            <div className="flex items-center gap-2">
                {decision === 'GO' && lifecycle === 'terminal'
                    ? <CheckCircle2 size={16} className="text-emerald-300" />
                    : <ShieldAlert size={16} className="text-amber-300" />}
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-200" data-testid="ai-preflight-title">
                        发布前检查 · {
                            reconciling
                                ? '对账中'
                                : terminalFailure
                                  ? (lifecycle === 'cancelled' ? '已取消' : '不可用')
                                  : decisionLabel(decision)
                        }
                    </div>
                    <div className="mt-1 text-xs text-slate-500" data-testid="ai-preflight-status">
                        {statusLine}
                    </div>
                </div>
                {state.snapshot_hash ? <code className="hidden max-w-[14rem] truncate text-[10px] text-slate-600 sm:block">{state.snapshot_hash}</code> : null}
            </div>

            <p
                className="mt-2 text-[11px] leading-relaxed text-slate-500"
                data-testid="ai-preflight-advisory-disclaimer"
            >
                AI 检查结果仅供参考。本地校验与您确认的冻结草稿共同决定是否发布；AI 不能单独授权发布。
            </p>

            {!reconciling && !terminalFailure && state.audit?.findings.map((finding) => (
                <div key={`${finding.code}-${finding.message}`} className="mt-2 flex gap-2 text-xs text-slate-300">
                    {finding.severity === 'CRITICAL' ? <ShieldAlert size={14} className="mt-0.5 shrink-0 text-rose-300" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
                    <span>{finding.message}</span>
                </div>
            ))}
            {!reconciling && !terminalFailure && state.audit?.local_blockers?.length ? (
                <div className="mt-2 space-y-1 text-xs text-rose-200">
                    {state.audit.local_blockers.map((blocker) => <div key={blocker}>本地阻断：{blocker}</div>)}
                </div>
            ) : null}

            {!reconciling && !terminalFailure && (decision === 'WARNING' || decision === 'NO_GO' || (decision === 'PENDING' && showLivePending)) ? (
                <div className="mt-3 space-y-2 border-t border-slate-700/60 pt-3 text-xs text-slate-300" data-testid="ai-preflight-acknowledgements">
                    {decision === 'WARNING' ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.warning} onChange={(event) => onAcknowledgementChange('warning', event.target.checked)} /><span>我已阅读提醒，仍要发布。</span></label>
                    ) : null}
                    {decision === 'NO_GO' ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.critical} onChange={(event) => onAcknowledgementChange('critical', event.target.checked)} /><span>我确认继续承担严重检查结果，仍要发布。</span></label>
                    ) : null}
                    {decision === 'PENDING' && showLivePending ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.pending} onChange={(event) => onAcknowledgementChange('pending', event.target.checked)} /><span>检查仍在进行，我确认发布冻结草稿。</span></label>
                    ) : null}
                </div>
            ) : null}
            {decision === 'LOCAL_BLOCKED' && !terminalFailure ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-300/90">
                    <CircleDot size={12} />
                    存在本地阻断，无法确认发布。
                </div>
            ) : null}
            {!state.token && decision === 'IDLE' && !state.checking && !reconciling && !terminalFailure ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <CircleDot size={12} />
                    确认数据已变化或检查未完成，请重新执行发布前检查。
                </div>
            ) : null}
            {!canConfirm && decision !== 'IDLE' && decision !== 'LOCAL_BLOCKED' && !reconciling && !terminalFailure ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <CircleDot size={12} />
                    完成对应确认后才能发布。
                </div>
            ) : null}

            {state.error ? (
                <div
                    className="mt-2 text-xs text-rose-300"
                    data-testid="ai-preflight-error"
                    role="alert"
                >
                    {state.error}
                </div>
            ) : null}

            {(showCancel || showRetry || showRetryReconciliation) ? (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-700/60 pt-3" data-testid="ai-preflight-actions">
                    {showCancel ? (
                        <button
                            type="button"
                            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            data-testid="ai-preflight-cancel"
                            aria-label="取消发布前检查"
                            disabled={reconciling}
                            onClick={() => onCancel?.()}
                        >
                            取消检查
                        </button>
                    ) : null}
                    {showRetryReconciliation ? (
                        <button
                            type="button"
                            className="rounded-md border border-amber-500/50 px-2 py-1 text-xs text-amber-100 hover:bg-amber-500/10"
                            data-testid="ai-preflight-retry-reconciliation"
                            aria-label="重试会话对账"
                            onClick={() => onRetryReconciliation?.()}
                        >
                            重试对账
                        </button>
                    ) : null}
                    {showRetry ? (
                        <button
                            type="button"
                            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                            data-testid="ai-preflight-retry"
                            aria-label="重试发布前检查"
                            onClick={() => onRetry?.()}
                        >
                            重试检查
                        </button>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
