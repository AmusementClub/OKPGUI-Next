import { Dialog, Transition } from '@headlessui/react';
import { Fragment, useState, useEffect, useRef } from 'react';
import { Terminal, X } from 'lucide-react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PublishOutput {
    line: string;
    is_stderr: boolean;
}

interface PublishComplete {
    success: boolean;
    message: string;
}

interface ConsoleModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function ConsoleModal({ isOpen, onClose }: ConsoleModalProps) {
    const [lines, setLines] = useState<{ text: string; isError: boolean }[]>([]);
    const [isComplete, setIsComplete] = useState(false);
    const [result, setResult] = useState<PublishComplete | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;

        setLines([]);
        setIsComplete(false);
        setResult(null);

        const unlisteners: UnlistenFn[] = [];

        const setup = async () => {
            const unlistenOutput = await listen<PublishOutput>('publish-output', (event) => {
                setLines((prev) => [
                    ...prev,
                    { text: event.payload.line, isError: event.payload.is_stderr },
                ]);
            });
            unlisteners.push(unlistenOutput);

            const unlistenComplete = await listen<PublishComplete>('publish-complete', (event) => {
                setIsComplete(true);
                setResult(event.payload);
            });
            unlisteners.push(unlistenComplete);
        };

        setup();

        return () => {
            unlisteners.forEach((fn) => fn());
        };
    }, [isOpen]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [lines]);

    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={() => {}}>
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
                                        <Terminal size={18} />
                                        <Dialog.Title className="text-sm font-medium">
                                            发布控制台
                                        </Dialog.Title>
                                    </div>
                                    {isComplete && (
                                        <button
                                            onClick={onClose}
                                            className="text-slate-500 hover:text-slate-300"
                                        >
                                            <X size={18} />
                                        </button>
                                    )}
                                </div>

                                {/* Console output */}
                                <div
                                    ref={scrollRef}
                                    className="h-80 overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-slate-900"
                                >
                                    {lines.map((line, i) => (
                                        <div
                                            key={i}
                                            className={
                                                line.isError
                                                    ? 'text-red-400'
                                                    : 'text-slate-300'
                                            }
                                        >
                                            {line.text}
                                        </div>
                                    ))}
                                    {!isComplete && (
                                        <div className="text-emerald-400 animate-pulse">
                                            ▋
                                        </div>
                                    )}
                                </div>

                                {/* Footer */}
                                <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between">
                                    <div className="text-xs">
                                        {isComplete ? (
                                            <span
                                                className={
                                                    result?.success
                                                        ? 'text-emerald-400'
                                                        : 'text-red-400'
                                                }
                                            >
                                                {result?.message || '完成'}
                                            </span>
                                        ) : (
                                            <span className="text-yellow-400">
                                                发布中...
                                            </span>
                                        )}
                                    </div>
                                    {isComplete && (
                                        <button
                                            onClick={onClose}
                                            className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-sm rounded-lg transition-colors"
                                        >
                                            确定
                                        </button>
                                    )}
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
