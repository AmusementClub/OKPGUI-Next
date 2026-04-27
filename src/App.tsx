import { Transition } from '@headlessui/react';
import { ComponentType, lazy, Suspense, useEffect, useRef, useState } from 'react';
import Sidebar, { Page } from './components/Sidebar';
import { getStartupPagePreference } from './utils/appPreferences';

const HomePage = lazy(() => import('./pages/HomePage'));
const QuickPublishPage = lazy(() => import('./pages/QuickPublishPage'));
const QuickPublishTemplatesPage = lazy(() => import('./pages/QuickPublishTemplatesPage'));
const ContentTemplatesPage = lazy(() => import('./pages/ContentTemplatesPage'));
const IdentityPage = lazy(() => import('./pages/IdentityPage'));
const MiscPage = lazy(() => import('./pages/MiscPage'));

const pageComponents: Record<Page, ComponentType> = {
    home: HomePage,
    quick_publish: QuickPublishPage,
    quick_publish_templates: QuickPublishTemplatesPage,
    content_templates: ContentTemplatesPage,
    identity: IdentityPage,
    misc: MiscPage,
};

const PAGE_ENTER_TIMING = 'ease-[cubic-bezier(0.16,1,0.3,1)]';
const PAGE_LEAVE_TIMING = 'ease-[cubic-bezier(0.32,0,0.67,0)]';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'okpgui:sidebar-collapsed';

export default function App() {
    const [activePage, setActivePage] = useState<Page>(() => getStartupPagePreference());
    const [displayPage, setDisplayPage] = useState<Page>(() => getStartupPagePreference());
    const [isPageVisible, setIsPageVisible] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
        if (typeof window === 'undefined') {
            return false;
        }

        return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
    });
    const pendingPageRef = useRef<Page>(getStartupPagePreference());

    useEffect(() => {
        pendingPageRef.current = activePage;

        if (activePage === displayPage) {
            if (!isPageVisible) {
                setIsPageVisible(true);
            }
            return;
        }

        setIsPageVisible(false);
    }, [activePage, displayPage, isPageVisible]);

    useEffect(() => {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isSidebarCollapsed));
    }, [isSidebarCollapsed]);

    const ActivePage = pageComponents[displayPage];

    const handlePageAfterLeave = () => {
        const nextPage = pendingPageRef.current;

        if (nextPage !== displayPage) {
            setDisplayPage(nextPage);
        }

        setIsPageVisible(true);
    };

    return (
        <div className="h-screen flex bg-slate-900 text-slate-100">
            <Sidebar
                activePage={activePage}
                isCollapsed={isSidebarCollapsed}
                onPageChange={setActivePage}
                onToggleCollapse={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
            />
            <main className="min-w-0 flex-1 overflow-hidden">
                <Transition
                    appear
                    show={isPageVisible}
                    as="div"
                    afterLeave={handlePageAfterLeave}
                    enter={`transform-gpu transition duration-150 ${PAGE_ENTER_TIMING}`}
                    enterFrom="opacity-0 translate-y-2 scale-[0.992] blur-[2px]"
                    enterTo="opacity-100 translate-y-0 scale-100 blur-0"
                    leave={`transform-gpu transition duration-100 ${PAGE_LEAVE_TIMING}`}
                    leaveFrom="opacity-100 translate-y-0 scale-100 blur-0"
                    leaveTo="pointer-events-none opacity-0 -translate-y-1 scale-[0.996] blur-[3px]"
                    className="h-full"
                >
                    <Suspense fallback={<div className="h-full flex items-center justify-center text-slate-400">加载中...</div>}>
                        <ActivePage />
                    </Suspense>
                </Transition>
            </main>
        </div>
    );
}
