import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ExternalLink, FolderSearch, Globe, Info, X } from 'lucide-react';
import { useAppVersion } from '../utils/appVersion';
import { getStartupPagePreference, setStartupPagePreference, type StartupPage } from '../utils/appPreferences';

interface ProxyConfig {
    proxy_type: string;
    proxy_host: string;
}

export default function MiscPage() {
    const [proxyType, setProxyType] = useState('none');
    const [proxyHost, setProxyHost] = useState('');
    const [saved, setSaved] = useState(false);
    const [startupPage, setStartupPage] = useState<StartupPage>(() => getStartupPagePreference());
    const [startupPageSaved, setStartupPageSaved] = useState(false);
    const [defaultMediaFolder, setDefaultMediaFolder] = useState('');
    const [mediaFolderStatus, setMediaFolderStatus] = useState('');
    const appVersion = useAppVersion();

    useEffect(() => {
        void loadProxy();
        void loadDefaultMediaFolder();
    }, []);

    const loadProxy = async () => {
        try {
            const proxy = await invoke<ProxyConfig>('get_proxy');
            setProxyType(proxy.proxy_type);
            setProxyHost(proxy.proxy_host);
        } catch (e) {
            console.error('加载代理设置失败:', e);
        }
    };

    const loadDefaultMediaFolder = async () => {
        try {
            const config = await invoke<{ default_media_search_folder?: string }>('get_config');
            setDefaultMediaFolder(config.default_media_search_folder ?? '');
        } catch (e) {
            console.error('加载默认媒体目录失败:', e);
        }
    };

    const persistDefaultMediaFolder = async (path: string) => {
        try {
            const savedPath = await invoke<string>('save_default_media_search_folder', { path });
            setDefaultMediaFolder(savedPath);
            setMediaFolderStatus(savedPath ? '默认媒体目录已保存。' : '已关闭拖入种子后的自动 MediaInfo 检查。');
        } catch (e) {
            console.error('保存默认媒体目录失败:', e);
            setMediaFolderStatus(typeof e === 'string' ? e : '保存默认媒体目录失败。');
        }
    };

    const chooseDefaultMediaFolder = async () => {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === 'string') {
            await persistDefaultMediaFolder(selected);
        }
    };

    const persistProxy = async (nextProxyType: string, nextProxyHost: string) => {
        try {
            await invoke('save_proxy', {
                proxyType: nextProxyType,
                proxyHost: nextProxyHost,
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (e) {
            console.error('保存代理设置失败:', e);
        }
    };

    const autosaveProxy = (nextProxyType: string = proxyType, nextProxyHost: string = proxyHost) => {
        void persistProxy(nextProxyType, nextProxyHost);
    };

    const persistStartupPage = (nextStartupPage: StartupPage) => {
        setStartupPagePreference(nextStartupPage);
        setStartupPageSaved(true);
        window.setTimeout(() => setStartupPageSaved(false), 2000);
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-6 space-y-6">
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                        <Info size={16} />
                        启动页面
                    </h2>
                    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 space-y-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">默认打开页面</label>
                            <select
                                value={startupPage}
                                onChange={(e) => {
                                    const nextStartupPage = e.target.value as StartupPage;
                                    setStartupPage(nextStartupPage);
                                    persistStartupPage(nextStartupPage);
                                }}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <option value="home">主页</option>
                                <option value="quick_publish">模板发布主页</option>
                            </select>
                        </div>
                        <p className="text-xs text-slate-500">
                            {startupPageSaved ? '启动页面已保存，下次打开时生效。' : '选择应用启动后默认进入的页面。'}
                        </p>
                    </div>
                </section>

                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                        <FolderSearch size={16} />
                        媒体检查
                    </h2>
                    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 space-y-3">
                        <label className="text-xs text-slate-500 block">默认媒体搜索文件夹</label>
                        <div className="flex gap-2">
                            <input
                                value={defaultMediaFolder}
                                readOnly
                                placeholder="MediaInfo 将检查种子中的文件是否存在，并对比文件内容与种子标题"
                                className="min-w-0 flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200"
                            />
                            <button
                                type="button"
                                onClick={() => void chooseDefaultMediaFolder()}
                                title="选择默认媒体搜索文件夹"
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700"
                            >
                                <FolderSearch size={16} />
                            </button>
                            {defaultMediaFolder ? (
                                <button
                                    type="button"
                                    onClick={() => void persistDefaultMediaFolder('')}
                                    title="清除默认媒体搜索文件夹"
                                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700"
                                >
                                    <X size={16} />
                                </button>
                            ) : null}
                        </div>
                        <p className="text-xs text-slate-500">
                            {mediaFolderStatus || '设置后，拖入种子会在此目录中匹配媒体文件并自动运行 MediaInfo。'}
                        </p>
                    </div>
                </section>

                {/* Proxy Settings */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                        <Globe size={16} />
                        代理设置
                    </h2>
                    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 space-y-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">代理类型</label>
                            <select
                                value={proxyType}
                                onChange={(e) => {
                                    const nextProxyType = e.target.value;
                                    setProxyType(nextProxyType);
                                    autosaveProxy(nextProxyType, proxyHost);
                                }}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <option value="none">不使用代理</option>
                                <option value="http">HTTP 代理</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">代理地址</label>
                            <input
                                type="text"
                                value={proxyHost}
                                onChange={(e) => setProxyHost(e.target.value)}
                                onBlur={(e) => autosaveProxy(proxyType, e.target.value)}
                                disabled={proxyType === 'none'}
                                placeholder="如: http://127.0.0.1:7890"
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                        <p className="text-xs text-slate-500">
                            {saved ? '代理设置已自动保存。' : '代理类型修改后立即保存，代理地址在失焦后自动保存。'}
                        </p>
                    </div>
                </section>

                {/* About */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                        <Info size={16} />
                        关于
                    </h2>
                    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                        <div className="space-y-3">
                            <div>
                                <h3 className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                                    OKPGUI Next
                                </h3>
                                <p className="text-sm text-slate-400 mt-1">
                                    基于 Tauri 2 的现代化一键发布工具
                                </p>
                            </div>

                            <div className="text-sm text-slate-400 space-y-1">
                                <p>
                                    <span className="text-slate-500">版本:</span>{' '}
                                    <span className="text-slate-300">{appVersion}</span>
                                </p>
                                <p>
                                    <span className="text-slate-500">技术栈:</span>{' '}
                                    <span className="text-slate-300">
                                        Rust + React + TailwindCSS
                                    </span>
                                </p>
                                <p>
                                    <span className="text-slate-500">运行时:</span>{' '}
                                    <span className="text-slate-300">
                                        需要 OKP.Core 可执行文件或 DLL，以及 Chrome、Chromium 或 Edge
                                    </span>
                                </p>
                            </div>

                            <div className="pt-2 border-t border-slate-700">
                                <p className="text-sm text-slate-400 mb-2">支持的站点:</p>
                                <div className="grid grid-cols-3 gap-2 text-xs text-slate-400">
                                    <span className="bg-slate-900 px-2 py-1 rounded">動漫花園</span>
                                    <span className="bg-slate-900 px-2 py-1 rounded">Nyaa</span>
                                    <span className="bg-slate-900 px-2 py-1 rounded">ACG.RIP</span>
                                    <span className="bg-slate-900 px-2 py-1 rounded">萌番組</span>
                                    <span className="bg-slate-900 px-2 py-1 rounded">ACGNx Asia</span>
                                    <span className="bg-slate-900 px-2 py-1 rounded">ACGNx Global</span>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-slate-700 flex gap-3">
                                <a
                                    href="https://github.com/AmusementClub"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300"
                                >
                                    <ExternalLink size={12} />
                                    AmusementClub GitHub
                                </a>
                                <a
                                    href="https://github.com/AmusementClub/OKP"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300"
                                >
                                    <ExternalLink size={12} />
                                    OKP 项目
                                </a>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
