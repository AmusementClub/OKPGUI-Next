import { Home, UserCircle, Settings } from 'lucide-react';

export type Page = 'home' | 'identity' | 'misc';

interface SidebarProps {
    activePage: Page;
    onPageChange: (page: Page) => void;
}

const navItems: { key: Page; label: string; icon: typeof Home }[] = [
    { key: 'home', label: '主页', icon: Home },
    { key: 'identity', label: '身份管理器', icon: UserCircle },
    { key: 'misc', label: '杂项', icon: Settings },
];

export default function Sidebar({ activePage, onPageChange }: SidebarProps) {
    return (
        <aside className="w-56 bg-slate-800 border-r border-slate-700 flex flex-col shrink-0">
            {/* App Title */}
            <div className="px-4 py-5 border-b border-slate-700">
                <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                    OKPGUI Next
                </h1>
                <p className="text-xs text-slate-500 mt-1">一键发布工具</p>
            </div>

            {/* Navigation */}
            <nav className="flex-1 py-3">
                {navItems.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => onPageChange(key)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                            activePage === key
                                ? 'bg-slate-700/60 text-emerald-400 border-r-2 border-emerald-400'
                                : 'text-slate-400 hover:bg-slate-700/30 hover:text-slate-200'
                        }`}
                    >
                        <Icon size={18} />
                        <span>{label}</span>
                    </button>
                ))}
            </nav>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-slate-700">
                <p className="text-xs text-slate-600">v0.1.0 Phase 1</p>
            </div>
        </aside>
    );
}
