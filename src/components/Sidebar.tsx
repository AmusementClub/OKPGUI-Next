import { Transition } from '@headlessui/react';
import { ChevronLeft, ChevronRight, Home, Settings, UserCircle } from 'lucide-react';
import { useAppVersion } from '../utils/appVersion';

export type Page = 'home' | 'identity' | 'misc';

interface SidebarProps {
    activePage: Page;
    isCollapsed: boolean;
    onPageChange: (page: Page) => void;
    onToggleCollapse: () => void;
}

const navItems: { key: Page; label: string; icon: typeof Home }[] = [
    { key: 'home', label: '主页', icon: Home },
    { key: 'identity', label: '身份管理器', icon: UserCircle },
    { key: 'misc', label: '杂项', icon: Settings },
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
            <div className={`border-b border-slate-700 ${isCollapsed ? 'px-2 py-4' : 'px-4 py-5'}`}>
                <div className={`flex items-start ${isCollapsed ? 'justify-center' : 'justify-between gap-3'}`}>
                    <div className={`min-w-0 ${isCollapsed ? 'hidden' : ''}`}>
                        <h1 className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-lg font-bold text-transparent">
                            OKPGUI Next
                        </h1>
                        <p className="mt-1 text-xs text-slate-500">一键发布工具</p>
                    </div>
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                        title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700/80 bg-slate-900/35 text-slate-400 transition-[color,background-color,border-color,transform] duration-200 ease-out hover:border-slate-600 hover:bg-slate-700/70 hover:text-slate-100"
                    >
                        <CollapseIcon size={18} />
                    </button>
                </div>
                {isCollapsed ? (
                    <div className="mt-4 flex justify-center">
                        <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-400/20 bg-slate-700/80 shadow-[0_14px_30px_rgba(15,23,42,0.35)]">
                            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-sm font-bold text-transparent">
                                OKP
                            </span>
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Navigation */}
            <nav className="flex-1 py-3">
                <div className={`space-y-1 ${isCollapsed ? 'px-2' : 'px-3'}`}>
                    {navItems.map(({ key, label, icon: Icon }) => {
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
                                <span
                                    className={`relative z-10 flex h-full items-center transition-[padding,justify-content] duration-200 ease-out ${
                                        isCollapsed ? 'justify-center px-0' : 'justify-start px-4'
                                    }`}
                                >
                                    <span
                                        className={`flex items-center justify-center transition-[width,transform,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                            isCollapsed ? 'w-11' : 'w-[18px]'
                                        } ${
                                            isActive
                                                ? isCollapsed
                                                    ? 'text-emerald-300'
                                                    : 'translate-x-0.5 text-emerald-300'
                                                : 'text-slate-500'
                                        }`}
                                    >
                                        <Icon size={18} />
                                    </span>
                                </span>
                                <Transition
                                    show={!isCollapsed}
                                    as="span"
                                    className={`pointer-events-none absolute inset-y-0 left-12 right-6 z-10 flex items-center whitespace-nowrap transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                        isActive ? 'translate-x-0.5' : ''
                                    }`}
                                    enter="transition duration-180 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                    enterFrom="opacity-0 translate-x-1"
                                    enterTo="opacity-100 translate-x-0"
                                    leave="transition duration-120 ease-[cubic-bezier(0.4,0,0.2,1)]"
                                    leaveFrom="opacity-100 translate-x-0"
                                    leaveTo="opacity-0 translate-x-1"
                                >
                                    {label}
                                </Transition>
                                <Transition
                                    show={isActive && !isCollapsed}
                                    as="span"
                                    aria-hidden="true"
                                    className="absolute right-4 top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-emerald-300"
                                    enter="transition duration-220 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                    enterFrom="scale-50 opacity-0"
                                    enterTo="scale-100 opacity-100"
                                    leave="transition duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]"
                                    leaveFrom="scale-100 opacity-100"
                                    leaveTo="scale-50 opacity-0"
                                />
                            </button>
                        );
                    })}
                </div>
            </nav>

            {/* Footer */}
            <div
                className={`border-t border-slate-700 text-xs text-slate-600 ${
                    isCollapsed ? 'px-2 py-3 text-center' : 'px-4 py-3'
                }`}
            >
                {isCollapsed ? <span title={appVersion}>Ver</span> : <p>{appVersion}</p>}
            </div>
        </aside>
    );
}
