import { Dialog, Transition } from '@headlessui/react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, Terminal, X } from 'lucide-react';
import { getPublishStatusBadgeClass, getPublishStatusLabel } from '../utils/siteStatus';

export interface PublishOutput {
    publish_id: string;
    site_code: string;
    site_label: string;
    line: string;
    is_stderr: boolean;
}

export interface PublishSiteComplete {
    publish_id: string;
    site_code: string;
    site_label: string;
    success: boolean;
    message: string;
}

export interface PublishComplete {
    publish_id: string;
    success: boolean;
    message: string;
}

export interface PublishConsoleSite {
    siteCode: string;
    siteLabel: string;
    lines: { text: string; isError: boolean }[];
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
}

interface ConsoleModalProps {
    isOpen: boolean;
    onClose: () => void;
    sites: PublishConsoleSite[];
    isComplete: boolean;
    result: PublishComplete | null;
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function normalizeHttpUrl(candidate: string): string | null {
    const normalized = candidate.replace(/[)\],.;!?]+$/g, '');
    try {
        return new URL(normalized).toString();
    } catch {
        return null;
    }
}

function extractPublishUrl(lines: PublishConsoleSite['lines']): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line.isError) {
            continue;
        }

        const matches = line.text.match(HTTP_URL_PATTERN);
        if (!matches || matches.length === 0) {
            continue;
        }

        for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
            const normalized = normalizeHttpUrl(matches[matchIndex]);
            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

export default function ConsoleModal({
    isOpen,
    onClose,
    sites,
    isComplete,
    result,
}: ConsoleModalProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [activeSiteCode, setActiveSiteCode] = useState('');

    const activeSite = useMemo(
        () => sites.find((site) => site.siteCode === activeSiteCode) ?? sites[0] ?? null,
        [activeSiteCode, sites],
    );
    const activePublishUrl = useMemo(() => {
        if (!activeSite || activeSite.status !== 'success') {
            return null;
        }

        return extractPublishUrl(activeSite.lines);
    }, [activeSite]);

    useEffect(() => {
        if (!sites.some((site) => site.siteCode === activeSiteCode)) {
            setActiveSiteCode(sites[0]?.siteCode ?? '');
        }
    }, [activeSiteCode, sites]);

    useEffect(() => {
        if (isOpen && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [isOpen, activeSite, isComplete]);

    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={() => {}}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-200"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-150"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/60" />
                </Transition.Child>

                <div className="fixed inset-0 overflow-y-auto">
                    <div className="flex min-h-full items-center justify-center p-4">
                        <Transition.Child
                            as={Fragment}
                            enter="ease-out duration-200"
                            enterFrom="opacity-0 scale-95"
                            enterTo="opacity-100 scale-100"
                            leave="ease-in duration-150"
                            leaveFrom="opacity-100 scale-100"
                            leaveTo="opacity-0 scale-95"
                        >
                            <Dialog.Panel className="w-full max-w-5xl rounded-xl border border-slate-700 bg-slate-800 shadow-xl">
                                <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
                                    <div className="flex items-center gap-2 text-emerald-400">
                                        <Terminal size={18} />
                                        <Dialog.Title className="text-sm font-medium">
                                            发布控制台
                                        </Dialog.Title>
                                    </div>
                                    {isComplete && (
                                        <button
                                            onClick={onClose}
                                            className="text-slate-500 hover:text-slate-300"
                                        >
                                            <X size={18} />
                                        </button>
                                    )}
                                </div>

                                <div className="border-b border-slate-700 px-4 py-3">
                                    <div className="flex flex-wrap gap-2">
                                        {sites.map((site) => {
                                            const isActive = activeSite?.siteCode === site.siteCode;
                                            return (
                                                <button
                                                    key={site.siteCode}
                                                    type="button"
                                                    onClick={() => setActiveSiteCode(site.siteCode)}
                                                    className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                                                        isActive
                                                            ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
                                                            : 'border-slate-700 bg-slate-900/70 text-slate-300 hover:bg-slate-800'
                                                    }`}
                                                >
                                                    <div className="font-medium">{site.siteLabel}</div>
                                                    <div className="mt-1 text-[11px] text-slate-400">
                                                        {site.message || getPublishStatusLabel(site.status)}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div
                                    ref={scrollRef}
                                    className="h-[28rem] overflow-y-auto bg-slate-900 p-4 font-mono text-xs leading-relaxed"
                                >
                                    {activeSite ? (
                                        <>
                                            <div className="mb-3 flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
                                                <div>
                                                    <div className="text-sm font-medium text-slate-100">
                                                        {activeSite.siteLabel}
                                                    </div>
                                                    <div className="mt-1 text-slate-400">
                                                        {activeSite.message || '等待输出...'}
                                                    </div>
                                                    {activePublishUrl ? (
                                                        <div className="mt-2 text-[11px] text-cyan-300/90">
                                                            发布地址: {activePublishUrl}
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {activePublishUrl ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                void openUrl(activePublishUrl).catch((error) => {
                                                                    console.error('打开发布页面失败:', error);
                                                                });
                                                            }}
                                                            title={`打开 ${activeSite.siteLabel} 发布页`}
                                                            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20"
                                                        >
                                                            <ExternalLink size={13} />
                                                            打开发布页
                                                        </button>
                                                    ) : null}
                                                    <span
                                                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${getPublishStatusBadgeClass(activeSite.status)}`}
                                                    >
                                                        {getPublishStatusLabel(activeSite.status)}
                                                    </span>
                                                </div>
                                            </div>
                                            {activeSite.lines.map((line, index) => (
                                                <div
                                                    key={`${activeSite.siteCode}-${index}`}
                                                    className={line.isError ? 'text-red-400' : 'text-slate-300'}
                                                >
                                                    {line.text}
                                                </div>
                                            ))}
                                            {activeSite.lines.length === 0 && (
                                                <div className="text-slate-500">当前站点还没有输出。</div>
                                            )}
                                            {activeSite.status === 'running' && (
                                                <div className="animate-pulse text-emerald-400">▋</div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="text-slate-500">尚未开始发布。</div>
                                    )}
                                </div>

                                <div className="flex items-center justify-between border-t border-slate-700 px-4 py-3">
                                    <div className="text-xs">
                                        {isComplete ? (
                                            <span className={result?.success ? 'text-emerald-400' : 'text-red-400'}>
                                                {result?.message || '完成'}
                                            </span>
                                        ) : (
                                            <span className="text-yellow-400">发布中...</span>
                                        )}
                                    </div>
                                    {isComplete && (
                                        <button
                                            onClick={onClose}
                                            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm text-white transition-colors hover:bg-emerald-600"
                                        >
                                            确定
                                        </button>
                                    )}
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
