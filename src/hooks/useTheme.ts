import { useSyncExternalStore } from 'react';
import { getThemePreference, type ThemePreference } from '../utils/appPreferences';
import {
    getResolvedTheme,
    setThemePreference,
    subscribeTheme,
    type ResolvedTheme,
} from '../utils/theme';

export function useTheme(): {
    preference: ThemePreference;
    resolvedTheme: ResolvedTheme;
    setPreference: (preference: ThemePreference) => void;
} {
    const preference = useSyncExternalStore(subscribeTheme, getThemePreference);
    const resolvedTheme = useSyncExternalStore(subscribeTheme, getResolvedTheme);
    return { preference, resolvedTheme, setPreference: setThemePreference };
}
