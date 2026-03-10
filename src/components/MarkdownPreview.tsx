import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { Eye, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

interface MarkdownPreviewProps {
    isOpen: boolean;
    onClose: () => void;
    content: string;
}

const previewSchema = {
    ...defaultSchema,
    tagNames: [
        ...(defaultSchema.tagNames || []),
        'div',
        'span',
        'details',
        'summary',
        'kbd',
        'sub',
        'sup',
    ],
    attributes: {
        ...defaultSchema.attributes,
        a: [...(defaultSchema.attributes?.a || []), 'target', 'rel'],
        img: [...(defaultSchema.attributes?.img || []), 'loading'],
        div: [...(defaultSchema.attributes?.div || []), 'align'],
        span: [...(defaultSchema.attributes?.span || []), 'align'],
    },
};

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
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSchema]]}
                                            components={{
                                                h1: ({ node: _node, ...props }) => <h1 className="text-2xl font-bold mt-4 mb-3 text-slate-100" {...props} />,
                                                h2: ({ node: _node, ...props }) => <h2 className="text-xl font-bold mt-4 mb-3 text-slate-100" {...props} />,
                                                h3: ({ node: _node, ...props }) => <h3 className="text-lg font-semibold mt-4 mb-2 text-slate-100" {...props} />,
                                                p: ({ node: _node, ...props }) => <p className="mb-3 leading-7 text-slate-300" {...props} />,
                                                ul: ({ node: _node, ...props }) => <ul className="mb-3 list-disc pl-6 text-slate-300" {...props} />,
                                                ol: ({ node: _node, ...props }) => <ol className="mb-3 list-decimal pl-6 text-slate-300" {...props} />,
                                                li: ({ node: _node, ...props }) => <li className="mb-1" {...props} />,
                                                a: ({ node: _node, ...props }) => <a className="text-cyan-400 hover:text-cyan-300 hover:underline" target="_blank" rel="noreferrer" {...props} />,
                                                img: ({ node: _node, ...props }) => <img className="my-3 max-w-full rounded-lg border border-slate-700" {...props} />,
                                                div: ({ node: _node, ...props }) => <div className="text-slate-300" {...props} />,
                                                span: ({ node: _node, ...props }) => <span className="text-slate-300" {...props} />,
                                                blockquote: ({ node: _node, ...props }) => <blockquote className="mb-3 border-l-4 border-emerald-500/60 pl-4 italic text-slate-400" {...props} />,
                                                details: ({ node: _node, ...props }) => <details className="mb-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-slate-300" {...props} />,
                                                summary: ({ node: _node, ...props }) => <summary className="cursor-pointer font-medium text-slate-100" {...props} />,
                                                code: ({ node: _node, className, children, ...props }) => {
                                                    const isInline = !className;
                                                    if (isInline) {
                                                        return (
                                                            <code className="rounded bg-slate-700 px-1.5 py-0.5 text-sm text-emerald-300" {...props}>
                                                                {children}
                                                            </code>
                                                        );
                                                    }

                                                    return (
                                                        <code className="block overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-200" {...props}>
                                                            {children}
                                                        </code>
                                                    );
                                                },
                                                pre: ({ node: _node, ...props }) => <pre className="mb-3 overflow-x-auto" {...props} />,
                                                hr: ({ node: _node, ...props }) => <hr className="my-4 border-slate-700" {...props} />,
                                                table: ({ node: _node, ...props }) => <div className="mb-3 overflow-x-auto"><table className="min-w-full border-collapse text-left text-sm text-slate-300" {...props} /></div>,
                                                thead: ({ node: _node, ...props }) => <thead className="bg-slate-700/40" {...props} />,
                                                th: ({ node: _node, ...props }) => <th className="border border-slate-700 px-3 py-2 font-semibold text-slate-100" {...props} />,
                                                td: ({ node: _node, ...props }) => <td className="border border-slate-700 px-3 py-2" {...props} />,
                                            }}
                                        >
                                            {content}
                                        </ReactMarkdown>
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
