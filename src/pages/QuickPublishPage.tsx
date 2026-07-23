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
import AiPreflightPanel from '../components/AiPreflightPanel';
import AiRecognitionPanel from '../components/AiRecognitionPanel';
import PublishContentEditor from '../components/PublishContentEditor';
import TemplateSelect, { TemplateSelectOption } from '../components/TemplateSelect';
import WarningBanner from '../components/WarningBanner';
import { EP_PATTERN_HELP } from '../utils/titleRules';
import { renderMarkdownToHtml } from '../utils/markdown';
import { isHtmlPreferredSite, validatePublishContentForSites } from '../utils/publishValidation';
import {
    createPublishConsoleSiteMap,
    createPublishId,
    usePublishTask,
} from '../hooks/usePublishTask';
import { useQuickPublishRuntimeDraft } from '../hooks/useQuickPublishRuntimeDraft';
import { isPrepareSupersededError, useAiPreflight } from '../hooks/useAiPreflight';
import { useAiRecognition } from '../hooks/useAiRecognition';
import { SiteDefinition, siteDefinitions, useSiteLoginTest } from '../hooks/useSiteLoginTest';
import { useSiteRows } from '../hooks/useSiteRows';
import {
    getPublishStatusTextClass,
    getSiteLoginStateBadgeClass,
} from '../utils/siteStatus';
import { createLatestValuePersistQueue } from '../utils/lastUsedPersistQueue';
import { extractDroppedFilePath } from '../utils/drop';
import {
    buildSortedTemplateSelectOptions,
    getLatestPublishTimestamp,
} from '../utils/templateSelectOptions';
import {
    QuickPublishRuntimeDraft,
    QuickPublishTemplate,
    LegacyPublishTemplatePayload,
    SiteSelection,
    buildLegacyPublishTemplatePayload,
    formatTemplateTimestamp,
    quickPublishSiteKeys,
    quickPublishSiteLabels,
} from '../utils/quickPublish';
import {
    acknowledgeAutoTemplateSeedHydration,
    clearAutoTemplateSeedHydrationCycle,
    consumeTemplateSeed,
    hasAutoTemplateSeedConsumeInFlight,
    isAiCapabilityReady,
    peekAutoTemplateSeedHandoff,
    publishPreparedPlan,
    readFriendlyError,
    takeAndConsumeAutoTemplateSeed,
    takeAutoTemplateSeedHandoff,
} from '../services/ai';
import {
    buildRecognitionDraftIdentity,
    type PublishRequestPayload,
} from '../types/ai';
import {
    resolvePublishTitleMetadata,
    type ParsedTitleDetails,
} from '../utils/publishTitleMetadata';

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

interface FrozenPublishPlan {
    token: string;
    request: PublishRequestPayload;
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
            formatPublishedAtLabel: formatTemplateTimestamp,
        })),
    );
}

export default function QuickPublishPage() {
    const [isDragging, setIsDragging] = useState(false);
    const [showConsole, setShowConsole] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [isPreparingPublish, setIsPreparingPublish] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [confirmDraft, setConfirmDraft] = useState<QuickPublishRuntimeDraft | null>(null);
    const frozenPlanRef = useRef<FrozenPublishPlan | null>(null);
    /** Bumps on covered draft mutations so in-flight resolve/prepare cannot freeze stale data. */
    const coveredEditGenerationRef = useRef(0);
    const isPreparingPublishRef = useRef(false);
    // Ref keeps invalidatePreparedOnCoveredEdit stable so drag-drop does not re-register.
    const showConfirmRef = useRef(showConfirm);
    showConfirmRef.current = showConfirm;
    // Stable callbacks: an inline onClearError would recreate parseTorrent every render,
    // forcing the drag-drop effect to re-register its listener each time.
    const handleRuntimeError = useCallback((message: string) => setErrorMessage(message), []);
    const handleClearRuntimeError = useCallback(() => setErrorMessage(''), []);
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
        showPublishResult,
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
        onError: handleRuntimeError,
        onClearError: handleClearRuntimeError,
    });
    const preflight = useAiPreflight();
    const recognition = useAiRecognition();
    const clearRecognition = recognition.clear;
    const invalidateRecognitionIfDraftMismatch = recognition.invalidateIfDraftMismatch;
    /**
     * Explicit episode/resolution adopts applied as history metadata.
     * Survive unrelated covered edits (e.g. title override) but clear on torrent/template
     * identity change and on a new recognition request.
     */
    const [adoptedHistory, setAdoptedHistory] = useState<{ episode: string; resolution: string }>({
        episode: '',
        resolution: '',
    });
    const adoptedHistoryRef = useRef(adoptedHistory);
    adoptedHistoryRef.current = adoptedHistory;
    const clearAdoptedHistory = useCallback(() => {
        const empty = { episode: '', resolution: '' };
        adoptedHistoryRef.current = empty;
        setAdoptedHistory(empty);
    }, []);

    const invalidatePreflight = preflight.invalidate;
    const clearFrozenPreflight = useCallback(() => {
        invalidatePreflight();
        frozenPlanRef.current = null;
        setShowConfirm(false);
        setConfirmDraft(null);
    }, [invalidatePreflight]);

    /**
     * Covered draft/template/torrent/profile/site/content/title/OKP mutations supersede
     * any live or in-flight resolve/prepare. Confirm-modal episode/resolution history
     * edits remain non-covered (same as HomePage).
     * Clears advisory recognition candidates; already-applied history adopts stay unless
     * clearHistoryAdopts (torrent/template identity).
     */
    const invalidatePreparedOnCoveredEdit = useCallback((options?: { clearHistoryAdopts?: boolean }) => {
        coveredEditGenerationRef.current += 1;
        clearRecognition({ resetOrigins: Boolean(options?.clearHistoryAdopts) });
        if (options?.clearHistoryAdopts) {
            clearAdoptedHistory();
        }
        if (frozenPlanRef.current || showConfirmRef.current || isPreparingPublishRef.current) {
            clearFrozenPreflight();
        }
    }, [clearAdoptedHistory, clearFrozenPreflight, clearRecognition]);

    const updateDraftCovered = useCallback(
        (updater: (current: QuickPublishRuntimeDraft) => QuickPublishRuntimeDraft) => {
            invalidatePreparedOnCoveredEdit();
            setDraft(updater);
        },
        [invalidatePreparedOnCoveredEdit, setDraft],
    );

    const parseTorrentCovered = useCallback(
        async (path: string) => {
            // Torrent identity change: drop history adopts with recognition candidates.
            invalidatePreparedOnCoveredEdit({ clearHistoryAdopts: true });
            await parseTorrent(path);
        },
        [invalidatePreparedOnCoveredEdit, parseTorrent],
    );

    const selectTorrentFileCovered = useCallback(async () => {
        invalidatePreparedOnCoveredEdit({ clearHistoryAdopts: true });
        await selectTorrentFile();
    }, [invalidatePreparedOnCoveredEdit, selectTorrentFile]);

    const generateTitleCovered = useCallback(async () => {
        invalidatePreparedOnCoveredEdit();
        await generateTitle(activeTemplate, draft, true);
    }, [activeTemplate, draft, generateTitle, invalidatePreparedOnCoveredEdit]);

    const switchRuntimeContentTemplateCovered = useCallback(
        (templateId: string) => {
            invalidatePreparedOnCoveredEdit();
            switchRuntimeContentTemplate(templateId);
        },
        [invalidatePreparedOnCoveredEdit, switchRuntimeContentTemplate],
    );

    const resetToTemplateDefaultsCovered = useCallback(() => {
        invalidatePreparedOnCoveredEdit();
        resetToTemplateDefaults();
    }, [invalidatePreparedOnCoveredEdit, resetToTemplateDefaults]);

    const selectOkpExecutableCovered = useCallback(async () => {
        invalidatePreparedOnCoveredEdit();
        await selectOkpExecutable();
    }, [invalidatePreparedOnCoveredEdit, selectOkpExecutable]);

    const clearOkpExecutablePathCovered = useCallback(async () => {
        invalidatePreparedOnCoveredEdit();
        await clearOkpExecutablePath();
    }, [clearOkpExecutablePath, invalidatePreparedOnCoveredEdit]);

    const templateOptions = useMemo(
        () => buildTemplateOptions(quickPublishTemplates),
        [quickPublishTemplates],
    );

    const publishSitesList = useMemo(
        () => Object.values(publishSites).sort((left, right) => left.siteLabel.localeCompare(right.siteLabel, 'zh-CN')),
        [publishSites],
    );

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
                    void parseTorrentCovered(droppedTorrentPath);
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
    }, [parseTorrentCovered]);

    // AutoTemplate seed hydration: wait for catalog load, validate backend metadata
    // against the currently loaded catalog, then mutate the runtime draft only on success.
    // Fail-closed paths never mutate runtime and always surface a concise sanitized error.
    const autoTemplateSeedHandledRef = useRef(false);

    /** User-visible, non-sensitive hydration failures (no paths, secrets, or raw provider bodies). */
    const reportAutoTemplateHydrationFailure = useCallback((message: string) => {
        setStatusMessage('');
        setErrorMessage(message);
    }, []);
    useEffect(() => {
        if (autoTemplateSeedHandledRef.current) {
            return;
        }

        let cancelled = false;

        const attemptHydration = async () => {
            const handoff = peekAutoTemplateSeedHandoff();
            const inFlight = hasAutoTemplateSeedConsumeInFlight();
            if (!handoff && !inFlight) {
                return;
            }

            // After a StrictMode remount the module-scoped consume may still be in flight
            // while runtime catalog state is empty again — wait for reload before validating.
            if (!handoff && inFlight && Object.keys(quickPublishTemplates).length === 0) {
                return;
            }

            // When a handoff is still present, wait until the target template is in the
            // runtime catalog (or confirm it is truly missing after config load).
            if (handoff) {
                const catalogTemplate = quickPublishTemplates[handoff.template_id];
                if (!catalogTemplate) {
                    try {
                        const config = await invoke<{
                            quick_publish_templates?: Record<string, { revision?: number }>;
                        }>('get_config');
                        if (cancelled) {
                            return;
                        }
                        const remote = config.quick_publish_templates?.[handoff.template_id];
                        if (!remote) {
                            // Template deleted/missing: fail closed, invalidate handoff + seed.
                            autoTemplateSeedHandledRef.current = true;
                            const token = handoff.token;
                            takeAutoTemplateSeedHandoff();
                            void consumeTemplateSeed(token);
                            clearAutoTemplateSeedHydrationCycle();
                            reportAutoTemplateHydrationFailure(
                                '自动选模板对应的发布模板不存在或已变更，请重新选择模板。',
                            );
                            return;
                        }
                        // Config has the template but runtime state is not ready yet — wait.
                        return;
                    } catch {
                        return;
                    }
                }
            }

            const consumed = await takeAndConsumeAutoTemplateSeed();
            if (cancelled) {
                // StrictMode remount: the shared in-flight promise will be applied by the next effect.
                return;
            }
            if (!consumed || !consumed.template_id || !consumed.torrent_path) {
                // Transport/invoke failure leaves the opaque handoff in place for remount retry.
                // Explicit terminal consume rejection already cleared storage — only then finalize.
                if (peekAutoTemplateSeedHandoff()) {
                    return;
                }
                // Replay / expired / stale / missing: fail closed, do not hydrate as success.
                autoTemplateSeedHandledRef.current = true;
                clearAutoTemplateSeedHydrationCycle();
                reportAutoTemplateHydrationFailure(
                    '自动选模板结果已失效或无法使用，请重新选择模板。',
                );
                return;
            }

            // Validate backend seed metadata against the currently loaded catalog.
            const liveTemplate = quickPublishTemplates[consumed.template_id];
            if (!liveTemplate || liveTemplate.revision !== consumed.template_revision) {
                // Missing template or revision/digest drift — do not mutate user state.
                autoTemplateSeedHandledRef.current = true;
                clearAutoTemplateSeedHydrationCycle();
                reportAutoTemplateHydrationFailure(
                    '自动选模板对应的发布模板不存在或已变更，请重新选择模板。',
                );
                return;
            }

            // Validate torrent parse before mutating runtime as a successful seed hydration.
            // Fail closed on terminal parse errors without acknowledging success.
            try {
                await invoke('parse_torrent', { path: consumed.torrent_path });
            } catch {
                if (cancelled) {
                    return;
                }
                autoTemplateSeedHandledRef.current = true;
                clearAutoTemplateSeedHydrationCycle();
                // Sanitized: never surface absolute paths or raw parse provider bodies.
                reportAutoTemplateHydrationFailure(
                    '自动选模板的种子文件无法解析，请重新选择种子或模板。',
                );
                return;
            }
            if (cancelled) {
                return;
            }

            autoTemplateSeedHandledRef.current = true;
            // Seed hydration mutates template + torrent identity: supersede any prepared plan.
            coveredEditGenerationRef.current += 1;
            selectRuntimeTemplate(consumed.template_id);
            try {
                await parseTorrentCovered(consumed.torrent_path);
            } catch {
                clearAutoTemplateSeedHydrationCycle();
                reportAutoTemplateHydrationFailure(
                    '自动选模板的种子文件无法解析，请重新选择种子或模板。',
                );
                return;
            }
            if (cancelled) {
                return;
            }
            // Acknowledge only after torrent hydration has completed successfully.
            acknowledgeAutoTemplateSeedHydration();
        };

        void attemptHydration();

        return () => {
            cancelled = true;
        };
    }, [parseTorrentCovered, quickPublishTemplates, reportAutoTemplateHydrationFailure, selectRuntimeTemplate]);

    const siteRows = useSiteRows({
        publishSites,
        selectedProfileData,
        siteLoginTests,
    });

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

        // Template identity mutation supersedes any live or in-flight prepare and history adopts.
        invalidatePreparedOnCoveredEdit({ clearHistoryAdopts: true });
        // UI selection is sync; persist is serialized so the last pick wins on disk.
        selectRuntimeTemplate(templateId);
        setStatusMessage('');
        setErrorMessage('');
        lastUsedPersistQueueRef.current.enqueue(templateId);
    }, [invalidatePreparedOnCoveredEdit, quickPublishTemplates, selectRuntimeTemplate]);

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

    const buildPublishRequest = useCallback((
        draftToPublish: QuickPublishRuntimeDraft,
        publishId: string,
    ): PublishRequestPayload | null => {
        if (!activeTemplate) return null;
        const publishTemplatePayload: LegacyPublishTemplatePayload = buildLegacyPublishTemplatePayload(draftToPublish, activeTemplate);
        const selectedSiteKeys = quickPublishSiteKeys.filter((siteKey) => draftToPublish.sites[siteKey]);
        if (
            publishTemplatePayload.description.trim()
            && !publishTemplatePayload.description_html.trim()
            && selectedSiteKeys.some((siteKey) => isHtmlPreferredSite(siteKey))
        ) {
            publishTemplatePayload.description_html = renderMarkdownToHtml(publishTemplatePayload.description);
        }
        return {
            publish_id: publishId,
            torrent_path: draftToPublish.torrent_path,
            profile_name: draftToPublish.profile,
            template: publishTemplatePayload,
        };
    }, [activeTemplate]);

    const startPublish = async (autoOpenConsole: boolean) => {
        if (!activeTemplate) return;

        // Publish only the exact prepared request. Never rebuild a mutable draft after confirm.
        const frozenPlan = frozenPlanRef.current;
        if (
            !frozenPlan
            || !frozenPlan.token
            || frozenPlan.token !== preflight.state.token
            || !preflight.canConfirm
        ) {
            preflight.invalidate();
            frozenPlanRef.current = null;
            setErrorMessage('确认内容已变化或未完成发布前检查，请重新执行发布前检查。');
            setShowConfirm(false);
            setConfirmDraft(null);
            return;
        }

        const publishRequest = frozenPlan.request;
        const publishId = publishRequest.publish_id;
        const selectedSiteKeys = quickPublishSiteKeys.filter((siteKey) => publishRequest.template.sites[siteKey]);
        const selectedSites = selectedSiteKeys.map((siteKey) => ({
            key: siteKey,
            label: quickPublishSiteLabels[siteKey],
        }));

        const contentValidationIssues = validatePublishContentForSites(
            publishRequest.template,
            selectedSites,
        );
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

        const nextPublishSites = createPublishConsoleSiteMap(
            selectedSiteKeys.map((siteKey) => ({
                siteCode: siteKey,
                siteLabel: quickPublishSiteLabels[siteKey],
                lines: [],
                status: 'idle' as const,
                message: '等待发布...',
            })),
        );

        const historyDraft = confirmDraft ?? draft;
        publishAttemptRef.current = {
            publishId,
            templateId: activeTemplate.id,
            publishedAt: new Date().toISOString(),
            publishedEpisode: historyDraft.episode,
            publishedResolution: historyDraft.resolution,
            siteKeys: selectedSiteKeys,
        };

        // Close confirmation only after freezing history metadata for this attempt.
        setShowConfirm(false);
        setConfirmDraft(null);

        if (autoOpenConsole) {
            setShowConsole(true);
        }
        startPublishTask(publishId, nextPublishSites);
        setStatusMessage('');
        setErrorMessage('');

        const tokenToPublish = frozenPlan.token;
        frozenPlanRef.current = null;
        try {
            // Pending formal audit + pending ack: cancel the job before publishing the frozen plan.
            // Late completion must not replace UI or bind a consumed/cancelled plan.
            await preflight.cancelPendingAuditForPublish();
            await publishPreparedPlan(tokenToPublish);
            preflight.invalidate();
        } catch (error) {
            const message = readFriendlyError(error, '启动发布失败。');
            setErrorMessage(message);
            failActivePublish(message);
            preflight.invalidate();
        }
    };

    const handlePublishClick = async () => {
        const error = validateBeforePublish();
        if (error) {
            setErrorMessage(error);
            return;
        }
        const template = activeTemplate;
        if (!template) {
            // Keep the template reference stable across the async prepare sequence.
            setErrorMessage('请先选择一个快速发布模板。');
            return;
        }
        // Reject re-entry while resolve/prepare is in flight (HomePage parity).
        // Check the ref as well so a same-tick second click cannot pass before re-render.
        if (isPublishing || isPreparingPublish || isPreparingPublishRef.current) return;
        setErrorMessage('');
        setStatusMessage('');

        // Capture covered-edit generation before any async resolve/prepare work.
        const prepareGeneration = coveredEditGenerationRef.current;
        isPreparingPublishRef.current = true;
        setIsPreparingPublish(true);
        try {
            const resolvedDraft = await resolvePublishRuntimeDraft(template, draft);
            if (prepareGeneration !== coveredEditGenerationRef.current) {
                // Covered edit during resolve superseded this attempt; never open stale confirm.
                return;
            }
            // Deterministic history reparse (HomePage parity): never let leftover draft chips from a
            // prior AI adopt survive into confirm after re-recognize cleared page-side adopts.
            // Explicit adopt / confirm manual-edit provenance still wins via adoptedHistory.
            const publishDetails = await resolvePublishTitleMetadata({
                finalTitle: resolvedDraft.title,
                fallbackFilename: torrentInfo?.name,
                template,
                parseTitleDetails: (request) =>
                    invoke<ParsedTitleDetails>('parse_title_details', {
                        filename: request.filename,
                        epPattern: request.epPattern,
                        resolutionPattern: request.resolutionPattern,
                        titlePattern: request.titlePattern,
                    }),
            });
            if (prepareGeneration !== coveredEditGenerationRef.current) {
                return;
            }
            // Prefer latest page-side adopts only (ref may advance if adopt lands during awaits).
            // Do not restore a start-of-prepare snapshot: mid-prepare re-recognize clears
            // adoptedHistory and must not re-seed the old adopt into live draft chips.
            const latestAdopts = adoptedHistoryRef.current;
            const nextConfirmDraft = {
                ...resolvedDraft,
                episode: latestAdopts.episode.trim() || publishDetails.episode,
                resolution: latestAdopts.resolution.trim() || publishDetails.resolution,
            };
            // Sync live chips after title-metadata parse while this prepare generation is still
            // valid: current explicit adopts win when present; otherwise deterministic reparse.
            // Never leave stale pre-clear adopt values on the live draft when adopts were cleared.
            setDraft((current) => ({
                ...current,
                episode: latestAdopts.episode.trim() || publishDetails.episode,
                resolution: latestAdopts.resolution.trim() || publishDetails.resolution,
            }));
            const request = buildPublishRequest(nextConfirmDraft, createPublishId());
            if (!request) return;
            const contentValidationIssues = validatePublishContentForSites(
                request.template,
                quickPublishSiteKeys
                    .filter((siteKey) => request.template.sites[siteKey])
                    .map((siteKey) => ({ key: siteKey, label: quickPublishSiteLabels[siteKey] })),
            );
            if (contentValidationIssues.length > 0) {
                setErrorMessage(contentValidationIssues.map((issue) => issue.message).join('；'));
                return;
            }
            const prepared = await preflight.prepare(request);
            if (prepareGeneration !== coveredEditGenerationRef.current) {
                // Covered edit during prepare: drop any token that may have been committed.
                clearFrozenPreflight();
                return;
            }
            // Re-read adopts after prepare awaits so mid-flight adopts still win over reparse.
            // A re-recognize after the post-parse live sync may have cleared page-side adopts
            // without bumping covered-edit generation — confirm + live chips must both follow
            // current adopts (or deterministic reparse), never the pre-clear AI adopt snapshot.
            const finalAdopts = adoptedHistoryRef.current;
            const finalEpisode = finalAdopts.episode.trim() || publishDetails.episode;
            const finalResolution = finalAdopts.resolution.trim() || publishDetails.resolution;
            const finalConfirmDraft = {
                ...nextConfirmDraft,
                episode: finalEpisode,
                resolution: finalResolution,
            };
            setDraft((current) => ({
                ...current,
                episode: finalEpisode,
                resolution: finalResolution,
            }));
            frozenPlanRef.current = { token: prepared.token, request };
            setConfirmDraft(finalConfirmDraft);
            setShowConfirm(true);
        } catch (error) {
            if (isPrepareSupersededError(error)) {
                return;
            }
            setErrorMessage(readFriendlyError(error, '无法准备发布前检查。'));
            setConfirmDraft(null);
            setShowConfirm(false);
            frozenPlanRef.current = null;
        } finally {
            isPreparingPublishRef.current = false;
            setIsPreparingPublish(false);
        }
    };

    const handleCloseConfirm = () => {
        clearFrozenPreflight();
    };

    const handleReturnToEdit = () => {
        if (confirmDraft) {
            // History-only episode/resolution return is not a covered identity mutation.
            setDraft((current) => ({
                ...current,
                episode: confirmDraft.episode,
                resolution: confirmDraft.resolution,
            }));
        }
        clearFrozenPreflight();
    };

    const updateConfirmDraftMetadata = useCallback(
        (field: 'episode' | 'resolution', value: string) => {
            // History-only confirm metadata: keep frozen token valid (HomePage parity).
            // Episode/resolution are local publish-history fields, not covered plan identity.
            // Manual edit is explicit provenance — never auto-filled from recognition.
            recognition.markFieldManualEdit(field);
            setConfirmDraft((current) => (current ? { ...current, [field]: value } : current));
            setAdoptedHistory((current) => {
                const next = { ...current, [field]: value };
                adoptedHistoryRef.current = next;
                return next;
            });
        },
        [recognition],
    );

    const publishPreviewDraft = confirmDraft ?? draft;

    const recognitionPatternsActive = Boolean(
        activeTemplate
        && activeTemplate.ep_pattern.trim()
        && activeTemplate.resolution_pattern.trim()
        && activeTemplate.title_pattern.trim(),
    );
    const recognitionDraftIdentity = useMemo(() => {
        if (!activeTemplate || !torrentInfo?.name?.trim() || !recognitionPatternsActive) {
            return '';
        }
        return buildRecognitionDraftIdentity({
            torrentName: torrentInfo.name,
            epPattern: activeTemplate.ep_pattern,
            resolutionPattern: activeTemplate.resolution_pattern,
            titlePattern: activeTemplate.title_pattern,
        });
    }, [
        activeTemplate,
        recognitionPatternsActive,
        torrentInfo?.name,
    ]);
    // Drop recognition when torrent/template draft identity drifts; also drop page-side adopts.
    const previousRecognitionIdentityRef = useRef(recognitionDraftIdentity);
    useEffect(() => {
        const previous = previousRecognitionIdentityRef.current;
        previousRecognitionIdentityRef.current = recognitionDraftIdentity;
        if (previous && previous !== recognitionDraftIdentity) {
            clearAdoptedHistory();
        }
        invalidateRecognitionIfDraftMismatch(recognitionDraftIdentity || null);
    }, [clearAdoptedHistory, invalidateRecognitionIfDraftMismatch, recognitionDraftIdentity]);
    const recognitionReady = isAiCapabilityReady(preflight.state.settings);
    const canRunRecognition = Boolean(
        torrentInfo?.name?.trim()
        && recognitionDraftIdentity
        && recognitionReady
        && recognitionPatternsActive
        && !recognition.busy,
    );
    // canAdopt = candidate present for explicit user action; never auto-fills; manual may re-adopt.
    const canAdoptEpisode = Boolean(
        !recognition.busy
        && recognition.result
        && recognition.result.episode?.value?.trim(),
    );
    const canAdoptResolution = Boolean(
        !recognition.busy
        && recognition.result
        && recognition.result.resolution?.value?.trim(),
    );

    const handleAiRecognize = useCallback(() => {
        if (!activeTemplate || !torrentInfo?.name?.trim() || !recognitionDraftIdentity) {
            return;
        }
        // New recognition request: clear page-side adopts so prior adopt cannot outlive this run.
        // Also clear live draft chips only when they still match those adopts (AI-adopt provenance).
        // Unrelated user/manual values that differ from the dropped adopts are left alone.
        const adoptsBeingCleared = adoptedHistoryRef.current;
        clearAdoptedHistory();
        const clearedEpisode = adoptsBeingCleared.episode.trim();
        const clearedResolution = adoptsBeingCleared.resolution.trim();
        if (clearedEpisode || clearedResolution) {
            setDraft((current) => {
                let changed = false;
                const next = { ...current };
                if (clearedEpisode && current.episode === adoptsBeingCleared.episode) {
                    next.episode = '';
                    changed = true;
                }
                if (clearedResolution && current.resolution === adoptsBeingCleared.resolution) {
                    next.resolution = '';
                    changed = true;
                }
                return changed ? next : current;
            });
        }
        void recognition.recognize({
            torrentName: torrentInfo.name,
            epPattern: activeTemplate.ep_pattern,
            resolutionPattern: activeTemplate.resolution_pattern,
            titlePattern: activeTemplate.title_pattern,
            draftIdentity: recognitionDraftIdentity,
        });
    }, [activeTemplate, clearAdoptedHistory, recognition, recognitionDraftIdentity, setDraft, torrentInfo?.name]);

    const handleAdoptRecognitionField = useCallback((field: 'episode' | 'resolution') => {
        const value = recognition.adoptField(field);
        if (value == null) {
            return;
        }
        // Episode/resolution are history metadata, not covered plan identity — do not clear recognition.
        setAdoptedHistory((current) => {
            const next = { ...current, [field]: value };
            adoptedHistoryRef.current = next;
            return next;
        });
        setDraft((current) => ({ ...current, [field]: value }));
        if (confirmDraft) {
            setConfirmDraft((current) => (current ? { ...current, [field]: value } : current));
        }
    }, [confirmDraft, recognition, setDraft]);

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
                        onClick={resetToTemplateDefaultsCovered}
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
                                    void selectTorrentFileCovered();
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
                        {torrentInfo?.compat_notice ? (
                            <WarningBanner className="mt-4">{torrentInfo.compat_notice}</WarningBanner>
                        ) : null}
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
                                    onChange={(event) =>
                                        updateDraftCovered((current) => ({
                                            ...current,
                                            profile: event.target.value,
                                        }))
                                    }
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
                                    onChange={(event) =>
                                        updateDraftCovered((current) => ({
                                            ...current,
                                            poster: event.target.value,
                                        }))
                                    }
                                    placeholder="海报图片 URL"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">About</span>
                                <input
                                    type="text"
                                    value={draft.about}
                                    onChange={(event) =>
                                        updateDraftCovered((current) => ({
                                            ...current,
                                            about: event.target.value,
                                        }))
                                    }
                                    placeholder="发布说明"
                                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 xl:flex-1"
                                />
                            </label>

                            <label className="block text-sm text-slate-300 xl:flex xl:h-full xl:flex-col">
                                <span className="mb-2 block font-mono text-[11px] tracking-[0.08em] uppercase text-slate-500">Tags</span>
                                <input
                                    type="text"
                                    value={draft.tags}
                                    onChange={(event) =>
                                        updateDraftCovered((current) => ({
                                            ...current,
                                            tags: event.target.value,
                                        }))
                                    }
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
                                    void generateTitleCovered();
                                }}
                                disabled={!activeTemplate || !torrentInfo?.name || isGeneratingTitle}
                                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isGeneratingTitle ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                重新生成标题
                            </button>
                            <button
                                type="button"
                                data-testid="ai-recognize-button"
                                onClick={handleAiRecognize}
                                disabled={!canRunRecognition}
                                title={
                                    !torrentInfo?.name?.trim()
                                        ? '需要种子显示名称'
                                        : !recognitionReady
                                          ? '需要 AI 能力状态为 Ready'
                                          : !recognitionPatternsActive
                                            ? '需要有效的集数/分辨率/标题模板模式'
                                            : '对当前种子与模板模式运行 AI 识别（仅建议，不自动写入）'
                                }
                                className="inline-flex items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-sm text-violet-100 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {recognition.busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                                AI 识别
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
                                updateDraftCovered((current) => ({
                                    ...current,
                                    title: event.target.value,
                                    is_title_overridden: true,
                                }))
                            }
                            placeholder="最终发布标题"
                            className="w-full resize-y rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                    </label>

                    <AiRecognitionPanel
                        busy={recognition.busy}
                        error={recognition.error}
                        result={recognition.result}
                        onAdoptEpisode={() => handleAdoptRecognitionField('episode')}
                        onAdoptResolution={() => handleAdoptRecognitionField('resolution')}
                        episodeAdopted={recognition.adopted.episode}
                        resolutionAdopted={recognition.adopted.resolution}
                        canAdoptEpisode={canAdoptEpisode}
                        canAdoptResolution={canAdoptResolution}
                    />
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
                                onChange={(event) =>
                                    switchRuntimeContentTemplateCovered(event.target.value)
                                }
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
                                updateDraftCovered((current) => ({
                                    ...current,
                                    markdown,
                                    is_content_overridden: true,
                                }))
                            }
                            onHtmlChange={(html) =>
                                updateDraftCovered((current) => ({
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
                                                        updateDraftCovered((current) => ({
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
                                                {formatTemplateTimestamp(activeTemplate?.publish_history[site.key as keyof SiteSelection].last_published_at ?? '')}
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
                        onClick={() => void selectOkpExecutableCovered()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
                    >
                        <FolderOpen size={14} />
                        选择 OKP
                    </button>
                    <button
                        type="button"
                        onClick={() => void clearOkpExecutablePathCovered()}
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
                        disabled={isPublishing || isPreparingPublish || !activeTemplate}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isPreparingPublish || isPublishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
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
                onReturnToEdit={handleReturnToEdit}
                onConfirm={({ autoOpenConsole }) => {
                    void startPublish(autoOpenConsole);
                }}
                title={publishPreviewDraft.title}
                templateLabel={activeTemplate ? (activeTemplate.name || activeTemplate.id) : ''}
                templateLatestPublishedAtLabel={
                    activeTemplate ? formatTemplateTimestamp(getLatestPublishedAt(activeTemplate)) : '未发布'
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
                preflight={(
                    <AiPreflightPanel
                        state={preflight.state}
                        configured={preflight.isConfigured}
                        canConfirm={preflight.canConfirm}
                        onAcknowledgementChange={preflight.setAcknowledgement}
                        onToggleVisionSelection={preflight.toggleVisionSelection}
                        onConfirmVisionSelection={() => { void preflight.confirmVisionSelection(); }}
                    />
                )}
                confirmDisabled={isPublishing || isPreparingPublish || !preflight.canConfirm}
            />
        </div>
    );
}
