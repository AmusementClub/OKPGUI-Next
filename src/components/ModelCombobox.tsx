import {
    Combobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
    Transition,
} from '@headlessui/react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';

interface ModelComboboxProps {
    options: string[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

export default function ModelCombobox({
    options,
    value,
    onChange,
    placeholder = '输入或选择模型名',
}: ModelComboboxProps) {
    const [query, setQuery] = useState('');
    const filteredOptions = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return options;
        return options.filter((option) => option.toLocaleLowerCase().includes(normalizedQuery));
    }, [options, query]);

    return (
        <Combobox
            value={value}
            onChange={(model: string | null) => {
                if (model !== null) onChange(model);
            }}
            onClose={() => setQuery('')}
            immediate
        >
            <div className="relative mt-1">
                <div className="relative flex w-full items-center overflow-hidden rounded-lg border border-slate-700 bg-slate-900 text-sm text-slate-200 focus-within:ring-2 focus-within:ring-emerald-500">
                    <Search size={16} className="pointer-events-none absolute left-3 text-slate-500" />
                    <ComboboxInput
                        aria-label="模型"
                        displayValue={(model: string) => model ?? ''}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            onChange(event.target.value);
                        }}
                        placeholder={placeholder}
                        className="w-full bg-transparent py-2 pr-10 pl-10 text-left text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
                    />
                    <ComboboxButton
                        aria-label="展开模型列表"
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 hover:text-slate-300 focus:outline-none"
                    >
                        <ChevronDown size={16} className="shrink-0" />
                    </ComboboxButton>
                </div>
                {options.length > 0 ? (
                    <Transition
                        as={Fragment}
                        enter="transition duration-150 ease-out"
                        enterFrom="opacity-0 translate-y-1"
                        enterTo="opacity-100 translate-y-0"
                        leave="transition duration-100 ease-in"
                        leaveFrom="opacity-100 translate-y-0"
                        leaveTo="opacity-0 translate-y-1"
                    >
                        <ComboboxOptions
                            modal={false}
                            className="absolute z-30 mt-2 max-h-60 w-full overflow-auto rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-2xl shadow-slate-950/60 focus:outline-none"
                        >
                            {filteredOptions.length === 0 ? (
                                <div className="rounded-lg px-3 py-2 text-sm text-slate-500">
                                    没有匹配的模型，可继续手动输入
                                </div>
                            ) : (
                                filteredOptions.map((model) => (
                                    <ComboboxOption
                                        key={model}
                                        value={model}
                                        className={({ focus }) => `cursor-pointer rounded-lg px-3 py-2 ${focus ? 'bg-slate-800 text-slate-100' : 'text-slate-300'}`}
                                    >
                                        {({ selected }) => (
                                            <div className="flex min-w-0 items-center gap-3">
                                                <span className="min-w-0 flex-1 truncate font-medium">{model}</span>
                                                <span className={`shrink-0 text-emerald-300 ${selected ? 'opacity-100' : 'opacity-0'}`}>
                                                    <Check size={14} />
                                                </span>
                                            </div>
                                        )}
                                    </ComboboxOption>
                                ))
                            )}
                        </ComboboxOptions>
                    </Transition>
                ) : null}
            </div>
        </Combobox>
    );
}
