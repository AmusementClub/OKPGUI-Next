export type StartupPage = 'home' | 'quick_publish';

const STARTUP_PAGE_STORAGE_KEY = 'okpgui:startup-page';
export function getStartupPagePreference(): StartupPage {
    if (typeof window === 'undefined') {
        return 'home';
    }

    const storedValue = window.localStorage.getItem(STARTUP_PAGE_STORAGE_KEY);

    return storedValue === 'quick_publish' ? 'quick_publish' : 'home';
}

export function setStartupPagePreference(page: StartupPage) {
    if (typeof window === 'undefined') {
        return;
    }

    window.localStorage.setItem(STARTUP_PAGE_STORAGE_KEY, page);
}

export type ThemePreference = 'auto' | 'light' | 'dark';

// 该 key 在 index.html 的预绘制脚本中有镜像（纯 JS，无法 import），修改时需同步。
export const THEME_STORAGE_KEY = 'okpgui:theme';

export function getThemePreference(): ThemePreference {
    if (typeof window === 'undefined') {
        return 'auto';
    }

    const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY);

    return storedValue === 'light' || storedValue === 'dark' ? storedValue : 'auto';
}