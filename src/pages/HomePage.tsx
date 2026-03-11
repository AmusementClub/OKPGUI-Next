import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import {
    FolderOpen,
    Trash2,
    Send,
    Loader2,
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
import { getCookiePanelSummary, getRemainingTextClass, getSiteCookieText, SiteCookies } from '../utils/cookieUtils';
import { renderMarkdownToHtml } from '../utils/markdown';
import { DEFAULT_OKP_TAGS } from '../utils/okpTags';
import { getPublishStatusTextClass, getSiteLoginStateBadgeClass, SiteLoginStatus } from '../utils/siteStatus';

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
    title_pattern: string;
    poster: string;
    about: string;
    tags: string;
    description: string;
    description_html: string;
    profile: string;
    title: string;
    sites: SiteSelection;
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

const defaultTemplate: Template = {
    ep_pattern: '',
    title_pattern: '',
    poster: '',
    about: '',
    tags: DEFAULT_OKP_TAGS,
    description: '',
    description_html: '',
    profile: '',
    title: '',
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
        tags: typeof template?.tags === 'string' ? template.tags : defaultTemplate.tags,
        description: typeof template?.description === 'string' ? template.description : defaultTemplate.description,
        description_html:
            typeof template?.description_html === 'string'
                ? template.description_html
                : defaultTemplate.description_html,
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
    const [templateList, setTemplateList] = useState<string[]>([]);
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
    const [publishSites, setPublishSites] = useState<Record<string, PublishConsoleSite>>({});
    const [isPublishComplete, setIsPublishComplete] = useState(false);
    const [publishResult, setPublishResult] = useState<PublishComplete | null>(null);
    const [siteLoginTests, setSiteLoginTests] = useState<Record<string, SiteLoginTestState>>({});
    const templateRef = useRef(template);
    const lastPersistedDescriptionRef = useRef(defaultTemplate.description);
    const lastPersistedDescriptionHtmlRef = useRef(defaultTemplate.description_html);

    // Load templates and profiles on mount
    useEffect(() => {
        loadTemplateList();
        loadProfileList();
        loadLastConfig();
    }, []);

    useEffect(() => {
        templateRef.current = template;
    }, [template]);

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
            });
        };

        void setupListeners();

        return () => {
            outputUnlisten?.();
            siteCompleteUnlisten?.();
            completeUnlisten?.();
        };
    }, []);

    const loadTemplateList = async () => {
        try {
            const list = await invoke<string[]>('get_template_list');
            setTemplateList(list);
        } catch (e) {
            console.error('加载模板列表失败:', e);
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
            const config = await invoke<{
                last_used_template: string | null;
                okp_executable_path: string;
                templates: Record<string, Template>;
            }>('get_config');
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
            const config = await invoke<{
                templates: Record<string, Template>;
            }>('get_config');
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
            await loadTemplateList();
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
            await loadTemplateList();
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

        if (!name || !activeTemplate.ep_pattern || !activeTemplate.title_pattern) {
            return '';
        }

        try {
            const title = await invoke<string>('match_title', {
                filename: name,
                epPattern: activeTemplate.ep_pattern,
                titlePattern: activeTemplate.title_pattern,
            });

            if (!templateToMatch) {
                setTemplate((t) => ({ ...t, title }));
            }

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
            // Auto-match title if patterns are set
            const activeTemplate = templateRef.current;
            if (activeTemplate.ep_pattern && activeTemplate.title_pattern) {
                const title = await matchTitle(info.name, activeTemplate);
                if (title) {
                    setTemplate((current) => ({ ...current, title }));
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

    const handlePatternBlur = async (field: 'ep_pattern' | 'title_pattern', value: string) => {
        const nextTemplate = withSelectedProfile({ ...templateRef.current, [field]: value } as Template);
        const matchedTitle = await matchTitle(undefined, nextTemplate);
        const templateToSave = matchedTitle
            ? { ...nextTemplate, title: matchedTitle }
            : nextTemplate;

        setTemplate(templateToSave);
        await persistTemplateToDisk(templateToSave);
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

    const handleSiteLoginTest = async (site: SiteDefinition) => {
        if (!selectedProfileData || !site.loginEnabled) {
            return;
        }

        const rawText = getSiteCookieText(selectedProfileData.site_cookies, site.key);
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
            const expectedName = String(selectedProfileData[site.nameField] ?? '').trim();
            const result = await invoke<SiteLoginTestResult>('test_site_login', {
                site: site.key,
                cookieText: rawText,
                userAgent: selectedProfileData.user_agent.trim() || null,
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
        [publishSites, selectedProfileData, siteLoginTests, template.sites],
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
        const hasInvalidSelection = Object.entries(template.sites).some(
            ([siteKey, enabled]) => enabled && !selectableSiteKeys.has(siteKey as keyof SiteSelection),
        );

        if (!hasInvalidSelection) {
            return;
        }

        setTemplate((current) => {
            const nextSites = { ...current.sites };
            for (const siteKey of Object.keys(nextSites) as (keyof SiteSelection)[]) {
                if (nextSites[siteKey] && !selectableSiteKeys.has(siteKey)) {
                    nextSites[siteKey] = false;
                }
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

        const selectedSites = siteDefinitions.filter((site) => template.sites[site.key]);
        const contentValidationIssues = validatePublishContentForSites(template, selectedSites);
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
                    template_name: currentTemplateName,
                    profile_name: selectedProfile,
                    template: {
                        ...template,
                        profile: selectedProfile,
                    },
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

    const updateField = (field: keyof Template, value: string) => {
        setTemplate((t) => ({ ...t, [field]: value }));
    };

    const getTemplateWithFieldValue = (field: keyof Template, value: string): Template =>
        withSelectedProfile({ ...templateRef.current, [field]: value } as Template);

    const handleTransformMarkdownToHtml = () => {
        const nextHtml = renderMarkdownToHtml(templateRef.current.description);
        const nextTemplate = getTemplateWithFieldValue('description_html', nextHtml);
        setTemplate(nextTemplate);
        autosaveTemplate(nextTemplate);
    };

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
                        <select
                            value={currentTemplateName}
                            onChange={(e) => loadTemplate(e.target.value)}
                            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                            <option value="">选择模板...</option>
                            {templateList.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
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
                            className="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <button
                            onClick={deleteTemplate}
                            disabled={!currentTemplateName}
                            className="flex items-center gap-1.5 px-3 py-2 bg-red-600/80 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                        >
                            <Trash2 size={14} />
                            删除
                        </button>
                    </div>
                </section>

                {/* Torrent File */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">种子文件</h2>
                    <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
                            isDragging
                                ? 'border-emerald-400 bg-emerald-400/10'
                                : 'border-slate-700 hover:border-slate-600'
                        }`}
                    >
                        {torrentPath ? (
                            <div className="text-sm text-slate-300">
                                <p className="truncate">{torrentPath}</p>
                            </div>
                        ) : (
                            <p className="text-sm text-slate-500">
                                拖放种子文件到此处，或点击下方按钮选择
                            </p>
                        )}
                    </div>
                    <button
                        onClick={selectTorrentFile}
                        className="mt-2 flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
                    >
                        <FolderOpen size={14} />
                        选择种子文件
                    </button>
                    {torrentInfo && (
                        <div className="mt-2">
                            <FileTree root={torrentInfo.file_tree} totalSize={torrentInfo.total_size} />
                        </div>
                    )}
                </section>

                {/* Title Matching */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">标题匹配</h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">集数匹配正则</label>
                            <input
                                type="text"
                                value={template.ep_pattern}
                                onChange={(e) => updateField('ep_pattern', e.target.value)}
                                onBlur={(e) => {
                                    void handlePatternBlur('ep_pattern', e.target.value);
                                }}
                                placeholder="如: (?P<ep>\d+)"
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
                                placeholder="如: [Group] Title - <ep>"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                    </div>
                    <div className="mt-2">
                        <label className="text-xs text-slate-500 mb-1 block">生成标题</label>
                        <input
                            type="text"
                            value={template.title}
                            onChange={(e) => updateField('title', e.target.value)}
                            onBlur={(e) => autosaveTemplate(getTemplateWithFieldValue('title', e.target.value))}
                            placeholder="标题将自动生成或手动输入"
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
                            使用 OKP 的分类标签，不是 bangumi.moe 原生 tag。按回车完成tag输入
                        </p>
                    </div>
                    <div className="mt-3">
                        <PublishContentEditor
                            markdown={template.description}
                            html={template.description_html}
                            onMarkdownChange={(value) => updateField('description', value)}
                            onHtmlChange={(value) => updateField('description_html', value)}
                            onTransformMarkdownToHtml={handleTransformMarkdownToHtml}
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
                                            <th className="px-4 py-3 font-medium">身份状态</th>
                                            <th className="w-36 px-4 py-3 font-medium">Cookie 测试</th>
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
                                                            disabled={!selectedProfileData || loginState?.status === 'testing'}
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
