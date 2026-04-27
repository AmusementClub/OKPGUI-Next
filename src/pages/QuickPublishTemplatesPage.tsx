import { invoke } from '@tauri-apps/api/core';
import { Copy, Layers3, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import MarkdownContentView from '../components/MarkdownContentView';
import PublishContentEditor from '../components/PublishContentEditor';
import { useImportConflictDialog } from '../hooks/useImportConflictDialog';
import { quickPublishTemplateManagerConfig, useTemplateManager } from '../hooks/useTemplateManager';
import { ENTITY_NAME_MAX_LENGTH, sanitizeEntityNameInput } from '../utils/entityNaming';
import { getTemplateSaveStateMeta } from '../utils/templateAutosave';
import { DEFAULT_EP_PATTERN, DEFAULT_RESOLUTION_PATTERN, DEFAULT_TITLE_PATTERN } from '../utils/titleRules';
import {
    ContentTemplate,
    QuickPublishConfigPayload,
    SiteSelection,
    composePublishContent,
    formatTemplateTimestamp,
    getPublishedVersionLabel,
    normalizeContentTemplate,
    quickPublishSiteKeys,
    quickPublishSiteLabels,
} from '../utils/quickPublish';

function buildHtmlPreviewDocument(html: string) {
    const body = html.trim()
        ? html
        : '<p class="okp-html-preview-empty">暂无 HTML 内容</p>';

    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 20px;
            background: #0f172a;
            color: #cbd5e1;
            font: 14px/1.7 ui-sans-serif, system-ui, sans-serif;
            word-break: break-word;
        }
        a { color: #22d3ee; }
        img { max-width: 100%; height: auto; border-radius: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #334155; padding: 8px 10px; }
        pre {
            overflow-x: auto;
            padding: 14px;
            border-radius: 12px;
            background: #020617;
        }
        .okp-html-preview-empty {
            margin: 0;
            padding: 32px 0;
            text-align: center;
            color: #64748b;
        }
    </style>
</head>
<body>${body}</body>
</html>`;
}

export default function QuickPublishTemplatesPage() {
    const { requestImportConflictStrategy, importConflictDialog } = useImportConflictDialog();
    const manager = useTemplateManager(quickPublishTemplateManagerConfig, {
        resolveImportConflict: requestImportConflictStrategy,
    });
    const {
        draft, selectedTemplateId, sortedTemplates, statusMessage, errorMessage, hasPendingAutosave,
        saveState, conflictState,
        updateDraft, selectTemplate, createTemplate, duplicateTemplate,
        importTemplate, exportTemplate, deleteTemplate,
        reloadConflictDraft, overwriteConflictDraft, saveConflictAsCopy,
    } = manager;

    const [contentTemplates, setContentTemplates] = useState<Record<string, ContentTemplate>>({});
    const [profileList, setProfileList] = useState<string[]>([]);

    const sharedContentTemplateOptions = useMemo(
        () =>
            Object.values(contentTemplates)
                .filter((template) => template.id)
                .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
                .map((template) => ({ id: template.id, name: template.name || template.id })),
        [contentTemplates],
    );

    const selectedSharedContentTemplate =
        draft.shared_content_template_id && contentTemplates[draft.shared_content_template_id]
            ? contentTemplates[draft.shared_content_template_id]
            : null;

    const composedMarkdown = useMemo(
        () => composePublishContent(draft.body_markdown, selectedSharedContentTemplate?.markdown ?? ''),
        [draft.body_markdown, selectedSharedContentTemplate],
    );

    const composedHtml = useMemo(
        () => composePublishContent(draft.body_html, selectedSharedContentTemplate?.html ?? '', '\n'),
        [draft.body_html, selectedSharedContentTemplate],
    );

    const composedHtmlPreviewDocument = useMemo(
        () => buildHtmlPreviewDocument(composedHtml),
        [composedHtml],
    );

    const saveStateMeta = useMemo(
        () => getTemplateSaveStateMeta(saveState, hasPendingAutosave),
        [hasPendingAutosave, saveState],
    );

    useEffect(() => {
        void loadExtraData();
    }, []);

    const loadExtraData = async () => {
        const [config, nextProfiles] = await Promise.all([
            invoke<QuickPublishConfigPayload>('get_config'),
            invoke<string[]>('get_profile_list'),
        ]);
        setContentTemplates(
            Object.fromEntries(
                Object.entries(config.content_templates ?? {}).map(([id, template]) => [
                    id,
                    normalizeContentTemplate({ id, ...template }),
                ]),
            ),
        );
        setProfileList(nextProfiles);
    };

    const updateDefaultSite = (siteKey: keyof SiteSelection, enabled: boolean) => {
        updateDraft((current) => ({
            ...current,
            default_sites: {
                ...current.default_sites,
                [siteKey]: enabled,
            },
        }));
    };

    return (
        <>
        <div className="h-full overflow-y-auto bg-slate-900 px-6 py-6 text-slate-100">
            <div className="mx-auto flex max-w-7xl flex-col gap-6">
                <header className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-400/80">快速模板发布</p>
                        <h1 className="mt-2 text-3xl font-semibold text-white">发布模板管理</h1>
                        <p className="mt-2 max-w-3xl text-sm text-slate-400">
                            发布模板现在同时管理"怎么发"和"这一片的正文主体"。公共正文模板只承载组级共用尾巴，运行时覆盖默认仍不会回写模板。
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={createTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            <Plus size={16} />
                            新建模板
                        </button>
                        <button
                            type="button"
                            onClick={duplicateTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            <Copy size={16} />
                            复制模板
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
                            删除模板
                        </button>
                    </div>
                </header>

                <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${saveStateMeta.className}`}>
                        {saveStateMeta.label}
                    </span>
                    <span className="text-xs text-slate-500">
                        模板编辑采用防抖自动保存；检测到版本冲突时会暂停自动写回。
                    </span>
                </div>

                {conflictState ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-50">
                        <div className="font-medium text-amber-100">检测到模板保存冲突</div>
                        <p className="mt-1 text-amber-50/90">{conflictState.message}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    void reloadConflictDraft();
                                }}
                                className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-800"
                            >
                                重新加载远端
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    void overwriteConflictDraft();
                                }}
                                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-500/20"
                            >
                                覆盖保存
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    void saveConflictAsCopy();
                                }}
                                className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-800"
                            >
                                另存为副本
                            </button>
                        </div>
                    </div>
                ) : null}

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
                                <h2 className="text-sm font-medium text-slate-200">发布模板列表</h2>
                                <p className="mt-1 text-xs text-slate-500">共 {sortedTemplates.length} 个模板</p>
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
                                                    <Layers3 size={15} />
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
                                    还没有发布模板，先新建一个。
                                </div>
                            )}
                        </div>
                    </aside>

                    <section className="space-y-6">
                        <div className="grid gap-6 lg:grid-cols-2">
                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">基础信息</h2>
                                <div className="mt-4 space-y-4">
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">模板名称</span>
                                        <input
                                            type="text"
                                            value={draft.name}
                                            maxLength={ENTITY_NAME_MAX_LENGTH}
                                            onChange={(event) =>
                                                updateDraft((current) => ({
                                                    ...current,
                                                    name: sanitizeEntityNameInput(event.target.value),
                                                }))
                                            }
                                            placeholder="例如：季度新番周更模板"
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
                                        placeholder="说明这份模板适用于哪类作品或发布场景。"
                                        className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                    />
                                </label>

                                <div className="mt-4 grid gap-4 md:grid-cols-2">
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">关联公共正文模板</span>
                                        <select
                                            value={draft.shared_content_template_id ?? ''}
                                            onChange={(event) =>
                                                updateDraft((current) => ({
                                                    ...current,
                                                    shared_content_template_id: event.target.value || null,
                                                }))
                                            }
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        >
                                            <option value="">不使用公共正文模板</option>
                                            {sharedContentTemplateOptions.map((option) => (
                                                <option key={option.id} value={option.id}>
                                                    {option.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">默认身份</span>
                                        <select
                                            value={draft.default_profile}
                                            onChange={(event) =>
                                                updateDraft((current) => ({ ...current, default_profile: event.target.value }))
                                            }
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        >
                                            <option value="">未设置默认身份</option>
                                            {profileList.map((profile) => (
                                                <option key={profile} value={profile}>
                                                    {profile}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            </div>

                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">发布信息</h2>
                                <div className="mt-4 space-y-4">
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">默认标题</span>
                                        <input
                                            type="text"
                                            value={draft.title}
                                            onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))}
                                            placeholder="模板发布页默认填充的最终标题"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">Poster</span>
                                        <input
                                            type="text"
                                            value={draft.poster}
                                            onChange={(event) => updateDraft((current) => ({ ...current, poster: event.target.value }))}
                                            placeholder="海报图片 URL"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">About</span>
                                        <input
                                            type="text"
                                            value={draft.about}
                                            onChange={(event) => updateDraft((current) => ({ ...current, about: event.target.value }))}
                                            placeholder="发布备注"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">Tags</span>
                                        <input
                                            type="text"
                                            value={draft.tags}
                                            onChange={(event) => updateDraft((current) => ({ ...current, tags: event.target.value }))}
                                            placeholder="多个标签使用英文逗号分隔"
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-6">
                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <h2 className="text-sm font-medium text-slate-200">正文主体</h2>
                                        <p className="mt-1 text-xs text-slate-500">这里编辑这一片自己的正文内容，通常对应用户反馈里的红框区域。</p>
                                    </div>
                                </div>
                                <div className="mt-4">
                                    <PublishContentEditor
                                        contentKey={draft.id || 'quick-publish-template'}
                                        markdown={draft.body_markdown}
                                        html={draft.body_html}
                                        onMarkdownChange={(body_markdown) =>
                                            updateDraft((current) => ({ ...current, body_markdown }))
                                        }
                                        onHtmlChange={(body_html) =>
                                            updateDraft((current) => ({ ...current, body_html }))
                                        }
                                    />
                                </div>
                            </div>

                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">公共正文模板</h2>
                                <p className="mt-2 text-xs text-slate-500">这里选择组共用的小尾巴。它会追加到正文主体后面，通常对应黄框区域。</p>

                                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                                    <div className="text-xs text-slate-500">当前选择</div>
                                    <div className="mt-2 text-sm font-medium text-slate-100">
                                        {selectedSharedContentTemplate?.name || '未使用公共正文模板'}
                                    </div>
                                    <div className="mt-2 text-xs text-slate-500">
                                        {selectedSharedContentTemplate?.summary || '如需维护公共尾巴，请前往公共正文模板管理页面。'}
                                    </div>
                                </div>

                                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
                                    <div className="text-xs text-slate-500">站点备注</div>
                                    <div className="mt-2 whitespace-pre-wrap text-sm text-slate-200">
                                        {selectedSharedContentTemplate?.site_notes || '暂无站点备注'}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">最终正文预览</h2>
                                <p className="mt-2 text-xs text-slate-500">这是正文主体与公共正文模板拼接后的结果，也是发布时默认使用的正文。</p>

                                <div className="mt-4 space-y-4">
                                    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                                        <div className="mb-3 text-xs text-slate-500">Markdown 预览</div>
                                        <MarkdownContentView
                                            content={composedMarkdown}
                                            emptyMessage="正文主体和公共正文模板都为空。"
                                        />
                                    </div>

                                    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                                        <div className="mb-3 text-xs text-slate-500">HTML 预览</div>
                                        <iframe
                                            title="发布模板 HTML 预览"
                                            sandbox="allow-popups"
                                            srcDoc={composedHtmlPreviewDocument}
                                            className="min-h-72 w-full rounded-xl border border-slate-700 bg-slate-800"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">标题规则</h2>
                                <div className="mt-4 space-y-4">
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">集数正则</span>
                                        <input
                                            type="text"
                                            value={draft.ep_pattern}
                                            onChange={(event) => updateDraft((current) => ({ ...current, ep_pattern: event.target.value }))}
                                            placeholder={`例如：${DEFAULT_EP_PATTERN}`}
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">分辨率正则</span>
                                        <input
                                            type="text"
                                            value={draft.resolution_pattern}
                                            onChange={(event) =>
                                                updateDraft((current) => ({
                                                    ...current,
                                                    resolution_pattern: event.target.value,
                                                }))
                                            }
                                            placeholder={`例如：${DEFAULT_RESOLUTION_PATTERN}`}
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                    <label className="block text-sm text-slate-300">
                                        <span className="mb-2 block text-xs text-slate-500">标题模板</span>
                                        <input
                                            type="text"
                                            value={draft.title_pattern}
                                            onChange={(event) => updateDraft((current) => ({ ...current, title_pattern: event.target.value }))}
                                            placeholder={`例如：${DEFAULT_TITLE_PATTERN}`}
                                            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        />
                                    </label>
                                </div>
                                <p className="mt-3 text-xs text-slate-500">
                                    这些规则会在模板发布页用于生成建议标题，并记录发布历史中的集数与分辨率。
                                </p>
                            </div>

                            <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                                <h2 className="text-sm font-medium text-slate-200">默认站点</h2>
                                <div className="mt-4 space-y-2">
                                    {quickPublishSiteKeys.map((siteKey) => (
                                        <label
                                            key={siteKey}
                                            className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-3"
                                        >
                                            <span className="text-sm text-slate-300">{quickPublishSiteLabels[siteKey]}</span>
                                            <input
                                                type="checkbox"
                                                checked={draft.default_sites[siteKey]}
                                                onChange={(event) => updateDefaultSite(siteKey, event.target.checked)}
                                                className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
                                            />
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                            <h2 className="text-sm font-medium text-slate-200">发布历史</h2>
                            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {quickPublishSiteKeys.map((siteKey) => {
                                    const history = draft.publish_history[siteKey];
                                    return (
                                        <div
                                            key={siteKey}
                                            className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3"
                                        >
                                            <div className="text-sm font-medium text-slate-200">
                                                {quickPublishSiteLabels[siteKey]}
                                            </div>
                                            <div className="mt-2 text-xs text-slate-500">
                                                最近发布时间 {formatTemplateTimestamp(history.last_published_at)}
                                            </div>
                                            <div className="mt-1 text-sm text-slate-300">
                                                最近发布版本 {getPublishedVersionLabel(history)}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
        {importConflictDialog}
        </>
    );
}
