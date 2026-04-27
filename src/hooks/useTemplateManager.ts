import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTOSAVE_DEBOUNCE_MS } from '../utils/constants';
import { useLatest } from '../hooks/useLatest';
import {
    createCopyEntityName,
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

function serializeForComparison<T extends AnyTemplate>(template: T): string {
    return JSON.stringify({
        ...template,
        updated_at: '',
        revision: 0,
    });
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

function createCopyDraft<T extends AnyTemplate>(
    template: T,
    fallbackName: string,
): T {
    const duplicated = {
        ...template,
        id: '',
        name: createCopyEntityName(template.name, fallbackName),
        updated_at: '',
        revision: 0,
    } as T;

    if ('publish_history' in duplicated) {
        (duplicated as QuickPublishTemplate).publish_history = createDefaultPublishHistory();
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

    selectTemplate: (id: string) => void;
    createTemplate: () => void;
    duplicateTemplate: () => void;
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
    const latestDraftRef = useLatest(draft);
    const conflictStateRef = useLatest(conflictState);
    const lastPersistedSnapshotRef = useRef(serializeForComparison(config.createDefault()));

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
        const fullConfig = await invoke<QuickPublishConfigPayload>('get_config');
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

    const persistDraft = async (
        sourceDraft: T,
        options: PersistDraftOptions = {},
    ) => {
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
            return;
        }

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

            lastPersistedSnapshotRef.current = savedSnapshot;
            setTemplates((current) => {
                const nextTemplates = { ...current };
                if (previousId && previousId !== saved.id) {
                    delete nextTemplates[previousId];
                }
                nextTemplates[saved.id] = savedTemplate;
                return nextTemplates;
            });
            setSelectedTemplateId(saved.id);
            setDraft((current) =>
                serializeForComparison(current) === sourceSnapshot
                    ? savedTemplate
                    : current,
            );
            if (serializeForComparison(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
            }
            setConflictState(null);
            setSaveState('saved');
            setStatusMessage(`${config.entityLabel}"${savedTemplate.name}"已自动保存。`);
            setErrorMessage('');
        } catch (error) {
            const conflict = parseTemplateRevisionConflict(error);
            if (conflict) {
                if (serializeForComparison(latestDraftRef.current) === sourceSnapshot) {
                    setHasPendingAutosave(false);
                }
                setConflictState({
                    entityId: conflict.entity_id,
                    currentRevision: conflict.current_revision,
                    message: conflict.message,
                });
                setSaveState('conflict');
                setErrorMessage(conflict.message);
                setStatusMessage('');
                return;
            }

            if (serializeForComparison(latestDraftRef.current) === sourceSnapshot) {
                setHasPendingAutosave(false);
            }
            setConflictState(null);
            setSaveState('failed');
            setErrorMessage(typeof error === 'string' ? error : `自动保存${config.entityLabel}失败。`);
            setStatusMessage('');
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

    const selectTemplate = (id: string) => {
        setSelectedTemplateId(id);
        const nextDraft = templates[id] ?? config.createDefault();
        setDraft(nextDraft);
        lastPersistedSnapshotRef.current = serializeForComparison(nextDraft);
        setHasPendingAutosave(false);
        setConflictState(null);
        setSaveState(id ? 'saved' : 'idle');
        setStatusMessage('');
        setErrorMessage('');
    };

    const createTemplate = () => {
        const emptyDraft = config.createDefault();
        setSelectedTemplateId('');
        setDraft(emptyDraft);
        setHasPendingAutosave(false);
        setConflictState(null);
        setSaveState('idle');
        setStatusMessage(`已创建空白${config.entityLabel}草稿。`);
        setErrorMessage('');
    };

    const duplicateTemplate = () => {
        const duplicated = createCopyDraft(draft, config.fallbackName);

        setSelectedTemplateId('');
        setDraft(duplicated);
        setHasPendingAutosave(false);
        setConflictState(null);
        setSaveState('idle');
        setStatusMessage(`已基于当前${config.entityLabel}创建副本草稿。`);
        setErrorMessage('');
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

        try {
            await invoke(config.deleteCommand, { id: selectedTemplateId });
            const deletedName = draft.name || selectedTemplateId;
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
        const duplicated = createCopyDraft(latestDraftRef.current, config.fallbackName);

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
