import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
    FolderOpen,
    Download,
    Upload,
    Trash2,
    Send,
    Loader2,
    RefreshCw,
} from 'lucide-react';
import FieldHelpHint from '../components/FieldHelpHint';
import FileTree from '../components/FileTree';
import ConsoleModal, { PublishConsoleSite } from '../components/ConsoleModal';
import PublishContentEditor from '../components/PublishContentEditor';
import TagInput from '../components/TagInput';
import TemplateSelect, { TemplateSelectOption } from '../components/TemplateSelect';
import WarningBanner from '../components/WarningBanner';
import type { TorrentInfo } from '../types/torrent';
import { useImportConflictDialog } from '../hooks/useImportConflictDialog';
import {
    createPublishConsoleSiteMap,
    createPublishId,
    usePublishTask,
} from '../hooks/usePublishTask';
import { useNoticeDialog } from '../hooks/useNoticeDialog';
import { SiteCookies } from '../utils/cookieUtils';
import {
    ENTITY_NAME_MAX_LENGTH,
    parseImportConflictName,
    sanitizeEntityNameInput,
    sanitizeExportFileStem,
    trimEntityName,
} from '../utils/entityNaming';
import { renderMarkdownToHtml } from '../utils/markdown';
import { serializeForComparison } from '../utils/templateSnapshot';
import { isHtmlPreferredSite, validatePublishContentForSites } from '../utils/publishValidation';
import { DEFAULT_OKP_TAGS } from '../utils/okpTags';
import { getPublishStatusTextClass, getSiteLoginStateBadgeClass } from '../utils/siteStatus';
import { SiteDefinition, siteDefinitions, useSiteLoginTest } from '../hooks/useSiteLoginTest';
import { useSiteRows } from '../hooks/useSiteRows';
import { useLatest } from '../hooks/useLatest';
import { AUTOSAVE_DEBOUNCE_MS } from '../utils/constants';
import { reconcileSelectableSiteSelection } from '../utils/siteSelection';
import {
    DEFAULT_EP_PATTERN,
    DEFAULT_RESOLUTION_PATTERN,
    DEFAULT_TITLE_PATTERN,
    EP_PATTERN_HELP,
    normalizeRuleTemplate,
} from '../utils/titleRules';
import {
    ParsedTitleDetails,
    PublishTitleMetadata,
    resolvePublishTitleMetadata,
} from '../utils/publishTitleMetadata';
import { createLatestValuePersistQueue } from '../utils/lastUsedPersistQueue';
import { buildSortedTemplateSelectOptions } from '../utils/templateSelectOptions';
import { extractDroppedFilePath } from '../utils/drop';
import {
    createDefaultPublishHistory,
    formatTemplateTimestamp,
    getPublishedVersionLabel,
    normalizePublishHistory,
    quickPublishSiteKeys,
    SitePublishHistory,
    SiteSelection,
} from '../utils/quickPublish';

interface Template {
    ep_pattern: string;
    resolution_pattern: string;
    title_pattern: string;
    poster: string;
    about: string;
    tags: string;
    description: string;
    description_html: string;
    profile: string;
    title: string;
    publish_history: SitePublishHistory;
    sites: SiteSelection;
}

interface ConfigPayload {
    last_used_template: string | null;
    okp_executable_path: string;
    templates: Record<string, Partial<Template>>;
}

interface ImportedTemplatePayload {
    name: string;
    template: Partial<Template>;
}

interface PublishAttemptContext {
    publishId: string;
    templateName: string;
    publishedAt: string;
    publishedEpisode: string;
    publishedResolution: string;
    siteKeys: (keyof SiteSelection)[];
}

interface TemplatePublishHistoryUpdate {
    site_key: keyof SiteSelection;
    last_published_at: string;
    last_published_episode: string;
    last_published_resolution: string;
}

interface Profile {
    user_agent: string;
    site_cookies: SiteCookies;
    dmhy_name: string;
    nyaa_name: string;
    acgrip_name: string;
    acgrip_api_token: string;
    bangumi_name: string;
    acgnx_asia_name: string;
    acgnx_asia_token: string;
    acgnx_global_name: string;
    acgnx_global_token: string;
    [key: string]: unknown;
}

const buildTemplateOptions = (templates: Record<string, Partial<Template>>): TemplateSelectOption[] =>
    buildSortedTemplateSelectOptions(
        Object.entries(templates).map(([name, templateValue]) => {
            const normalizedTemplate = normalizeTemplate(templateValue);
            return {
                name,
                label: name,
                publishTimestamps: quickPublishSiteKeys.map(
                    (siteKey) => normalizedTemplate.publish_history[siteKey].last_published_at,
                ),
                formatPublishedAtLabel: formatTemplateTimestamp,
            };
        }),
    );

const mergePublishHistory = (
    templateValue: Template,
    updates: TemplatePublishHistoryUpdate[],
): Template => {
    const nextPublishHistory = normalizePublishHistory(templateValue.publish_history);

    for (const update of updates) {
        nextPublishHistory[update.site_key] = {
            last_published_at: update.last_published_at,
            last_published_episode: update.last_published_episode,
            last_published_resolution: update.last_published_resolution,
        };
    }

    return {
        ...templateValue,
        publish_history: nextPublishHistory,
    };
};

const defaultTemplate: Template = {
    ep_pattern: DEFAULT_EP_PATTERN,
    resolution_pattern: DEFAULT_RESOLUTION_PATTERN,
    title_pattern: DEFAULT_TITLE_PATTERN,
    poster: '',
    about: '',
    tags: DEFAULT_OKP_TAGS,
    description: '',
    description_html: '',
    profile: '',
    title: '',
    publish_history: createDefaultPublishHistory(),
    sites: {
        dmhy: false,
        nyaa: false,
        acgrip: false,
        bangumi: false,
        acgnx_asia: false,
        acgnx_global: false,
    },
};

function normalizeTemplate(template?: Partial<Template>): Template {
    return {
        ...defaultTemplate,
        ...template,
        ep_pattern: normalizeRuleTemplate(template?.ep_pattern, DEFAULT_EP_PATTERN),
        resolution_pattern: normalizeRuleTemplate(template?.resolution_pattern, DEFAULT_RESOLUTION_PATTERN),
        title_pattern: normalizeRuleTemplate(template?.title_pattern, DEFAULT_TITLE_PATTERN),
        tags: typeof template?.tags === 'string' ? template.tags : defaultTemplate.tags,
        description: typeof template?.description === 'string' ? template.description : defaultTemplate.description,
        description_html:
            typeof template?.description_html === 'string'
                ? template.description_html
                : defaultTemplate.description_html,
        publish_history: normalizePublishHistory(template?.publish_history),
        sites: {
            ...defaultTemplate.sites,
            ...template?.sites,
        },
    };
}

export default function HomePage() {
    const { requestImportConflictStrategy, importConflictDialog } = useImportConflictDialog();
    const { showNotice, noticeDialog } = useNoticeDialog();
    // Template state
    const [templateOptions, setTemplateOptions] = useState<TemplateSelectOption[]>([]);
    const [currentTemplateName, setCurrentTemplateName] = useState('');
    const [configLoadError, setConfigLoadError] = useState<string | null>(null);
    const [newTemplateName, setNewTemplateName] = useState('');
    const [template, setTemplate] = useState<Template>(defaultTemplate);

    // Profile state
    const [profileList, setProfileList] = useState<string[]>([]);
    const [selectedProfile, setSelectedProfile] = useState('');
    const [selectedProfileData, setSelectedProfileData] = useState<Profile | null>(null);
    const [okpExecutablePath, setOkpExecutablePath] = useState('');
    const [loadedProfileName, setLoadedProfileName] = useState('');

    // Torrent state
    const [torrentPath, setTorrentPath] = useState('');
    const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);
    const [torrentError, setTorrentError] = useState('');

    // Modal state
    const [showConsole, setShowConsole] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
    const {
        siteLoginTests,
        isTestingAllSiteLogins,
        hasRunningSiteLoginTest,
        clearSiteLoginTest,
        clearAllSiteLoginTests,
        handleSiteLoginTest: hookHandleSiteLoginTest,
        handleTestAllSiteLogins: hookHandleTestAllSiteLogins,
    } = useSiteLoginTest();
    const templateRef = useLatest(template);
    const currentTemplateNameRef = useLatest(currentTemplateName);
    const torrentInfoRef = useLatest(torrentInfo);
    const selectedProfileRef = useLatest(selectedProfile);
    const lastPersistedDescriptionRef = useRef(defaultTemplate.description);
    const lastPersistedDescriptionHtmlRef = useRef(defaultTemplate.description_html);
    const publishAttemptRef = useRef<PublishAttemptContext | null>(null);
    const lastUsedPersistQueueRef = useRef(
        createLatestValuePersistQueue({
            persist: async (name) => {
                await invoke('set_last_used_template', { name });
            },
            onError: (error) => {
                showNotice({
                    title: '记住最近模板失败',
                    message:
                        typeof error === 'string'
                            ? error
                            : '无法保存最近使用的模板。当前选择仍会保留。',
                });
            },
        }),
    );
    const descriptionSaveTimerRef = useRef<number | null>(null);
    const templateSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
    const templateSaveFailureGenerationRef = useRef(0);
    const templateSelectionQueueRef = useRef<Promise<void>>(Promise.resolve());
    const templateSelectionGenerationRef = useRef(0);
    const parseGenerationRef = useRef(0);
    const titleGenerationRef = useRef(0);
    const manualTitleEditGenerationRef = useRef(0);
    const profileLoadGenerationRef = useRef(0);

    // Load templates and profiles on mount
    useEffect(() => {
        loadProfileList();
        loadLastConfig();
    }, []);

    useEffect(() => {
        const hasPendingDescriptionSave =
            template.description !== lastPersistedDescriptionRef.current ||
            template.description_html !== lastPersistedDescriptionHtmlRef.current;

        if (!hasPendingDescriptionSave) {
            return;
        }

        descriptionSaveTimerRef.current = window.setTimeout(() => {
            descriptionSaveTimerRef.current = null;
            void persistTemplateToDisk(withSelectedProfile(templateRef.current));
        }, AUTOSAVE_DEBOUNCE_MS);

        return () => {
            if (descriptionSaveTimerRef.current !== null) {
                window.clearTimeout(descriptionSaveTimerRef.current);
                descriptionSaveTimerRef.current = null;
            }
        };
    }, [template.description, template.description_html]);

    useEffect(() => {
        const generation = ++profileLoadGenerationRef.current;
        const profileName = selectedProfile;
        setSelectedProfileData(null);
        setLoadedProfileName('');
        clearAllSiteLoginTests();

        if (!profileName) {
            return;
        }

        void loadSelectedProfileData(profileName, generation);
    }, [selectedProfile]);

    const fetchConfig = () => invoke<ConfigPayload>('get_config');

    const refreshTemplateOptions = async (config?: ConfigPayload) => {
        try {
            const nextConfig = config ?? await fetchConfig();
            setTemplateOptions(buildTemplateOptions(nextConfig.templates));
            return nextConfig;
        } catch (e) {
            console.error('加载模板列表失败:', e);
            return null;
        }
    };

    const loadProfileList = async () => {
        try {
            const list = await invoke<string[]>('get_profile_list');
            setProfileList(list);
        } catch (e) {
            console.error('加载配置列表失败:', e);
        }
    };

    const loadSelectedProfileData = async (profileName: string, generation: number) => {
        try {
            const store = await invoke<{
                profiles: Record<string, Profile>;
            }>('get_profiles');
            if (
                profileLoadGenerationRef.current !== generation
                || selectedProfileRef.current !== profileName
            ) {
                return;
            }
            setSelectedProfileData(store.profiles[profileName] ?? null);
            setLoadedProfileName(profileName);
            clearAllSiteLoginTests();
        } catch (e) {
            console.error('加载身份详情失败:', e);
            if (
                profileLoadGenerationRef.current === generation
                && selectedProfileRef.current === profileName
            ) {
                setSelectedProfileData(null);
                setLoadedProfileName(profileName);
            }
        }
    };

    const loadLastConfig = async () => {
        try {
            const config = await refreshTemplateOptions();
            if (!config) {
                return;
            }

            try {
                setConfigLoadError(await invoke<string | null>('get_config_load_error'));
            } catch (loadErrorStateError) {
                console.error('读取配置加载状态失败:', loadErrorStateError);
            }

            setOkpExecutablePath(config.okp_executable_path || '');
            const initialTemplateName =
                config.last_used_template ?? (config.templates.default ? 'default' : null);

            if (initialTemplateName && config.templates[initialTemplateName]) {
                const nextTemplate = normalizeTemplate(config.templates[initialTemplateName]);
                lastPersistedDescriptionRef.current = nextTemplate.description;
                lastPersistedDescriptionHtmlRef.current = nextTemplate.description_html;
                setCurrentTemplateName(initialTemplateName);
                setTemplate(nextTemplate);
                setSelectedProfile(nextTemplate.profile || '');
            }
        } catch (e) {
            console.error('加载配置失败:', e);
        }
    };

    const loadTemplate = async (
        name: string,
        selectionGeneration?: number,
        beforeApply?: () => Promise<boolean>,
    ) => {
        try {
            const config = await fetchConfig();
            // Drop stale responses before any UI mutation (options list or template body).
            if (
                selectionGeneration !== undefined
                && selectionGeneration !== templateSelectionGenerationRef.current
            ) {
                return false;
            }

            if (beforeApply && !(await beforeApply())) {
                return false;
            }

            if (
                selectionGeneration !== undefined
                && selectionGeneration !== templateSelectionGenerationRef.current
            ) {
                return false;
            }

            await refreshTemplateOptions(config);

            if (
                selectionGeneration !== undefined
                && selectionGeneration !== templateSelectionGenerationRef.current
            ) {
                return false;
            }

            if (config.templates[name]) {
                const nextTemplate = normalizeTemplate(config.templates[name]);
                lastPersistedDescriptionRef.current = nextTemplate.description;
                lastPersistedDescriptionHtmlRef.current = nextTemplate.description_html;
                setCurrentTemplateName(name);
                setNewTemplateName('');
                setTemplate(nextTemplate);
                titleGenerationRef.current += 1;
                setIsGeneratingTitle(false);
                setSelectedProfile(nextTemplate.profile || '');
                return true;
            }
            return false;
        } catch (e) {
            console.error('加载模板失败:', e);
            return false;
        }
    };

    /** User dropdown selection only — never called from restore/import/loadLastConfig. */
    const handleTemplateSelection = (name: string) => {
        const selectionGeneration = ++templateSelectionGenerationRef.current;
        const runSelection = async () => {
            const failureGeneration = templateSaveFailureGenerationRef.current;
            const drainDescriptionSaves = async () => {
                while (selectionGeneration === templateSelectionGenerationRef.current) {
                    const pendingQueue = templateSaveQueueRef.current;
                    await pendingQueue;
                    if (templateSaveFailureGenerationRef.current !== failureGeneration) {
                        return false;
                    }
                    if (pendingQueue !== templateSaveQueueRef.current) {
                        continue;
                    }

                    if (descriptionSaveTimerRef.current !== null) {
                        window.clearTimeout(descriptionSaveTimerRef.current);
                        descriptionSaveTimerRef.current = null;
                    }
                    const currentTemplate = templateRef.current;
                    const hasDirtyDescription =
                        currentTemplate.description !== lastPersistedDescriptionRef.current
                        || currentTemplate.description_html !== lastPersistedDescriptionHtmlRef.current;
                    if (!hasDirtyDescription) {
                        return true;
                    }

                    const saved = await persistTemplateToDisk(withSelectedProfile(currentTemplate));
                    if (!saved) {
                        return false;
                    }
                }
                return false;
            };

            if (!(await drainDescriptionSaves())) {
                return;
            }
            const loaded = await loadTemplate(name, selectionGeneration, drainDescriptionSaves);
            if (loaded) {
                lastUsedPersistQueueRef.current.enqueue(name);
            }
        };

        const selection = templateSelectionQueueRef.current.then(runSelection, runSelection);
        templateSelectionQueueRef.current = selection.then(() => undefined, () => undefined);
    };

    const getTemplateName = (explicitName?: string) => {
        const candidates = [explicitName, currentTemplateName, newTemplateName]
            .map((value) => trimEntityName(value || ''))
            .filter((value) => value.length > 0);

        return candidates[0] || 'default';
    };

    const withSelectedProfile = (templateValue: Template, profileName: string = selectedProfile) => ({
        ...templateValue,
        profile: profileName,
    });

    const persistTemplateToDisk = (
        templateToSave: Template = withSelectedProfile(templateRef.current),
        explicitName?: string,
        expectedEditorSnapshot?: string,
    ) => {
        const name = getTemplateName(explicitName);
        const capturedTemplateName = currentTemplateNameRef.current;
        const preSaveSnapshot = expectedEditorSnapshot ?? serializeForComparison(templateToSave);

        const save = async () => {
            try {
                const saved = await invoke<ImportedTemplatePayload>('save_template', {
                    name,
                    template: templateToSave,
                    previousName: capturedTemplateName || undefined,
                });
                const nextTemplate = normalizeTemplate(saved.template);

                if (currentTemplateNameRef.current === capturedTemplateName) {
                    lastPersistedDescriptionRef.current = nextTemplate.description;
                    lastPersistedDescriptionHtmlRef.current = nextTemplate.description_html;
                    // Only apply the saved template when the editor was not touched while the
                    // save was in flight; otherwise the response would clobber fresh keystrokes.
                    // Compare with the same profile augmentation as the pre-save snapshot so a
                    // profile switch does not silently disable the guard.
                    if (
                        serializeForComparison(withSelectedProfile(templateRef.current, templateToSave.profile))
                        === preSaveSnapshot
                    ) {
                        setTemplate(nextTemplate);
                        setNewTemplateName('');
                    }
                    setCurrentTemplateName(saved.name);
                }
                await refreshTemplateOptions();
                return { name: saved.name, template: nextTemplate };
            } catch (e) {
                templateSaveFailureGenerationRef.current += 1;
                console.error('保存模板失败:', e);
                if (currentTemplateNameRef.current === capturedTemplateName) {
                    // Surface autosave failures too, and leave the dirty state intact so the
                    // debounce effect re-arms (lastPersisted* refs stay at their pre-save values).
                    showNotice({
                        title: '保存模板失败',
                        message: typeof e === 'string' ? e : '保存模板失败。',
                    });
                }
                return null;
            }
        };

        const queuedSave = templateSaveQueueRef.current.then(save, save);
        templateSaveQueueRef.current = queuedSave.then(() => undefined, () => undefined);
        return queuedSave;
    };

    const autosaveTemplate = (templateToSave: Template = withSelectedProfile(templateRef.current), explicitName?: string) => {
        void persistTemplateToDisk(templateToSave, explicitName);
    };

    const deleteTemplate = async () => {
        if (!currentTemplateName) return;
        try {
            await invoke('delete_template', { name: currentTemplateName });
            setCurrentTemplateName('');
            setNewTemplateName('');
            lastPersistedDescriptionRef.current = defaultTemplate.description;
            lastPersistedDescriptionHtmlRef.current = defaultTemplate.description_html;
            setTemplate(defaultTemplate);
            setSelectedProfile('');
            clearAllSiteLoginTests();
            await refreshTemplateOptions();
        } catch (e) {
            console.error('删除模板失败:', e);
        }
    };

    // Torrent file handling
    const selectTorrentFile = async () => {
        try {
            const file = await open({
                filters: [{ name: '种子文件', extensions: ['torrent'] }],
            });
            if (file) {
                await parseTorrent(file);
            }
        } catch (e) {
            console.error('选择文件失败:', e);
        }
    };

    const matchTitle = useCallback(async (filename?: string, templateToMatch?: Template) => {
        const name = filename || torrentInfoRef.current?.name;
        const activeTemplate = templateToMatch || templateRef.current;

        if (!name || !activeTemplate.title_pattern.trim()) {
            return '';
        }

        try {
            const details = await invoke<ParsedTitleDetails>('parse_title_details', {
                filename: name,
                epPattern: activeTemplate.ep_pattern,
                resolutionPattern: activeTemplate.resolution_pattern,
                titlePattern: activeTemplate.title_pattern,
            });
            const title = details.title;

            return title;
        } catch (e) {
            console.error('匹配标题失败:', e);
            return '';
        }
    }, [torrentInfoRef]);

    const parseTorrent = useCallback(async (path: string) => {
        const generation = ++parseGenerationRef.current;
        titleGenerationRef.current += 1;
        setIsGeneratingTitle(false);
        setTorrentPath('');
        setTorrentInfo(null);
        setTorrentError('');
        try {
            const info = await invoke<TorrentInfo>('parse_torrent', { path });
            if (generation !== parseGenerationRef.current) {
                return;
            }
            setTorrentPath(path);
            setTorrentInfo(info);
            setTorrentError('');
            // Only prefill an empty title; never overwrite a user-edited final title.
            const activeTemplate = templateRef.current;
            if (!activeTemplate.title.trim() && activeTemplate.title_pattern.trim()) {
                const manualTitleEditGeneration = manualTitleEditGenerationRef.current;
                const title = await matchTitle(info.name, activeTemplate);
                if (
                    generation === parseGenerationRef.current
                    && manualTitleEditGeneration === manualTitleEditGenerationRef.current
                    && title
                ) {
                    setTemplate((current) => (current.title.trim() ? current : { ...current, title }));
                }
            }
        } catch (e) {
            if (generation !== parseGenerationRef.current) {
                return;
            }
            console.error('解析种子文件失败:', e);
            setTorrentInfo(null);
            setTorrentPath('');
            setTorrentError(typeof e === 'string' ? e : '解析种子文件失败。');
        }
    }, [matchTitle, templateRef]);

    useEffect(() => {
        let disposed = false;
        let unlisten: UnlistenFn | null = null;

        const setupDragDropListener = async () => {
            const nextUnlisten = await getCurrentWindow().onDragDropEvent((event) => {
                if (event.payload.type === 'enter' || event.payload.type === 'over') {
                    setIsDragging(true);
                    return;
                }

                if (event.payload.type === 'leave') {
                    setIsDragging(false);
                    return;
                }

                setIsDragging(false);
                const droppedTorrentPath = extractDroppedFilePath(event.payload.paths);

                if (droppedTorrentPath) {
                    void parseTorrent(droppedTorrentPath);
                }
            });

            // If cleanup ran while registration was in flight, detach immediately.
            if (disposed) {
                nextUnlisten();
                return;
            }
            unlisten = nextUnlisten;
        };

        void setupDragDropListener();

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [parseTorrent]);

    
    const saveOkpExecutablePath = async (path: string) => {
        try {
            await invoke('save_okp_executable_path', {
                okpExecutablePath: path,
            });
            setOkpExecutablePath(path);
        } catch (e) {
            console.error('保存 OKP 可执行文件路径失败:', e);
        }
    };

    const selectOkpExecutable = async () => {
        try {
            const file = await open();
            const selectedPath = Array.isArray(file) ? file[0] : file;
            if (selectedPath) {
                await saveOkpExecutablePath(selectedPath);
            }
        } catch (e) {
            console.error('选择 OKP 可执行文件失败:', e);
        }
    };

    const clearOkpExecutablePath = async () => {
        await saveOkpExecutablePath('');
    };

    const handleImportTemplate = async () => {
        try {
            const selectedFile = await open({
                filters: [{ name: '模板文件', extensions: ['json'] }],
                multiple: false,
            });

            const importPath = Array.isArray(selectedFile) ? selectedFile[0] : selectedFile;
            if (!importPath) {
                return;
            }

            const importTemplateWithStrategy = (conflictStrategy: 'reject' | 'overwrite' | 'copy') =>
                invoke<ImportedTemplatePayload>('import_template_from_file', {
                    path: importPath,
                    conflictStrategy,
                });

            let imported: ImportedTemplatePayload;
            try {
                imported = await importTemplateWithStrategy('reject');
            } catch (error) {
                const conflictName = parseImportConflictName(error);
                if (!conflictName) {
                    throw error;
                }

                const strategy = await requestImportConflictStrategy('模板', conflictName);
                if (!strategy) {
                    return;
                }

                imported = await importTemplateWithStrategy(strategy);
            }
            const nextTemplate = normalizeTemplate(imported.template);

            lastPersistedDescriptionRef.current = nextTemplate.description;
            lastPersistedDescriptionHtmlRef.current = nextTemplate.description_html;
            setCurrentTemplateName(imported.name);
            setNewTemplateName('');
            setTemplate(nextTemplate);
            setSelectedProfile(nextTemplate.profile || '');
            await refreshTemplateOptions();
        } catch (e) {
            console.error('导入模板失败:', e);
            showNotice({
                title: '导入模板失败',
                message: typeof e === 'string' ? e : '导入模板失败。',
            });
        }
    };

    const handleExportTemplate = async () => {
        const candidateName = trimEntityName(currentTemplateName) || trimEntityName(newTemplateName);
        if (!candidateName) {
            return;
        }

        try {
            const templateToExport = withSelectedProfile(templateRef.current);
            const savedTemplate = await persistTemplateToDisk(templateToExport, candidateName);
            if (!savedTemplate) {
                return;
            }

            const selectedPath = await save({
                defaultPath: `${sanitizeExportFileStem(savedTemplate.name, 'template')}.json`,
                filters: [{ name: '模板文件', extensions: ['json'] }],
            });

            if (!selectedPath) {
                return;
            }

            await invoke('export_template_to_file', {
                name: savedTemplate.name,
                path: selectedPath,
            });
        } catch (e) {
            console.error('导出模板失败:', e);
        }
    };

    const resolvePublishDetails = async (
        templateToPublish: Template,
        fallbackFilename?: string,
    ): Promise<PublishTitleMetadata> =>
        resolvePublishTitleMetadata({
            finalTitle: templateToPublish.title,
            fallbackFilename,
            template: templateToPublish,
            parseTitleDetails: (request) =>
                invoke<ParsedTitleDetails>('parse_title_details', {
                    filename: request.filename,
                    epPattern: request.epPattern,
                    resolutionPattern: request.resolutionPattern,
                    titlePattern: request.titlePattern,
                }),
        });

    const finalizePublishHistory = useCallback(async (
        publishId: string,
        siteSuccess: Partial<Record<keyof SiteSelection, boolean>>,
    ) => {
        const publishAttempt = publishAttemptRef.current;
        publishAttemptRef.current = null;

        if (!publishAttempt || publishAttempt.publishId !== publishId) {
            return;
        }

        const updates = publishAttempt.siteKeys
            .filter((siteKey) => siteSuccess[siteKey])
            .map((siteKey) => ({
                site_key: siteKey,
                last_published_at: publishAttempt.publishedAt,
                last_published_episode: publishAttempt.publishedEpisode,
                last_published_resolution: publishAttempt.publishedResolution,
            }));

        if (updates.length === 0) {
            return;
        }

        try {
            await invoke('update_template_publish_history', {
                name: publishAttempt.templateName,
                updates,
            });

            if (currentTemplateNameRef.current === publishAttempt.templateName) {
                setTemplate((current) => mergePublishHistory(current, updates));
            }

            await refreshTemplateOptions();
        } catch (e) {
            console.error('保存模板发布历史失败:', e);
        }
    }, [currentTemplateNameRef, refreshTemplateOptions]);

    const {
        isPublishing,
        publishSites,
        isPublishComplete,
        publishResult,
        publishCompletion,
        startPublishTask,
        showPublishResult,
        failActivePublish,
        clearPublishCompletion,
    } = usePublishTask<keyof SiteSelection>();

    useEffect(() => {
        if (!publishCompletion) {
            return;
        }

        void finalizePublishHistory(publishCompletion.publishId, publishCompletion.siteSuccess);
        clearPublishCompletion();
    }, [clearPublishCompletion, finalizePublishHistory, publishCompletion]);

    const handlePatternBlur = async (
        field: 'ep_pattern' | 'resolution_pattern' | 'title_pattern',
        value: string,
    ) => {
        const nextTemplate = withSelectedProfile({ ...templateRef.current, [field]: value } as Template);
        setTemplate(nextTemplate);
        await persistTemplateToDisk(nextTemplate);
    };

    const handleGenerateTitle = async () => {
        if (isGeneratingTitle) {
            return;
        }

        const requestId = ++titleGenerationRef.current;
        const capturedTemplateName = currentTemplateNameRef.current;
        const capturedTorrentName = torrentInfoRef.current?.name ?? '';
        const capturedTemplate = templateRef.current;
        const startingTitle = capturedTemplate.title;
        const startingManualEditGeneration = manualTitleEditGenerationRef.current;
        setIsGeneratingTitle(true);

        try {
            const generatedTitle = await matchTitle(capturedTorrentName, capturedTemplate);
            if (!generatedTitle.trim()) {
                return;
            }

            if (
                requestId !== titleGenerationRef.current
                || capturedTemplateName !== currentTemplateNameRef.current
                || capturedTorrentName !== (torrentInfoRef.current?.name ?? '')
                || startingTitle !== templateRef.current.title
                || startingManualEditGeneration !== manualTitleEditGenerationRef.current
            ) {
                return;
            }

            const nextTemplate = withSelectedProfile({ ...templateRef.current, title: generatedTitle });
            setTemplate(nextTemplate);
            await persistTemplateToDisk(nextTemplate);
        } finally {
            if (requestId === titleGenerationRef.current) {
                setIsGeneratingTitle(false);
            }
        }
    };

    const getErrorMessage = (error: unknown) => {
        if (typeof error === 'string') {
            return error;
        }

        if (error instanceof Error) {
            return error.message;
        }

        return '发布失败，请查看日志输出。';
    };

    const handleSiteLoginTest = (site: SiteDefinition) => {
        void hookHandleSiteLoginTest(site, readySelectedProfileData);
    };

    const handleTestAllSiteLogins = () => {
        void hookHandleTestAllSiteLogins(siteDefinitions, readySelectedProfileData);
    };

    const readySelectedProfileData =
        loadedProfileName === selectedProfile ? selectedProfileData : null;

    const siteRows = useSiteRows({
        publishSites,
        selectedProfileData: readySelectedProfileData,
        siteLoginTests,
        publishHistory: template.publish_history,
    });

    const selectedSiteKeys = useMemo(
        () =>
            siteRows
                .filter((row) => row.selectable && template.sites[row.site.key as keyof SiteSelection])
                .map((row) => row.site.key),
        [siteRows, template.sites],
    );

    useEffect(() => {
        const selectableSiteKeys = new Set<keyof SiteSelection>(
            siteRows
                .filter((row) => row.selectable)
                .map((row) => row.site.key as keyof SiteSelection),
        );

        const currentTemplate = templateRef.current;
        const nextSites = reconcileSelectableSiteSelection(currentTemplate.sites, selectableSiteKeys);

        if (nextSites === currentTemplate.sites) {
            return;
        }

        const nextTemplate = { ...currentTemplate, sites: nextSites };
        setTemplate(nextTemplate);
        autosaveTemplate(withSelectedProfile(nextTemplate));
    }, [siteRows]);

    // Publish
    const handlePublish = async () => {
        if (!torrentPath) return;
        if (!selectedProfile) return;
        if (!okpExecutablePath) return;
        if (selectedSiteKeys.length === 0) return;
        if (isPublishing) return;

        const publishTemplateName = getTemplateName();
        const selectedSites = siteDefinitions.filter((site) => template.sites[site.key as keyof SiteSelection]);
        let templateToPublish = withSelectedProfile(template, selectedProfile);
        const preBackfillSnapshot = serializeForComparison(templateToPublish);

        // Back-fill rendered HTML for HTML-preferring sites before validating and
        // persisting, so preview == persisted == published. The persisted response
        // updates the editor after the refs are current, avoiding a redundant autosave.
        if (
            templateToPublish.description.trim()
            && !templateToPublish.description_html.trim()
            && selectedSites.some((site) => isHtmlPreferredSite(site.key))
        ) {
            templateToPublish = {
                ...templateToPublish,
                description_html: renderMarkdownToHtml(templateToPublish.description),
            };
        }

        const contentValidationIssues = validatePublishContentForSites(templateToPublish, selectedSites);
        if (contentValidationIssues.length > 0) {
            const issueMessageMap = new Map(
                contentValidationIssues.map((issue) => [issue.siteCode, issue.message]),
            );
            const combinedMessage = contentValidationIssues.map((issue) => issue.message).join('；');

            showPublishResult(
                createPublishConsoleSiteMap(
                    selectedSites.map((site) => {
                        const siteMessage = issueMessageMap.get(site.key) ?? '发布已取消：发布内容校验未通过。';
                        return {
                            siteCode: site.key,
                            siteLabel: site.label,
                            lines: [{ text: siteMessage, isError: true }],
                            status: 'error' as const,
                            message: siteMessage,
                        };
                    }),
                ),
                {
                    success: false,
                    message: combinedMessage,
                },
            );
            setShowConsole(true);
            return;
        }

        const saved = await persistTemplateToDisk(
            templateToPublish,
            publishTemplateName,
            preBackfillSnapshot,
        );
        if (!saved) {
            return;
        }

        const finalTitle = templateToPublish.title.trim();
        const publishDetails = await resolvePublishDetails(
            templateToPublish,
            finalTitle ? undefined : torrentInfo?.name,
        );
        const publishId = createPublishId();

        publishAttemptRef.current = {
            publishId,
            templateName: saved.name,
            publishedAt: new Date().toISOString(),
            publishedEpisode: publishDetails.episode,
            publishedResolution: publishDetails.resolution,
            siteKeys: selectedSites.map((site) => site.key as keyof SiteSelection),
        };
        startPublishTask(
            publishId,
            createPublishConsoleSiteMap(
                selectedSites.map((site) => ({
                    siteCode: site.key,
                    siteLabel: site.label,
                    lines: [],
                    status: 'running' as const,
                    message: '等待 OKP 输出...',
                })),
            ),
        );
        setShowConsole(true);

        try {
            await invoke('publish', {
                request: {
                    publish_id: publishId,
                    torrent_path: torrentPath,
                    profile_name: selectedProfile,
                    template: templateToPublish,
                },
            });
        } catch (e) {
            console.error('发布失败:', e);
            failActivePublish(getErrorMessage(e));
        }
    };
    // Drag and drop is handled by the Tauri window drag-drop listener above;
    // HTML5 drop events never fire while Tauri dragDropEnabled is on.
    const handleTorrentPickerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') {
            return;
        }

        e.preventDefault();
        void selectTorrentFile();
    };

    const updateField = (field: keyof Template, value: string) => {
        setTemplate((t) => ({ ...t, [field]: value }));
    };

    const getTemplateWithFieldValue = (field: keyof Template, value: string): Template =>
        withSelectedProfile({ ...templateRef.current, [field]: value } as Template);

    const toggleSite = (site: keyof SiteSelection) => {
        const targetSiteRow = siteRows.find((row) => row.site.key === site);
        if (!targetSiteRow?.selectable) {
            return;
        }

        const currentTemplate = templateRef.current;
        const nextTemplate = {
            ...currentTemplate,
            sites: { ...currentTemplate.sites, [site]: !currentTemplate.sites[site] },
        };

        setTemplate(nextTemplate);
        clearSiteLoginTest(site);
        autosaveTemplate(withSelectedProfile(nextTemplate));
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-6 space-y-5">
                {configLoadError && (
                    <WarningBanner>
                        配置文件损坏，已加载默认配置，原文件未改动。请修复或删除配置文件后重启应用。
                    </WarningBanner>
                )}
                {/* Template Selection */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">模板管理</h2>
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <TemplateSelect
                                options={templateOptions}
                                value={currentTemplateName}
                                onChange={(name) => {
                                    void handleTemplateSelection(name);
                                }}
                            />
                        </div>
                        <input
                            type="text"
                            value={newTemplateName}
                            maxLength={ENTITY_NAME_MAX_LENGTH}
                            onChange={(e) => setNewTemplateName(sanitizeEntityNameInput(e.target.value))}
                            onBlur={(e) => {
                                const trimmedName = trimEntityName(e.target.value);
                                if (trimmedName) {
                                    autosaveTemplate(withSelectedProfile(templateRef.current), trimmedName);
                                }
                            }}
                            placeholder="新模板名称（失焦自动创建）"
                            className="w-56 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <button
                            onClick={deleteTemplate}
                            disabled={!currentTemplateName}
                            className="flex items-center gap-1.5 px-3 py-2 bg-red-600/80 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                        >
                            <Trash2 size={14} />
                            删除
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void handleImportTemplate();
                            }}
                            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                        >
                            <Download size={14} />
                            导入
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void handleExportTemplate();
                            }}
                            disabled={!currentTemplateName.trim() && !newTemplateName.trim()}
                            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                        >
                            <Upload size={14} />
                            导出
                        </button>
                    </div>
                </section>

                {/* Torrent File */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">种子文件</h2>
                    <div
                        role="button"
                        tabIndex={0}
                        aria-label="选择种子文件"
                        onClick={() => {
                            void selectTorrentFile();
                        }}
                        onKeyDown={handleTorrentPickerKeyDown}
                        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                            isDragging
                                ? 'border-emerald-400 bg-emerald-400/10'
                                : 'border-slate-700 hover:border-slate-600'
                        }`}
                    >
                        {torrentPath ? (
                            <div className="text-sm text-slate-300 space-y-1">
                                <p className="truncate">{torrentPath}</p>
                                <p className="text-xs text-slate-500">点击或拖放其他种子文件以替换</p>
                            </div>
                        ) : (
                            <div className="space-y-1">
                                <p className="text-sm text-slate-400">拖放种子文件到此处，或点击选择</p>
                                <p className="text-xs text-slate-500">支持直接拖拽 .torrent 文件</p>
                            </div>
                        )}
                    </div>
                    {torrentInfo && (
                        <div className="mt-2">
                            <FileTree root={torrentInfo.file_tree} totalSize={torrentInfo.total_size} />
                        </div>
                    )}
                    {torrentInfo?.compat_notice ? (
                        <WarningBanner className="mt-2">{torrentInfo.compat_notice}</WarningBanner>
                    ) : null}
                    {torrentError ? (
                        <p className="mt-2 text-xs text-rose-400">{torrentError}</p>
                    ) : null}
                </section>

                {/* Title Matching */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">标题自动生成</h2>
                    <div className="grid gap-3 md:grid-cols-2">
                        <div>
                            <label className="mb-1 flex items-center text-xs text-slate-500">
                                集数匹配正则
                                <FieldHelpHint label="集数正则说明">{EP_PATTERN_HELP}</FieldHelpHint>
                            </label>
                            <input
                                type="text"
                                value={template.ep_pattern}
                                onChange={(e) => updateField('ep_pattern', e.target.value)}
                                onBlur={(e) => {
                                    void handlePatternBlur('ep_pattern', e.target.value);
                                }}
                                placeholder={`如: ${DEFAULT_EP_PATTERN}`}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">分辨率匹配正则</label>
                            <input
                                type="text"
                                value={template.resolution_pattern}
                                onChange={(e) => updateField('resolution_pattern', e.target.value)}
                                onBlur={(e) => {
                                    void handlePatternBlur('resolution_pattern', e.target.value);
                                }}
                                placeholder={`如: ${DEFAULT_RESOLUTION_PATTERN}`}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                            />
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-1 block">标题模板</label>
                        <input
                            type="text"
                            value={template.title_pattern}
                            onChange={(e) => updateField('title_pattern', e.target.value)}
                            onBlur={(e) => {
                                void handlePatternBlur('title_pattern', e.target.value);
                            }}
                            placeholder={`如: ${DEFAULT_TITLE_PATTERN}`}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-500">
                        <span>自动生成仅用于填充建议标题；最终发布时始终以你手动编辑后的“发布标题”为准。</span>
                        <button
                            type="button"
                            onClick={() => {
                                void handleGenerateTitle();
                            }}
                            disabled={!torrentInfo?.name || !template.title_pattern.trim() || isGeneratingTitle}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {isGeneratingTitle ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                            重新生成标题
                        </button>
                    </div>
                    <div className="mt-2">
                        <label className="text-xs text-slate-500 mb-1 block">发布标题</label>
                        <textarea
                            rows={2}
                            value={template.title}
                            onChange={(e) => {
                                manualTitleEditGenerationRef.current += 1;
                                updateField('title', e.target.value);
                            }}
                            onBlur={(e) => autosaveTemplate(getTemplateWithFieldValue('title', e.target.value))}
                            placeholder="最终发布标题，可手动编辑或使用上方按钮重新生成"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                        />
                    </div>
                </section>

                {/* Content Fields */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">发布内容</h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">海报地址</label>
                            <input
                                type="text"
                                value={template.poster}
                                onChange={(e) => updateField('poster', e.target.value)}
                                onBlur={(e) => autosaveTemplate(getTemplateWithFieldValue('poster', e.target.value))}
                                placeholder="海报图片 URL"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">简介</label>
                            <input
                                type="text"
                                value={template.about}
                                onChange={(e) => updateField('about', e.target.value)}
                                onBlur={(e) => autosaveTemplate(getTemplateWithFieldValue('about', e.target.value))}
                                placeholder="简介或联系方式"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-1 block">标签</label>
                        <TagInput
                            value={template.tags}
                            placeholder=""
                            onChange={(nextTags) => updateField('tags', nextTags)}
                            onBlur={(nextTags) => autosaveTemplate(getTemplateWithFieldValue('tags', nextTags))}
                        />
                        <p className="mt-1 text-xs text-slate-500">
                            使用 OKP 的分类标签，不是 bangumi.moe 原生 tag。按 Tab 可补全当前候选，按空格或回车完成 tag 输入
                        </p>
                    </div>
                    <div className="mt-3">
                        <PublishContentEditor
                            contentKey={currentTemplateName || 'home-template'}
                            markdown={template.description}
                            html={template.description_html}
                            onMarkdownChange={(value) => updateField('description', value)}
                            onHtmlChange={(value) => updateField('description_html', value)}
                        />
                    </div>
                </section>

                {/* Identity & Site Selection */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">发布设置</h2>
                    <div className="flex gap-3 items-end">
                        <div className="flex-1">
                            <label className="text-xs text-slate-500 mb-1 block">身份选择</label>
                            <select
                                value={selectedProfile}
                                onChange={(e) => {
                                    const profileName = e.target.value;
                                    setSelectedProfile(profileName);
                                    autosaveTemplate(withSelectedProfile(templateRef.current, profileName));
                                }}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <option value="">选择身份配置...</option>
                                {profileList.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-1 block">OKP 可执行文件</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={okpExecutablePath}
                                readOnly
                                placeholder="请选择 OKP.Core 可执行文件或 DLL"
                                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={selectOkpExecutable}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                            >
                                <FolderOpen size={14} />
                                浏览
                            </button>
                            <button
                                type="button"
                                onClick={clearOkpExecutablePath}
                                disabled={!okpExecutablePath}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                            >
                                <Trash2 size={14} />
                                清空
                            </button>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                            Windows 请选择 OKP.Core.exe 或 OKP.Core.dll，Linux/macOS 请选择当前平台的 OKP.Core 可执行文件，或选择 OKP.Core.dll 并安装 dotnet 运行时。
                        </p>
                    </div>
                    <div className="mt-3">
                        <label className="mb-2 block text-xs text-slate-500">发布站点</label>
                        <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60">
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-left text-sm text-slate-300">
                                    <thead className="bg-slate-800/80 text-xs uppercase tracking-wide text-slate-500">
                                        <tr>
                                            <th className="w-16 px-4 py-3 font-medium">选择</th>
                                            <th className="px-4 py-3 font-medium">站点</th>
                                            <th className="w-40 px-4 py-3 font-medium">最后发布时间</th>
                                            <th className="w-32 px-4 py-3 font-medium">最后发布版本</th>
                                            <th className="px-4 py-3 font-medium">身份状态</th>
                                            <th className="w-36 px-4 py-3 font-medium">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        void handleTestAllSiteLogins();
                                                    }}
                                                    disabled={!readySelectedProfileData || isTestingAllSiteLogins || hasRunningSiteLoginTest}
                                                    title={
                                                        !readySelectedProfileData
                                                            ? '请先选择身份配置'
                                                            : hasRunningSiteLoginTest && !isTestingAllSiteLogins
                                                              ? '请等待当前登录测试完成'
                                                              : '测试全部支持登录检测的站点'
                                                    }
                                                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    {isTestingAllSiteLogins ? (
                                                        <>
                                                            <Loader2 size={12} className="animate-spin" />
                                                            测试中
                                                        </>
                                                    ) : (
                                                        '测试全部'
                                                    )}
                                                </button>
                                            </th>
                                            <th className="w-44 px-4 py-3 font-medium">发布状态</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {siteRows.map(({ site, selectable, selectDisabledReason, identityText, identityClass, identityTitle, loginState, publishState }) => (
                                            <tr key={site.key} className={`border-t border-slate-800/80 ${selectable ? '' : 'opacity-60'}`}>
                                                <td className="px-4 py-3 align-middle">
                                                    <input
                                                        type="checkbox"
                                                        checked={template.sites[site.key as keyof SiteSelection]}
                                                        disabled={!selectable}
                                                        onChange={() => toggleSite(site.key as keyof SiteSelection)}
                                                        title={selectable ? `选择 ${site.label}` : selectDisabledReason}
                                                        className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                                    />
                                                </td>
                                                <td className="px-4 py-3 align-middle font-medium text-slate-100">
                                                    {site.label}
                                                </td>
                                                <td className="px-4 py-3 align-middle text-xs text-slate-400">
                                                    {formatTemplateTimestamp(template.publish_history[site.key as keyof SiteSelection].last_published_at)}
                                                </td>
                                                <td className="px-4 py-3 align-middle text-slate-300">
                                                    {getPublishedVersionLabel(template.publish_history[site.key as keyof SiteSelection])}
                                                </td>
                                                <td className="px-4 py-3 align-middle">
                                                    <div className={identityClass} title={identityTitle}>
                                                        {identityText}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 align-middle">
                                                    {site.loginEnabled ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                void handleSiteLoginTest(site);
                                                            }}
                                                            disabled={!readySelectedProfileData || isTestingAllSiteLogins || loginState?.status === 'testing'}
                                                            title={loginState?.message ?? `测试 ${site.label} 登录`}
                                                            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            {loginState?.status === 'testing' ? (
                                                                <>
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                    测试中
                                                                </>
                                                            ) : loginState ? (
                                                                <span
                                                                    className={`rounded-full border px-2 py-0.5 ${getSiteLoginStateBadgeClass(loginState.status)}`}
                                                                >
                                                                    {loginState.status === 'success' ? '通过' : '重试'}
                                                                </span>
                                                            ) : (
                                                                '测试登录'
                                                            )}
                                                        </button>
                                                    ) : (
                                                        <span className="text-xs text-slate-500">不适用</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-middle">
                                                    <div className={getPublishStatusTextClass(publishState?.status ?? 'idle')}>
                                                        {publishState?.message || '未发布'}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </section>

                <section>
                    <button
                        onClick={handlePublish}
                        disabled={
                            !torrentPath ||
                            !selectedProfile ||
                            !okpExecutablePath ||
                            isPublishing ||
                            selectedSiteKeys.length === 0 ||
                            !readySelectedProfileData
                        }
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-all shadow-lg shadow-emerald-500/20"
                    >
                        <Send size={18} />
                        发布已选站点
                    </button>
                </section>
            </div>

            <ConsoleModal
                isOpen={showConsole}
                onClose={() => setShowConsole(false)}
                sites={siteDefinitions
                    .map((site) => publishSites[site.key])
                    .filter((site): site is PublishConsoleSite => Boolean(site))}
                isComplete={isPublishComplete}
                result={publishResult}
            />
            {importConflictDialog}
            {noticeDialog}
        </div>
    );
}
