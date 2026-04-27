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

const normalizeSearchValue = (value: string) => value.trim().toLocaleLowerCase();

export default function TemplateSelect({
    options,
    value,
    onChange,
    placeholder = '选择模板...',
}: TemplateSelectProps) {
    const [query, setQuery] = useState('');
    const selectedOption = options.find((option) => option.name === value) ?? null;
    const isDisabled = options.length === 0;
    const normalizedQuery = normalizeSearchValue(query);
    const filteredOptions = useMemo(() => {
        if (!normalizedQuery) {
            return options;
        }

        return options.filter((option) => {
            const searchFields = [option.label, option.name];

            return searchFields.some((field) => normalizeSearchValue(field).includes(normalizedQuery));
        });
    }, [normalizedQuery, options]);

    return (
        <Combobox
            value={selectedOption}
            onChange={(option: TemplateSelectOption | null) => {
                if (option) {
                    onChange(option.name);
                }
            }}
            onClose={() => setQuery('')}
            immediate
            disabled={isDisabled}
        >
            <div className="relative">
                <div className="relative flex w-full items-center overflow-hidden rounded-lg border border-slate-700 bg-slate-800 text-sm text-slate-200 focus-within:ring-2 focus-within:ring-emerald-500 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60">
                    <Search size={16} className="pointer-events-none absolute left-3 text-slate-500" />
                    <ComboboxInput
                        aria-label="选择模板"
                        displayValue={(option: TemplateSelectOption | null) => option?.label ?? ''}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={placeholder}
                        className="w-full bg-transparent py-2 pr-24 pl-10 text-left text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none disabled:cursor-not-allowed"
                    />
                    {selectedOption && !query ? (
                        <span className="pointer-events-none absolute right-9 max-w-28 truncate text-xs text-slate-500">
                            {selectedOption.latestPublishedAtLabel}
                        </span>
                    ) : null}
                    <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 focus:outline-none disabled:cursor-not-allowed">
                        <ChevronDown size={16} className="shrink-0" />
                    </ComboboxButton>
                </div>
                <Transition
                    as={Fragment}
                    enter="transition duration-150 ease-out"
                    enterFrom="opacity-0 translate-y-1"
                    enterTo="opacity-100 translate-y-0"
                    leave="transition duration-100 ease-in"
                    leaveFrom="opacity-100 translate-y-0"
                    leaveTo="opacity-0 translate-y-1"
                >
                    <ComboboxOptions className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-2xl shadow-slate-950/60 focus:outline-none empty:invisible">
                        {filteredOptions.length === 0 ? (
                            <div className="rounded-lg px-3 py-2 text-sm text-slate-500">没有匹配的模板</div>
                        ) : (
                            filteredOptions.map((option) => (
                                <ComboboxOption
                                    key={option.name}
                                    value={option}
                                    className={({ focus }) => `cursor-pointer rounded-lg px-3 py-2 ${focus ? 'bg-slate-800 text-slate-100' : 'text-slate-300'}`}
                                >
                                    {({ selected, focus }) => (
                                        <div className="flex items-center gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate font-medium">{option.label}</div>
                                                {option.name !== option.label ? (
                                                    <div className={`truncate text-xs ${focus ? 'text-slate-400' : 'text-slate-500'}`}>
                                                        {option.name}
                                                    </div>
                                                ) : null}
                                            </div>
                                            <span className="shrink-0 text-xs text-slate-500">
                                                {option.latestPublishedAtLabel}
                                            </span>
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
            </div>
        </Combobox>
    );
}