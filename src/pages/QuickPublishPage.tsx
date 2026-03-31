import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import {
    FileText,
    FolderOpen,
    Loader2,
    RefreshCw,
    RotateCcw,
    Send,
    Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ConsoleModal, {
    PublishComplete,
    PublishConsoleSite,
    PublishOutput,
    PublishSiteComplete,
} from '../components/ConsoleModal';
import FileTree, { FileTreeNodeData } from '../components/FileTree';
import PublishContentEditor from '../components/PublishContentEditor';
import TemplateSelect, { TemplateSelectOption } from '../components/TemplateSelect';
import { getCookiePanelSummary, getRemainingTextClass, getSiteCookieText, SiteCookies } from '../utils/cookieUtils';
import { getPublishStatusTextClass, getSiteLoginStateBadgeClass, SiteLoginStatus } from '../utils/siteStatus';
import {
    ContentTemplate,
    QuickPublishConfigPayload,
    QuickPublishRuntimeDraft,
    QuickPublishTemplate,
    SitePublishHistory,
    SiteSelection,
    buildLegacyPublishTemplatePayload,
    buildRuntimeDraftFromTemplate,
    composePublishContent,
    createDefaultQuickPublishRuntimeDraft,
    normalizeContentTemplate,
    normalizePublishHistory,
    normalizeQuickPublishTemplate,
    quickPublishSiteKeys,
    quickPublishSiteLabels,
} from '../utils/quickPublish';

interface ParsedTitleDetails {
    title: string;
    episode: string;
    resolution: string;
}

interface TorrentInfo {
    name: string;
    total_size: number;
    file_tree: FileTreeNodeData;
}

interface PublishAttemptContext {
    templateId: string;
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

interface SiteDefinition {
    key: keyof SiteSelection;
    label: string;
    loginEnabled: boolean;
    nameField: keyof Profile;
    tokenField?: keyof Profile;
}

interface SiteLoginTestResult {
    success: boolean;
    message: string;
}

interface SiteLoginTestState {
    status: SiteLoginStatus;
    message: string;
}

function formatTimestamp(value: string) {
    if (!value.trim()) {
        return '未发布';
    }

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        return value;
    }

    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
        .format(new Date(timestamp))
        .replace(/\//g, '-');
}

function getLatestPublishedAt(template: QuickPublishTemplate) {
    return quickPublishSiteKeys.reduce((latest, siteKey) => {
        const publishedAt = template.publish_history[siteKey].last_published_at;
        return publishedAt > latest ? publishedAt : latest;
    }, '');
}

function buildTemplateOptions(templates: Record<string, QuickPublishTemplate>): TemplateSelectOption[] {
    return Object.values(templates)
        .map((template) => ({
            name: template.id,
            label: template.name || template.id,
            latestPublishedAtLabel: formatTimestamp(getLatestPublishedAt(template)),
        }))
        .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function mergePublishHistory(
    history: SitePublishHistory,
    updates: TemplatePublishHistoryUpdate[],
): SitePublishHistory {
    const nextHistory = normalizePublishHistory(history);

    for (const update of updates) {
        nextHistory[update.site_key] = {
            last_published_at: update.last_published_at,
            last_published_episode: update.last_published_episode,
            last_published_resolution: update.last_published_resolution,
        };
    }

    return nextHistory;
}

export default function QuickPublishPage() {
    const [quickPublishTemplates, setQuickPublishTemplates] = useState<Record<string, QuickPublishTemplate>>({});
    const [contentTemplates, setContentTemplates] = useState<Record<string, ContentTemplate>>({});
    const [profileList, setProfileList] = useState<string[]>([]);
    const [templateOptions, setTemplateOptions] = useState<TemplateSelectOption[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [draft, setDraft] = useState<QuickPublishRuntimeDraft>(createDefaultQuickPublishRuntimeDraft());
    const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
    const [isPublishing, setIsPublishing] = useState(false);
    const [showConsole, setShowConsole] = useState(false);
    const [publishSites, setPublishSites] = useState<Record<string, PublishConsoleSite>>({});
    const [isPublishComplete, setIsPublishComplete] = useState(false);
    const [publishResult, setPublishResult] = useState<PublishComplete | null>(null);
    const [selectedProfileData, setSelectedProfileData] = useState<Profile | null>(null);
    const [siteLoginTests, setSiteLoginTests] = useState<Record<string, SiteLoginTestState>>({});
    const [isTestingAllSiteLogins, setIsTestingAllSiteLogins] = useState(false);
    const [okpExecutablePath, setOkpExecutablePath] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const publishAttemptRef = useRef<PublishAttemptContext | null>(null);
    const publishSiteSuccessRef = useRef<Partial<Record<keyof SiteSelection, boolean>>>({});

    const activeTemplate = selectedTemplateId ? quickPublishTemplates[selectedTemplateId] ?? null : null;
    const activeSharedContentTemplate =
        draft.shared_content_template_id && contentTemplates[draft.shared_content_template_id]
            ? contentTemplates[draft.shared_content_template_id]
            : null;

    const siteDefinitions: SiteDefinition[] = [
        { key: 'dmhy', label: '动漫花园', loginEnabled: true, nameField: 'dmhy_name' },
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

    const publishSitesList = useMemo(
        () => Object.values(publishSites).sort((left, right) => left.siteLabel.localeCompare(right.siteLabel, 'zh-CN')),
        [publishSites],
    );

    useEffect(() => {
        void Promise.all([loadData(), loadProfiles()]);
    }, []);

    useEffect(() => {
        if (!draft.profile.trim()) {
            setSelectedProfileData(null);
            setSiteLoginTests({});
            return;
        }

        void loadSelectedProfileData(draft.profile);
    }, [draft.profile]);

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
                setIsPublishing(false);
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
    }, [quickPublishTemplates]);

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
    }, [selectedTemplateId, quickPublishTemplates]);

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
                        selectDisabledReason: hasCookies ? '' : `请先在身份页面配置 ${site.label} 的 Cookie`,
                        identityText: hasCookies
                            ? `${summary.remainingText} / ${summary.earliestExpiryText}`
                            : '未配置 Cookie',
                        identityClass: hasCookies ? getRemainingTextClass(summary.earliestExpiry) : 'text-slate-500',
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
                    selectDisabledReason: hasToken ? '' : `${site.label} 缺少 API 令牌`,
                    identityText: hasToken
                        ? accountName.length > 0
                            ? 'API 身份已配置'
                            : 'API 令牌已配置'
                        : '缺少 API 令牌',
                    identityClass: hasToken ? 'text-emerald-300' : 'text-yellow-300',
                    identityTitle: hasToken ? `${site.label} 已配置 API 令牌` : `${site.label} 需要 API 令牌`,
                    loginState,
                    publishState,
                };
            }),
        [publishSites, selectedProfileData, siteDefinitions, siteLoginTests],
    );
    const hasRunningSiteLoginTest = useMemo(
        () => Object.values(siteLoginTests).some((test) => test.status === 'testing'),
        [siteLoginTests],
    );

    useEffect(() => {
        const selectableSiteKeys = new Set(siteRows.filter((row) => row.selectable).map((row) => row.site.key));

        setDraft((current) => {
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

            return {
                ...current,
                sites: nextSites,
            };
        });
    }, [siteRows]);

    const loadProfiles = async () => {
        const nextProfiles = await invoke<string[]>('get_profile_list');
        setProfileList(nextProfiles);
    };

    const saveOkpExecutablePath = async (path: string) => {
        try {
            await invoke('save_okp_executable_path', {
                okpExecutablePath: path,
            });
            setOkpExecutablePath(path);
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '保存 OKP 路径失败。');
        }
    };

    const selectOkpExecutable = async () => {
        try {
            const file = await open();
            const selectedPath = Array.isArray(file) ? file[0] : file;
            if (selectedPath) {
                await saveOkpExecutablePath(selectedPath);
            }
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '选择 OKP 路径失败。');
        }
    };

    const clearOkpExecutablePath = async () => {
        await saveOkpExecutablePath('');
    };

    const loadSelectedProfileData = async (profileName: string) => {
        try {
            const store = await invoke<{ profiles: Record<string, Profile> }>('get_profiles');
            setSelectedProfileData(store.profiles[profileName] ?? null);
            setSiteLoginTests({});
        } catch (error) {
            setSelectedProfileData(null);
            setSiteLoginTests({});
            setErrorMessage(typeof error === 'string' ? error : '加载身份详情失败。');
        }
    };

    const loadData = async (preferredId?: string) => {
        const config = await invoke<QuickPublishConfigPayload>('get_config');
        const nextQuickPublishTemplates = Object.fromEntries(
            Object.entries(config.quick_publish_templates ?? {}).map(([id, template]) => [
                id,
                normalizeQuickPublishTemplate({ id, ...template }),
            ]),
        );
        const nextContentTemplates = Object.fromEntries(
            Object.entries(config.content_templates ?? {}).map(([id, template]) => [
                id,
                normalizeContentTemplate({ id, ...template }),
            ]),
        );

        setQuickPublishTemplates(nextQuickPublishTemplates);
        setContentTemplates(nextContentTemplates);
        setTemplateOptions(buildTemplateOptions(nextQuickPublishTemplates));
        setOkpExecutablePath(config.okp_executable_path ?? '');

        const resolvedTemplateId =
            preferredId && nextQuickPublishTemplates[preferredId]
                ? preferredId
                : selectedTemplateId && nextQuickPublishTemplates[selectedTemplateId]
                  ? selectedTemplateId
                  : config.last_used_quick_publish_template && nextQuickPublishTemplates[config.last_used_quick_publish_template]
                    ? config.last_used_quick_publish_template
                    : Object.keys(nextQuickPublishTemplates).sort((left, right) => left.localeCompare(right, 'zh-CN'))[0] ?? '';

        if (!resolvedTemplateId) {
            setSelectedTemplateId('');
            setDraft(createDefaultQuickPublishRuntimeDraft());
            return;
        }

        applyTemplateSelection(
            resolvedTemplateId,
            nextQuickPublishTemplates,
            nextContentTemplates,
            draft.torrent_path,
        );
    };

    const applyTemplateSelection = (
        templateId: string,
        templates = quickPublishTemplates,
        contents = contentTemplates,
        currentTorrentPath = draft.torrent_path,
    ) => {
        const template = templates[templateId];
        if (!template) {
            return;
        }

        const contentTemplate = template.shared_content_template_id
            ? contents[template.shared_content_template_id] ?? null
            : null;
        const nextDraft = {
            ...buildRuntimeDraftFromTemplate(template, contentTemplate),
            torrent_path: currentTorrentPath,
        };

        setSelectedTemplateId(templateId);
        setDraft(nextDraft);
        setStatusMessage('');
        setErrorMessage('');

        if (torrentInfo?.name) {
            void generateTitle(template, nextDraft);
        }
    };

    const parseTorrent = async (path: string) => {
        try {
            const info = await invoke<TorrentInfo>('parse_torrent', { path });
            setTorrentInfo(info);
            setDraft((current) => ({ ...current, torrent_path: path }));

            if (activeTemplate) {
                await generateTitle(activeTemplate, {
                    ...draft,
                    torrent_path: path,
                });
            }
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '解析种子失败。');
        }
    };

    const selectTorrentFile = async () => {
        const file = await open({
            filters: [{ name: '种子文件', extensions: ['torrent'] }],
        });

        if (typeof file === 'string') {
            await parseTorrent(file);
        }
    };

    const generateTitle = async (
        templateToUse = activeTemplate,
        draftToUse = draft,
        forceOverwrite = false,
    ) => {
        if (!templateToUse || !torrentInfo?.name || !templateToUse.title_pattern.trim()) {
            return;
        }

        if (draftToUse.is_title_overridden && !forceOverwrite) {
            return;
        }

        setIsGeneratingTitle(true);

        try {
            const details = await invoke<ParsedTitleDetails>('parse_title_details', {
                filename: torrentInfo.name,
                epPattern: templateToUse.ep_pattern,
                resolutionPattern: templateToUse.resolution_pattern,
                titlePattern: templateToUse.title_pattern,
            });

            setDraft((current) => ({
                ...current,
                title: details.title || current.title,
                episode: details.episode,
                resolution: details.resolution,
                is_title_overridden: false,
            }));
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '生成标题失败。');
        } finally {
            setIsGeneratingTitle(false);
        }
    };

    const switchRuntimeContentTemplate = (contentTemplateId: string) => {
        const nextContentTemplate = contentTemplateId ? contentTemplates[contentTemplateId] ?? null : null;
        const bodyMarkdown = activeTemplate?.body_markdown ?? '';
        const bodyHtml = activeTemplate?.body_html ?? '';

        setDraft((current) => ({
            ...current,
            shared_content_template_id: contentTemplateId || null,
            markdown: composePublishContent(bodyMarkdown, nextContentTemplate?.markdown ?? ''),
            html: composePublishContent(bodyHtml, nextContentTemplate?.html ?? '', '\n'),
            is_content_overridden: false,
        }));
    };

    const resetToTemplateDefaults = () => {
        if (!activeTemplate) {
            return;
        }

        const contentTemplate =
            activeTemplate.shared_content_template_id && contentTemplates[activeTemplate.shared_content_template_id]
                ? contentTemplates[activeTemplate.shared_content_template_id]
                : null;

        const nextDraft = {
            ...buildRuntimeDraftFromTemplate(activeTemplate, contentTemplate),
            torrent_path: draft.torrent_path,
        };
        setDraft(nextDraft);

        if (torrentInfo?.name) {
            void generateTitle(activeTemplate, nextDraft, true);
        }
    };

    const finalizePublishHistory = async () => {
        const publishAttempt = publishAttemptRef.current;
        if (!publishAttempt) {
            return;
        }

        const successfulSiteKeys = publishAttempt.siteKeys.filter(
            (siteKey) => publishSiteSuccessRef.current[siteKey],
        );
        if (successfulSiteKeys.length === 0) {
            return;
        }

        const updates: TemplatePublishHistoryUpdate[] = successfulSiteKeys.map((siteKey) => ({
            site_key: siteKey,
            last_published_at: publishAttempt.publishedAt,
            last_published_episode: publishAttempt.publishedEpisode,
            last_published_resolution: publishAttempt.publishedResolution,
        }));

        try {
            await invoke('update_quick_publish_template_publish_history', {
                id: publishAttempt.templateId,
                updates,
            });

            setQuickPublishTemplates((current) => {
                const currentTemplate = current[publishAttempt.templateId];
                if (!currentTemplate) {
                    return current;
                }

                return {
                    ...current,
                    [publishAttempt.templateId]: {
                        ...currentTemplate,
                        publish_history: mergePublishHistory(currentTemplate.publish_history, updates),
                    },
                };
            });
            setStatusMessage('已回填快速发布模板的发布历史。');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '更新发布历史失败。');
        }
    };

    const publish = async () => {
        if (!activeTemplate) {
            setErrorMessage('请先选择一个快速发布模板。');
            return;
        }

        if (!draft.torrent_path.trim()) {
            setErrorMessage('请先选择一个种子文件。');
            return;
        }

        if (!draft.title.trim()) {
            setErrorMessage('请先填写发布标题。');
            return;
        }

        if (!draft.profile.trim()) {
            setErrorMessage('请先选择一个身份。');
            return;
        }

        if (!okpExecutablePath.trim()) {
            setErrorMessage('请先在旧主页里配置 OKP 可执行文件路径。');
            return;
        }

        const selectedSiteKeys = quickPublishSiteKeys.filter((siteKey) => draft.sites[siteKey]);
        if (selectedSiteKeys.length === 0) {
            setErrorMessage('请至少选择一个发布站点。');
            return;
        }

        const publishTemplatePayload = buildLegacyPublishTemplatePayload(draft, activeTemplate);
        const nextPublishSites = Object.fromEntries(
            selectedSiteKeys.map((siteKey) => [
                siteKey,
                {
                    siteCode: siteKey,
                    siteLabel: quickPublishSiteLabels[siteKey],
                    lines: [],
                    status: 'idle' as const,
                    message: '等待发布...',
                },
            ]),
        );

        publishAttemptRef.current = {
            templateId: activeTemplate.id,
            publishedAt: new Date().toISOString(),
            publishedEpisode: draft.episode,
            publishedResolution: draft.resolution,
            siteKeys: selectedSiteKeys,
        };
        publishSiteSuccessRef.current = {};
        setShowConsole(true);
        setPublishSites(nextPublishSites);
        setPublishResult(null);
        setIsPublishComplete(false);
        setIsPublishing(true);
        setStatusMessage('');
        setErrorMessage('');

        try {
            await invoke('publish', {
                request: {
                    torrent_path: draft.torrent_path,
                    template_name: activeTemplate.name || activeTemplate.id,
                    profile_name: draft.profile,
                    template: publishTemplatePayload,
                },
            });
        } catch (error) {
            const message = typeof error === 'string' ? error : '启动发布失败。';
            setErrorMessage(message);
            setPublishResult({ success: false, message });
            setIsPublishComplete(true);
            setIsPublishing(false);
        }
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
                    message: typeof error === 'string' ? error : '登录测试失败。',
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

    return (
        <div className="h-full overflow-y-auto bg-slate-900 px-6 py-6 text-slate-100">
            <div className="mx-auto flex max-w-7xl flex-col gap-6">
                <header className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-400/80">快速模板发布</p>
                        <h1 className="mt-2 text-3xl font-semibold text-white">模板发布</h1>
                        <p className="mt-2 max-w-3xl text-sm text-slate-400">
                            这里是运行时装配页。发布模板提供默认值，你可以在本次发布里覆盖标题、正文、身份与站点，但这些覆盖默认不会回写模板。
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={resetToTemplateDefaults}
                            disabled={!activeTemplate}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <RotateCcw size={16} />
                            重置为模板默认值
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void publish();
                            }}
                            disabled={isPublishing || !activeTemplate}
                            className="hidden items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isPublishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                            发布已选站点
                        </button>
                    </div>
                </header>

                {statusMessage ? (
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                        {statusMessage}
                    </div>
                ) : null}
                {errorMessage ? (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                        {errorMessage}
                    </div>
                ) : null}

                <section className="order-1 rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] xl:items-start">
                        <div>
                            <h2 className="text-sm font-medium text-slate-200">发布模板选择</h2>
                            <p className="mt-1 text-xs text-slate-500">先选本次发布要套用的模板，标题和正文会按这里的默认值初始化。</p>
                            <div className="mt-4">
                                <label className="mb-2 block text-xs text-slate-500">发布模板</label>
                                <TemplateSelect
                                    options={templateOptions}
                                    value={selectedTemplateId}
                                    onChange={(templateId) => applyTemplateSelection(templateId)}
                                    placeholder="选择快速发布模板..."
                                />
                            </div>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
                            <div className="text-xs text-slate-500">当前公共正文模板</div>
                            <div className="mt-1 font-medium text-slate-100">
                                {activeSharedContentTemplate?.name || '未关联公共正文模板'}
                            </div>
                            <div className="mt-2 text-xs text-slate-500">
                                {activeSharedContentTemplate?.summary || '正文主体来自发布模板，公共尾巴可在本页临时切换。'}
                            </div>
                        </div>
                    </div>
                </section>

                <section className="order-5 rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <h2 className="text-sm font-medium text-slate-200">状态</h2>
                    <div className="mt-4 grid gap-4 xl:grid-cols-4">
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                            <div className="text-xs text-slate-500">标题覆盖</div>
                            <div className="mt-2 text-sm font-medium text-slate-100">
                                {draft.is_title_overridden ? '已覆盖' : '使用模板默认/自动生成'}
                            </div>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                            <div className="text-xs text-slate-500">正文覆盖</div>
                            <div className="mt-2 text-sm font-medium text-slate-100">
                                {draft.is_content_overridden ? '已覆盖' : '使用模板默认正文'}
                            </div>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                            <div className="text-xs text-slate-500">解析集数</div>
                            <div className="mt-2 text-sm font-medium text-slate-100">{draft.episode || '未解析'}</div>
                        </div>
                        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                            <div className="text-xs text-slate-500">解析分辨率</div>
                            <div className="mt-2 text-sm font-medium text-slate-100">{draft.resolution || '未解析'}</div>
                        </div>
                    </div>
                    <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-xs text-slate-500">OKP 路径</div>
                                <div className="mt-2 truncate text-sm font-medium text-slate-100" title={okpExecutablePath || '未配置'}>
                                    {okpExecutablePath || '未配置'}
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        void selectOkpExecutable();
                                    }}
                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                                >
                                    <FolderOpen size={15} />
                                    选择 OKP
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void clearOkpExecutablePath();
                                    }}
                                    disabled={!okpExecutablePath}
                                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Trash2 size={15} />
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="mt-3 text-xs text-slate-500">
                            Windows 请选择 OKP.Core.exe 或 OKP.Core.dll。当前路径保存在全局配置中，与旧主页共享。
                        </div>
                    </div>
                </section>

                <section className="order-3 grid gap-6 xl:grid-cols-2 xl:items-stretch">
                    <div className="space-y-6">
                        <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <h2 className="text-sm font-medium text-slate-200">发布准备</h2>
                                    <p className="mt-1 text-xs text-slate-500">支持文件选择和拖拽导入 .torrent。</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        void selectTorrentFile();
                                    }}
                                    className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                                >
                                    <FolderOpen size={16} />
                                    选择种子
                                </button>
                            </div>

                            <div
                                className={`mt-4 rounded-2xl border px-4 py-4 transition-colors ${
                                    isDragging
                                        ? 'border-cyan-400/40 bg-cyan-500/10'
                                        : 'border-dashed border-slate-700 bg-slate-900/60'
                                }`}
                            >
                                <div className="text-sm text-slate-200">{draft.torrent_path || '拖拽 .torrent 到窗口任意位置，或点击上方按钮选择文件。'}</div>
                                <div className="mt-2 text-xs text-slate-500">
                                    {torrentInfo ? `种子名称：${torrentInfo.name}` : '选择后会自动解析文件树。'}
                                </div>
                            </div>

                            <div className="mt-4">
                                <FileTree root={torrentInfo?.file_tree ?? null} totalSize={torrentInfo?.total_size} />
                            </div>
                        </div>
                    </div>

                    <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5 xl:flex xl:h-full xl:flex-col">
                        <h2 className="text-sm font-medium text-slate-200">发布参数</h2>
                        <div className="mt-4 space-y-4 xl:grid xl:flex-1 xl:grid-rows-4 xl:gap-4 xl:space-y-0">
                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block text-xs text-slate-500">身份</span>
                                <select
                                    value={draft.profile}
                                    onChange={(event) => setDraft((current) => ({ ...current, profile: event.target.value }))}
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                >
                                    <option value="">选择身份</option>
                                    {profileList.map((profile) => (
                                        <option key={profile} value={profile}>
                                            {profile}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block text-xs text-slate-500">Poster</span>
                                <input
                                    type="text"
                                    value={draft.poster}
                                    onChange={(event) => setDraft((current) => ({ ...current, poster: event.target.value }))}
                                    placeholder="海报图片 URL"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block text-xs text-slate-500">About</span>
                                <input
                                    type="text"
                                    value={draft.about}
                                    onChange={(event) => setDraft((current) => ({ ...current, about: event.target.value }))}
                                    placeholder="发布说明"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block text-xs text-slate-500">Tags</span>
                                <input
                                    type="text"
                                    value={draft.tags}
                                    onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                                    placeholder="多个标签以英文逗号分隔"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>
                        </div>
                    </div>
                </section>

                <section className="order-2 space-y-6">
                    <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-medium text-slate-200">标题</h2>
                                <p className="mt-1 text-xs text-slate-500">可按模板规则生成建议标题，也可以手动覆盖。</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    void generateTitle(activeTemplate, draft, true);
                                }}
                                disabled={!activeTemplate || !torrentInfo?.name || isGeneratingTitle}
                                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isGeneratingTitle ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                重新生成标题
                            </button>
                        </div>

                        <div className="mt-4 grid gap-4 md:grid-cols-3">
                            <label className="block text-sm text-slate-300">
                                <span className="mb-2 block text-xs text-slate-500">集数正则</span>
                                <input
                                    type="text"
                                    value={activeTemplate?.ep_pattern ?? ''}
                                    readOnly
                                    className="w-full rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 font-mono text-sm text-slate-400"
                                />
                            </label>
                            <label className="block text-sm text-slate-300">
                                <span className="mb-2 block text-xs text-slate-500">分辨率正则</span>
                                <input
                                    type="text"
                                    value={activeTemplate?.resolution_pattern ?? ''}
                                    readOnly
                                    className="w-full rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 font-mono text-sm text-slate-400"
                                />
                            </label>
                            <label className="block text-sm text-slate-300">
                                <span className="mb-2 block text-xs text-slate-500">标题模板</span>
                                <input
                                    type="text"
                                    value={activeTemplate?.title_pattern ?? ''}
                                    readOnly
                                    className="w-full rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-400"
                                />
                            </label>
                        </div>

                        <label className="mt-4 block text-sm text-slate-300">
                            <span className="mb-2 block text-xs text-slate-500">最终发布标题</span>
                            <input
                                type="text"
                                value={draft.title}
                                onChange={(event) =>
                                    setDraft((current) => ({
                                        ...current,
                                        title: event.target.value,
                                        is_title_overridden: true,
                                    }))
                                }
                                placeholder="最终发布标题"
                                className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                            />
                        </label>
                    </div>

                    <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-medium text-slate-200">正文</h2>
                                <p className="mt-1 text-xs text-slate-500">发布模板自带正文主体，这里可以临时切换公共正文模板，或直接覆盖最终正文。</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <select
                                    value={draft.shared_content_template_id ?? ''}
                                    onChange={(event) => switchRuntimeContentTemplate(event.target.value)}
                                    className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                >
                                    <option value="">不使用公共正文模板</option>
                                    {Object.values(contentTemplates)
                                        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
                                        .map((template) => (
                                            <option key={template.id} value={template.id}>
                                                {template.name || template.id}
                                            </option>
                                        ))}
                                </select>
                            </div>
                        </div>

                        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
                            <div className="flex items-center gap-2 text-slate-200">
                                <FileText size={15} />
                                {activeSharedContentTemplate?.name || '当前未关联公共正文模板'}
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                                {activeSharedContentTemplate?.site_notes || '最终正文由发布模板正文主体和公共正文模板共同组成；站点转换仍交给上游 OKP 处理。'}
                            </p>
                        </div>

                        <div className="mt-4">
                            <PublishContentEditor
                                contentKey={draft.template_id ?? 'quick-publish-runtime'}
                                markdown={draft.markdown}
                                html={draft.html}
                                onMarkdownChange={(markdown) =>
                                    setDraft((current) => ({
                                        ...current,
                                        markdown,
                                        is_content_overridden: true,
                                    }))
                                }
                                onHtmlChange={(html) =>
                                    setDraft((current) => ({
                                        ...current,
                                        html,
                                        is_content_overridden: true,
                                    }))
                                }
                            />
                        </div>
                    </div>
                </section>

                <section className="order-4 rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <h2 className="text-sm font-medium text-slate-200">站点选择</h2>
                    <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60">
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-left text-sm text-slate-300">
                                <thead className="bg-slate-800/80 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th className="w-16 px-4 py-3 font-medium">选择</th>
                                        <th className="px-4 py-3 font-medium">站点</th>
                                        <th className="w-32 px-4 py-3 font-medium">最后发布</th>
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
                                        <th className="w-32 px-4 py-3 font-medium">发布状态</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {siteRows.map(({ site, selectable, selectDisabledReason, identityText, identityClass, identityTitle, loginState, publishState }) => (
                                        <tr key={site.key} className={`border-t border-slate-800/80 ${selectable ? '' : 'opacity-60'}`}>
                                            <td className="px-4 py-3 align-middle">
                                                <input
                                                    type="checkbox"
                                                    checked={draft.sites[site.key]}
                                                    disabled={!selectable}
                                                    onChange={(event) =>
                                                        setDraft((current) => ({
                                                            ...current,
                                                            sites: {
                                                                ...current.sites,
                                                                [site.key]: event.target.checked,
                                                            },
                                                        }))
                                                    }
                                                    title={selectable ? `选择 ${site.label}` : selectDisabledReason}
                                                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
                                                />
                                            </td>
                                            <td className="px-4 py-3 align-middle font-medium text-slate-100">{site.label}</td>
                                            <td className="px-4 py-3 align-middle text-xs text-slate-400">
                                                {formatTimestamp(activeTemplate?.publish_history[site.key].last_published_at ?? '')}
                                            </td>
                                            <td className="px-4 py-3 align-middle">
                                                <div className={identityClass} title={identityTitle}>{identityText}</div>
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
                                                            <span className={`rounded-full border px-2 py-0.5 ${getSiteLoginStateBadgeClass(loginState.status)}`}>
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
                </section>
                <div className="order-6">
                    <button
                        type="button"
                        onClick={() => {
                            void publish();
                        }}
                        disabled={isPublishing || !activeTemplate}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/15 px-6 py-4 text-base font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isPublishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                        发布已选站点
                    </button>
                </div>
            </div>

            <ConsoleModal
                isOpen={showConsole}
                onClose={() => setShowConsole(false)}
                sites={publishSitesList}
                isComplete={isPublishComplete}
                result={publishResult}
            />
        </div>
    );
}
