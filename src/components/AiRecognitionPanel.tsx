import { CircleDot, Loader2, Sparkles } from 'lucide-react';
import type { RecognitionCandidate, RecognitionResult } from '../types/ai';

export interface AiRecognitionPanelProps {
    busy: boolean;
    error: string | null;
    result: RecognitionResult | null;
}

function CandidateRow({
    label,
    candidate,
    testId,
}: {
    label: string;
    candidate?: RecognitionCandidate | null;
    testId: string;
}) {
    if (!candidate) {
        return (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2" data-testid={testId}>
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
                <div className="mt-1 text-xs text-slate-600">无候选</div>
            </div>
        );
    }

    const confidencePct = Number.isFinite(candidate.confidence)
        ? `${Math.round(Math.max(0, Math.min(1, candidate.confidence)) * 100)}%`
        : '—';

    return (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2" data-testid={testId}>
            <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
                <div className="text-[11px] text-slate-500" data-testid={`${testId}-confidence`}>
                    置信度 {confidencePct}
                </div>
            </div>
            <div className="mt-1 break-words text-sm text-slate-200" data-testid={`${testId}-value`}>
                {candidate.value}
            </div>
            <div className="mt-1 text-xs text-slate-500" data-testid={`${testId}-evidence`}>
                依据：{candidate.evidence}
            </div>
        </div>
    );
}

/**
 * Display-only advisory recognition panel.
 * Reads episode / resolution / suggested_title directly from the result.
 * Never auto-fills drafts, never keyword-parses free text, never changes publish decisions.
 */
export default function AiRecognitionPanel({ busy, error, result }: AiRecognitionPanelProps) {
    if (!busy && !error && !result) {
        return null;
    }

    return (
        <section
            className="mt-3 rounded-xl border border-violet-400/25 bg-violet-500/5 px-4 py-3"
            data-testid="ai-recognition-panel"
        >
            <div className="flex items-start gap-2">
                {busy ? (
                    <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-violet-300" />
                ) : (
                    <Sparkles size={16} className="mt-0.5 shrink-0 text-violet-300" />
                )}
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-200">AI 识别建议（仅供参考）</div>
                    <div className="mt-1 text-xs text-slate-500">
                        识别结果不会自动写入标题或发布字段；最终标题仍由本地模板规则与你的编辑决定。
                    </div>
                </div>
            </div>

            {busy ? (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400" data-testid="ai-recognition-busy">
                    <CircleDot size={12} />
                    正在识别当前种子与模板模式…
                </div>
            ) : null}

            {error ? (
                <div className="mt-2 text-xs text-rose-300" data-testid="ai-recognition-error">
                    {error}
                </div>
            ) : null}

            {result ? (
                <div className="mt-3 space-y-2" data-testid="ai-recognition-result">
                    <CandidateRow
                        label="集数"
                        candidate={result.episode}
                        testId="ai-recognition-episode"
                    />
                    <CandidateRow
                        label="分辨率"
                        candidate={result.resolution}
                        testId="ai-recognition-resolution"
                    />
                    <CandidateRow
                        label="建议标题"
                        candidate={result.suggested_title}
                        testId="ai-recognition-suggested-title"
                    />
                    <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-800/80 pt-2 text-[10px] text-slate-600">
                        <span data-testid="ai-recognition-job-id">job: {result.job_id || '—'}</span>
                        <span data-testid="ai-recognition-schema">schema: {result.schema_version || '—'}</span>
                        <span className="max-w-full truncate" data-testid="ai-recognition-snapshot" title={result.snapshot_hash}>
                            snapshot: {result.snapshot_hash || '—'}
                        </span>
                        <span data-testid="ai-recognition-generation">gen: {result.request_generation}</span>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
