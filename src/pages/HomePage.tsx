import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
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
import FileTree, { FileTreeNodeData } from '../components/FileTree';
import ConsoleModal, {
    PublishComplete,
    PublishConsoleSite,
    PublishOutput,
    PublishSiteComplete,
} from '../components/ConsoleModal';
import PublishContentEditor from '../components/PublishContentEditor';
import TagInput from '../components/TagInput';
import TemplateSelect, { TemplateSelectOption } from '../components/TemplateSelect';
import { getCookiePanelSummary, getRemainingTextClass, getSiteCookieText, SiteCookies } from '../utils/cookieUtils';
import { renderMarkdownToHtml } from '../utils/markdown';
import { DEFAULT_OKP_TAGS } from '../utils/okpTags';
import { getPublishStatusTextClass, getSiteLoginStateBadgeClass, SiteLoginStatus } from '../utils/siteStatus';
import {
    DEFAULT_EP_PATTERN,
    DEFAULT_RESOLUTION_PATTERN,
    DEFAULT_TITLE_PATTERN,
    normalizeRuleTemplate,
} from '../utils/titleRules';

interface SiteSelection {
    dmhy: boolean;
    nyaa: boolean;
    acgrip: boolean;
    bangumi: boolean;
    acgnx_asia: boolean;
    acgnx_global: boolean;
}

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

interface SitePublishHistoryEntry {
    last_published_at: string;
    last_published_episode: string;
    last_published_resolution: string;
}

type SitePublishHistory = Record<keyof SiteSelection, SitePublishHistoryEntry>;

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
    bangumi_name: string;
    acgnx_asia_name: string;
    acgnx_asia_token: string;
    acgnx_global_name: string;
    acgnx_global_token: string;
}

interface SiteLoginTestResult {
    success: boolean;
    message: string;
}

interface SiteLoginTestState {
    status: SiteLoginStatus;
    message: string;
}

interface SiteDefinition {
    key: keyof SiteSelection;
    label: string;
    loginEnabled: boolean;
    nameField: keyof Profile;
    tokenField?: keyof Profile;
}

interface PublishContentValidationIssue {
    siteCode: keyof SiteSelection;
    siteLabel: string;
    message: string;
}

interface TorrentInfo {
    name: string;
    total_size: number;
    file_tree: FileTreeNodeData;
}

interface ParsedTitleDetails {
    title: string;
    episode: string;
    resolution: string;
}

const siteKeys: (keyof SiteSelection)[] = [
    'dmhy',
    'nyaa',
    'acgrip',
    'bangumi',
    'acgnx_asia',
    'acgnx_global',
];

const publishTimestampFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

const createDefaultPublishHistory = (): SitePublishHistory => ({
    dmhy: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    nyaa: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    acgrip: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    bangumi: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    acgnx_asia: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    acgnx_global: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
});

const normalizePublishHistory = (history?: Partial<SitePublishHistory>): SitePublishHistory => {
    const defaultHistory = createDefaultPublishHistory();

    return siteKeys.reduce((accumulator, siteKey) => {
        const entry = history?.[siteKey];
        accumulator[siteKey] = {
            last_published_at:
                typeof entry?.last_published_at === 'string'
                    ? entry.last_published_at
                    : defaultHistory[siteKey].last_published_at,
            last_published_episode:
                typeof entry?.last_published_episode === 'string'
                    ? entry.last_published_episode
                    : defaultHistory[siteKey].last_published_episode,
            last_published_resolution:
                typeof entry?.last_published_resolution === 'string'
                    ? entry.last_published_resolution
                    : defaultHistory[siteKey].last_published_resolution,
        };
        return accumulator;
    }, {} as SitePublishHistory);
};

const formatPublishTimestamp = (value: string) => {
    if (!value.trim()) {
        return '未发布';
    }

    const parsedTimestamp = Date.parse(value);
    if (Number.isNaN(parsedTimestamp)) {
        return value;
    }

    return publishTimestampFormatter.format(new Date(parsedTimestamp)).replace(/\//g, '-');
};

const getPublishTimestampSortValue = (value: string) => {
    if (!value.trim()) {
        return Number.NEGATIVE_INFINITY;
    }

    const parsedTimestamp = Date.parse(value);
    return Number.isNaN(parsedTimestamp) ? Number.NEGATIVE_INFINITY : parsedTimestamp;
};

const getLatestTemplatePublishAt = (templateValue: Template) => {
    let latestPublishedAt = '';
    let latestPublishedAtSortValue = Number.NEGATIVE_INFINITY;

    for (const siteKey of siteKeys) {
        const publishedAt = templateValue.publish_history[siteKey].last_published_at;
        const sortValue = getPublishTimestampSortValue(publishedAt);
        if (sortValue > latestPublishedAtSortValue) {
            latestPublishedAt = publishedAt;
            latestPublishedAtSortValue = sortValue;
        }
    }

    return latestPublishedAt;
};

const buildTemplateOptions = (templates: Record<string, Partial<Template>>): TemplateSelectOption[] =>
    Object.entries(templates)
        .map(([name, templateValue]) => {
            const normalizedTemplate = normalizeTemplate(templateValue);
            const latestPublishedAt = getLatestTemplatePublishAt(normalizedTemplate);

            return {
                name,
                label: name,
                latestPublishedAtLabel: formatPublishTimestamp(latestPublishedAt),
                sortValue: getPublishTimestampSortValue(latestPublishedAt),
            };
        })
        .sort((left, right) => {
            if (left.sortValue !== right.sortValue) {
                return left.sortValue - right.sortValue;
            }

            return left.label.localeCompare(right.label, 'zh-CN');
        })
        .map(({ sortValue: _sortValue, ...option }) => option);

const getPublishedValue = (value: string) => value.trim();

const getPublishedVersionLabel = (entry: SitePublishHistoryEntry) => {
    const episode = getPublishedValue(entry.last_published_episode);
    const resolution = getPublishedValue(entry.last_published_resolution);

    if (episode && resolution) {
        return `${episode} / ${resolution}`;
    }

    return episode || resolution || '不适用';
};

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

const siteDefinitions: SiteDefinition[] = [
    { key: 'dmhy', label: '動漫花園', loginEnabled: true, nameField: 'dmhy_name' },
    { key: 'nyaa', label: 'Nyaa', loginEnabled: true, nameField: 'nyaa_name' },
    { key: 'acgrip', label: 'ACG.RIP', loginEnabled: true, nameField: 'acgrip_name' },
    { key: 'bangumi', label: '萌番组', loginEnabled: true, nameField: 'bangumi_name' },
    {
        key: 'acgnx_asia',
        label: 'ACGNx Asia',
        loginEnabled: false,
        nameField: 'acgnx_asia_name',
        tokenField: 'acgnx_asia_token',
    },
    {
        key: 'acgnx_global',
        label: 'ACGNx Global',
        loginEnabled: false,
        nameField: 'acgnx_global_name',
        tokenField: 'acgnx_global_token',
    },
];

const htmlPreferredSiteKeys = new Set<keyof SiteSelection>(['dmhy', 'bangumi', 'acgnx_asia', 'acgnx_global']);
const markdownRequiredSiteKeys = new Set<keyof SiteSelection>(['nyaa', 'acgrip']);

function validatePublishContentForSites(
    template: Template,
    selectedSites: SiteDefinition[],
): PublishContentValidationIssue[] {
    const markdown = template.description.trim();
    const html = template.description_html.trim();
    const convertedHtml = markdown ? renderMarkdownToHtml(template.description).trim() : '';

    return selectedSites.flatMap((site) => {
        if (markdownRequiredSiteKeys.has(site.key) && !markdown) {
            return [{
                siteCode: site.key,
                siteLabel: site.label,
                message: `${site.label} 需要 Markdown 发布内容，请先填写 Markdown。`,
            }];
        }

        if (htmlPreferredSiteKeys.has(site.key) && !html && !convertedHtml) {
            return [{
                siteCode: site.key,
                siteLabel: site.label,
                message: `${site.label} 需要 HTML 内容，或可转换为 HTML 的 Markdown 发布内容。`,
            }];
        }

        return [];
    });
}

const getTorrentPathFromUriList = (uriList: string): string | null => {
    const candidate = uriList
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry && !entry.startsWith('#') && entry.toLowerCase().startsWith('file://'));

    if (!candidate) {
        return null;
    }

    try {
        return decodeURIComponent(candidate.replace(/^file:\/\//i, ''));
    } catch {
        return candidate.replace(/^file:\/\//i, '');
    }
};

export default function HomePage() {
    // Template state
    const [templateOptions, setTemplateOptions] = useState<TemplateSelectOption[]>([]);
    const [currentTemplateName, setCurrentTemplateName] = useState('');
    const [newTemplateName, setNewTemplateName] = useState('');
    const [template, setTemplate] = useState<Template>(defaultTemplate);

    // Profile state
    const [profileList, setProfileList] = useState<string[]>([]);
    const [selectedProfile, setSelectedProfile] = useState('');
    const [selectedProfileData, setSelectedProfileData] = useState<Profile | null>(null);
    const [okpExecutablePath, setOkpExecutablePath] = useState('');

    // Torrent state
    const [torrentPath, setTorrentPath] = useState('');
    const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);

    // Modal state
    const [showConsole, setShowConsole] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isPublishing, setIsPublishing] = useState(false);
    const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
    const [publishSites, setPublishSites] = useState<Record<string, PublishConsoleSite>>({});
    const [isPublishComplete, setIsPublishComplete] = useState(false);
    const [publishResult, setPublishResult] = useState<PublishComplete | null>(null);
    const [siteLoginTests, setSiteLoginTests] = useState<Record<string, SiteLoginTestState>>({});
    const [isTestingAllSiteLogins, setIsTestingAllSiteLogins] = useState(false);
    const templateRef = useRef(template);
    const currentTemplateNameRef = useRef(currentTemplateName);
    const lastPersistedDescriptionRef = useRef(defaultTemplate.description);
    const lastPersistedDescriptionHtmlRef = useRef(defaultTemplate.description_html);
    const publishAttemptRef = useRef<PublishAttemptContext | null>(null);
    const publishSiteSuccessRef = useRef<Partial<Record<keyof SiteSelection, boolean>>>({});

    // Load templates and profiles on mount
    useEffect(() => {
        loadProfileList();
        loadLastConfig();
    }, []);

    useEffect(() => {
        templateRef.current = template;
    }, [template]);

    useEffect(() => {
        currentTemplateNameRef.current = currentTemplateName;
    }, [currentTemplateName]);

    useEffect(() => {
        const hasPendingDescriptionSave =
            template.description !== lastPersistedDescriptionRef.current ||
            template.description_html !== lastPersistedDescriptionHtmlRef.current;

        if (!hasPendingDescriptionSave) {
            return;
        }

        const saveTimer = window.setTimeout(() => {
            void persistTemplateToDisk(withSelectedProfile(templateRef.current));
        }, 700);

        return () => {
            window.clearTimeout(saveTimer);
        };
    }, [template.description, template.description_html]);

    useEffect(() => {
        if (!selectedProfile) {
            setSelectedProfileData(null);
            setSiteLoginTests({});
            return;
        }

        void loadSelectedProfileData(selectedProfile);
    }, [selectedProfile]);

    useEffect(() => {
        let outputUnlisten: UnlistenFn | null = null;
        let siteCompleteUnlisten: UnlistenFn | null = null;
        let completeUnlisten: UnlistenFn | null = null;

        const setupListeners = async () => {
            outputUnlisten = await listen<PublishOutput>('publish-output', (event) => {
                setPublishSites((current) => {
                    const existing = current[event.payload.site_code] ?? {
                        siteCode: event.payload.site_code,
                        siteLabel: event.payload.site_label,
                        lines: [],
                        status: 'running' as const,
                        message: '发布中...',
                    };

                    return {
                        ...current,
                        [event.payload.site_code]: {
                            ...existing,
                            status: 'running',
                            message: '发布中...',
                            lines: [
                                ...existing.lines,
                                {
                                    text: event.payload.line,
                                    isError: event.payload.is_stderr,
                                },
                            ],
                        },
                    };
                });
            });

            siteCompleteUnlisten = await listen<PublishSiteComplete>('publish-site-complete', (event) => {
                publishSiteSuccessRef.current[event.payload.site_code as keyof SiteSelection] = event.payload.success;

                setPublishSites((current) => {
                    const existing = current[event.payload.site_code] ?? {
                        siteCode: event.payload.site_code,
                        siteLabel: event.payload.site_label,
                        lines: [],
                        status: 'idle' as const,
                        message: '',
                    };

                    return {
                        ...current,
                        [event.payload.site_code]: {
                            ...existing,
                            status: event.payload.success ? 'success' : 'error',
                            message: event.payload.message,
                        },
                    };
                });
            });

            completeUnlisten = await listen<PublishComplete>('publish-complete', (event) => {
                setIsPublishComplete(true);
                setPublishResult(event.payload);
                void finalizePublishHistory();
            });
        };

        void setupListeners();

        return () => {
            outputUnlisten?.();
            siteCompleteUnlisten?.();
            completeUnlisten?.();
        };
    }, []);

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

    const loadSelectedProfileData = async (profileName: string) => {
        try {
            const store = await invoke<{
                profiles: Record<string, Profile>;
            }>('get_profiles');
            setSelectedProfileData(store.profiles[profileName] ?? null);
            setSiteLoginTests({});
        } catch (e) {
            console.error('加载身份详情失败:', e);
            setSelectedProfileData(null);
        }
    };

    const loadLastConfig = async () => {
        try {
            const config = await refreshTemplateOptions();
            if (!config) {
                return;
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

    const loadTemplate = async (name: string) => {
        try {
            const config = await fetchConfig();
            await refreshTemplateOptions(config);
            if (config.templates[name]) {
                const nextTemplate = normalizeTemplate(config.templates[name]);
                lastPersistedDescriptionRef.current = nextTemplate.description;
                lastPersistedDescriptionHtmlRef.current = nextTemplate.description_html;
                setCurrentTemplateName(name);
                setNewTemplateName('');
                setTemplate(nextTemplate);
                setSelectedProfile(nextTemplate.profile || '');
            }
        } catch (e) {
            console.error('加载模板失败:', e);
        }
    };

    const getTemplateName = (explicitName?: string) => {
        const candidates = [explicitName, currentTemplateName, newTemplateName]
            .map((value) => value?.trim() || '')
            .filter((value) => value.length > 0);

        return candidates[0] || 'default';
    };

    const withSelectedProfile = (templateValue: Template, profileName: string = selectedProfile) => ({
        ...templateValue,
        profile: profileName,
    });

    const persistTemplateToDisk = async (
        templateToSave: Template = withSelectedProfile(templateRef.current),
        explicitName?: string,
    ) => {
        const name = getTemplateName(explicitName);

        try {
            await invoke('save_template', { name, template: templateToSave });
            lastPersistedDescriptionRef.current = templateToSave.description;
            lastPersistedDescriptionHtmlRef.current = templateToSave.description_html;
            setTemplate(templateToSave);
            setCurrentTemplateName(name);
            setNewTemplateName('');
            await refreshTemplateOptions();
            return true;
        } catch (e) {
            console.error('保存模板失败:', e);
            return false;
        }
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
            setSiteLoginTests({});
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
        const name = filename || torrentInfo?.name;
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
    }, [torrentInfo?.name]);

    const parseTorrent = useCallback(async (path: string) => {
        try {
            const info = await invoke<TorrentInfo>('parse_torrent', { path });
            setTorrentPath(path);
            setTorrentInfo(info);
            // Only prefill an empty title; never overwrite a user-edited final title.
            const activeTemplate = templateRef.current;
            if (!activeTemplate.title.trim() && activeTemplate.title_pattern.trim()) {
                const title = await matchTitle(info.name, activeTemplate);
                if (title) {
                    setTemplate((current) => (current.title.trim() ? current : { ...current, title }));
                }
            }
        } catch (e) {
            console.error('解析种子文件失败:', e);
        }
    }, [matchTitle]);

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;

        const setupDragDropListener = async () => {
            unlisten = await getCurrentWindow().onDragDropEvent((event) => {
                if (event.payload.type === 'enter' || event.payload.type === 'over') {
                    setIsDragging(true);
                    return;
                }

                if (event.payload.type === 'leave') {
                    setIsDragging(false);
                    return;
                }

                setIsDragging(false);
                const droppedTorrentPath = event.payload.paths.find((path) =>
                    path.toLowerCase().endsWith('.torrent'),
                );

                if (droppedTorrentPath) {
                    void parseTorrent(droppedTorrentPath);
                }
            });
        };

        void setupDragDropListener();

        return () => {
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

            const imported = await invoke<ImportedTemplatePayload>('import_template_from_file', {
                path: importPath,
            });
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
        }
    };

    const handleExportTemplate = async () => {
        const candidateName = currentTemplateName.trim() || newTemplateName.trim();
        if (!candidateName) {
            return;
        }

        try {
            const templateToExport = withSelectedProfile(templateRef.current);
            const persisted = await persistTemplateToDisk(templateToExport, candidateName);
            if (!persisted) {
                return;
            }

            const selectedPath = await save({
                defaultPath: `${candidateName}.json`,
                filters: [{ name: '模板文件', extensions: ['json'] }],
            });

            if (!selectedPath) {
                return;
            }

            await invoke('export_template_to_file', {
                name: candidateName,
                path: selectedPath,
            });
        } catch (e) {
            console.error('导出模板失败:', e);
        }
    };

    const resolvePublishDetails = async (
        templateToPublish: Template,
        filename?: string,
    ): Promise<Pick<ParsedTitleDetails, 'episode' | 'resolution'>> => {
        if (!filename) {
            return { episode: '', resolution: '' };
        }

        try {
            const details = await invoke<ParsedTitleDetails>('parse_title_details', {
                filename,
                epPattern: templateToPublish.ep_pattern,
                resolutionPattern: templateToPublish.resolution_pattern,
                titlePattern: templateToPublish.title_pattern,
            });

            return {
                episode: getPublishedValue(details.episode),
                resolution: getPublishedValue(details.resolution),
            };
        } catch (e) {
            console.error('提取发布信息失败:', e);
            return { episode: '', resolution: '' };
        }
    };

    const finalizePublishHistory = async () => {
        const publishAttempt = publishAttemptRef.current;
        publishAttemptRef.current = null;

        if (!publishAttempt) {
            publishSiteSuccessRef.current = {};
            return;
        }

        const updates = publishAttempt.siteKeys
            .filter((siteKey) => publishSiteSuccessRef.current[siteKey])
            .map((siteKey) => ({
                site_key: siteKey,
                last_published_at: publishAttempt.publishedAt,
                last_published_episode: publishAttempt.publishedEpisode,
                last_published_resolution: publishAttempt.publishedResolution,
            }));

        publishSiteSuccessRef.current = {};

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
    };

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

        setIsGeneratingTitle(true);

        try {
            const generatedTitle = await matchTitle();
            if (!generatedTitle.trim()) {
                return;
            }

            const nextTemplate = getTemplateWithFieldValue('title', generatedTitle);
            setTemplate(nextTemplate);
            await persistTemplateToDisk(nextTemplate);
        } finally {
            setIsGeneratingTitle(false);
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

    const clearSiteLoginTest = (siteCode: string) => {
        setSiteLoginTests((current) => {
            if (!(siteCode in current)) {
                return current;
            }

            const nextState = { ...current };
            delete nextState[siteCode];
            return nextState;
        });
    };

    const runSiteLoginTest = async (site: SiteDefinition, profileData: Profile) => {
        if (!site.loginEnabled) {
            return;
        }

        const rawText = getSiteCookieText(profileData.site_cookies, site.key);
        if (!rawText.trim()) {
            setSiteLoginTests((current) => ({
                ...current,
                [site.key]: {
                    status: 'error',
                    message: `请先在身份页面配置 ${site.label} 的 Cookie。`,
                },
            }));
            return;
        }

        setSiteLoginTests((current) => ({
            ...current,
            [site.key]: {
                status: 'testing',
                message: `正在测试 ${site.label} 登录状态...`,
            },
        }));

        try {
            const expectedName = String(profileData[site.nameField] ?? '').trim();
            const result = await invoke<SiteLoginTestResult>('test_site_login', {
                site: site.key,
                cookieText: rawText,
                userAgent: profileData.user_agent.trim() || null,
                expectedName: expectedName || null,
            });

            setSiteLoginTests((current) => ({
                ...current,
                [site.key]: {
                    status: result.success ? 'success' : 'error',
                    message: result.message,
                },
            }));
        } catch (error) {
            setSiteLoginTests((current) => ({
                ...current,
                [site.key]: {
                    status: 'error',
                    message: getErrorMessage(error),
                },
            }));
        }
    };

    const handleSiteLoginTest = async (site: SiteDefinition) => {
        if (!selectedProfileData || !site.loginEnabled || isTestingAllSiteLogins) {
            return;
        }

        await runSiteLoginTest(site, selectedProfileData);
    };

    const handleTestAllSiteLogins = async () => {
        if (!selectedProfileData || isTestingAllSiteLogins || hasRunningSiteLoginTest) {
            return;
        }

        const loginSites = siteDefinitions.filter((site) => site.loginEnabled);
        if (loginSites.length === 0) {
            return;
        }

        setIsTestingAllSiteLogins(true);
        try {
            for (const site of loginSites) {
                await runSiteLoginTest(site, selectedProfileData);
            }
        } finally {
            setIsTestingAllSiteLogins(false);
        }
    };

    const siteRows = useMemo(
        () =>
            siteDefinitions.map((site) => {
                const publishState = publishSites[site.key] ?? null;
                const loginState = siteLoginTests[site.key];

                if (!selectedProfileData) {
                    return {
                        site,
                        selectable: false,
                        selectDisabledReason: '请先选择身份配置',
                        identityText: '未选择身份',
                        identityClass: 'text-slate-500',
                        identityTitle: '请先选择身份配置',
                        loginState,
                        publishState,
                    };
                }

                if (site.loginEnabled) {
                    const rawText = getSiteCookieText(selectedProfileData.site_cookies, site.key);
                    const summary = getCookiePanelSummary(rawText);
                    const hasCookies = summary.cookieCount > 0;

                    return {
                        site,
                        selectable: hasCookies,
                        selectDisabledReason: hasCookies
                            ? ''
                            : `请先在身份页面配置 ${site.label} 的 Cookie`,
                        identityText: hasCookies
                            ? `${summary.remainingText} / ${summary.earliestExpiryText}`
                            : '未配置 Cookie',
                        identityClass: hasCookies
                            ? getRemainingTextClass(summary.earliestExpiry)
                            : 'text-slate-500',
                        identityTitle: hasCookies
                            ? `${site.label} 已配置 ${summary.cookieCount} 条 Cookie`
                            : `尚未配置 ${site.label} Cookie`,
                        loginState,
                        publishState,
                    };
                }

                const accountName = String(selectedProfileData[site.nameField] ?? '').trim();
                const tokenValue = site.tokenField
                    ? String(selectedProfileData[site.tokenField] ?? '').trim()
                    : '';
                const hasToken = tokenValue.length > 0;

                return {
                    site,
                    selectable: hasToken,
                    selectDisabledReason: hasToken
                        ? ''
                        : `${site.label} 缺少 API 令牌`,
                    identityText: hasToken
                        ? accountName.length > 0
                            ? 'API 身份已配置'
                            : 'API 令牌已配置'
                        : '缺少 API 令牌',
                    identityClass: hasToken ? 'text-emerald-300' : 'text-yellow-300',
                    identityTitle: hasToken
                        ? `${site.label} 已配置 API 令牌`
                        : `${site.label} 需要 API 令牌`,
                    loginState,
                    publishState,
                };
            }),
        [publishSites, selectedProfileData, siteLoginTests, template.publish_history],
    );
    const hasRunningSiteLoginTest = useMemo(
        () => Object.values(siteLoginTests).some((test) => test.status === 'testing'),
        [siteLoginTests],
    );

    const selectedSiteKeys = useMemo(
        () =>
            siteRows
                .filter((row) => row.selectable && template.sites[row.site.key])
                .map((row) => row.site.key),
        [siteRows, template.sites],
    );

    useEffect(() => {
        const selectableSiteKeys = new Set(
            siteRows.filter((row) => row.selectable).map((row) => row.site.key),
        );

        setTemplate((current) => {
            const nextSites = { ...current.sites };
            let hasChanges = false;

            for (const siteKey of Object.keys(nextSites) as (keyof SiteSelection)[]) {
                const shouldBeSelected = selectableSiteKeys.has(siteKey);
                if (nextSites[siteKey] !== shouldBeSelected) {
                    nextSites[siteKey] = shouldBeSelected;
                    hasChanges = true;
                }
            }

            if (!hasChanges) {
                return current;
            }

            const nextTemplate = { ...current, sites: nextSites };
            autosaveTemplate(withSelectedProfile(nextTemplate));
            return nextTemplate;
        });
    }, [siteRows]);

    // Publish
    const handlePublish = async () => {
        if (!torrentPath) return;
        if (!selectedProfile) return;
        if (!okpExecutablePath) return;
        if (selectedSiteKeys.length === 0) return;
        if (isPublishing) return;

        const publishTemplateName = getTemplateName();
        const templateToPublish = withSelectedProfile(template, selectedProfile);
        const selectedSites = siteDefinitions.filter((site) => template.sites[site.key]);
        const contentValidationIssues = validatePublishContentForSites(templateToPublish, selectedSites);
        if (contentValidationIssues.length > 0) {
            const issueMessageMap = new Map(
                contentValidationIssues.map((issue) => [issue.siteCode, issue.message]),
            );
            const combinedMessage = contentValidationIssues.map((issue) => issue.message).join('；');

            setPublishSites(
                Object.fromEntries(
                    selectedSites.map((site) => {
                        const siteMessage = issueMessageMap.get(site.key) ?? '发布已取消：发布内容校验未通过。';
                        return [
                            site.key,
                            {
                                siteCode: site.key,
                                siteLabel: site.label,
                                lines: [{ text: siteMessage, isError: true }],
                                status: 'error' as const,
                                message: siteMessage,
                            },
                        ];
                    }),
                ),
            );
            setIsPublishComplete(true);
            setPublishResult({
                success: false,
                message: combinedMessage,
            });
            setShowConsole(true);
            return;
        }

        const saved = await persistTemplateToDisk(templateToPublish, publishTemplateName);
        if (!saved) {
            return;
        }

        const publishDetails = await resolvePublishDetails(templateToPublish, torrentInfo?.name);

        publishAttemptRef.current = {
            templateName: publishTemplateName,
            publishedAt: new Date().toISOString(),
            publishedEpisode: publishDetails.episode,
            publishedResolution: publishDetails.resolution,
            siteKeys: selectedSites.map((site) => site.key),
        };
        publishSiteSuccessRef.current = {};

        setPublishSites(
            Object.fromEntries(
                selectedSites.map((site) => [
                        site.key,
                        {
                            siteCode: site.key,
                            siteLabel: site.label,
                            lines: [],
                            status: 'running' as const,
                            message: '等待 OKP 输出...',
                        },
                    ]),
            ),
        );
        setIsPublishComplete(false);
        setPublishResult(null);
        setShowConsole(true);
        setIsPublishing(true);

        try {
            await invoke('publish', {
                request: {
                    torrent_path: torrentPath,
                    template_name: publishTemplateName,
                    profile_name: selectedProfile,
                    template: templateToPublish,
                },
            });
        } catch (e) {
            console.error('发布失败:', e);
            setPublishSites((current) => {
                if (Object.keys(current).length === 0) {
                    return current;
                }

                const firstSiteCode = Object.keys(current)[0];
                const firstSite = current[firstSiteCode];
                return {
                    ...current,
                    [firstSiteCode]: {
                        ...firstSite,
                        status: 'error',
                        message: getErrorMessage(e),
                        lines: [...firstSite.lines, { text: getErrorMessage(e), isError: true }],
                    },
                };
            });
            setIsPublishComplete(true);
            setPublishResult({
                success: false,
                message: getErrorMessage(e),
            });
        } finally {
            setIsPublishing(false);
        }
    };
    // Drag and drop handlers
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const droppedFiles = Array.from(e.dataTransfer.files || []);
        const droppedTorrent = droppedFiles.find((file) => file.name.toLowerCase().endsWith('.torrent'));
        const droppedTorrentPath = droppedTorrent
            ? ((droppedTorrent as File & { path?: string }).path ?? null)
            : null;

        if (droppedTorrentPath) {
            void parseTorrent(droppedTorrentPath);
            return;
        }

        const uriList = e.dataTransfer.getData('text/uri-list');
        const uriPath = uriList ? getTorrentPathFromUriList(uriList) : null;
        if (uriPath && uriPath.toLowerCase().endsWith('.torrent')) {
            void parseTorrent(uriPath);
        }
    }, [parseTorrent]);

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

        setTemplate((t) => {
            const nextTemplate = {
                ...t,
                sites: { ...t.sites, [site]: !t.sites[site] },
            };

            clearSiteLoginTest(site);
            autosaveTemplate(withSelectedProfile(nextTemplate));
            return nextTemplate;
        });
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-6 space-y-5">
                {/* Template Selection */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">模板管理</h2>
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <TemplateSelect
                                options={templateOptions}
                                value={currentTemplateName}
                                onChange={loadTemplate}
                            />
                        </div>
                        <input
                            type="text"
                            value={newTemplateName}
                            onChange={(e) => setNewTemplateName(e.target.value)}
                            onBlur={(e) => {
                                const trimmedName = e.target.value.trim();
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
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
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
                </section>

                {/* Title Matching */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">标题自动生成</h2>
                    <div className="grid gap-3 md:grid-cols-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">集数匹配正则</label>
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
                        <div>
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
                        <input
                            type="text"
                            value={template.title}
                            onChange={(e) => updateField('title', e.target.value)}
                            onBlur={(e) => autosaveTemplate(getTemplateWithFieldValue('title', e.target.value))}
                            placeholder="最终发布标题，可手动编辑或使用上方按钮重新生成"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
                                                    disabled={!selectedProfileData || isTestingAllSiteLogins || hasRunningSiteLoginTest}
                                                    title={
                                                        !selectedProfileData
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
                                                        checked={template.sites[site.key]}
                                                        disabled={!selectable}
                                                        onChange={() => toggleSite(site.key)}
                                                        title={selectable ? `选择 ${site.label}` : selectDisabledReason}
                                                        className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                                    />
                                                </td>
                                                <td className="px-4 py-3 align-middle font-medium text-slate-100">
                                                    {site.label}
                                                </td>
                                                <td className="px-4 py-3 align-middle text-xs text-slate-400">
                                                    {formatPublishTimestamp(template.publish_history[site.key].last_published_at)}
                                                </td>
                                                <td className="px-4 py-3 align-middle text-slate-300">
                                                    {getPublishedVersionLabel(template.publish_history[site.key])}
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
                                                            disabled={!selectedProfileData || isTestingAllSiteLogins || loginState?.status === 'testing'}
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
                            selectedSiteKeys.length === 0
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
        </div>
    );
}
