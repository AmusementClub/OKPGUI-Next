import { Listbox, Transition } from '@headlessui/react';
import { Check, ChevronDown } from 'lucide-react';
import { Fragment } from 'react';

export interface TemplateSelectOption {
    name: string;
    label: string;
    latestPublishedAtLabel: string;
}

interface TemplateSelectProps {
    options: TemplateSelectOption[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

export default function TemplateSelect({
    options,
    value,
    onChange,
    placeholder = '选择模板...',
}: TemplateSelectProps) {
    const selectedOption = options.find((option) => option.name === value) ?? null;
    const isDisabled = options.length === 0;

    return (
        <Listbox value={value} onChange={onChange} disabled={isDisabled}>
            <div className="relative">
                <Listbox.Button className="flex w-full items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-left text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60">
                    <div className="min-w-0 flex-1">
                        {selectedOption ? (
                            <div className="flex items-center gap-3">
                                <span className="truncate text-slate-100">{selectedOption.label}</span>
                                <span className="ml-auto shrink-0 text-xs text-slate-500">
                                    {selectedOption.latestPublishedAtLabel}
                                </span>
                            </div>
                        ) : (
                            <span className="text-slate-500">{placeholder}</span>
                        )}
                    </div>
                    <ChevronDown size={16} className="shrink-0 text-slate-500" />
                </Listbox.Button>
                <Transition
                    as={Fragment}
                    enter="transition duration-150 ease-out"
                    enterFrom="opacity-0 translate-y-1"
                    enterTo="opacity-100 translate-y-0"
                    leave="transition duration-100 ease-in"
                    leaveFrom="opacity-100 translate-y-0"
                    leaveTo="opacity-0 translate-y-1"
                >
                    <Listbox.Options className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-2xl shadow-slate-950/60 focus:outline-none">
                        {options.map((option) => (
                            <Listbox.Option
                                key={option.name}
                                value={option.name}
                                className={({ active }) => `cursor-pointer rounded-lg px-3 py-2 ${active ? 'bg-slate-800 text-slate-100' : 'text-slate-300'}`}
                            >
                                {({ selected }) => (
                                    <div className="flex items-center gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate font-medium">{option.label}</div>
                                        </div>
                                        <span className="shrink-0 text-xs text-slate-500">
                                            {option.latestPublishedAtLabel}
                                        </span>
                                        <span className={`shrink-0 text-emerald-300 ${selected ? 'opacity-100' : 'opacity-0'}`}>
                                            <Check size={14} />
                                        </span>
                                    </div>
                                )}
                            </Listbox.Option>
                        ))}
                    </Listbox.Options>
                </Transition>
            </div>
        </Listbox>
    );
}