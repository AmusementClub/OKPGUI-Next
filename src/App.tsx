import { useState } from 'react';
import Sidebar, { Page } from './components/Sidebar';
import HomePage from './pages/HomePage';
import IdentityPage from './pages/IdentityPage';
import MiscPage from './pages/MiscPage';

export default function App() {
    const [activePage, setActivePage] = useState<Page>('home');

    const renderPage = () => {
        switch (activePage) {
            case 'home':
                return <HomePage />;
            case 'identity':
                return <IdentityPage />;
            case 'misc':
                return <MiscPage />;
        }
    };

    return (
        <div className="h-screen flex bg-slate-900 text-slate-100">
            <Sidebar activePage={activePage} onPageChange={setActivePage} />
            <main className="flex-1 overflow-hidden">{renderPage()}</main>
        </div>
    );
}
