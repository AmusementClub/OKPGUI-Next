import { invoke } from '@tauri-apps/api/core';
import { Copy, FileText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import PublishContentEditor from '../components/PublishContentEditor';
import { contentTemplateManagerConfig, useTemplateManager } from '../hooks/useTemplateManager';
import {
    QuickPublishConfigPayload,
    QuickPublishTemplate,
    formatTemplateTimestamp,
    normalizeQuickPublishTemplate,
} from '../utils/quickPublish';

export default function ContentTemplatesPage() {
    const manager = useTemplateManager(contentTemplateManagerConfig);
    const {
        draft, selectedTemplateId, sortedTemplates, statusMessage, errorMessage,
        updateDraft, selectTemplate, createTemplate, duplicateTemplate,
        importTemplate, exportTemplate, deleteTemplate,
    } = manager;

    const [quickPublishTemplates, setQuickPublishTemplates] = useState<Record<string, QuickPublishTemplate>>({});

    const referencedBy = useMemo(
        () =>
            Object.values(quickPublishTemplates)
                .filter((template) => template.shared_content_template_id === selectedTemplateId)
                .map((template) => template.name || template.id),
        [quickPublishTemplates, selectedTemplateId],
    );

    useEffect(() => {
        void loadQuickPublishTemplates();
    }, []);

    const loadQuickPublishTemplates = async () => {
        const config = await invoke<QuickPublishConfigPayload>('get_config');
        setQuickPublishTemplates(
            Object.fromEntries(
                Object.entries(config.quick_publish_templates ?? {}).map(([id, template]) => [
                    id,
                    normalizeQuickPublishTemplate({ id, ...template }),
                ]),
            ),
        );
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
                            onClick={() => {
                                void deleteTemplate();
                            }}
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
                                                        最近更新 {formatTemplateTimestamp(template.updated_at)}
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
                                <div className="mt-4 space-y-4">
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
                                    {selectedTemplateId ? (
                                        <div className="block text-sm text-slate-300">
                                            <span className="mb-2 block text-xs text-slate-500">模板 ID</span>
                                            <div className="w-full rounded-xl border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-sm text-slate-400">
                                                {draft.id}
                                            </div>
                                        </div>
                                    ) : null}
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
                                            <dd className="text-right text-slate-200">{formatTemplateTimestamp(draft.updated_at)}</dd>
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
