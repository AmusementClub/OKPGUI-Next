import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';
import { CircleAlert, X } from 'lucide-react';

interface NoticeDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    onClose: () => void;
}

export default function NoticeDialog({
    isOpen,
    title,
    message,
    confirmLabel = '知道了',
    onClose,
}: NoticeDialogProps) {
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
                                    <div className="flex items-center gap-2 text-rose-300">
                                        <CircleAlert size={18} />
                                        <Dialog.Title className="text-sm font-medium text-slate-100">
                                            {title}
                                        </Dialog.Title>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="text-slate-500 transition-colors hover:text-slate-300"
                                    >
                                        <X size={18} />
                                    </button>
                                </div>

                                <div className="space-y-5 px-6 py-6 text-sm text-slate-300">
                                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-100">
                                        {message}
                                    </div>

                                    <div className="flex justify-end">
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-400"
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