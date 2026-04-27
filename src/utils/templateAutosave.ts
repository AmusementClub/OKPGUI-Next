export const TEMPLATE_REVISION_CONFLICT_PREFIX = 'TEMPLATE_REVISION_CONFLICT:';

export type TemplateSaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

export interface TemplateRevisionConflictPayload {
    entity_id: string;
    current_revision: number | null;
    message: string;
}

interface TemplateSaveStateMeta {
    label: string;
    className: string;
}

export function parseTemplateRevisionConflict(error: unknown): TemplateRevisionConflictPayload | null {
    if (typeof error !== 'string' || !error.startsWith(TEMPLATE_REVISION_CONFLICT_PREFIX)) {
        return null;
    }

    try {
        const raw = JSON.parse(
            error.slice(TEMPLATE_REVISION_CONFLICT_PREFIX.length),
        ) as Partial<TemplateRevisionConflictPayload>;

        return {
            entity_id: typeof raw.entity_id === 'string' ? raw.entity_id : '',
            current_revision:
                typeof raw.current_revision === 'number'
                && Number.isInteger(raw.current_revision)
                && raw.current_revision >= 0
                    ? raw.current_revision
                    : null,
            message:
                typeof raw.message === 'string' && raw.message.trim()
                    ? raw.message
                    : '模板已被其他会话修改。',
        };
    } catch {
        return null;
    }
}

export function getTemplateSaveStateMeta(
    saveState: TemplateSaveState,
    hasPendingAutosave: boolean,
): TemplateSaveStateMeta {
    if (saveState === 'idle' && hasPendingAutosave) {
        return {
            label: '待保存',
            className: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-100',
        };
    }

    switch (saveState) {
        case 'saving':
            return {
                label: '保存中',
                className: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-100',
            };
        case 'saved':
            return {
                label: '已保存',
                className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
            };
        case 'failed':
            return {
                label: '保存失败',
                className: 'border-rose-500/40 bg-rose-500/10 text-rose-100',
            };
        case 'conflict':
            return {
                label: '保存冲突',
                className: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
            };
        default:
            return {
                label: '未修改',
                className: 'border-slate-700 bg-slate-800 text-slate-300',
            };
    }
}