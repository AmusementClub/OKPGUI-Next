import { AlertTriangle, CheckCircle2, CircleDot, ShieldAlert } from 'lucide-react';
import type { AiPreflightState } from '../hooks/useAiPreflight';

interface AiPreflightPanelProps {
    state: AiPreflightState;
    configured: boolean;
    canConfirm: boolean;
    onAcknowledgementChange: (key: 'warning' | 'critical' | 'pending', checked: boolean) => void;
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

export default function AiPreflightPanel({
    state,
    configured,
    canConfirm,
    onAcknowledgementChange,
}: AiPreflightPanelProps) {
    const decision = state.decision;
    const tone = decision === 'GO'
        ? 'border-emerald-400/30 bg-emerald-500/5'
        : decision === 'LOCAL_BLOCKED' || decision === 'NO_GO'
          ? 'border-rose-400/30 bg-rose-500/5'
          : 'border-amber-400/30 bg-amber-500/5';

    return (
        <section className={`rounded-xl border px-4 py-3 ${tone}`} data-testid="ai-preflight-panel">
            <div className="flex items-center gap-2">
                {decision === 'GO' ? <CheckCircle2 size={16} className="text-emerald-300" /> : <ShieldAlert size={16} className="text-amber-300" />}
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-200">发布前检查 · {decisionLabel(decision)}</div>
                    <div className="mt-1 text-xs text-slate-500">
                        {!configured
                            ? 'AI 未启用，发布沿用本地校验。'
                            : state.checking || decision === 'PENDING'
                              ? '正在检查当前冻结草稿。'
                              : '检查结果只对应当前冻结草稿。'}
                    </div>
                </div>
                {state.snapshot_hash ? <code className="hidden max-w-[14rem] truncate text-[10px] text-slate-600 sm:block">{state.snapshot_hash}</code> : null}
            </div>

            {state.audit?.findings.map((finding) => (
                <div key={`${finding.code}-${finding.message}`} className="mt-2 flex gap-2 text-xs text-slate-300">
                    {finding.severity === 'CRITICAL' ? <ShieldAlert size={14} className="mt-0.5 shrink-0 text-rose-300" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
                    <span>{finding.message}</span>
                </div>
            ))}
            {state.audit?.local_blockers?.length ? (
                <div className="mt-2 space-y-1 text-xs text-rose-200">
                    {state.audit.local_blockers.map((blocker) => <div key={blocker}>本地阻断：{blocker}</div>)}
                </div>
            ) : null}

            {decision === 'WARNING' || decision === 'NO_GO' || decision === 'PENDING' ? (
                <div className="mt-3 space-y-2 border-t border-slate-700/60 pt-3 text-xs text-slate-300">
                    {decision === 'WARNING' ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.warning} onChange={(event) => onAcknowledgementChange('warning', event.target.checked)} /><span>我已阅读提醒，仍要发布。</span></label>
                    ) : null}
                    {decision === 'NO_GO' ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.critical} onChange={(event) => onAcknowledgementChange('critical', event.target.checked)} /><span>我确认继续承担严重检查结果，仍要发布。</span></label>
                    ) : null}
                    {decision === 'PENDING' ? (
                        <label className="flex items-start gap-2"><input type="checkbox" checked={state.acknowledgements.pending} onChange={(event) => onAcknowledgementChange('pending', event.target.checked)} /><span>检查仍在进行，我确认发布冻结草稿。</span></label>
                    ) : null}
                </div>
            ) : null}
            {decision === 'LOCAL_BLOCKED' ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-rose-300/90">
                    <CircleDot size={12} />
                    存在本地阻断，无法确认发布。
                </div>
            ) : null}
            {!state.token && decision === 'IDLE' && !state.checking ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <CircleDot size={12} />
                    确认数据已变化或检查未完成，请重新执行发布前检查。
                </div>
            ) : null}
            {!canConfirm && decision !== 'IDLE' && decision !== 'LOCAL_BLOCKED' ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <CircleDot size={12} />
                    完成对应确认后才能发布。
                </div>
            ) : null}
            {state.error ? <div className="mt-2 text-xs text-rose-300">{state.error}</div> : null}
        </section>
    );
}
