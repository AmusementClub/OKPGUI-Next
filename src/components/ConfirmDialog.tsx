import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { TriangleAlert, X } from 'lucide-react';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = '确认',
    cancelLabel = '取消',
    danger = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    return (
        <Transition appear show={open} as={Fragment}>
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
                            <Dialog.Panel className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
                                <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
                                    <div
                                        className={`flex items-center gap-2 ${
                                            danger ? 'text-rose-300' : 'text-emerald-300'
                                        }`}
                                    >
                                        <TriangleAlert size={18} />
                                        <Dialog.Title className="text-sm font-medium text-slate-100">
                                            {title}
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
                                    <div
                                        className={`rounded-xl border px-4 py-3 ${
                                            danger
                                                ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
                                                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                                        }`}
                                    >
                                        {message}
                                    </div>

                                    <div className="flex justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={onCancel}
                                            className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-800"
                                        >
                                            {cancelLabel}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onConfirm}
                                            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                                                danger
                                                    ? 'bg-rose-500 hover:bg-rose-400'
                                                    : 'bg-emerald-500 hover:bg-emerald-400'
                                            }`}
                                        >
                                            {confirmLabel}
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
