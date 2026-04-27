import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    PublishComplete,
    PublishConsoleSite,
    PublishOutput,
    PublishSiteComplete,
} from '../components/ConsoleModal';

export interface PublishTaskSiteInput {
    siteCode: string;
    siteLabel: string;
    lines?: PublishConsoleSite['lines'];
    status?: PublishConsoleSite['status'];
    message?: string;
}

export interface PublishTaskCompletion<SiteKey extends string> {
    publishId: string;
    result: PublishComplete;
    siteSuccess: Partial<Record<SiteKey, boolean>>;
}

export function createPublishId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return `publish-${globalThis.crypto.randomUUID()}`;
    }

    return `publish-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPublishConsoleSiteMap(
    sites: PublishTaskSiteInput[],
): Record<string, PublishConsoleSite> {
    return Object.fromEntries(
        sites.map((site) => [
            site.siteCode,
            {
                siteCode: site.siteCode,
                siteLabel: site.siteLabel,
                lines: site.lines ?? [],
                status: site.status ?? 'idle',
                message: site.message ?? '',
            },
        ]),
    );
}

function buildPublishResult(
    publishId: string,
    result: Omit<PublishComplete, 'publish_id'>,
): PublishComplete {
    return {
        publish_id: publishId,
        ...result,
    };
}

export function usePublishTask<SiteKey extends string>() {
    const [isPublishing, setIsPublishing] = useState(false);
    const [publishSites, setPublishSites] = useState<Record<string, PublishConsoleSite>>({});
    const [isPublishComplete, setIsPublishComplete] = useState(false);
    const [publishResult, setPublishResult] = useState<PublishComplete | null>(null);
    const [publishCompletion, setPublishCompletion] = useState<PublishTaskCompletion<SiteKey> | null>(null);
    const activePublishIdRef = useRef('');
    const publishSiteSuccessRef = useRef<Partial<Record<SiteKey, boolean>>>({});

    useEffect(() => {
        let outputUnlisten: (() => void) | null = null;
        let siteCompleteUnlisten: (() => void) | null = null;
        let completeUnlisten: (() => void) | null = null;

        const setupListeners = async () => {
            outputUnlisten = await listen<PublishOutput>('publish-output', (event) => {
                if (!event.payload.publish_id || event.payload.publish_id !== activePublishIdRef.current) {
                    return;
                }

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
                if (!event.payload.publish_id || event.payload.publish_id !== activePublishIdRef.current) {
                    return;
                }

                publishSiteSuccessRef.current[event.payload.site_code as SiteKey] = event.payload.success;

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
                if (!event.payload.publish_id || event.payload.publish_id !== activePublishIdRef.current) {
                    return;
                }

                const publishId = event.payload.publish_id;
                const siteSuccess = { ...publishSiteSuccessRef.current };

                activePublishIdRef.current = '';
                publishSiteSuccessRef.current = {};
                setIsPublishing(false);
                setIsPublishComplete(true);
                setPublishResult(event.payload);
                setPublishCompletion({
                    publishId,
                    result: event.payload,
                    siteSuccess,
                });
            });
        };

        void setupListeners();

        return () => {
            outputUnlisten?.();
            siteCompleteUnlisten?.();
            completeUnlisten?.();
        };
    }, []);

    const startPublishTask = useCallback(
        (publishId: string, sites: Record<string, PublishConsoleSite>) => {
            activePublishIdRef.current = publishId;
            publishSiteSuccessRef.current = {};
            setPublishSites(sites);
            setPublishResult(null);
            setIsPublishComplete(false);
            setIsPublishing(true);
            setPublishCompletion(null);
        },
        [],
    );

    const showPublishResult = useCallback(
        (
            sites: Record<string, PublishConsoleSite>,
            result: Omit<PublishComplete, 'publish_id'>,
            publishId = '',
        ) => {
            activePublishIdRef.current = publishId;
            publishSiteSuccessRef.current = {};
            setPublishSites(sites);
            setPublishResult(buildPublishResult(publishId, result));
            setIsPublishComplete(true);
            setIsPublishing(false);
            setPublishCompletion(null);
        },
        [],
    );

    const failActivePublish = useCallback(
        (message: string, options?: { appendToFirstSite?: boolean }) => {
            const publishId = activePublishIdRef.current;

            activePublishIdRef.current = '';
            publishSiteSuccessRef.current = {};
            setPublishSites((current) => {
                if (!options?.appendToFirstSite || Object.keys(current).length === 0) {
                    return current;
                }

                const firstSiteCode = Object.keys(current)[0];
                const firstSite = current[firstSiteCode];

                return {
                    ...current,
                    [firstSiteCode]: {
                        ...firstSite,
                        status: 'error',
                        message,
                        lines: [...firstSite.lines, { text: message, isError: true }],
                    },
                };
            });
            setPublishResult(buildPublishResult(publishId, { success: false, message }));
            setIsPublishComplete(true);
            setIsPublishing(false);
            setPublishCompletion(null);
        },
        [],
    );

    const clearPublishCompletion = useCallback(() => {
        setPublishCompletion(null);
    }, []);

    return {
        isPublishing,
        publishSites,
        isPublishComplete,
        publishResult,
        publishCompletion,
        startPublishTask,
        showPublishResult,
        failActivePublish,
        clearPublishCompletion,
    };
}