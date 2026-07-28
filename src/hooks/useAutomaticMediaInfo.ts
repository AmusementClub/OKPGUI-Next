import { useCallback, useEffect, useRef, useState } from 'react';
import {
    cancelAiJob,
    pollPlanMediaInfo,
    readFriendlyError,
    startDefaultMediaInfo,
} from '../services/ai';
import type { MediaInfoJobView } from '../types/ai';

export type AutomaticMediaInfoStatus = 'idle' | 'checking' | 'done' | 'failed';

export interface AutomaticMediaInfoState {
    status: AutomaticMediaInfoStatus;
    results: MediaInfoJobView['results'];
    message: string;
}

export interface AutomaticMediaInfoController extends AutomaticMediaInfoState {
    /** Re-run automatic MediaInfo for the current torrent + default folder. */
    retry: () => void;
}

const idleState: AutomaticMediaInfoState = {
    status: 'idle',
    results: [],
    message: '',
};

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'stale']);

/**
 * Quick Publish automatic MediaInfo lifecycle for the configured default media folder.
 *
 * Every run owns a generation, cooperative cancellation, and eventual job id.
 * Unmount or input supersession before start resolves cancels the returned job
 * once its id becomes available. Supersession during polling cancels exactly once
 * and never applies stale terminal state or errors to the page.
 */
export function useAutomaticMediaInfo(
    torrentPath: string,
    defaultMediaSearchFolder: string,
): AutomaticMediaInfoController {
    const [state, setState] = useState<AutomaticMediaInfoState>(idleState);
    const [retryNonce, setRetryNonce] = useState(0);
    const generationRef = useRef(0);

    const retry = useCallback(() => {
        setRetryNonce((value) => value + 1);
    }, []);

    useEffect(() => {
        const path = torrentPath.trim();
        const folder = defaultMediaSearchFolder.trim();
        if (!path || !folder) {
            setState(idleState);
            return;
        }

        const generation = ++generationRef.current;
        let disposed = false;
        let jobId = '';
        let cancelSent = false;

        const requestCancel = (id?: string) => {
            const target = (id ?? jobId).trim();
            if (!target || cancelSent) {
                return;
            }
            cancelSent = true;
            void cancelAiJob(target).catch(() => undefined);
        };

        setState({
            status: 'checking',
            results: [],
            message: '正在自动检查媒体信息...',
        });

        const run = async () => {
            try {
                let terminal = await startDefaultMediaInfo(path);
                jobId = terminal.job_id;
                // Unmount / supersession may have fired before start resolved — cancel once.
                if (disposed || generation !== generationRef.current) {
                    requestCancel(jobId);
                    return;
                }
                while (!terminal.state || !TERMINAL_STATES.has(terminal.state)) {
                    await new Promise((resolve) => window.setTimeout(resolve, 250));
                    if (disposed || generation !== generationRef.current) {
                        requestCancel(jobId);
                        return;
                    }
                    const polled = await pollPlanMediaInfo(jobId);
                    if (polled) {
                        terminal = polled;
                    }
                }
                if (disposed || generation !== generationRef.current) {
                    return;
                }
                const measured = terminal.results.filter((result) => result.state === 'measured').length;
                const changedDuringProbe = terminal.results.filter(
                    (result) => result.state === 'changed_during_probe',
                ).length;
                const unresolved = terminal.results.length - measured - changedDuringProbe;
                if (changedDuringProbe > 0) {
                    setState({
                        status: 'failed',
                        results: terminal.results,
                        message: `媒体文件在检查过程中发生变化（${changedDuringProbe} 个），请重试自动检查。`,
                    });
                    return;
                }
                setState({
                    status: terminal.state === 'succeeded' ? 'done' : 'failed',
                    results: terminal.results,
                    message: terminal.state === 'succeeded'
                        ? `MediaInfo 已检查 ${terminal.results.length} 个文件：${measured} 个已识别，${unresolved} 个未识别。`
                        : 'MediaInfo 自动检查未完成。',
                });
            } catch (error) {
                if (!disposed && generation === generationRef.current) {
                    setState({
                        status: 'failed',
                        results: [],
                        message: readFriendlyError(error, 'MediaInfo 自动检查失败。'),
                    });
                }
            }
        };

        void run();

        return () => {
            disposed = true;
            requestCancel();
        };
    }, [defaultMediaSearchFolder, torrentPath, retryNonce]);

    return { ...state, retry };
}
