import { renderMarkdownToSafePreviewHtml } from '../utils/markdown';

interface MarkdownContentViewProps {
    content: string;
    emptyMessage?: string;
}

export default function MarkdownContentView({
    content,
    emptyMessage = '暂无内容',
}: MarkdownContentViewProps) {
    if (!content.trim()) {
        return <p className="py-8 text-center text-slate-500">{emptyMessage}</p>;
    }

    return (
        <div
            className="okp-md-preview okp-md-preview-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdownToSafePreviewHtml(content) }}
        />
    );
}