import Tags from '@yaireo/tagify/react';
import { OKP_CONTENT_TAGS, parseOkpTagString, serializeOkpTags } from '../utils/okpTags';

interface TagInputProps {
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    onBlur?: (value: string) => void;
}

interface TagifyCleanTag {
    value?: string;
}

interface TagifyEventDetail {
    tagify?: {
        getCleanValue?: () => TagifyCleanTag[];
    };
}

interface TagifyEvent {
    detail?: TagifyEventDetail;
}

interface TagifyHookContext {
    tagify?: {
        DOM: {
            input?: {
                textContent?: string | null;
            };
        };
        state: {
            autoCompleteData?: unknown;
            inputSuggestion?: unknown;
            actions?: {
                selectOption?: boolean;
            };
        };
        addTags: (tags: readonly unknown[], clearInput?: boolean) => void;
        trim: (value: string) => string;
    };
}

function handleSpaceConfirm(event: KeyboardEvent, context: TagifyHookContext): Promise<void> {
    if (event.key !== ' ' && event.key !== 'Spacebar') {
        return Promise.resolve();
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return Promise.resolve();
    }

    const tagify = context.tagify;
    const inputText = tagify?.trim(tagify.DOM.input?.textContent ?? '') ?? '';
    const valueToAdd = tagify?.state.autoCompleteData ?? tagify?.state.inputSuggestion ?? inputText;

    if (!tagify || !valueToAdd) {
        return Promise.resolve();
    }

    event.preventDefault();

    setTimeout(() => {
        if (tagify.state.actions?.selectOption) {
            return;
        }

        tagify.addTags([valueToAdd], true);
        tagify.state.autoCompleteData = undefined;
    });

    return Promise.resolve();
}

const TAGIFY_SETTINGS = {
    delimiters: ',',
    duplicates: false,
    addTagOn: ['blur', 'tab', 'enter'],
    autoComplete: {
        enabled: true,
        tabKey: true,
    },
    hooks: {
        beforeKeyDown: handleSpaceConfirm,
    },
    dropdown: {
        enabled: 0,
        maxItems: 12,
        closeOnSelect: false,
        highlightFirst: true,
    },
};

function extractSerializedTags(event: TagifyEvent, fallbackValue: string): string {
    const cleanTags = event.detail?.tagify?.getCleanValue?.();
    if (!cleanTags) {
        return fallbackValue;
    }

    return serializeOkpTags(cleanTags.map((tag) => tag.value ?? ''));
}

export default function TagInput({ value, placeholder, onChange, onBlur }: TagInputProps) {
    return (
        <Tags
            className="okp-tag-input"
            settings={TAGIFY_SETTINGS}
            whitelist={[...OKP_CONTENT_TAGS]}
            value={parseOkpTagString(value)}
            placeholder={placeholder}
            onChange={(event: TagifyEvent) => {
                onChange(extractSerializedTags(event, value));
            }}
            onBlur={(event: TagifyEvent) => {
                onBlur?.(extractSerializedTags(event, value));
            }}
        />
    );
}