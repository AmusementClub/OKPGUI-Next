import { getThemePreference, THEME_STORAGE_KEY, type ThemePreference } from './appPreferences';

export type ResolvedTheme = 'light' | 'dark';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
let mediaQueryList: MediaQueryList | null = null;

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
    if (preference !== 'auto') {
        return preference;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return 'dark';
    }
    return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

export function getResolvedTheme(): ResolvedTheme {
    return resolveTheme(getThemePreference());
}

function applyResolvedTheme(resolved: ResolvedTheme) {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
}

function emitThemeChanged() {
    applyResolvedTheme(getResolvedTheme());
    listeners.forEach((listener) => listener());
}

function handleSystemThemeChange() {
    if (getThemePreference() === 'auto') {
        emitThemeChanged();
    }
}

export function setThemePreference(preference: ThemePreference) {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    emitThemeChanged();
}

export function subscribeTheme(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function initializeTheme() {
    applyResolvedTheme(getResolvedTheme());

    if (mediaQueryList || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return;
    }

    // 持久的系统主题监听：auto 模式下无论哪个页面处于前台都要跟随系统切换。
    mediaQueryList = window.matchMedia(MEDIA_QUERY);
    mediaQueryList.addEventListener('change', handleSystemThemeChange);
}
