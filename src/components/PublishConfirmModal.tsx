import { Dialog, Transition } from '@headlessui/react';
import { ChevronLeft, FileText, Send, Terminal, User, X } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import type { SiteSelection } from '../utils/quickPublish';

export interface PublishConfirmSiteSummary {
    key: keyof SiteSelection;
    label: string;
    identityText: string;
    identityToneClass: string; // one of: 'text-emerald-300' | 'text-yellow-300' | 'text-red-300' | 'text-slate-500'
}

interface PublishConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (options: { autoOpenConsole: boolean }) => void;
    title: string;
    templateLabel: string;
    templateLatestPublishedAtLabel: string;
    torrentPath: string;
    torrentTotalSizeLabel: string;
    episode: string;
    resolution: string;
    about: string;
    tags: string;
    poster: string;
    profile: string;
    okpPath: string;
    selectedSites: PublishConfirmSiteSummary[];
}

function dotBgFromTone(toneClass: string): string {
    switch (toneClass) {
        case 'text-emerald-300':
            return 'bg-emerald-400';
        case 'text-yellow-300':
            return 'bg-yellow-400';
        case 'text-red-300':
            return 'bg-red-400';
        default:
            return 'bg-slate-500';
    }
}

function Pill({ tone, children }: { tone: 'success' | 'outline'; children: React.ReactNode }) {
    const cls =
        tone === 'success'
            ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
            : 'border-slate-600 bg-transparent text-slate-300';
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone === 'outline' ? 'font-mono' : ''} ${cls}`}
        >
            {children}
        </span>
    );
}

export default function PublishConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    templateLabel,
    templateLatestPublishedAtLabel,
    torrentPath,
    torrentTotalSizeLabel,
    episode,
    resolution,
    about,
    tags,
    poster,
    profile,
    okpPath,
    selectedSites,
}: PublishConfirmModalProps) {
    const [autoOpenConsole, setAutoOpenConsole] = useState<boolean>(() => {
        const stored = localStorage.getItem('okpgui:autoOpenPublishConsole');
        return stored === null ? true : stored !== 'false';
    });
    const confirmButtonRef = useRef<HTMLButtonElement>(null);

    const torrentName = torrentPath.split(/[/\\]/).pop() ?? torrentPath;
    const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    const warnSite = selectedSites.find((s) => s.identityToneClass === 'text-yellow-300');

    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={onClose} initialFocus={confirmButtonRef}>
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
                            <Dialog.Panel className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
                                {/* Header */}
                                <div className="flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-900/70 px-[22px] py-[18px]">
                                    <div className="min-w-0">
                                        <div className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.22em] uppercase text-emerald-200/80">
                                            <Send size={11} className="text-emerald-300" />
                                            STEP 6 · 发布前确认
                                        </div>
                                        <div className="mt-1.5 flex items-baseline gap-1.5 text-xl font-semibold text-slate-100">
                                            确认发布{' '}
                                            <span className="font-mono text-emerald-300">
                                                {selectedSites.length}
                                            </span>{' '}
                                            站点
                                        </div>
                                        <div className="mt-1 text-xs text-slate-400">
                                            确认后 OKP.Core 会依次启动各站点发布。控制台会在过程中实时显示输出。
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>

                                {/* Body */}
                                <div className="flex flex-col gap-3.5 bg-slate-950/40 px-[22px] py-[18px]">
                                    {/* Hero card */}
                                    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
                                        {/* Title half */}
                                        <div className="px-[18px] py-3.5">
                                            <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                                                最终发布标题
                                            </div>
                                            <div className="mt-2 break-all font-mono text-[15px] leading-relaxed text-slate-100">
                                                {title}
                                            </div>
                                            <div className="mt-2.5 flex items-center gap-2 text-[11px] text-slate-500">
                                                <span>套用模板</span>
                                                <span className="text-sm font-medium text-slate-300">
                                                    {templateLabel}
                                                </span>
                                                <span className="text-slate-600">·</span>
                                                <span className="font-mono">
                                                    最近 {templateLatestPublishedAtLabel}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="h-px bg-slate-800" />

                                        {/* Torrent half */}
                                        <div className="flex items-start gap-3 bg-slate-900/40 px-[18px] py-3">
                                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-200">
                                                <FileText size={15} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="font-mono text-[11px] tracking-[0.16em] uppercase text-slate-500">
                                                    种子
                                                </div>
                                                <div
                                                    className="mt-0.5 break-all font-mono text-xs leading-relaxed text-slate-100"
                                                    title={torrentPath}
                                                >
                                                    {torrentName}
                                                </div>
                                            </div>
                                            <Pill tone="outline">{torrentTotalSizeLabel}</Pill>
                                            <Pill tone="success">EP {episode}</Pill>
                                            <Pill tone="success">{resolution}</Pill>
                                        </div>
                                    </div>

                                    {/* Metadata card */}
                                    <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-2.5">
                                        <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-slate-500">
                                            元数据
                                        </div>
                                        <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                                            <span className="text-slate-500">About</span>
                                            <span className="text-slate-300">{about}</span>

                                            <span className="text-slate-500">Tags</span>
                                            <span className="flex flex-wrap items-center gap-1 font-mono text-slate-300">
                                                {tagList.map((tag, i) => (
                                                    <Fragment key={i}>
                                                        <span>{tag}</span>
                                                        {i < tagList.length - 1 && (
                                                            <span className="text-slate-600">·</span>
                                                        )}
                                                    </Fragment>
                                                ))}
                                            </span>

                                            <span className="text-slate-500">Poster</span>
                                            <span
                                                className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-slate-300"
                                                title={poster}
                                            >
                                                {poster}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Sites strip */}
                                    <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-slate-500">
                                                发布去向 · {selectedSites.length}
                                            </span>
                                            <div className="flex flex-wrap gap-1.5">
                                                {selectedSites.map((site) => (
                                                    <span
                                                        key={site.key}
                                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-0.5 text-xs font-medium text-slate-100"
                                                    >
                                                        <span
                                                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotBgFromTone(site.identityToneClass)}`}
                                                        />
                                                        {site.label}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        {warnSite && (
                                            <div className="flex items-center gap-2 border-t border-dashed border-slate-700 pt-2 text-[11px] text-slate-500">
                                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-400" />
                                                <span>
                                                    <span className="font-medium text-slate-300">
                                                        {warnSite.label}
                                                    </span>{' '}
                                                    的 Cookie {warnSite.identityText} —
                                                    仍可发布，建议本次完成后重新捕获。
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Runtime footer line */}
                                    <div className="flex items-center gap-3.5 px-3 py-2 font-mono text-[11px] text-slate-500">
                                        <span className="inline-flex items-center gap-1.5">
                                            <User size={11} />
                                            身份{' '}
                                            <span className="text-slate-300">{profile}</span>
                                        </span>
                                        <span className="text-slate-600">·</span>
                                        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                                            <Terminal size={11} />
                                            OKP.Core{' '}
                                            <span
                                                className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-300"
                                                title={okpPath}
                                            >
                                                {okpPath}
                                            </span>
                                        </span>
                                    </div>
                                </div>

                                {/* Action bar */}
                                <div className="flex items-center gap-2.5 border-t border-slate-800 bg-slate-900/70 px-[22px] py-3.5">
                                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                                        <input
                                            type="checkbox"
                                            checked={autoOpenConsole}
                                            onChange={(e) => setAutoOpenConsole(e.target.checked)}
                                            className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                                        />
                                        自动打开发布控制台
                                    </label>
                                    <span className="font-mono text-[11px] text-slate-600">
                                        · 预计 ~12s × {selectedSites.length}
                                    </span>
                                    <div className="flex-1" />
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700"
                                    >
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700"
                                    >
                                        <ChevronLeft size={13} />
                                        返回编辑
                                    </button>
                                    <button
                                        ref={confirmButtonRef}
                                        type="button"
                                        onClick={() => {
                                            localStorage.setItem(
                                                'okpgui:autoOpenPublishConsole',
                                                String(autoOpenConsole),
                                            );
                                            onConfirm({ autoOpenConsole });
                                        }}
                                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500 px-[18px] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
                                    >
                                        <Send size={14} />
                                        确认发布
                                    </button>
                                </div>
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
