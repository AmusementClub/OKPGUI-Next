import { useEffect, useMemo, useState } from 'react';
import EasyMarkdownEditor from './EasyMarkdownEditor';
import { IFRAME_MONO_FONT_STACK, IFRAME_SANS_FONT_STACK } from '../utils/iframeFonts';
import { renderMarkdownToHtml } from '../utils/markdown';

interface PublishContentEditorProps {
    contentKey?: string;
    markdown: string;
    html: string;
    onMarkdownChange: (markdown: string) => void;
    onHtmlChange: (html: string) => void;
}

function normalizeHtml(value: string) {
    return value.replace(/\s+/g, ' ').trim();
}

function hasCustomHtml(markdown: string, html: string) {
    const normalizedHtml = html.trim();

    if (!normalizedHtml) {
        return false;
    }

    return normalizeHtml(normalizedHtml) !== normalizeHtml(renderMarkdownToHtml(markdown));
}

function buildHtmlPreviewDocument(html: string) {
    const body = html.trim()
        ? html
        : '<p class="okp-html-preview-empty">暂无内容</p>';

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
      font: 14px/1.7 ${IFRAME_SANS_FONT_STACK};
      word-break: break-word;
    }
    a { color: #22d3ee; }
    img { max-width: 100%; height: auto; border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #334155; padding: 8px 10px; }
    code, pre {
      font-family: ${IFRAME_MONO_FONT_STACK};
    }
    pre {
      overflow-x: auto;
      padding: 14px;
      border-radius: 12px;
      background: #020617;
    }
    blockquote {
      margin: 0 0 16px;
      padding-left: 16px;
      border-left: 4px solid rgba(16, 185, 129, 0.65);
      color: #94a3b8;
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

export default function PublishContentEditor({
    contentKey,
    markdown,
    html,
    onMarkdownChange,
    onHtmlChange,
}: PublishContentEditorProps) {
    const [htmlOverrideEnabled, setHtmlOverrideEnabled] = useState(() => hasCustomHtml(markdown, html));

    useEffect(() => {
        setHtmlOverrideEnabled(hasCustomHtml(markdown, html));
    }, [contentKey]);

    const generatedHtml = useMemo(() => renderMarkdownToHtml(markdown), [markdown]);
    const effectiveHtml = htmlOverrideEnabled ? html : generatedHtml;

    const handleMarkdownChange = (value: string) => {
        onMarkdownChange(value);

        if (!htmlOverrideEnabled) {
            onHtmlChange(renderMarkdownToHtml(value));
        }
    };

    const handleToggleHtmlOverride = () => {
        const nextEnabled = !htmlOverrideEnabled;
        setHtmlOverrideEnabled(nextEnabled);

        if (!nextEnabled) {
            onHtmlChange(generatedHtml);
            return;
        }

        if (!html.trim()) {
            onHtmlChange(generatedHtml);
        }
    };

    const htmlPreviewDocument = useMemo(() => buildHtmlPreviewDocument(effectiveHtml), [effectiveHtml]);

    return (
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/40">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/70 px-4 py-3">
                <div>
                    <label className="block text-xs text-slate-500">描述内容</label>
                    <p className="mt-1 text-xs text-slate-500">
                        默认只需维护 Markdown。HTML 会自动生成并用于预览，只有在个别站点样式需要微调时再手动覆盖。
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleToggleHtmlOverride}
                    className={[
                        'rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                        htmlOverrideEnabled
                            ? 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:border-amber-400 hover:bg-amber-500/15'
                            : 'border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700',
                    ].join(' ')}
                >
                    {htmlOverrideEnabled ? '关闭 HTML 覆盖' : '开启 HTML 覆盖'}
                </button>
            </div>

            <div className="p-4">
                <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-medium text-slate-200">Markdown 编辑</h3>
                        <span className="text-xs text-slate-500">图片仅支持 URL，本地上传不在此编辑器内处理。</span>
                    </div>
                    <div className="okp-md-editor-shell overflow-hidden rounded-lg border border-slate-700">
                        <EasyMarkdownEditor
                            editorKey={contentKey}
                            value={markdown}
                            onChange={handleMarkdownChange}
                            placeholder="输入 Markdown 内容"
                            height={360}
                        />
                    </div>
                    <p className="text-xs text-slate-500">
                        自动模式下会实时同步最终 HTML；Nyaa 和 ACG.RIP 仍以 Markdown 内容为准。
                    </p>
                </section>

                {htmlOverrideEnabled ? (
                    <section className="mt-4 space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
                        <div>
                            <h3 className="text-sm font-medium text-amber-100">高级选项: 自定义 HTML 覆盖</h3>
                            <p className="mt-1 text-xs text-amber-100/70">
                                仅在自动生成的 HTML 仍不能满足目标站点样式时使用。关闭后会恢复为 Markdown 自动生成的 HTML。
                            </p>
                        </div>
                        <textarea
                            value={html}
                            onChange={(event) => onHtmlChange(event.target.value)}
                            placeholder="手动调整将要提交给 HTML 站点的内容。"
                            rows={14}
                            className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                        />
                    </section>
                ) : null}

                <section className="mt-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-medium text-slate-200">最终 HTML 预览</h3>
                        <span className="text-xs text-slate-500">
                            {htmlOverrideEnabled ? '当前使用手动 HTML 覆盖' : '当前使用 Markdown 自动生成'}
                        </span>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-slate-700">
                        <iframe
                            title="HTML 预览"
                            sandbox="allow-popups"
                            srcDoc={htmlPreviewDocument}
                            className="min-h-72 w-full rounded-lg border-0 bg-slate-800"
                        />
                    </div>
                </section>
            </div>
        </div>
    );
}