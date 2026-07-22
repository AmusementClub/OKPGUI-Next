import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTOSAVE_DEBOUNCE_MS } from '../utils/constants';
import { useLatest } from '../hooks/useLatest';
import {
    createCopyEntityName,
    ENTITY_NAME_MAX_LENGTH,
    ImportConflictStrategy,
    parseImportConflictName,
    sanitizeEntityNameInput,
    sanitizeExportFileStem,
    trimEntityName,
} from '../utils/entityNaming';
import {
    parseTemplateRevisionConflict,
    TemplateSaveState,
} from '../utils/templateAutosave';
import { renderMarkdownToHtml } from '../utils/markdown';
import { serializeForComparison } from '../utils/templateSnapshot';
import {
    ContentTemplate,
    QuickPublishConfigPayload,
    QuickPublishTemplate,
    createDefaultContentTemplate,
    createDefaultPublishHistory,
    createDefaultQuickPublishTemplate,
    createTemplateIdFromName,
    createUpdatedAtTimestamp,
    normalizeContentTemplate,
    normalizeQuickPublishTemplate,
} from '../utils/quickPublish';

type AnyTemplate = QuickPublishTemplate | ContentTemplate;

interface TemplateManagerConfig<T extends AnyTemplate> {
    configKey: 'quick_publish_templates' | 'content_templates';
    createDefault: () => T;
    normalize: (t: Partial<T>) => T;
    saveCommand: string;
    deleteCommand: string;
    importCommand: string;
    exportCommand: string;
    fallbackPrefix: string;
    fallbackName: string;
    fileFilterName: string;
    entityLabel: string;
}

interface TemplateManagerOptions {
    resolveImportConflict?: (
        entityLabel: string,
        targetName: string,
    ) => Promise<ImportConflictStrategy | null>;
}

interface PersistDraftOptions {
    expectedRevision?: number | null;
}

export interface TemplateConflictState {
    entityId: string;
    currentRevision: number | null;
    message: string;
}

type PersistDraftResult = 'saved' | 'unchanged' | 'conflict' | 'failed';

interface QueuedPersistDraft<T extends AnyTemplate> {
    sourceDraft: T;
    options: PersistDraftOptions;
    selectedTemplateId: string;
}

function buildPersistableTemplate<T extends AnyTemplate>(
    template: T,
    normalize: (t: Partial<T>) => T,
    fallbackPrefix: string,
    fallbackName: string,
): T {
    const name =
        trimEntityName(sanitizeEntityNameInput((template as AnyTemplate).name)) || fallbackName;

    return normalize({
        ...template,
        id: (template as AnyTemplate).id.trim() || createTemplateIdFromName(name, fallbackPrefix),
        name,
        updated_at: createUpdatedAtTimestamp(),
    } as Partial<T>);
}

export function createCopyDraft<T extends AnyTemplate>(
    template: T,
    fallbackName: string,
    existingNames: readonly string[] = [],
): T {
    const duplicated = {
        ...template,
        id: '',
        name: createCopyEntityName(template.name, fallbackName, ENTITY_NAME_MAX_LENGTH, existingNames),
        updated_at: '',
        revision: 0,
    } as T;

    if ('publish_history' in duplicated) {
        const quickPublish = duplicated as QuickPublishTemplate;
        quickPublish.publish_history = createDefaultPublishHistory();
        // Drop inherited custom HTML, but keep the copy publish-ready from its Markdown.
        quickPublish.body_html = renderMarkdownToHtml(quickPublish.body_markdown);
    }

    if ('markdown' in duplicated) {
        const contentTemplate = duplicated as ContentTemplate;
        // Drop inherited custom HTML, but keep the copy publish-ready from its Markdown.
        contentTemplate.html = renderMarkdownToHtml(contentTemplate.markdown);
    }

    return duplicated;
}

export interface TemplateManagerState<T extends AnyTemplate> {
    templates: Record<string, T>;
    draft: T;
    selectedTemplateId: string;
    sortedTemplates: T[];
    statusMessage: string;
    errorMessage: string;
    hasPendingAutosave: boolean;
    saveState: TemplateSaveState;
    conflictState: TemplateConflictState | null;
    loadError: string;
    isSwitching: boolean;

    selectTemplate: (id: string) => Promise<void>;
    createTemplate: () => Promise<void>;
    duplicateTemplate: () => Promise<void>;
    updateDraft: (updater: (current: T) => T) => void;
    deleteTemplate: () => Promise<void>;
    importTemplate: () => Promise<void>;
    exportTemplate: () => Promise<void>;
    loadData: (preferredId?: string) => Promise<void>;
    reloadConflictDraft: () => Promise<void>;
    overwriteConflictDraft: () => Promise<void>;
    saveConflictAsCopy: () => Promise<void>;
}

export function useTemplateManager<T extends AnyTemplate>(
    config: TemplateManagerConfig<T>,
    options: TemplateManagerOptions = {},
): TemplateManagerState<T> {
    const [templates, setTemplates] = useState<Record<string, T>>({});
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [draft, setDraft] = useState<T>(config.createDefault());
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [hasPendingAutosave, setHasPendingAutosave] = useState(false);
    const [saveState, setSaveState] = useState<TemplateSaveState>('idle');
    const [conflictState, setConflictState] = useState<TemplateConflictState | null>(null);
    const [loadError, setLoadError] = useState('');
    const [isSwitching, setIsSwitching] = useState(false);
    const latestDraftRef = useLatest(draft);
    const conflictStateRef = useLatest(conflictState);
    const templatesRef = useLatest(templates);
    const selectedTemplateIdRef = useLatest(selectedTemplateId);
    const lastPersistedSnapshotRef = useRef(serializeForComparison(config.createDefault()));
    // Re-entrancy guards: a switch flushes the pending autosave first, and a second
    // switch during that in-flight flush must be ignored, not raced.
    const switchingRef = useRef(false);
    const persistInFlightRef = useRef<Promise<PersistDraftResult> | null>(null);
    const queuedPersistRef = useRef<QueuedPersistDraft<T> | null>(null);

    const sortedTemplates = useMemo(
        () =>
            Object.values(templates).sort((left, right) => {
                const byUpdatedAt = right.updated_at.localeCompare(left.updated_at);
                if (byUpdatedAt !== 0) {
                    return byUpdatedAt;
                }

                return left.name.localeCompare(right.name, 'zh-CN');
            }),
        [templates],
    );

    useEffect(() => {
        void loadData();
    }, []);

    useEffect(() => {
        if (!hasPendingAutosave) {
            return undefined;
        }

        const autosaveTimer = window.setTimeout(() => {
            void persistDraft(latestDraftRef.current);
        }, AUTOSAVE_DEBOUNCE_MS);

        return () => window.clearTimeout(autosaveTimer);
    }, [draft, hasPendingAutosave]);

    const loadData = async (preferredId?: string) => {
        let fullConfig: QuickPublishConfigPayload;
        try {
            fullConfig = await invoke<QuickPublishConfigPayload>('get_config');
        } catch (error) {
            setLoadError(typeof error === 'string' ? error : '加载配置失败，请重试。');
            return;
        }

        let configLoadError: string | null = null;
        try {
            configLoadError = await invoke<string | null>('get_config_load_error');
        } catch (error) {
            console.error('读取配置加载状态失败:', error);
        }
        setLoadError(
            configLoadError
                ? '配置文件损坏，已加载默认配置，原文件未改动。请修复或删除配置文件后重启应用。'
                : '',
        );

        const rawTemplates = (fullConfig[config.configKey] ?? {}) as Record<string, Partial<T>>;

        const nextTemplates = Object.fromEntries(
            Object.entries(rawTemplates).map(([id, template]) => [
                id,
                config.normalize({ id, ...template } as Partial<T>),
            ]),
        ) as Record<string, T>;

        setTemplates(nextTemplates);

        const resolvedId =
            preferredId && nextTemplates[preferredId]
                ? preferredId
                : selectedTemplateId && nextTemplates[selectedTemplateId]
                  ? selectedTemplateId
                  : sortedObjectKeys(nextTemplates)[0] ?? '';

        if (!resolvedId) {
            setSelectedTemplateId('');
            const emptyDraft = config.createDefault();
            setDraft(emptyDraft);
            lastPersistedSnapshotRef.current = serializeForComparison(emptyDraft);
            setHasPendingAutosave(false);
            setConflictState(null);
            setSaveState('idle');
            return;
        }

        setSelectedTemplateId(resolvedId);
        setDraft(nextTemplates[resolvedId]);
        lastPersistedSnapshotRef.current = serializeForComparison(nextTemplates[resolvedId]);
        setHasPendingAutosave(false);
        setConflictState(null);
        setSaveState('saved');
    };

    const persistDraftInternal = async (
        sourceDraft: T,
        options: PersistDraftOptions = {},
    ): Promise<PersistDraftResult> => {
        const sourceSnapshot = serializeForComparison(sourceDraft);
        const templateToSave = buildPersistableTemplate(
            sourceDraft,
            config.normalize,
            config.fallbackPrefix,
            config.fallbackName,
        );
        const persistedSnapshot = serializeForComparison(templateToSave);
        const expectedRevision = options.expectedRevision !== undefined
            ? options.expectedRevision
            : sourceDraft.id.trim()
              ? sourceDraft.revision
              : null;

        if (persistedSnapshot === lastPersistedSnapshotRef.current) {
            if (serializeForComparison(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
                if (!conflictStateRef.current) {
                    setSaveState('saved');
                }
            }
            return 'unchanged';
        }

        // Capture selection identity before the await: if the user switches templates
        // while the save is in flight, the late response must not yank selection back.
        const capturedSelectedId = selectedTemplateIdRef.current;

        try {
            const saved = await invoke<{ id: string; template: T }>(config.saveCommand, {
                template: templateToSave,
                expectedRevision,
            });
            const savedTemplate = config.normalize({
                ...saved.template,
                id: saved.id,
            } as Partial<T>);
            const savedSnapshot = serializeForComparison(savedTemplate);
            const previousId = (sourceDraft as AnyTemplate).id.trim();
            const isStillSelected = () => {
                const currentSelectedId = selectedTemplateIdRef.current;
                return currentSelectedId === capturedSelectedId || currentSelectedId === previousId;
            };
            const mergeSavedMetadata = (current: T): T =>
                config.normalize({
                    ...current,
                    id: saved.id,
                    revision: savedTemplate.revision,
                    updated_at: savedTemplate.updated_at,
                } as Partial<T>);

            const queued = queuedPersistRef.current;
            if (
                queued
                && (queued.selectedTemplateId === capturedSelectedId
                    || queued.sourceDraft.id.trim() === previousId)
            ) {
                queuedPersistRef.current = {
                    ...queued,
                    sourceDraft: mergeSavedMetadata(queued.sourceDraft),
                };
            }

            lastPersistedSnapshotRef.current = savedSnapshot;
            setTemplates((current) => {
                const nextTemplates = { ...current };
                if (previousId && previousId !== saved.id) {
                    delete nextTemplates[previousId];
                }
                nextTemplates[saved.id] = savedTemplate;
                return nextTemplates;
            });
            if (isStillSelected()) {
                setSelectedTemplateId(saved.id);
                latestDraftRef.current =
                    serializeForComparison(latestDraftRef.current) === sourceSnapshot
                        ? savedTemplate
                        : mergeSavedMetadata(latestDraftRef.current);
            }
            setDraft((current) => {
                if (!isStillSelected()) {
                    return current;
                }

                return serializeForComparison(current) === sourceSnapshot
                    ? savedTemplate
                    : mergeSavedMetadata(current);
            });
            if (serializeForComparison(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
            }
            setConflictState(null);
            setSaveState('saved');
            setStatusMessage(`${config.entityLabel}"${savedTemplate.name}"已自动保存。`);
            setErrorMessage('');
            return 'saved';
        } catch (error) {
            const conflict = parseTemplateRevisionConflict(error);
            if (conflict) {
                // Do NOT clear hasPendingAutosave on failure: the draft is still dirty
                // and must stay armed so flush-on-switch or the next edit retries.
                setConflictState({
                    entityId: conflict.entity_id,
                    currentRevision: conflict.current_revision,
                    message: conflict.message,
                });
                setSaveState('conflict');
                setErrorMessage(conflict.message);
                setStatusMessage('');
                return 'conflict';
            }

            setConflictState(null);
            setSaveState('failed');
            setErrorMessage(typeof error === 'string' ? error : `自动保存${config.entityLabel}失败。`);
            setStatusMessage('');
            return 'failed';
        }
    };

    const persistDraft = (
        sourceDraft: T,
        options: PersistDraftOptions = {},
    ): Promise<PersistDraftResult> => {
        const request: QueuedPersistDraft<T> = {
            sourceDraft,
            options,
            selectedTemplateId: selectedTemplateIdRef.current,
        };
        const inFlight = persistInFlightRef.current;
        if (inFlight) {
            queuedPersistRef.current = request;
            return inFlight;
        }

        const drain = (async () => {
            let nextRequest: QueuedPersistDraft<T> | null = request;
            let result: PersistDraftResult = 'unchanged';

            while (nextRequest) {
                result = await persistDraftInternal(nextRequest.sourceDraft, nextRequest.options);
                if (result === 'failed' || result === 'conflict') {
                    queuedPersistRef.current = null;
                    return result;
                }

                nextRequest = queuedPersistRef.current;
                queuedPersistRef.current = null;
            }

            return result;
        })();

        persistInFlightRef.current = drain;
        void drain.finally(() => {
            if (persistInFlightRef.current === drain) {
                persistInFlightRef.current = null;
            }
        });
        return drain;
    };

    /** Flush a pending debounced autosave; resolves false when the draft could not
     *  be persisted (conflict/failure UI is surfaced by persistDraft). */
    const flushPendingAutosave = async (): Promise<boolean> => {
        // Disarm the debounce so the timer cannot fire a second persist mid-switch.
        setHasPendingAutosave(false);

        while (true) {
            const inFlight = persistInFlightRef.current;
            if (inFlight) {
                const result = await inFlight;
                if (result === 'failed' || result === 'conflict') {
                    return false;
                }
            }

            if (serializeForComparison(latestDraftRef.current) === lastPersistedSnapshotRef.current) {
                return true;
            }

            const result = await persistDraft(latestDraftRef.current);
            if (result === 'failed' || result === 'conflict') {
                return false;
            }
        }
    };

    const updateDraft = (updater: (current: T) => T) => {
        setDraft((current) => updater(current));

        if (conflictStateRef.current) {
            setHasPendingAutosave(false);
            setSaveState('conflict');
            setStatusMessage('');
            setErrorMessage(conflictStateRef.current.message);
            return;
        }

        setConflictState(null);
        setHasPendingAutosave(true);
        setSaveState('saving');
        setStatusMessage('');
        setErrorMessage('');
    };

    const selectTemplate = async (id: string) => {
        // Ignore a second switch while a flush-and-switch is already in flight.
        if (switchingRef.current) {
            return;
        }

        switchingRef.current = true;
        setIsSwitching(true);
        try {
            const flushed = await flushPendingAutosave();
            if (!flushed) {
                // Keep the current draft; the conflict/failure UI is already visible.
                return;
            }

            setSelectedTemplateId(id);
            const nextDraft = templatesRef.current[id] ?? config.createDefault();
            setDraft(nextDraft);
            lastPersistedSnapshotRef.current = serializeForComparison(nextDraft);
            setHasPendingAutosave(false);
            setConflictState(null);
            setSaveState(id ? 'saved' : 'idle');
            setStatusMessage('');
            setErrorMessage('');
        } finally {
            switchingRef.current = false;
            setIsSwitching(false);
        }
    };

    const createTemplate = async () => {
        if (switchingRef.current) {
            return;
        }

        switchingRef.current = true;
        setIsSwitching(true);
        try {
            const flushed = await flushPendingAutosave();
            if (!flushed) {
                return;
            }

            const emptyDraft = config.createDefault();
            setSelectedTemplateId('');
            setDraft(emptyDraft);
            setHasPendingAutosave(false);
            setConflictState(null);
            setSaveState('idle');
            setStatusMessage(`已创建空白${config.entityLabel}草稿。`);
            setErrorMessage('');
        } finally {
            switchingRef.current = false;
            setIsSwitching(false);
        }
    };

    const duplicateTemplate = async () => {
        if (switchingRef.current) {
            return;
        }

        switchingRef.current = true;
        setIsSwitching(true);
        try {
            const flushed = await flushPendingAutosave();
            if (!flushed) {
                return;
            }

            const duplicated = createCopyDraft(
                latestDraftRef.current,
                config.fallbackName,
                Object.values(templatesRef.current).map((template) => template.name),
            );

            setSelectedTemplateId('');
            setDraft(duplicated);
            setHasPendingAutosave(false);
            setConflictState(null);
            setSaveState('idle');
            setStatusMessage(`已基于当前${config.entityLabel}创建副本草稿。`);
            setErrorMessage('');
        } finally {
            switchingRef.current = false;
            setIsSwitching(false);
        }
    };

    const importTemplate = async () => {
        try {
            const selectedFile = await open({
                filters: [{ name: config.fileFilterName, extensions: ['json'] }],
                multiple: false,
            });

            const importPath = Array.isArray(selectedFile) ? selectedFile[0] : selectedFile;
            if (!importPath) {
                return;
            }

            const importTemplateWithStrategy = (conflictStrategy: 'reject' | 'overwrite' | 'copy') =>
                invoke<{ id: string; template: T }>(config.importCommand, {
                    path: importPath,
                    conflictStrategy,
                });

            let imported: { id: string; template: T };
            try {
                imported = await importTemplateWithStrategy('reject');
            } catch (error) {
                const conflictName = parseImportConflictName(error);
                if (!conflictName) {
                    throw error;
                }

                const strategy = options.resolveImportConflict
                    ? await options.resolveImportConflict(config.entityLabel, conflictName)
                    : null;
                if (!strategy) {
                    return;
                }

                imported = await importTemplateWithStrategy(strategy);
            }

            await loadData(imported.id);
            setSaveState('saved');
            setStatusMessage(`已导入${config.entityLabel}"${imported.template.name || imported.id}"。`);
            setErrorMessage('');
            setConflictState(null);
        } catch (error) {
            setSaveState('failed');
            setErrorMessage(typeof error === 'string' ? error : `导入${config.entityLabel}失败。`);
            setStatusMessage('');
        }
    };

    const exportTemplate = async () => {
        const id = selectedTemplateId || draft.id.trim();
        if (!id) {
            setErrorMessage(`请先选择或保存一个${config.entityLabel}。`);
            setStatusMessage('');
            return;
        }

        try {
            const name = draft.name.trim() || id;
            const selectedPath = await save({
                defaultPath: `${sanitizeExportFileStem(name, id)}.json`,
                filters: [{ name: config.fileFilterName, extensions: ['json'] }],
            });
            if (!selectedPath) {
                return;
            }

            await invoke(config.exportCommand, {
                id,
                path: selectedPath,
            });
            setConflictState(null);
            setStatusMessage(`已导出${config.entityLabel}"${name}"。`);
            setErrorMessage('');
        } catch (error) {
            setSaveState('failed');
            setErrorMessage(typeof error === 'string' ? error : `导出${config.entityLabel}失败。`);
            setStatusMessage('');
        }
    };

    const deleteTemplate = async () => {
        if (!selectedTemplateId) {
            setDraft(config.createDefault());
            setSaveState('idle');
            setConflictState(null);
            return;
        }

        // Same switching discipline as selectTemplate: ignore re-entrant calls and
        // flush the pending debounced autosave first, so a firing timer cannot
        // resurrect the template while the delete round-trip is in flight.
        if (switchingRef.current) {
            return;
        }

        switchingRef.current = true;
        setIsSwitching(true);
        try {
            // Disarm the debounce and await any in-flight persist, so neither a
            // firing timer nor a late save can resurrect the deleted template.
            setHasPendingAutosave(false);
            const inFlight = persistInFlightRef.current;
            if (inFlight) {
                await inFlight;
            }

            try {
                await invoke(config.deleteCommand, { id: selectedTemplateIdRef.current });
                const deletedName = latestDraftRef.current.name || selectedTemplateIdRef.current;
                await loadData();
                setSaveState('saved');
                setConflictState(null);
                setStatusMessage(`${config.entityLabel}"${deletedName}"已删除。`);
                setErrorMessage('');
            } catch (error) {
                setSaveState('failed');
                setErrorMessage(typeof error === 'string' ? error : `删除${config.entityLabel}失败。`);
                setStatusMessage('');
            }
        } finally {
            switchingRef.current = false;
            setIsSwitching(false);
        }
    };

    const reloadConflictDraft = async () => {
        const currentConflict = conflictStateRef.current;
        if (!currentConflict) {
            return;
        }

        try {
            await loadData(currentConflict.entityId);
            setConflictState(null);
            setSaveState('saved');
            setStatusMessage(`已重新加载远端${config.entityLabel}。`);
            setErrorMessage('');
        } catch (error) {
            setSaveState('failed');
            setErrorMessage(typeof error === 'string' ? error : `重新加载${config.entityLabel}失败。`);
            setStatusMessage('');
        }
    };

    const overwriteConflictDraft = async () => {
        const currentConflict = conflictStateRef.current;
        if (!currentConflict) {
            return;
        }

        setConflictState(null);
        setStatusMessage('');
        setErrorMessage('');
        await persistDraft(latestDraftRef.current, {
            expectedRevision: currentConflict.currentRevision,
        });
    };

    const saveConflictAsCopy = async () => {
        const duplicated = createCopyDraft(
            latestDraftRef.current,
            config.fallbackName,
            Object.values(templatesRef.current).map((template) => template.name),
        );

        setSelectedTemplateId('');
        setDraft(duplicated);
        setHasPendingAutosave(false);
        setConflictState(null);
        setStatusMessage('');
        setErrorMessage('');
        await persistDraft(duplicated, { expectedRevision: null });
    };

    return {
        templates,
        draft,
        selectedTemplateId,
        sortedTemplates,
        statusMessage,
        errorMessage,
        hasPendingAutosave,
        saveState,
        conflictState,
        loadError,
        isSwitching,
        selectTemplate,
        createTemplate,
        duplicateTemplate,
        updateDraft,
        deleteTemplate,
        importTemplate,
        exportTemplate,
        loadData,
        reloadConflictDraft,
        overwriteConflictDraft,
        saveConflictAsCopy,
    };
}

export const quickPublishTemplateManagerConfig: TemplateManagerConfig<QuickPublishTemplate> = {
    configKey: 'quick_publish_templates',
    createDefault: createDefaultQuickPublishTemplate,
    normalize: normalizeQuickPublishTemplate,
    saveCommand: 'save_quick_publish_template',
    deleteCommand: 'delete_quick_publish_template',
    importCommand: 'import_quick_publish_template_from_file',
    exportCommand: 'export_quick_publish_template_to_file',
    fallbackPrefix: 'quick-publish',
    fallbackName: '未命名发布模板',
    fileFilterName: '快速发布模板文件',
    entityLabel: '发布模板',
};

export const contentTemplateManagerConfig: TemplateManagerConfig<ContentTemplate> = {
    configKey: 'content_templates',
    createDefault: createDefaultContentTemplate,
    normalize: normalizeContentTemplate,
    saveCommand: 'save_content_template',
    deleteCommand: 'delete_content_template',
    importCommand: 'import_content_template_from_file',
    exportCommand: 'export_content_template_to_file',
    fallbackPrefix: 'content',
    fallbackName: '未命名公共正文模板',
    fileFilterName: '正文模板文件',
    entityLabel: '公共正文模板',
};

function sortedObjectKeys<T>(collection: Record<string, T>): string[] {
    return Object.keys(collection).sort((left, right) => left.localeCompare(right, 'zh-CN'));
}
