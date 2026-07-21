import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
    FileText,
    FolderOpen,
    Loader2,
    RefreshCw,
    RotateCcw,
    Send,
    Terminal,
    Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConsoleModal from '../components/ConsoleModal';
import FieldHelpHint from '../components/FieldHelpHint';
import FileTree from '../components/FileTree';
import PublishConfirmModal from '../components/PublishConfirmModal';
import PublishContentEditor from '../components/PublishContentEditor';
import TemplateSelect, { TemplateSelectOption } from '../components/TemplateSelect';
import { EP_PATTERN_HELP } from '../utils/titleRules';
import {
    createPublishConsoleSiteMap,
    createPublishId,
    usePublishTask,
} from '../hooks/usePublishTask';
import { useQuickPublishRuntimeDraft } from '../hooks/useQuickPublishRuntimeDraft';
import { SiteDefinition, siteDefinitions, useSiteLoginTest } from '../hooks/useSiteLoginTest';
import { getCookiePanelSummary, getRemainingTextClass, getSiteCookieText } from '../utils/cookieUtils';
import {
    getPublishStatusTextClass,
    getSiteLoginStateBadgeClass,
} from '../utils/siteStatus';
import { createLatestValuePersistQueue } from '../utils/lastUsedPersistQueue';
import {
    buildSortedTemplateSelectOptions,
    getLatestPublishTimestamp,
} from '../utils/templateSelectOptions';
import {
    QuickPublishRuntimeDraft,
    QuickPublishTemplate,
    SiteSelection,
    buildLegacyPublishTemplatePayload,
    quickPublishSiteKeys,
    quickPublishSiteLabels,
} from '../utils/quickPublish';

interface PublishAttemptContext {
    publishId: string;
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

function formatBytes(bytes?: number): string {
    if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
        return '未知';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function getLatestPublishedAt(template: QuickPublishTemplate): string {
    return (
        getLatestPublishTimestamp(
            quickPublishSiteKeys.map((siteKey) => template.publish_history[siteKey].last_published_at),
        )?.value ?? ''
    );
}

function buildTemplateOptions(templates: Record<string, QuickPublishTemplate>): TemplateSelectOption[] {
    return buildSortedTemplateSelectOptions(
        Object.values(templates).map((template) => ({
            name: template.id,
            label: template.name || template.id,
            publishTimestamps: quickPublishSiteKeys.map(
                (siteKey) => template.publish_history[siteKey].last_published_at,
            ),
            formatPublishedAtLabel: formatTimestamp,
        })),
    );
}

export default function QuickPublishPage() {
    const [isDragging, setIsDragging] = useState(false);
    const [showConsole, setShowConsole] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [confirmDraft, setConfirmDraft] = useState<QuickPublishRuntimeDraft | null>(null);
    const publishAttemptRef = useRef<PublishAttemptContext | null>(null);
    const lastUsedPersistQueueRef = useRef(
        createLatestValuePersistQueue({
            persist: async (id) => {
                await invoke('set_last_used_quick_publish_template', { id });
            },
            onError: (error) => {
                setErrorMessage(
                    typeof error === 'string'
                        ? error
                        : '无法保存最近使用的快速发布模板。当前选择仍会保留。',
                );
            },
        }),
    );
    const {
        siteLoginTests,
        isTestingAllSiteLogins,
        hasRunningSiteLoginTest,
        clearAllSiteLoginTests,
        handleSiteLoginTest: hookHandleSiteLoginTest,
        handleTestAllSiteLogins: hookHandleTestAllSiteLogins,
    } = useSiteLoginTest();
    const {
        isPublishing,
        publishSites,
        isPublishComplete,
        publishResult,
        publishCompletion,
        startPublishTask,
        failActivePublish,
        clearPublishCompletion,
    } = usePublishTask<keyof SiteSelection>();
    const {
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
        selectRuntimeTemplate,
        parseTorrent,
        selectTorrentFile,
        generateTitle,
        resolvePublishRuntimeDraft,
        switchRuntimeContentTemplate,
        resetToTemplateDefaults,
        reconcileRuntimeSelectableSites,
        selectOkpExecutable,
        clearOkpExecutablePath,
        applyTemplatePublishHistory,
    } = useQuickPublishRuntimeDraft({
        clearAllSiteLoginTests,
        onError: setErrorMessage,
    });

    const templateOptions = useMemo(
        () => buildTemplateOptions(quickPublishTemplates),
        [quickPublishTemplates],
    );

    const publishSitesList = useMemo(
        () => Object.values(publishSites).sort((left, right) => left.siteLabel.localeCompare(right.siteLabel, 'zh-CN')),
        [publishSites],
    );

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
                    const tokenValue = site.tokenField
                        ? String(selectedProfileData[site.tokenField] ?? '').trim()
                        : '';
                    if (tokenValue) {
                        return {
                            site,
                            selectable: true,
                            selectDisabledReason: '',
                            identityText: 'API Token 已配置',
                            identityClass: 'text-emerald-300',
                            identityTitle: `${site.label} 将优先使用 API Token`,
                            loginState,
                            publishState,
                        };
                    }

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
        [publishSites, selectedProfileData, siteLoginTests],
    );

    useEffect(() => {
        const selectableSiteKeys = new Set<keyof SiteSelection>(
            siteRows
                .filter((row) => row.selectable)
                .map((row) => row.site.key as keyof SiteSelection),
        );

        reconcileRuntimeSelectableSites(selectableSiteKeys);
    }, [reconcileRuntimeSelectableSites, siteRows]);

    const handleTemplateSelection = useCallback((templateId: string) => {
        if (!quickPublishTemplates[templateId]) {
            return;
        }

        // UI selection is sync; persist is serialized so the last pick wins on disk.
        selectRuntimeTemplate(templateId);
        setStatusMessage('');
        setErrorMessage('');
        lastUsedPersistQueueRef.current.enqueue(templateId);
    }, [quickPublishTemplates, selectRuntimeTemplate]);

    const finalizePublishHistory = useCallback(async (
        publishId: string,
        siteSuccess: Partial<Record<keyof SiteSelection, boolean>>,
    ) => {
        const publishAttempt = publishAttemptRef.current;
        publishAttemptRef.current = null;

        if (!publishAttempt || publishAttempt.publishId !== publishId) {
            return;
        }

        const successfulSiteKeys = publishAttempt.siteKeys.filter((siteKey) => siteSuccess[siteKey]);
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
            applyTemplatePublishHistory(publishAttempt.templateId, updates);
            setStatusMessage('已回填快速发布模板的发布历史。');
        } catch (error) {
            setErrorMessage(typeof error === 'string' ? error : '更新发布历史失败。');
        }
    }, [applyTemplatePublishHistory]);

    useEffect(() => {
        if (!publishCompletion) {
            return;
        }

        void finalizePublishHistory(publishCompletion.publishId, publishCompletion.siteSuccess);
        clearPublishCompletion();
    }, [clearPublishCompletion, finalizePublishHistory, publishCompletion]);

    function validateBeforePublish(): string | null {
        if (!activeTemplate) {
            return '请先选择一个快速发布模板。';
        }
        if (!draft.torrent_path.trim()) {
            return '请先选择一个种子文件。';
        }
        if (!draft.title.trim()) {
            return '请先填写发布标题。';
        }
        if (!draft.profile.trim()) {
            return '请先选择一个身份。';
        }
        if (!okpExecutablePath.trim()) {
            return '请先在旧主页里配置 OKP 可执行文件路径。';
        }
        const selectedSiteKeys = quickPublishSiteKeys.filter((siteKey) => draft.sites[siteKey]);
        if (selectedSiteKeys.length === 0) {
            return '请至少选择一个发布站点。';
        }
        return null;
    }

    const startPublish = async (
        autoOpenConsole: boolean,
        draftToPublish: QuickPublishRuntimeDraft,
    ) => {
        if (!activeTemplate) return;

        const selectedSiteKeys = quickPublishSiteKeys.filter((siteKey) => draftToPublish.sites[siteKey]);
        const publishTemplatePayload = buildLegacyPublishTemplatePayload(draftToPublish, activeTemplate);
        const publishId = createPublishId();
        const nextPublishSites = createPublishConsoleSiteMap(
            selectedSiteKeys.map((siteKey) => ({
                siteCode: siteKey,
                siteLabel: quickPublishSiteLabels[siteKey],
                lines: [],
                status: 'idle' as const,
                message: '等待发布...',
            })),
        );

        publishAttemptRef.current = {
            publishId,
            templateId: activeTemplate.id,
            publishedAt: new Date().toISOString(),
            publishedEpisode: draftToPublish.episode,
            publishedResolution: draftToPublish.resolution,
            siteKeys: selectedSiteKeys,
        };
        if (autoOpenConsole) {
            setShowConsole(true);
        }
        startPublishTask(publishId, nextPublishSites);
        setStatusMessage('');
        setErrorMessage('');

        try {
            await invoke('publish', {
                request: {
                    publish_id: publishId,
                    torrent_path: draftToPublish.torrent_path,
                    template_name: activeTemplate.name || activeTemplate.id,
                    profile_name: draftToPublish.profile,
                    template: publishTemplatePayload,
                },
            });
        } catch (error) {
            const message = typeof error === 'string' ? error : '启动发布失败。';
            setErrorMessage(message);
            failActivePublish(message, { appendToFirstSite: true });
        }
    };

    const handlePublishClick = async () => {
        const error = validateBeforePublish();
        if (error) {
            setErrorMessage(error);
            return;
        }
        setErrorMessage('');
        setStatusMessage('');

        try {
            const nextConfirmDraft = await resolvePublishRuntimeDraft(activeTemplate, draft);
            setConfirmDraft(nextConfirmDraft);
            setShowConfirm(true);
        } catch {
            setConfirmDraft(null);
            setShowConfirm(false);
        }
    };

    const handleCloseConfirm = () => {
        setShowConfirm(false);
        setConfirmDraft(null);
    };

    const updateConfirmDraftMetadata = useCallback(
        (field: 'episode' | 'resolution', value: string) => {
            setConfirmDraft((current) => current ? { ...current, [field]: value } : current);
        },
        [],
    );

    const publishPreviewDraft = confirmDraft ?? draft;

    const selectedSiteSummaries = useMemo(
        () =>
            siteRows
                .filter((row) => publishPreviewDraft.sites[row.site.key as keyof SiteSelection])
                .map((row) => ({
                    key: row.site.key as keyof SiteSelection,
                    label: row.site.label,
                    identityText: row.identityText,
                    identityToneClass: row.identityClass,
                })),
        [siteRows, publishPreviewDraft.sites],
    );

    const handleSiteLoginTest = (site: SiteDefinition) => {
        void hookHandleSiteLoginTest(site, selectedProfileData);
    };

    const handleTestAllSiteLogins = () => {
        void hookHandleTestAllSiteLogins(siteDefinitions, selectedProfileData);
    };

    return (
        <div className="h-full overflow-y-auto bg-slate-900 px-6 py-6 text-slate-100">
            <div className="mx-auto flex max-w-7xl flex-col gap-6">

                {/* 1. PageHeader */}
                <header className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-cyan-400/80">快速模板发布</p>
                        <h1 className="mt-2 text-3xl font-semibold text-white">模板发布</h1>
                        <p className="mt-2 max-w-3xl text-sm text-slate-400">
                            这里是运行时装配页。发布模板提供默认值，你可以在本次发布里覆盖标题、正文、身份与站点，但这些覆盖默认不会回写模板。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={resetToTemplateDefaults}
                        disabled={!activeTemplate}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <RotateCcw size={16} />
                        重置为模板默认值
                    </button>
                </header>

                {/* 2. Status / error banners */}
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

                {/* 3. Template section — STEP 1 */}
                <section className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                        STEP 1 · TEMPLATE
                    </div>
                    <div className="mt-3 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] xl:items-start">
                        <div>
                            <h2 className="text-sm font-medium text-slate-200">发布模板选择</h2>
                            <p className="mt-1 text-xs text-slate-500">先选本次发布要套用的模板，标题和正文会按这里的默认值初始化。</p>
                            <div className="mt-4">
                                <label className="mb-2 block text-xs text-slate-500">发布模板</label>
                                <TemplateSelect
                                    options={templateOptions}
                                    value={selectedTemplateId}
                                    onChange={handleTemplateSelection}
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

                {/* 4. Torrent | Metadata two-col grid — STEP 2 / STEP 3 */}
                <section className="grid gap-6 xl:grid-cols-2 xl:items-stretch">
                    {/* Torrent — STEP 2 */}
                    <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                        <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                            STEP 2 · TORRENT
                        </div>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
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

                    {/* Metadata — STEP 3 */}
                    <div className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5 xl:flex xl:h-full xl:flex-col">
                        <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                            STEP 3 · PARAMS
                        </div>
                        <h2 className="mt-3 text-sm font-medium text-slate-200">发布参数</h2>
                        <div className="mt-4 space-y-4 xl:grid xl:flex-1 xl:grid-rows-4 xl:gap-4 xl:space-y-0">
                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">身份</span>
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
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">Poster</span>
                                <input
                                    type="text"
                                    value={draft.poster}
                                    onChange={(event) => setDraft((current) => ({ ...current, poster: event.target.value }))}
                                    placeholder="海报图片 URL"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">About</span>
                                <input
                                    type="text"
                                    value={draft.about}
                                    onChange={(event) => setDraft((current) => ({ ...current, about: event.target.value }))}
                                    placeholder="发布说明"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">Tags</span>
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

                {/* 5. Title section — STEP 3 · TITLE */}
                <section className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                        STEP 3 · TITLE
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-medium text-slate-200">标题</h2>
                            <p className="mt-1 text-xs text-slate-500">可按模板规则生成建议标题，也可以手动覆盖。</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {draft.episode ? (
                                <span className="inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200">
                                    EP {draft.episode}
                                </span>
                            ) : null}
                            {draft.resolution ? (
                                <span className="inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-200">
                                    {draft.resolution}
                                </span>
                            ) : null}
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
                    </div>

                    <div className="mt-4 space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <label className="block text-sm text-slate-300">
                                <span className="mb-2 flex items-center text-xs text-slate-500">
                                    集数正则
                                    <FieldHelpHint label="集数正则说明">{EP_PATTERN_HELP}</FieldHelpHint>
                                </span>
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
                        </div>
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
                        <textarea
                            rows={2}
                            value={draft.title}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    title: event.target.value,
                                    is_title_overridden: true,
                                }))
                            }
                            placeholder="最终发布标题"
                            className="w-full resize-y rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                    </label>
                </section>

                {/* 6. Body section — STEP 4 · BODY */}
                <section className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                        STEP 4 · BODY
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
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
                </section>

                {/* 7. Site table — STEP 5 · SITES */}
                <section className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
                    <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                        STEP 5 · SITES
                    </div>
                    <h2 className="mt-3 text-sm font-medium text-slate-200">站点选择</h2>
                    <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60">
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-left text-sm text-slate-300">
                                <thead className="bg-slate-800/80">
                                    <tr>
                                        <th className="w-16 px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">选择</th>
                                        <th className="px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">站点</th>
                                        <th className="w-32 px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">最后发布</th>
                                        <th className="px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">身份状态</th>
                                        <th className="w-36 px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">
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
                                        <th className="w-32 px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">发布状态</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {siteRows.map(({ site, selectable, selectDisabledReason, identityText, identityClass, identityTitle, loginState, publishState }) => (
                                        <tr key={site.key} className={`border-t border-slate-800/80 ${selectable ? '' : 'opacity-60'}`}>
                                            <td className="px-4 py-3 align-middle">
                                                <input
                                                    type="checkbox"
                                                    checked={draft.sites[site.key as keyof SiteSelection]}
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
                                            <td className="px-4 py-3 align-middle font-medium text-slate-100">
                                                <div>{site.label}</div>
                                                <div className="font-mono text-[11px] text-slate-500">{site.key}</div>
                                            </td>
                                            <td className="px-4 py-3 align-middle text-xs text-slate-400">
                                                {formatTimestamp(activeTemplate?.publish_history[site.key as keyof SiteSelection].last_published_at ?? '')}
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

                {/* 8. OKP path row — standalone slim card */}
                <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3">
                    <Terminal size={15} className="text-cyan-300" />
                    <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] tracking-[0.06em] uppercase text-slate-500">OKP.CORE 路径</div>
                        <div className="mt-1 truncate font-mono text-xs text-slate-100" title={okpExecutablePath || '未配置'}>
                            {okpExecutablePath || '未配置'}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void selectOkpExecutable()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
                    >
                        <FolderOpen size={14} />
                        选择 OKP
                    </button>
                    <button
                        type="button"
                        onClick={() => void clearOkpExecutablePath()}
                        disabled={!okpExecutablePath}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Trash2 size={14} />
                        清空
                    </button>
                </div>

                {/* 9. PublishBar — STEP 6 */}
                <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/95 px-5 py-4 shadow-xl">
                    <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] tracking-[0.16em] uppercase text-slate-500">STEP 6 · PUBLISH</div>
                        <div className="mt-1 truncate text-sm font-semibold text-slate-100">
                            {selectedSiteSummaries.length > 0
                                ? `发布到 ${selectedSiteSummaries.length} 站点 · ${selectedSiteSummaries.map((s) => s.label).join(' · ')}`
                                : '请至少选择一个发布站点'}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                            确认后会先弹出发布前检查，再启动各站点发布。
                        </div>
                    </div>
                    {(draft.episode || draft.resolution) ? (
                        <span className="inline-flex items-center rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2.5 py-0.5 text-[11px] font-medium text-cyan-200">
                            {[draft.episode && `EP ${draft.episode}`, draft.resolution].filter(Boolean).join(' / ')}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => handlePublishClick()}
                        disabled={isPublishing || !activeTemplate}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
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
            <PublishConfirmModal
                isOpen={showConfirm}
                onClose={handleCloseConfirm}
                onConfirm={({ autoOpenConsole }) => {
                    const draftToPublish = confirmDraft ?? draft;
                    setShowConfirm(false);
                    setConfirmDraft(null);
                    void startPublish(autoOpenConsole, draftToPublish);
                }}
                title={publishPreviewDraft.title}
                templateLabel={activeTemplate ? (activeTemplate.name || activeTemplate.id) : ''}
                templateLatestPublishedAtLabel={
                    activeTemplate ? formatTimestamp(getLatestPublishedAt(activeTemplate)) : '未发布'
                }
                torrentPath={publishPreviewDraft.torrent_path}
                torrentTotalSizeLabel={formatBytes(torrentInfo?.total_size)}
                episode={publishPreviewDraft.episode}
                resolution={publishPreviewDraft.resolution}
                onEpisodeChange={(value) => updateConfirmDraftMetadata('episode', value)}
                onResolutionChange={(value) => updateConfirmDraftMetadata('resolution', value)}
                about={publishPreviewDraft.about}
                tags={publishPreviewDraft.tags}
                poster={publishPreviewDraft.poster}
                profile={publishPreviewDraft.profile}
                okpPath={okpExecutablePath}
                selectedSites={selectedSiteSummaries}
            />
        </div>
    );
}
