import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Copy, FileText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import PublishContentEditor from '../components/PublishContentEditor';
import {
    ContentTemplate,
    QuickPublishConfigPayload,
    QuickPublishTemplate,
    createDefaultContentTemplate,
    createTemplateIdFromName,
    createUpdatedAtTimestamp,
    normalizeContentTemplate,
    normalizeQuickPublishTemplate,
} from '../utils/quickPublish';

function formatTimestamp(value: string) {
    if (!value.trim()) {
        return '未保存';
    }

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        return value;
    }

    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
        .format(new Date(timestamp))
        .replace(/\//g, '-');
}

function serializeAutosaveTemplate(template: ContentTemplate) {
    return JSON.stringify({
        ...template,
        updated_at: '',
    });
}

function buildPersistableTemplate(template: ContentTemplate) {
    const name = template.name.trim() || '未命名公共正文模板';

    return normalizeContentTemplate({
        ...template,
        id: template.id.trim() || createTemplateIdFromName(name, 'content'),
        name,
        updated_at: createUpdatedAtTimestamp(),
    });
}

export default function ContentTemplatesPage() {
    const [contentTemplates, setContentTemplates] = useState<Record<string, ContentTemplate>>({});
    const [quickPublishTemplates, setQuickPublishTemplates] = useState<Record<string, QuickPublishTemplate>>({});
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [draft, setDraft] = useState<ContentTemplate>(createDefaultContentTemplate());
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [hasPendingAutosave, setHasPendingAutosave] = useState(false);
    const latestDraftRef = useRef(draft);
    const lastPersistedSnapshotRef = useRef(serializeAutosaveTemplate(createDefaultContentTemplate()));

    latestDraftRef.current = draft;

    const sortedTemplates = useMemo(
        () =>
            Object.values(contentTemplates).sort((left, right) => {
                const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
                if (byUpdatedAt !== 0) {
                    return byUpdatedAt;
                }

                return left.name.localeCompare(right.name, 'zh-CN');
            }),
        [contentTemplates],
    );

    const referencedBy = useMemo(
        () =>
            Object.values(quickPublishTemplates)
                .filter((template) => template.shared_content_template_id === selectedTemplateId)
                .map((template) => template.name || template.id),
        [quickPublishTemplates, selectedTemplateId],
    );

    useEffect(() => {
        void loadData();
    }, []);

    useEffect(() => {
        if (!hasPendingAutosave) {
            return undefined;
        }

        const autosaveTimer = window.setTimeout(() => {
            void persistDraft(latestDraftRef.current);
        }, 700);

        return () => window.clearTimeout(autosaveTimer);
    }, [draft, hasPendingAutosave]);

    const loadData = async (preferredId?: string) => {
        const config = await invoke<QuickPublishConfigPayload>('get_config');
        const nextContentTemplates = Object.fromEntries(
            Object.entries(config.content_templates ?? {}).map(([id, template]) => [
                id,
                normalizeContentTemplate({ id, ...template }),
            ]),
        );
        const nextQuickPublishTemplates = Object.fromEntries(
            Object.entries(config.quick_publish_templates ?? {}).map(([id, template]) => [
                id,
                normalizeQuickPublishTemplate({ id, ...template }),
            ]),
        );

        setContentTemplates(nextContentTemplates);
        setQuickPublishTemplates(nextQuickPublishTemplates);

        const resolvedId =
            preferredId && nextContentTemplates[preferredId]
                ? preferredId
                : selectedTemplateId && nextContentTemplates[selectedTemplateId]
                  ? selectedTemplateId
                  : sortedObjectKeys(nextContentTemplates)[0] ?? '';

        if (!resolvedId) {
            setSelectedTemplateId('');
            const emptyDraft = createDefaultContentTemplate();
            setDraft(emptyDraft);
            lastPersistedSnapshotRef.current = serializeAutosaveTemplate(emptyDraft);
            setHasPendingAutosave(false);
            return;
        }

        setSelectedTemplateId(resolvedId);
        setDraft(nextContentTemplates[resolvedId]);
        lastPersistedSnapshotRef.current = serializeAutosaveTemplate(nextContentTemplates[resolvedId]);
        setHasPendingAutosave(false);
    };

    const updateDraft = (updater: (current: ContentTemplate) => ContentTemplate) => {
        setDraft((current) => updater(current));
        setHasPendingAutosave(true);
        setStatusMessage('');
        setErrorMessage('');
    };

    const persistDraft = async (sourceDraft: ContentTemplate) => {
        const sourceSnapshot = serializeAutosaveTemplate(sourceDraft);
        const templateToSave = buildPersistableTemplate(sourceDraft);
        const persistedSnapshot = serializeAutosaveTemplate(templateToSave);

        if (persistedSnapshot === lastPersistedSnapshotRef.current) {
            if (serializeAutosaveTemplate(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
            }
            return;
        }

        try {
            await invoke('save_content_template', { template: templateToSave });
            lastPersistedSnapshotRef.current = persistedSnapshot;
            setContentTemplates((current) => ({
                ...current,
                [templateToSave.id]: templateToSave,
            }));
            setSelectedTemplateId(templateToSave.id);
            setDraft((current) =>
                serializeAutosaveTemplate(current) === sourceSnapshot ? templateToSave : current,
            );
            if (serializeAutosaveTemplate(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
            }
            setStatusMessage(`公共正文模板“${templateToSave.name}”已自动保存。`);
            setErrorMessage('');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '自动保存公共正文模板失败。');
            setStatusMessage('');
        }
    };

    const selectTemplate = (id: string) => {
        setSelectedTemplateId(id);
        const nextDraft = contentTemplates[id] ?? createDefaultContentTemplate();
        setDraft(nextDraft);
        lastPersistedSnapshotRef.current = serializeAutosaveTemplate(nextDraft);
        setHasPendingAutosave(false);
        setStatusMessage('');
        setErrorMessage('');
    };

    const createTemplate = () => {
        const emptyDraft = createDefaultContentTemplate();
        setSelectedTemplateId('');
        setDraft(emptyDraft);
        setHasPendingAutosave(false);
        setStatusMessage('已创建空白公共正文模板草稿。');
        setErrorMessage('');
    };

    const duplicateTemplate = () => {
        const duplicatedName = draft.name.trim() ? `${draft.name} 副本` : '未命名公共正文模板';
        const duplicated = {
            ...draft,
            id: `${createTemplateIdFromName(duplicatedName, 'content')}-copy`,
            name: duplicatedName,
            updated_at: '',
        };

        setSelectedTemplateId('');
        setDraft(duplicated);
        setHasPendingAutosave(false);
        setStatusMessage('已基于当前公共正文模板创建副本草稿。');
        setErrorMessage('');
    };

    const importTemplate = async () => {
        try {
            const selectedFile = await open({
                filters: [{ name: '正文模板文件', extensions: ['json'] }],
                multiple: false,
            });

            const importPath = Array.isArray(selectedFile) ? selectedFile[0] : selectedFile;
            if (!importPath) {
                return;
            }

            const imported = await invoke<{ id: string; template: ContentTemplate }>(
                'import_content_template_from_file',
                { path: importPath },
            );

            await loadData(imported.id);
            setStatusMessage(`已导入公共正文模板“${imported.template.name || imported.id}”。`);
            setErrorMessage('');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '导入公共正文模板失败。');
            setStatusMessage('');
        }
    };

    const exportTemplate = async () => {
        const id = selectedTemplateId || draft.id.trim();
        if (!id) {
            setErrorMessage('请先选择或保存一个公共正文模板。');
            setStatusMessage('');
            return;
        }

        try {
            const name = draft.name.trim() || id;
            const selectedPath = await save({
                defaultPath: `${name}.json`,
                filters: [{ name: '正文模板文件', extensions: ['json'] }],
            });
            if (!selectedPath) {
                return;
            }

            await invoke('export_content_template_to_file', {
                id,
                path: selectedPath,
            });
            setStatusMessage(`已导出公共正文模板“${name}”。`);
            setErrorMessage('');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '导出公共正文模板失败。');
            setStatusMessage('');
        }
    };

    const deleteTemplate = async () => {
        if (!selectedTemplateId) {
            setDraft(createDefaultContentTemplate());
            return;
        }

        try {
            await invoke('delete_content_template', { id: selectedTemplateId });
            const deletedName = draft.name || selectedTemplateId;
            await loadData();
            setStatusMessage(`公共正文模板“${deletedName}”已删除。`);
            setErrorMessage('');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '删除公共正文模板失败。');
            setStatusMessage('');
        }
    };

    return (
        <div className="h-full overflow-y-auto bg-slate-900 px-6 py-6 text-slate-100">
            <div className="mx-auto flex max-w-7xl flex-col gap-6">
                <header className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-400/80">快速模板发布</p>
                        <h1 className="mt-2 text-3xl font-semibold text-white">公共正文模板管理</h1>
                        <p className="mt-2 max-w-3xl text-sm text-slate-400">
                            在这里维护组级共用的小尾巴、公告和下载说明。发布模板页负责片级正文主体，这里只维护可被多个发布模板复用的公共部分。
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={createTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            <Plus size={16} />
                            新建公共正文模板
                        </button>
                        <button
                            type="button"
                            onClick={duplicateTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            <Copy size={16} />
                            复制
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void importTemplate();
                            }}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            导入
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void exportTemplate();
                            }}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            导出
                        </button>
                        <button
                            type="button"
                            onClick={deleteTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition-colors hover:bg-rose-500/20"
                        >
                            <Trash2 size={16} />
                            删除
                        </button>
                    </div>
                </header>

                {statusMessage ? (
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                        {statusMessage}
                    </div>
                ) : null}
                {errorMessage ? (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                        {errorMessage}
                    </div>
                ) : null}

                <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
                    <aside className="rounded-3xl border border-slate-800 bg-slate-950/50 p-4">
                        <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
                            <div>
                                <h2 className="text-sm font-medium text-slate-200">正文模板列表</h2>
                                <p className="mt-1 text-xs text-slate-500">共 {sortedTemplates.length} 个公共模板</p>
                            </div>
                        </div>

                        <div className="mt-4 space-y-2">
                            {sortedTemplates.length > 0 ? (
                                sortedTemplates.map((template) => {
                                    const isActive = template.id === selectedTemplateId;
                                    return (
                                        <button
                                            key={template.id}
                                            type="button"
                                            onClick={() => selectTemplate(template.id)}
                                            className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                                                isActive
                                                    ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-50'
                                                    : 'border-slate-800 bg-slate-900/70 text-slate-200 hover:bg-slate-800'
                                            }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className="mt-0.5 rounded-xl border border-slate-700 bg-slate-800 p-2 text-slate-300">
                                                    <FileText size={15} />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm font-medium">{template.name || template.id}</div>
                                                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                                                        {template.summary || '暂无说明'}
                                                    </p>
                                                    <p className="mt-2 text-[11px] text-slate-500">
                                                        最近更新 {formatTimestamp(template.updated_at)}
                                                    </p>
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })
                            ) : (
                                <div className="rounded-2xl border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
                                    还没有公共正文模板，先新建一个。
                                </div>
                            )}
                        </div>
                    </aside>

                    <section className="space-y-6">
                        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">基础信息</h2>
                                <div className="mt-4 grid gap-4 md:grid-cols-2">
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">模板名称</span>
                                        <input
                                            type="text"
                                            value={draft.name}
                                            onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
                                            placeholder="例如：字幕组通用尾巴"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">模板 ID</span>
                                        <input
                                            type="text"
                                            value={draft.id}
                                            onChange={(event) => updateDraft((current) => ({ ...current, id: event.target.value }))}
                                            placeholder="留空则按名称自动生成"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                </div>

                                <label className="mt-4 block text-sm text-slate-300">
                                    <span className="mb-2 block text-xs text-slate-500">模板说明</span>
                                    <textarea
                                        rows={3}
                                        value={draft.summary}
                                        onChange={(event) => updateDraft((current) => ({ ...current, summary: event.target.value }))}
                                        placeholder="简要说明这份公共正文模板适用于什么场景。"
                                        className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                    />
                                </label>

                                <label className="mt-4 block text-sm text-slate-300">
                                    <span className="mb-2 block text-xs text-slate-500">站点适配备注</span>
                                    <textarea
                                        rows={4}
                                        value={draft.site_notes}
                                        onChange={(event) => updateDraft((current) => ({ ...current, site_notes: event.target.value }))}
                                        placeholder="例如：ACG.RIP 会转成 BBCode，Bangumi 优先使用 HTML。"
                                        className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                    />
                                </label>
                            </div>

                            <div className="space-y-6">
                                <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                    <h2 className="text-sm font-medium text-slate-200">引用关系</h2>
                                    <p className="mt-2 text-xs text-slate-500">
                                        当前公共正文模板被 {referencedBy.length} 个发布模板引用。
                                    </p>
                                    <div className="mt-4 space-y-2">
                                        {referencedBy.length > 0 ? (
                                            referencedBy.map((templateName) => (
                                                <div
                                                    key={templateName}
                                                    className="rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-300"
                                                >
                                                    {templateName}
                                                </div>
                                            ))
                                        ) : (
                                            <div className="rounded-2xl border border-dashed border-slate-800 px-3 py-5 text-sm text-slate-500">
                                                暂无发布模板引用。
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                    <h2 className="text-sm font-medium text-slate-200">状态</h2>
                                    <dl className="mt-4 space-y-3 text-sm">
                                        <div className="flex items-start justify-between gap-4">
                                            <dt className="text-slate-500">最近更新时间</dt>
                                            <dd className="text-right text-slate-200">{formatTimestamp(draft.updated_at)}</dd>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <dt className="text-slate-500">Markdown 字数</dt>
                                            <dd className="text-right text-slate-200">{draft.markdown.trim().length}</dd>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <dt className="text-slate-500">HTML 字数</dt>
                                            <dd className="text-right text-slate-200">{draft.html.trim().length}</dd>
                                        </div>
                                    </dl>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                            <h2 className="text-sm font-medium text-slate-200">公共正文编辑</h2>
                            <div className="mt-4">
                                <PublishContentEditor
                                    contentKey={draft.id || 'content-template'}
                                    markdown={draft.markdown}
                                    html={draft.html}
                                    onMarkdownChange={(markdown) => updateDraft((current) => ({ ...current, markdown }))}
                                    onHtmlChange={(html) => updateDraft((current) => ({ ...current, html }))}
                                />
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}

function sortedObjectKeys<T>(collection: Record<string, T>) {
    return Object.keys(collection).sort((left, right) => left.localeCompare(right, 'zh-CN'));
}