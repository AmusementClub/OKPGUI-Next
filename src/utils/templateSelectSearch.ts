import { match } from 'pinyin-pro';

export function normalizeTemplateSelectQuery(query: string): string {
    return query.trim().toLocaleLowerCase().replace(/\s+/g, '');
}

/**
 * Match template dropdown options by raw substring (label/id) or continuous
 * toneless pinyin / initials against the display label.
 * Does not re-order callers' option lists.
 */
export function matchTemplateSelectQuery(
    option: { label: string; name: string },
    query: string,
): boolean {
    const normalizedQuery = normalizeTemplateSelectQuery(query);
    if (!normalizedQuery) {
        return true;
    }

    const label = option.label ?? '';
    const name = option.name ?? '';
    const normalizedLabel = label.toLocaleLowerCase();
    const normalizedName = name.toLocaleLowerCase();

    if (normalizedLabel.includes(normalizedQuery) || normalizedName.includes(normalizedQuery)) {
        return true;
    }

    // continuous + precision start keeps non-contiguous initials from matching.
    const pinyinHit = match(label, normalizedQuery, {
        continuous: true,
        precision: 'start',
        v: true,
    });

    return pinyinHit !== null;
}
