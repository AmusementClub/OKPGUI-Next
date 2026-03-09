import { Dialog, Transition } from '@headlessui/react';
import { Fragment, useMemo } from 'react';
import { CheckSquare, Loader2, LogIn, TriangleAlert, X } from 'lucide-react';

export interface CapturedCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    expires: number;
}

export type CookieCaptureDialogMode = 'confirm' | 'loading' | 'select' | 'error';

interface CookieCaptureDialogProps {
    isOpen: boolean;
    mode: CookieCaptureDialogMode;
    siteLabel: string;
    cookies: CapturedCookie[];
    selectedCookieKeys: string[];
    errorMessage?: string;
    isCaptureReady: boolean;
    onConfirmLogin: () => void;
    onReportFailure: () => void;
    onClose: () => void;
    onToggleAll: (checked: boolean) => void;
    onToggleCookie: (cookieKey: string) => void;
    onSubmitSelection: () => void;
}

export function getCapturedCookieKey(cookie: CapturedCookie): string {
    return [cookie.domain, cookie.path, cookie.name].join('\u0000');
}

function formatExpires(expires: number): string {
    if (!Number.isFinite(expires) || expires <= 0) {
        return '会话';
    }

    const date = new Date(expires * 1000);
    if (Number.isNaN(date.getTime())) {
        return '未知';
    }

    return date.toLocaleString('zh-CN', { hour12: false });
}

export default function CookieCaptureDialog({
    isOpen,
    mode,
    siteLabel,
    cookies,
    selectedCookieKeys,
    errorMessage,
    isCaptureReady,
    onConfirmLogin,
    onReportFailure,
    onClose,
    onToggleAll,
    onToggleCookie,
    onSubmitSelection,
}: CookieCaptureDialogProps) {
    const selectedCookieKeySet = useMemo(
        () => new Set(selectedCookieKeys),
        [selectedCookieKeys],
    );

    const isAllSelected =
        cookies.length > 0 &&
        cookies.every((cookie) => selectedCookieKeySet.has(getCapturedCookieKey(cookie)));

    const dialogOnClose = mode === 'select' || mode === 'error' ? onClose : () => {};

    return (
        <Transition appear show={isOpen} as={Fragment}>
            <Dialog as="div" className="relative z-50" onClose={dialogOnClose}>
                <Transition.Child
                    as={Fragment}
                    enter="ease-out duration-200"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-150"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/65" />
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
                            <Dialog.Panel className="w-full max-w-5xl overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
                                <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
                                    <div className="flex items-center gap-2 text-emerald-400">
                                        {mode === 'error' ? <TriangleAlert size={18} /> : <LogIn size={18} />}
                                        <Dialog.Title className="text-sm font-medium">
                                            {mode === 'select' ? '选择要保存的 Cookie' : '登录并获取 Cookie'}
                                        </Dialog.Title>
                                    </div>
                                    {(mode === 'select' || mode === 'error') && (
                                        <button
                                            onClick={onClose}
                                            className="text-slate-500 transition-colors hover:text-slate-300"
                                        >
                                            <X size={18} />
                                        </button>
                                    )}
                                </div>

                                {(mode === 'confirm' || mode === 'loading') && (
                                    <div className="space-y-5 px-6 py-6">
                                        <div className="space-y-3 text-sm text-slate-300">
                                            <p>
                                                正在从<span className="font-medium text-white">{siteLabel}</span>获取 Cookie。
                                            </p>
                                            {mode === 'confirm' ? (
                                                isCaptureReady ? (
                                                    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-3 text-slate-300">
                                                        <p>已打开临时浏览器，请在浏览器中完成登录。</p>
                                                        <p>
                                                            登录完成后，回到这里点击“登录成功”，程序会立即读取当前 Cookie 并关闭临时浏览器。
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-300">
                                                        <Loader2 size={18} className="animate-spin" />
                                                        正在启动浏览器，请稍候...
                                                    </div>
                                                )
                                            ) : (
                                                <div className="flex items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-300">
                                                    <Loader2 size={18} className="animate-spin" />
                                                    正在读取 Cookie，请稍候...
                                                </div>
                                            )}
                                        </div>

                                        {mode === 'confirm' && (
                                            <div className="flex items-center justify-end gap-3">
                                                <button
                                                    onClick={onReportFailure}
                                                    className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600"
                                                >
                                                    登录失败
                                                </button>
                                                <button
                                                    onClick={onConfirmLogin}
                                                    disabled={!isCaptureReady}
                                                    className="rounded-lg bg-emerald-500 px-4 py-2 text-sm text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    登录成功
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {mode === 'error' && (
                                    <div className="space-y-5 px-6 py-6">
                                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                                            {errorMessage || '获取 Cookie 失败，请重试。'}
                                        </div>
                                        <div className="flex justify-end">
                                            <button
                                                onClick={onClose}
                                                className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600"
                                            >
                                                关闭
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {mode === 'select' && (
                                    <div className="space-y-4 px-6 py-6">
                                        <div className="flex flex-col gap-3 text-sm text-slate-300 md:flex-row md:items-center md:justify-between">
                                            <div className="space-y-1">
                                                <p>
                                                    已捕获 <span className="font-medium text-white">{siteLabel}</span> 的 Cookie。
                                                </p>
                                                <p className="text-slate-400">
                                                    请选择要保存的条目，默认已全选，共 {cookies.length} 条。
                                                </p>
                                            </div>
                                            <label className="flex items-center gap-2 text-sm text-slate-200">
                                                <input
                                                    type="checkbox"
                                                    checked={isAllSelected}
                                                    onChange={(event) => onToggleAll(event.target.checked)}
                                                    className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                                                />
                                                全选
                                            </label>
                                        </div>

                                        {cookies.length > 0 ? (
                                            <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70">
                                                <div className="max-h-[420px] overflow-auto">
                                                    <table className="min-w-full table-fixed text-left text-xs text-slate-300">
                                                        <thead className="sticky top-0 bg-slate-900 text-slate-400">
                                                            <tr>
                                                                <th className="w-14 px-3 py-3 font-medium">选择</th>
                                                                <th className="w-40 px-3 py-3 font-medium">名称</th>
                                                                <th className="px-3 py-3 font-medium">值</th>
                                                                <th className="w-52 px-3 py-3 font-medium">域名</th>
                                                                <th className="w-48 px-3 py-3 font-medium">过期时间</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {cookies.map((cookie) => {
                                                                const cookieKey = getCapturedCookieKey(cookie);

                                                                return (
                                                                    <tr
                                                                        key={cookieKey}
                                                                        className="border-t border-slate-800 hover:bg-slate-800/80"
                                                                    >
                                                                        <td className="px-3 py-3 align-top">
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={selectedCookieKeySet.has(cookieKey)}
                                                                                onChange={() => onToggleCookie(cookieKey)}
                                                                                className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                                                                            />
                                                                        </td>
                                                                        <td className="px-3 py-3 align-top font-mono text-slate-100">
                                                                            {cookie.name}
                                                                        </td>
                                                                        <td className="px-3 py-3 align-top font-mono text-slate-300">
                                                                            <div
                                                                                className="max-w-[24rem] truncate"
                                                                                title={cookie.value || '（空值）'}
                                                                            >
                                                                                {cookie.value || '（空值）'}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-3 py-3 align-top font-mono text-slate-300">
                                                                            {cookie.domain}
                                                                        </td>
                                                                        <td className="px-3 py-3 align-top text-slate-300">
                                                                            {formatExpires(cookie.expires)}
                                                                        </td>
                                                                    </tr>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
                                                未捕获到 Cookie，请确认登录成功后重试。
                                            </div>
                                        )}

                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                                <CheckSquare size={14} />
                                                已选择 {selectedCookieKeys.length} / {cookies.length} 条
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <button
                                                    onClick={onClose}
                                                    className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600"
                                                >
                                                    取消
                                                </button>
                                                <button
                                                    onClick={onSubmitSelection}
                                                    disabled={selectedCookieKeys.length === 0}
                                                    className="rounded-lg bg-emerald-500 px-4 py-2 text-sm text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-600"
                                                >
                                                    确认保存
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </Dialog.Panel>
                        </Transition.Child>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
