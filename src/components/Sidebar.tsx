import { Transition } from '@headlessui/react';
import {
    ChevronLeft,
    ChevronRight,
    ClipboardList,
    FileText,
    Home,
    Send,
    Settings,
    UserCircle,
} from 'lucide-react';
import { useAppVersion } from '../utils/appVersion';

export type Page =
    | 'home'
    | 'quick_publish'
    | 'quick_publish_templates'
    | 'content_templates'
    | 'identity'
    | 'misc';

interface SidebarProps {
    activePage: Page;
    isCollapsed: boolean;
    onPageChange: (page: Page) => void;
    onToggleCollapse: () => void;
}

const navSections: { title: string; items: { key: Page; label: string; icon: typeof Home }[] }[] = [
    {
        title: '现有工作流',
        items: [{ key: 'home', label: '主页', icon: Home }],
    },
    {
        title: '快速模板发布',
        items: [
            { key: 'quick_publish', label: '模板发布', icon: Send },
            { key: 'quick_publish_templates', label: '发布模板管理', icon: ClipboardList },
            { key: 'content_templates', label: '公共正文模板管理', icon: FileText },
        ],
    },
    {
        title: '系统',
        items: [
            { key: 'identity', label: '身份管理器', icon: UserCircle },
            { key: 'misc', label: '杂项', icon: Settings },
        ],
    },
];

export default function Sidebar({
    activePage,
    isCollapsed,
    onPageChange,
    onToggleCollapse,
}: SidebarProps) {
    const appVersion = useAppVersion();
    const CollapseIcon = isCollapsed ? ChevronRight : ChevronLeft;

    return (
        <aside
            className={`flex shrink-0 flex-col border-r border-slate-700 bg-slate-800 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isCollapsed ? 'w-20' : 'w-56'
            }`}
        >
            {/* App Title */}
            <div className="border-b border-slate-700 px-4 py-4">
                <div className="relative h-14 overflow-hidden">
                    <div className="absolute inset-y-0 left-0 right-14 flex items-center overflow-hidden">
                        <div
                            className={`min-w-0 origin-left transition-[opacity,transform] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                isCollapsed
                                    ? 'pointer-events-none -translate-x-2 opacity-0'
                                    : 'translate-x-0 opacity-100'
                            }`}
                        >
                            <h1 className="truncate whitespace-nowrap bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-lg font-bold text-transparent">
                                OKPGUI Next
                            </h1>
                            <p className="mt-1 truncate whitespace-nowrap text-xs text-slate-500">一键发布工具</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                        title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                        className={`absolute top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-xl border border-slate-700/80 bg-slate-900/35 text-slate-400 transition-[color,background-color,border-color,transform,left,right] duration-200 ease-out hover:border-slate-600 hover:bg-slate-700/70 hover:text-slate-100 ${
                            isCollapsed ? 'left-1/2 -translate-x-1/2' : 'right-0'
                        }`}
                    >
                        <CollapseIcon size={18} />
                    </button>
                </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 py-3">
                <div className={`space-y-4 ${isCollapsed ? 'px-2' : 'px-3'}`}>
                    {navSections.map((section) => (
                        <div key={section.title}>
                            <div
                                className={`overflow-hidden px-3 text-[11px] uppercase tracking-[0.18em] text-slate-600 transition-[max-height,margin-bottom,opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                    isCollapsed
                                        ? 'pointer-events-none mb-0 max-h-0 translate-x-1 opacity-0'
                                        : 'mb-2 max-h-6 translate-x-0 opacity-100'
                                }`}
                            >
                                <span className="block truncate whitespace-nowrap">{section.title}</span>
                            </div>
                            <div className="space-y-1">
                                {section.items.map(({ key, label, icon: Icon }) => {
                                    const isActive = activePage === key;

                                    return (
                                        <button
                                            key={key}
                                            onClick={() => onPageChange(key)}
                                            aria-label={label}
                                            title={label}
                                            className={`relative h-11 w-full overflow-hidden rounded-xl text-sm transition-[color,transform] duration-200 ease-out ${
                                                isActive
                                                    ? 'text-emerald-100'
                                                    : 'text-slate-400 hover:text-slate-100'
                                            }`}
                                        >
                                            <Transition
                                                show={isActive}
                                                as="span"
                                                aria-hidden="true"
                                                className="absolute inset-0 rounded-xl border border-emerald-400/20 bg-slate-700/80 shadow-[0_14px_30px_rgba(15,23,42,0.35)]"
                                                enter="transition duration-220 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                                enterFrom="scale-[0.97] opacity-0"
                                                enterTo="scale-100 opacity-100"
                                                leave="transition duration-180 ease-[cubic-bezier(0.4,0,0.2,1)]"
                                                leaveFrom="scale-100 opacity-100"
                                                leaveTo="scale-[0.985] opacity-0"
                                            />
                                            <span className="relative z-10 block h-full">
                                                <span
                                                    className={`absolute top-1/2 flex h-10 w-10 items-center justify-center transition-[left,transform,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                                        isCollapsed
                                                            ? 'left-1/2 -translate-x-1/2 -translate-y-1/2'
                                                            : 'left-3.5 -translate-y-1/2'
                                                    } ${isActive ? 'text-emerald-300' : 'text-slate-500'}`}
                                                >
                                                    <span className={isActive && !isCollapsed ? 'translate-x-0.5' : ''}>
                                                        <Icon size={18} />
                                                    </span>
                                                </span>
                                            </span>
                                            <Transition
                                                show={!isCollapsed}
                                                as="span"
                                                className={`pointer-events-none absolute inset-y-0 left-[3.625rem] right-6 z-10 flex items-center overflow-hidden transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                                    isActive ? 'translate-x-0.5' : ''
                                                }`}
                                                enter="transition duration-180 delay-120 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                                enterFrom="opacity-0 translate-x-1"
                                                enterTo="opacity-100 translate-x-0"
                                                leave="transition duration-120 ease-[cubic-bezier(0.4,0,0.2,1)]"
                                                leaveFrom="opacity-100 translate-x-0"
                                                leaveTo="opacity-0 translate-x-1"
                                            >
                                                <span className="block truncate whitespace-nowrap">{label}</span>
                                            </Transition>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            </nav>

            {/* Footer */}
            <div
                className={`border-t border-slate-700 text-xs text-slate-600 ${
                    isCollapsed ? 'px-2 py-3 text-center' : 'px-4 py-3'
                }`}
            >
                {isCollapsed ? null : <p>{appVersion}</p>}
            </div>
        </aside>
    );
}
