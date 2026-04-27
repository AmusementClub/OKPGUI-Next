import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileTreeNodeData } from '../components/FileTree';
import type { SiteCookies } from '../utils/cookieUtils';
import { reconcileSelectableSiteSelection } from '../utils/siteSelection';
import {
    ContentTemplate,
    QuickPublishConfigPayload,
    QuickPublishRuntimeDraft,
    QuickPublishTemplate,
    SitePublishHistory,
    SiteSelection,
    buildRuntimeDraftFromTemplate,
    composePublishContent,
    createDefaultQuickPublishRuntimeDraft,
    normalizeContentTemplate,
    normalizePublishHistory,
    normalizeQuickPublishTemplate,
} from '../utils/quickPublish';
import { useLatest } from './useLatest';

interface ParsedTitleDetails {
    title: string;
    episode: string;
    resolution: string;
}

export interface QuickPublishTorrentInfo {
    name: string;
    total_size: number;
    file_tree: FileTreeNodeData;
}

interface RuntimeTemplateSelectionOptions {
    templates?: Record<string, QuickPublishTemplate>;
    contentTemplates?: Record<string, ContentTemplate>;
    currentTorrentPath?: string;
}

interface UseQuickPublishRuntimeDraftOptions {
    clearAllSiteLoginTests?: () => void;
    onError?: (message: string) => void;
}

interface QuickPublishProfileData {
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
    [key: string]: unknown;
}

interface TemplatePublishHistoryUpdate {
    site_key: keyof SiteSelection;
    last_published_at: string;
    last_published_episode: string;
    last_published_resolution: string;
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

function toErrorMessage(error: unknown, fallback: string): string {
    return typeof error === 'string' ? error : fallback;
}

export function useQuickPublishRuntimeDraft({
    clearAllSiteLoginTests,
    onError,
}: UseQuickPublishRuntimeDraftOptions) {
    const [quickPublishTemplates, setQuickPublishTemplates] = useState<Record<string, QuickPublishTemplate>>({});
    const [contentTemplates, setContentTemplates] = useState<Record<string, ContentTemplate>>({});
    const [profileList, setProfileList] = useState<string[]>([]);
    const [selectedProfileData, setSelectedProfileData] = useState<QuickPublishProfileData | null>(null);
    const [okpExecutablePath, setOkpExecutablePath] = useState('');
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [draft, setDraft] = useState<QuickPublishRuntimeDraft>(createDefaultQuickPublishRuntimeDraft());
    const [torrentInfo, setTorrentInfo] = useState<QuickPublishTorrentInfo | null>(null);
    const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
    const clearAllSiteLoginTestsRef = useLatest(clearAllSiteLoginTests);
    const quickPublishTemplatesRef = useLatest(quickPublishTemplates);
    const contentTemplatesRef = useLatest(contentTemplates);
    const selectedTemplateIdRef = useLatest(selectedTemplateId);
    const draftRef = useLatest(draft);
    const torrentInfoRef = useLatest(torrentInfo);

    const activeTemplate = useMemo(
        () => (selectedTemplateId ? quickPublishTemplates[selectedTemplateId] ?? null : null),
        [quickPublishTemplates, selectedTemplateId],
    );
    const activeTemplateRef = useLatest(activeTemplate);

    const activeSharedContentTemplate = useMemo(
        () =>
            draft.shared_content_template_id && contentTemplates[draft.shared_content_template_id]
                ? contentTemplates[draft.shared_content_template_id]
                : null,
        [contentTemplates, draft.shared_content_template_id],
    );

    const loadProfiles = useCallback(async () => {
        try {
            const nextProfiles = await invoke<string[]>('get_profile_list');
            setProfileList(nextProfiles);
        } catch (error) {
            onError?.(toErrorMessage(error, '加载身份列表失败。'));
        }
    }, [onError]);

    const loadSelectedProfileData = useCallback(async (profileName: string) => {
        if (!profileName.trim()) {
            setSelectedProfileData(null);
            clearAllSiteLoginTestsRef.current?.();
            return;
        }

        try {
            const store = await invoke<{ profiles: Record<string, QuickPublishProfileData> }>('get_profiles');

            if (draftRef.current.profile !== profileName) {
                return;
            }

            setSelectedProfileData(store.profiles[profileName] ?? null);
            clearAllSiteLoginTestsRef.current?.();
        } catch (error) {
            if (draftRef.current.profile !== profileName) {
                return;
            }

            setSelectedProfileData(null);
            clearAllSiteLoginTestsRef.current?.();
            onError?.(toErrorMessage(error, '加载身份详情失败。'));
        }
    }, [clearAllSiteLoginTestsRef, draftRef, onError]);

    const loadQuickPublishData = useCallback(async (preferredId?: string) => {
        try {
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
            setOkpExecutablePath(config.okp_executable_path ?? '');

            const currentSelectedTemplateId = selectedTemplateIdRef.current;
            const resolvedTemplateId =
                preferredId && nextQuickPublishTemplates[preferredId]
                    ? preferredId
                    : currentSelectedTemplateId && nextQuickPublishTemplates[currentSelectedTemplateId]
                      ? currentSelectedTemplateId
                      : config.last_used_quick_publish_template && nextQuickPublishTemplates[config.last_used_quick_publish_template]
                        ? config.last_used_quick_publish_template
                        : Object.keys(nextQuickPublishTemplates).sort((left, right) => left.localeCompare(right, 'zh-CN'))[0] ?? '';

            if (!resolvedTemplateId) {
                clearRuntimeDraft();
                return;
            }

            selectRuntimeTemplate(resolvedTemplateId, {
                templates: nextQuickPublishTemplates,
                contentTemplates: nextContentTemplates,
                currentTorrentPath: draftRef.current.torrent_path,
            });
        } catch (error) {
            onError?.(toErrorMessage(error, '加载快速发布配置失败。'));
        }
    }, [draftRef, onError, selectedTemplateIdRef]);

    const generateTitle = useCallback(
        async (
            templateToUse = activeTemplateRef.current,
            draftToUse = draftRef.current,
            forceOverwrite = false,
            filename = torrentInfoRef.current?.name,
        ) => {
            if (!templateToUse || !filename || !templateToUse.title_pattern.trim()) {
                return;
            }

            if (draftToUse.is_title_overridden && !forceOverwrite) {
                return;
            }

            setIsGeneratingTitle(true);

            try {
                const details = await invoke<ParsedTitleDetails>('parse_title_details', {
                    filename,
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
                onError?.(toErrorMessage(error, '生成标题失败。'));
            } finally {
                setIsGeneratingTitle(false);
            }
        },
        [activeTemplateRef, draftRef, onError, torrentInfoRef],
    );

    const selectRuntimeTemplate = useCallback(
        (
            templateId: string,
            options: RuntimeTemplateSelectionOptions = {},
        ) => {
            const templates = options.templates ?? quickPublishTemplatesRef.current;
            const contents = options.contentTemplates ?? contentTemplatesRef.current;
            const template = templates[templateId];
            if (!template) {
                return;
            }

            const contentTemplate = template.shared_content_template_id
                ? contents[template.shared_content_template_id] ?? null
                : null;
            const nextDraft = {
                ...buildRuntimeDraftFromTemplate(template, contentTemplate),
                torrent_path: options.currentTorrentPath ?? draftRef.current.torrent_path,
            };

            setSelectedTemplateId(templateId);
            setDraft(nextDraft);

            if (torrentInfoRef.current?.name) {
                void generateTitle(template, nextDraft);
            }
        },
        [contentTemplatesRef, draftRef, generateTitle, quickPublishTemplatesRef, torrentInfoRef],
    );

    const clearRuntimeDraft = useCallback(() => {
        setSelectedTemplateId('');
        setDraft(createDefaultQuickPublishRuntimeDraft());
    }, []);

    const parseTorrent = useCallback(
        async (path: string) => {
            try {
                const info = await invoke<QuickPublishTorrentInfo>('parse_torrent', { path });
                setTorrentInfo(info);

                const nextDraft = {
                    ...draftRef.current,
                    torrent_path: path,
                };
                setDraft(nextDraft);

                if (activeTemplateRef.current) {
                    await generateTitle(activeTemplateRef.current, nextDraft, false, info.name);
                }
            } catch (error) {
                onError?.(toErrorMessage(error, '解析种子失败。'));
            }
        },
        [activeTemplateRef, draftRef, generateTitle, onError],
    );

    const selectTorrentFile = useCallback(async () => {
        const file = await open({
            filters: [{ name: '种子文件', extensions: ['torrent'] }],
        });

        if (typeof file === 'string') {
            await parseTorrent(file);
        }
    }, [parseTorrent]);

    const switchRuntimeContentTemplate = useCallback(
        (contentTemplateId: string) => {
            const template = activeTemplateRef.current;
            if (!template) {
                return;
            }

            const nextContentTemplate = contentTemplateId
                ? contentTemplatesRef.current[contentTemplateId] ?? null
                : null;
            const bodyMarkdown = template.body_markdown ?? '';
            const bodyHtml = template.body_html ?? '';

            setDraft((current) => ({
                ...current,
                shared_content_template_id: contentTemplateId || null,
                markdown: composePublishContent(bodyMarkdown, nextContentTemplate?.markdown ?? ''),
                html: composePublishContent(bodyHtml, nextContentTemplate?.html ?? '', '\n'),
                is_content_overridden: false,
            }));
        },
        [activeTemplateRef, contentTemplatesRef],
    );

    const resetToTemplateDefaults = useCallback(() => {
        const template = activeTemplateRef.current;
        if (!template) {
            return;
        }

        const contentTemplate =
            template.shared_content_template_id && contentTemplatesRef.current[template.shared_content_template_id]
                ? contentTemplatesRef.current[template.shared_content_template_id]
                : null;

        const nextDraft = {
            ...buildRuntimeDraftFromTemplate(template, contentTemplate),
            torrent_path: draftRef.current.torrent_path,
        };
        setDraft(nextDraft);

        if (torrentInfoRef.current?.name) {
            void generateTitle(template, nextDraft, true, torrentInfoRef.current.name);
        }
    }, [activeTemplateRef, contentTemplatesRef, draftRef, generateTitle, torrentInfoRef]);

    const reconcileRuntimeSelectableSites = useCallback(
        (selectableSiteKeys: Iterable<keyof SiteSelection>) => {
            setDraft((current) => {
                const nextSites = reconcileSelectableSiteSelection(current.sites, selectableSiteKeys);

                if (nextSites === current.sites) {
                    return current;
                }

                return {
                    ...current,
                    sites: nextSites,
                };
            });
        },
        [],
    );

    const saveOkpExecutablePath = useCallback(async (path: string) => {
        try {
            await invoke('save_okp_executable_path', {
                okpExecutablePath: path,
            });
            setOkpExecutablePath(path);
        } catch (error) {
            onError?.(toErrorMessage(error, '保存 OKP 路径失败。'));
        }
    }, [onError]);

    const selectOkpExecutable = useCallback(async () => {
        try {
            const file = await open();
            const selectedPath = Array.isArray(file) ? file[0] : file;
            if (selectedPath) {
                await saveOkpExecutablePath(selectedPath);
            }
        } catch (error) {
            onError?.(toErrorMessage(error, '选择 OKP 路径失败。'));
        }
    }, [onError, saveOkpExecutablePath]);

    const clearOkpExecutablePath = useCallback(async () => {
        await saveOkpExecutablePath('');
    }, [saveOkpExecutablePath]);

    const applyTemplatePublishHistory = useCallback((
        templateId: string,
        updates: TemplatePublishHistoryUpdate[],
    ) => {
        setQuickPublishTemplates((current) => {
            const currentTemplate = current[templateId];
            if (!currentTemplate) {
                return current;
            }

            return {
                ...current,
                [templateId]: {
                    ...currentTemplate,
                    publish_history: mergePublishHistory(currentTemplate.publish_history, updates),
                },
            };
        });
    }, []);

    useEffect(() => {
        void Promise.all([loadQuickPublishData(), loadProfiles()]);
    }, [loadProfiles, loadQuickPublishData]);

    useEffect(() => {
        void loadSelectedProfileData(draft.profile);
    }, [draft.profile, loadSelectedProfileData]);

    return {
        quickPublishTemplates,
        contentTemplates,
        profileList,
        selectedProfileData,
        okpExecutablePath,
        selectedTemplateId,
        draft,
        setDraft,
        torrentInfo,
        isGeneratingTitle,
        activeTemplate,
        activeSharedContentTemplate,
        clearRuntimeDraft,
        selectRuntimeTemplate,
        parseTorrent,
        selectTorrentFile,
        generateTitle,
        switchRuntimeContentTemplate,
        resetToTemplateDefaults,
        reconcileRuntimeSelectableSites,
        selectOkpExecutable,
        clearOkpExecutablePath,
        applyTemplatePublishHistory,
    };
}