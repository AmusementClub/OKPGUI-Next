import { useEffect, useRef } from 'react';
import EasyMDE from 'easymde';
import hljs from 'highlight.js';
import { renderMarkdownToSafePreviewHtml } from '../utils/markdown';

interface EasyMarkdownEditorProps {
    editorKey?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    height?: number;
}

function normalizeHeight(height: number | undefined) {
    if (!height) {
        return '360px';
    }

    return `${height}px`;
}

export default function EasyMarkdownEditor({
    editorKey,
    value,
    onChange,
    placeholder,
    height = 360,
}: EasyMarkdownEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const instanceRef = useRef<EasyMDE | null>(null);
    const latestValueRef = useRef(value);
    const latestOnChangeRef = useRef(onChange);

    latestValueRef.current = value;
    latestOnChangeRef.current = onChange;

    useEffect(() => {
        const textarea = textareaRef.current;

        if (!textarea) {
            return undefined;
        }

        const instance = new EasyMDE({
            autoDownloadFontAwesome: false,
            element: textarea,
            forceSync: true,
            initialValue: value,
            inputStyle: 'textarea',
            maxHeight: normalizeHeight(height),
            minHeight: normalizeHeight(height),
            nativeSpellcheck: false,
            placeholder,
            renderingConfig: {
                codeSyntaxHighlighting: true,
                hljs,
                singleLineBreaks: true,
            },
            previewRender: (markdownPlaintext) => renderMarkdownToSafePreviewHtml(markdownPlaintext),
            spellChecker: false,
            status: false,
        });

        instanceRef.current = instance;

        const handleChange = () => {
            const nextValue = instance.value();
            latestValueRef.current = nextValue;
            latestOnChangeRef.current(nextValue);
        };

        instance.codemirror.on('change', handleChange);

        return () => {
            instance.codemirror.off('change', handleChange);
            instance.toTextArea();
            instance.cleanup();
            instanceRef.current = null;
        };
    }, [editorKey, height, placeholder]);

    useEffect(() => {
        const instance = instanceRef.current;

        if (!instance || instance.value() === value || latestValueRef.current === value) {
            return;
        }

        const codeMirror = instance.codemirror;
        const currentSelections = codeMirror.listSelections();
        const currentScrollInfo = codeMirror.getScrollInfo();

        instance.value(value);
        codeMirror.setSelections(currentSelections);
        codeMirror.scrollTo(currentScrollInfo.left, currentScrollInfo.top);
        latestValueRef.current = value;
    }, [value]);

    return <textarea ref={textareaRef} defaultValue={value} />;
}