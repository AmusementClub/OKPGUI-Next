import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
    FolderOpen,
    Save,
    Trash2,
    Eye,
    Send,
} from 'lucide-react';
import FileTree, { FileTreeNodeData } from '../components/FileTree';
import ConsoleModal from '../components/ConsoleModal';
import MarkdownPreview from '../components/MarkdownPreview';

interface SiteSelection {
    dmhy: boolean;
    nyaa: boolean;
    acgrip: boolean;
    bangumi: boolean;
    acgnx_asia: boolean;
    acgnx_global: boolean;
}

interface Template {
    ep_pattern: string;
    title_pattern: string;
    poster: string;
    about: string;
    tags: string;
    description: string;
    profile: string;
    title: string;
    sites: SiteSelection;
}

interface TorrentInfo {
    name: string;
    total_size: number;
    file_tree: FileTreeNodeData;
}

const defaultTemplate: Template = {
    ep_pattern: '',
    title_pattern: '',
    poster: '',
    about: '',
    tags: '',
    description: '',
    profile: '',
    title: '',
    sites: {
        dmhy: false,
        nyaa: false,
        acgrip: false,
        bangumi: false,
        acgnx_asia: false,
        acgnx_global: false,
    },
};

const siteLabels: { key: keyof SiteSelection; label: string }[] = [
    { key: 'dmhy', label: '動漫花園' },
    { key: 'nyaa', label: 'Nyaa' },
    { key: 'acgrip', label: 'ACG.RIP' },
    { key: 'bangumi', label: '萌番組' },
    { key: 'acgnx_asia', label: 'ACGNx Asia' },
    { key: 'acgnx_global', label: 'ACGNx Global' },
];

export default function HomePage() {
    // Template state
    const [templateList, setTemplateList] = useState<string[]>([]);
    const [currentTemplateName, setCurrentTemplateName] = useState('');
    const [newTemplateName, setNewTemplateName] = useState('');
    const [template, setTemplate] = useState<Template>(defaultTemplate);

    // Profile state
    const [profileList, setProfileList] = useState<string[]>([]);
    const [selectedProfile, setSelectedProfile] = useState('');
    const [okpExecutablePath, setOkpExecutablePath] = useState('');

    // Torrent state
    const [torrentPath, setTorrentPath] = useState('');
    const [torrentInfo, setTorrentInfo] = useState<TorrentInfo | null>(null);

    // Modal state
    const [showConsole, setShowConsole] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isPublishing, setIsPublishing] = useState(false);

    // Load templates and profiles on mount
    useEffect(() => {
        loadTemplateList();
        loadProfileList();
        loadLastConfig();
    }, []);

    const loadTemplateList = async () => {
        try {
            const list = await invoke<string[]>('get_template_list');
            setTemplateList(list);
        } catch (e) {
            console.error('加载模板列表失败:', e);
        }
    };

    const loadProfileList = async () => {
        try {
            const list = await invoke<string[]>('get_profile_list');
            setProfileList(list);
        } catch (e) {
            console.error('加载配置列表失败:', e);
        }
    };

    const loadLastConfig = async () => {
        try {
            const config = await invoke<{
                last_used_template: string | null;
                okp_executable_path: string;
                templates: Record<string, Template>;
            }>('get_config');
            setOkpExecutablePath(config.okp_executable_path || '');
            if (config.last_used_template && config.templates[config.last_used_template]) {
                setCurrentTemplateName(config.last_used_template);
                setTemplate(config.templates[config.last_used_template]);
                setSelectedProfile(config.templates[config.last_used_template].profile || '');
            }
        } catch (e) {
            console.error('加载配置失败:', e);
        }
    };

    const loadTemplate = async (name: string) => {
        try {
            const config = await invoke<{
                templates: Record<string, Template>;
            }>('get_config');
            if (config.templates[name]) {
                setCurrentTemplateName(name);
                setTemplate(config.templates[name]);
                setSelectedProfile(config.templates[name].profile || '');
            }
        } catch (e) {
            console.error('加载模板失败:', e);
        }
    };

    const saveTemplate = async () => {
        const name = currentTemplateName || newTemplateName;
        if (!name) return;
        try {
            const t = { ...template, profile: selectedProfile };
            await invoke('save_template', { name, template: t });
            setCurrentTemplateName(name);
            setNewTemplateName('');
            await loadTemplateList();
        } catch (e) {
            console.error('保存模板失败:', e);
        }
    };

    const deleteTemplate = async () => {
        if (!currentTemplateName) return;
        try {
            await invoke('delete_template', { name: currentTemplateName });
            setCurrentTemplateName('');
            setTemplate(defaultTemplate);
            await loadTemplateList();
        } catch (e) {
            console.error('删除模板失败:', e);
        }
    };

    // Torrent file handling
    const selectTorrentFile = async () => {
        try {
            const file = await open({
                filters: [{ name: '种子文件', extensions: ['torrent'] }],
            });
            if (file) {
                await parseTorrent(file);
            }
        } catch (e) {
            console.error('选择文件失败:', e);
        }
    };

    const parseTorrent = async (path: string) => {
        try {
            const info = await invoke<TorrentInfo>('parse_torrent', { path });
            setTorrentPath(path);
            setTorrentInfo(info);
            // Auto-match title if patterns are set
            if (template.ep_pattern && template.title_pattern) {
                matchTitle(info.name);
            }
        } catch (e) {
            console.error('解析种子文件失败:', e);
        }
    };

    
    const saveOkpExecutablePath = async (path: string) => {
        try {
            await invoke('save_okp_executable_path', {
                okpExecutablePath: path,
            });
            setOkpExecutablePath(path);
        } catch (e) {
            console.error('保存 OKP 可执行文件路径失败:', e);
        }
    };

    const selectOkpExecutable = async () => {
        try {
            const file = await open({
                filters: [{ name: '可执行文件', extensions: ['exe'] }],
            });
            const selectedPath = Array.isArray(file) ? file[0] : file;
            if (selectedPath) {
                await saveOkpExecutablePath(selectedPath);
            }
        } catch (e) {
            console.error('选择 OKP 可执行文件失败:', e);
        }
    };

    const clearOkpExecutablePath = async () => {
        await saveOkpExecutablePath('');
    };

    const matchTitle = async (filename?: string) => {
        const name = filename || torrentInfo?.name;
        if (!name || !template.ep_pattern || !template.title_pattern) return;
        try {
            const title = await invoke<string>('match_title', {
                filename: name,
                epPattern: template.ep_pattern,
                titlePattern: template.title_pattern,
            });
            setTemplate((t) => ({ ...t, title }));
        } catch (e) {
            console.error('匹配标题失败:', e);
        }
    };
    // Publish
    const handlePublish = async () => {
        if (!torrentPath) return;
        if (!selectedProfile) return;
        if (!okpExecutablePath) return;
        if (isPublishing) return;
        setShowConsole(true);
        setIsPublishing(true);
        try {
            await invoke('publish', {
                request: {
                    torrent_path: torrentPath,
                    template_name: currentTemplateName,
                    profile_name: selectedProfile,
                },
            });
        } catch (e) {
            console.error('发布失败:', e);
        } finally {
            setIsPublishing(false);
        }
    };
    // Drag and drop handlers
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (file.name.endsWith('.torrent')) {
                // For Tauri, the drag-drop path can be accessed via the file
                // In practice, Tauri's own drag-drop handling may be needed
                parseTorrent(file.name);
            }
        }
    }, []);

    const updateField = (field: keyof Template, value: string) => {
        setTemplate((t) => ({ ...t, [field]: value }));
    };

    const toggleSite = (site: keyof SiteSelection) => {
        setTemplate((t) => ({
            ...t,
            sites: { ...t.sites, [site]: !t.sites[site] },
        }));
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="p-6 space-y-5">
                {/* Template Selection */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">模板管理</h2>
                    <div className="flex gap-2">
                        <select
                            value={currentTemplateName}
                            onChange={(e) => loadTemplate(e.target.value)}
                            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                            <option value="">选择模板...</option>
                            {templateList.map((name) => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </select>
                        <input
                            type="text"
                            value={newTemplateName}
                            onChange={(e) => setNewTemplateName(e.target.value)}
                            placeholder="新模板名称"
                            className="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <button
                            onClick={saveTemplate}
                            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors"
                        >
                            <Save size={14} />
                            保存
                        </button>
                        <button
                            onClick={deleteTemplate}
                            disabled={!currentTemplateName}
                            className="flex items-center gap-1.5 px-3 py-2 bg-red-600/80 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                        >
                            <Trash2 size={14} />
                            删除
                        </button>
                    </div>
                </section>

                {/* Torrent File */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">种子文件</h2>
                    <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
                            isDragging
                                ? 'border-emerald-400 bg-emerald-400/10'
                                : 'border-slate-700 hover:border-slate-600'
                        }`}
                    >
                        {torrentPath ? (
                            <div className="text-sm text-slate-300">
                                <p className="truncate">{torrentPath}</p>
                            </div>
                        ) : (
                            <p className="text-sm text-slate-500">
                                拖放种子文件到此处，或点击下方按钮选择
                            </p>
                        )}
                    </div>
                    <button
                        onClick={selectTorrentFile}
                        className="mt-2 flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
                    >
                        <FolderOpen size={14} />
                        选择种子文件
                    </button>
                    {torrentInfo && (
                        <div className="mt-2">
                            <FileTree root={torrentInfo.file_tree} totalSize={torrentInfo.total_size} />
                        </div>
                    )}
                </section>

                {/* Title Matching */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">标题匹配</h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">集数匹配正则</label>
                            <input
                                type="text"
                                value={template.ep_pattern}
                                onChange={(e) => updateField('ep_pattern', e.target.value)}
                                onBlur={() => matchTitle()}
                                placeholder="如: (?P<ep>\d+)"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">标题模板</label>
                            <input
                                type="text"
                                value={template.title_pattern}
                                onChange={(e) => updateField('title_pattern', e.target.value)}
                                onBlur={() => matchTitle()}
                                placeholder="如: [Group] Title - <ep>"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                    </div>
                    <div className="mt-2">
                        <label className="text-xs text-slate-500 mb-1 block">生成标题</label>
                        <input
                            type="text"
                            value={template.title}
                            onChange={(e) => updateField('title', e.target.value)}
                            placeholder="标题将自动生成或手动输入"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                    </div>
                </section>

                {/* Content Fields */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">发布内容</h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">海报地址</label>
                            <input
                                type="text"
                                value={template.poster}
                                onChange={(e) => updateField('poster', e.target.value)}
                                placeholder="海报图片 URL"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 mb-1 block">简介</label>
                            <input
                                type="text"
                                value={template.about}
                                onChange={(e) => updateField('about', e.target.value)}
                                placeholder="简介或联系方式"
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-1 block">标签</label>
                        <input
                            type="text"
                            value={template.tags}
                            onChange={(e) => updateField('tags', e.target.value)}
                            placeholder="以逗号分隔，如: Anime, TV, Chinese"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                    </div>
                    <div className="mt-3">
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-xs text-slate-500">描述 (Markdown)</label>
                            <button
                                onClick={() => setShowPreview(true)}
                                className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
                            >
                                <Eye size={12} />
                                预览
                            </button>
                        </div>
                        <textarea
                            value={template.description}
                            onChange={(e) => updateField('description', e.target.value)}
                            placeholder="使用 Markdown 格式编写发布描述..."
                            rows={6}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono resize-y"
                        />
                    </div>
                </section>

                {/* Identity & Site Selection */}
                <section>
                    <h2 className="text-sm font-medium text-slate-400 mb-2">发布设置</h2>
                    <div className="flex gap-3 items-end">
                        <div className="flex-1">
                            <label className="text-xs text-slate-500 mb-1 block">身份选择</label>
                            <select
                                value={selectedProfile}
                                onChange={(e) => setSelectedProfile(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <option value="">选择身份配置...</option>
                                {profileList.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-1 block">OKP 可执行文件</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={okpExecutablePath}
                                readOnly
                                placeholder="请选择 OKP.Core.exe"
                                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none"
                            />
                            <button
                                type="button"
                                onClick={selectOkpExecutable}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                            >
                                <FolderOpen size={14} />
                                浏览
                            </button>
                            <button
                                type="button"
                                onClick={clearOkpExecutablePath}
                                disabled={!okpExecutablePath}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700 text-slate-200 text-sm rounded-lg transition-colors"
                            >
                                <Trash2 size={14} />
                                清空
                            </button>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                            未选择 OKP 可执行文件时，无法点击一键发布。
                        </p>
                    </div>
                    <div className="mt-3">
                        <label className="text-xs text-slate-500 mb-2 block">站点选择</label>
                        <div className="flex flex-wrap gap-3">
                            {siteLabels.map(({ key, label }) => (
                                <label
                                    key={key}
                                    className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={template.sites[key]}
                                        onChange={() => toggleSite(key)}
                                        className="w-4 h-4 rounded bg-slate-800 border-slate-600 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>
                    </div>
                </section>

                {/* Publish Button */}
                <section>
                    <button
                        onClick={handlePublish}
                        disabled={!torrentPath || !selectedProfile || !okpExecutablePath || isPublishing}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-all shadow-lg shadow-emerald-500/20"
                    >
                        <Send size={18} />
                        一键发布！
                    </button>
                </section>
            </div>

            {/* Modals */}
            <ConsoleModal isOpen={showConsole} onClose={() => setShowConsole(false)} />
            <MarkdownPreview
                isOpen={showPreview}
                onClose={() => setShowPreview(false)}
                content={template.description}
            />
        </div>
    );
}
