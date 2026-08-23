import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemePreference } from './appPreferences';
import { getResolvedTheme, resolveTheme, setThemePreference } from './theme';

function stubSystemTheme(prefersDark: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
    }));
}

describe('getThemePreference', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        window.localStorage.clear();
    });

    it('未设置时默认 auto', () => {
        expect(getThemePreference()).toBe('auto');
    });

    it('读取已保存的 light/dark', () => {
        window.localStorage.setItem('okpgui:theme', 'light');
        expect(getThemePreference()).toBe('light');
        window.localStorage.setItem('okpgui:theme', 'dark');
        expect(getThemePreference()).toBe('dark');
    });

    it('非法值回退为 auto', () => {
        window.localStorage.setItem('okpgui:theme', 'blue');
        expect(getThemePreference()).toBe('auto');
    });
});

describe('resolveTheme', () => {
    it('显式偏好原样返回', () => {
        expect(resolveTheme('light')).toBe('light');
        expect(resolveTheme('dark')).toBe('dark');
    });

    it('auto 跟随系统深色', () => {
        stubSystemTheme(true);
        expect(resolveTheme('auto')).toBe('dark');
    });

    it('auto 跟随系统浅色', () => {
        stubSystemTheme(false);
        expect(resolveTheme('auto')).toBe('light');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });
});

describe('setThemePreference', () => {
    beforeEach(() => {
        window.localStorage.clear();
        stubSystemTheme(false);
    });

    afterEach(() => {
        window.localStorage.clear();
        vi.unstubAllGlobals();
        delete document.documentElement.dataset.theme;
        document.documentElement.style.colorScheme = '';
    });

    it('持久化偏好并应用到 documentElement', () => {
        setThemePreference('light');
        expect(window.localStorage.getItem('okpgui:theme')).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(document.documentElement.style.colorScheme).toBe('light');
    });

    it('auto 时按系统主题应用', () => {
        setThemePreference('auto');
        expect(getResolvedTheme()).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');
    });
});
