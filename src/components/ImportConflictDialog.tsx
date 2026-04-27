import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { CopyPlus, ShieldAlert, X } from 'lucide-react';

interface ImportConflictDialogProps {
    isOpen: boolean;
    entityLabel: string;
    targetName: string;
    onOverwrite: () => void;
    onCopy: () => void;
    onCancel: () => void;
}

export default function ImportConflictDialog({
    isOpen,
    entityLabel,
    targetName,
    onOverwrite,
    onCopy,
    onCancel,
}: ImportConflictDialogProps) {
    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={onCancel}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-200"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-150"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/65" />
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
                            <Dialog.Panel className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
                                <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
                                    <div className="flex items-center gap-2 text-amber-300">
                                        <ShieldAlert size={18} />
                                        <Dialog.Title className="text-sm font-medium text-slate-100">
                                            导入冲突
                                        </Dialog.Title>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={onCancel}
                                        className="text-slate-500 transition-colors hover:text-slate-300"
                                    >
                                        <X size={18} />
                                    </button>
                                </div>

                                <div className="space-y-5 px-6 py-6 text-sm text-slate-300">
                                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-100">
                                        导入的{entityLabel}与现有项重名，继续导入前需要选择处理方式。
                                    </div>

                                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
                                        <div className="text-xs uppercase tracking-wide text-slate-500">冲突目标</div>
                                        <div className="mt-2 break-all text-sm font-medium text-white">{targetName}</div>
                                    </div>

                                    <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-4">
                                        <div>
                                            <div className="text-sm font-medium text-slate-100">覆盖现有项</div>
                                            <p className="mt-1 text-xs text-slate-400">
                                                使用导入内容替换当前同名{entityLabel}。
                                            </p>
                                        </div>
                                        <div>
                                            <div className="text-sm font-medium text-slate-100">另存为副本</div>
                                            <p className="mt-1 text-xs text-slate-400">
                                                保留当前{entityLabel}，并为导入内容生成一个新的副本名称或 ID。
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                                        <button
                                            type="button"
                                            onClick={onCancel}
                                            className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600"
                                        >
                                            取消导入
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onCopy}
                                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-100 transition-colors hover:bg-cyan-500/20"
                                        >
                                            <CopyPlus size={16} />
                                            另存为副本
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onOverwrite}
                                            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-amber-400"
                                        >
                                            覆盖现有项
                                        </button>
                                    </div>
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}