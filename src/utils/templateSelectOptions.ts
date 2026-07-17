import type { TemplateSelectOption } from '../components/TemplateSelect';

export interface TemplateSelectSortInput {
    name: string;
    label: string;
    publishTimestamps: Iterable<string>;
    formatPublishedAtLabel: (latestPublishedAt: string) => string;
}

export function parsePublishTimestampMs(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
}

export function getLatestPublishTimestamp(
    timestamps: Iterable<string>,
): { value: string; ms: number } | null {
    let latest: { value: string; ms: number } | null = null;

    for (const timestamp of timestamps) {
        const ms = parsePublishTimestampMs(timestamp);
        if (ms === null) {
            continue;
        }

        if (latest === null || ms > latest.ms) {
            latest = { value: timestamp, ms };
        }
    }

    return latest;
}

export function compareByLatestPublishTime(
    left: { label: string; name: string; latestPublishMs: number | null },
    right: { label: string; name: string; latestPublishMs: number | null },
): number {
    if (left.latestPublishMs !== right.latestPublishMs) {
        if (left.latestPublishMs === null) {
            return 1;
        }
        if (right.latestPublishMs === null) {
            return -1;
        }
        return right.latestPublishMs - left.latestPublishMs;
    }

    const labelCompare = left.label.localeCompare(right.label, 'zh-CN');
    if (labelCompare !== 0) {
        return labelCompare;
    }

    return left.name.localeCompare(right.name, 'zh-CN');
}

export function buildSortedTemplateSelectOptions(
    inputs: TemplateSelectSortInput[],
): TemplateSelectOption[] {
    return inputs
        .map((input) => {
            const latest = getLatestPublishTimestamp(input.publishTimestamps);

            return {
                name: input.name,
                label: input.label,
                latestPublishedAtLabel: input.formatPublishedAtLabel(latest?.value ?? ''),
                latestPublishMs: latest?.ms ?? null,
            };
        })
        .sort(compareByLatestPublishTime)
        .map(({ latestPublishMs: _latestPublishMs, ...option }) => option);
}
