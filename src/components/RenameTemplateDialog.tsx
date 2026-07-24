import { Dialog, Transition } from '@headlessui/react';
import { Pencil, X } from 'lucide-react';
import { Fragment, useRef } from 'react';

interface RenameTemplateDialogProps {
    isOpen: boolean;
    value: string;
    maxLength: number;
    isSaving: boolean;
    onChange: (value: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function RenameTemplateDialog({
    isOpen,
    value,
    maxLength,
    isSaving,
    onChange,
    onConfirm,
    onCancel,
}: RenameTemplateDialogProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const canConfirm = value.trim().length > 0 && !isSaving;

    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog
                as="div"
                className="relative z-50"
                initialFocus={inputRef}
                onClose={() => {
                    if (!isSaving) onCancel();
                }}
            >
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
                            <Dialog.Panel className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
                                <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
                                    <div className="flex items-center gap-2 text-cyan-300">
                                        <Pencil size={17} />
                                        <Dialog.Title className="text-sm font-medium text-slate-100">
                                            重命名模板
                                        </Dialog.Title>
                                    </div>
                                    <button
                                        type="button"
                                        aria-label="关闭重命名模板"
                                        onClick={onCancel}
                                        disabled={isSaving}
                                        className="text-slate-500 transition-colors hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        <X size={18} />
                                    </button>
                                </div>

                                <form
                                    className="space-y-5 px-6 py-6"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        if (canConfirm) onConfirm();
                                    }}
                                >
                                    <div>
                                        <label htmlFor="rename-template-name" className="mb-1.5 block text-xs text-slate-400">
                                            模板名称
                                        </label>
                                        <input
                                            ref={inputRef}
                                            id="rename-template-name"
                                            type="text"
                                            aria-label="模板名称"
                                            value={value}
                                            maxLength={maxLength}
                                            disabled={isSaving}
                                            onChange={(event) => onChange(event.target.value)}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                                        />
                                    </div>

                                    <div className="flex justify-end gap-3">
                                        <button
                                            type="button"
                                            onClick={onCancel}
                                            disabled={isSaving}
                                            className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            取消
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={!canConfirm}
                                            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            {isSaving ? '保存中...' : '确认重命名'}
                                        </button>
                                    </div>
                                </form>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
