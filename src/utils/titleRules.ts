export const DEFAULT_EP_PATTERN = '(?P<ep>\\d{1,3}(?:[-~～]\\d{1,3})?)';
export const DEFAULT_RESOLUTION_PATTERN = '(?P<res>1080p|720p)';
export const DEFAULT_TITLE_PATTERN = '<ep> [<res>]';

/**
 * Hover help next to 集数正则 — describes default behavior, not a full regex tutorial.
 * Keep in sync with DEFAULT_EP_PATTERN + choose_episode_match semantics.
 */
export const EP_PATTERN_HELP =
    '默认识别单集与区间（01、01-12、50-80；分隔符 - ~ ～），不要求集数在 [] 内，也适用于「标题 - 01 [WebRip 1080p]」。多处数字时优先取分辨率前最近的一段（避免 S2 误识别）。紧贴在集数后的修订号（如 [02v2] 中的 v2）以及独立的修订标记（如 v2、V3）不会识别为集数，单独出现时也不会回退识别；MV03 等单词内部形式仍可识别为 03。可按发布组命名自定义正则。';

export function normalizeRuleTemplate(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }

    return value.trim() ? value : fallback;
}
