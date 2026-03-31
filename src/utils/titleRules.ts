export const DEFAULT_EP_PATTERN = '(?P<ep>\\d+)';
export const DEFAULT_RESOLUTION_PATTERN = '(?P<res>1080p|720p)';
export const DEFAULT_TITLE_PATTERN = '<ep> [<res>]';

export function normalizeRuleTemplate(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }

    return value.trim() ? value : fallback;
}
