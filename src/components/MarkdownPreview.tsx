import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { Eye, X } from 'lucide-react';

interface MarkdownPreviewProps {
    isOpen: boolean;
    onClose: () => void;
    content: string;
}

/** Simple markdown to HTML conversion for preview */
function markdownToHtml(md: string): string {
    let html = md;

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-4 mb-2">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-4 mb-2">$1</h1>');

    // Bold & italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="bg-slate-700 px-1 py-0.5 rounded text-sm text-emerald-300">$1</code>');

    // Links
    html = html.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" class="text-cyan-400 hover:underline" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Images
    html = html.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        '<img src="$2" alt="$1" class="max-w-full rounded mt-2 mb-2" />'
    );

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');

    // Line breaks (double newline = paragraph)
    html = html.replace(/\n\n/g, '</p><p class="mb-2">');
    html = `<p class="mb-2">${html}</p>`;

    // Single line break
    html = html.replace(/\n/g, '<br />');

    return html;
}

export default function MarkdownPreview({ isOpen, onClose, content }: MarkdownPreviewProps) {
    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={onClose}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-200"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-150"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/60" />
                </Transition.Child>

                <div className="fixed inset-0 overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4">
                        <Transition.Child
                            as={Fragment}
                            enter="ease-out duration-200"
                            enterFrom="opacity-0 scale-95"
                            enterTo="opacity-100 scale-100"
                            leave="ease-in duration-150"
                            leaveFrom="opacity-100 scale-100"
                            leaveTo="opacity-0 scale-95"
                        >
                            <Dialog.Panel className="w-full max-w-2xl bg-slate-800 rounded-xl border border-slate-700 shadow-xl">
                                {/* Header */}
                                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                                    <div className="flex items-center gap-2 text-emerald-400">
                                        <Eye size={18} />
                                        <Dialog.Title className="text-sm font-medium">
                                            Markdown 预览
                                        </Dialog.Title>
                                    </div>
                                    <button
                                        onClick={onClose}
                                        className="text-slate-500 hover:text-slate-300"
                                    >
                                        <X size={18} />
                                    </button>
                                </div>

                                {/* Preview content */}
                                <div className="p-6 max-h-96 overflow-y-auto">
                                    {content.trim() ? (
                                        <div
                                            className="prose prose-invert prose-sm max-w-none text-slate-300"
                                            dangerouslySetInnerHTML={{
                                                __html: markdownToHtml(content),
                                            }}
                                        />
                                    ) : (
                                        <p className="text-slate-500 text-center py-8">
                                            暂无内容
                                        </p>
                                    )}
                                </div>

                                {/* Footer */}
                                <div className="px-4 py-3 border-t border-slate-700 flex justify-end">
                                    <button
                                        onClick={onClose}
                                        className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
                                    >
                                        关闭
                                    </button>
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
