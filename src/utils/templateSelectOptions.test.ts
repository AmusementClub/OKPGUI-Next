import { describe, expect, it } from 'vitest';
import {
    buildSortedTemplateSelectOptions,
    compareByLatestPublishTime,
    getLatestPublishTimestamp,
    parsePublishTimestampMs,
} from './templateSelectOptions';

describe('templateSelectOptions', () => {
    it('parses only non-empty Date.parse-able timestamps', () => {
        expect(parsePublishTimestampMs('')).toBeNull();
        expect(parsePublishTimestampMs('   ')).toBeNull();
        expect(parsePublishTimestampMs('not-a-date')).toBeNull();
        expect(parsePublishTimestampMs('2026-07-09T20:29:00')).toEqual(
            Date.parse('2026-07-09T20:29:00'),
        );
    });

    it('takes the max valid timestamp across sites', () => {
        const latest = getLatestPublishTimestamp([
            '',
            'invalid',
            '2026-01-01T00:00:00Z',
            '2026-07-09T20:29:00Z',
            '2026-03-01T00:00:00Z',
        ]);

        expect(latest?.value).toBe('2026-07-09T20:29:00Z');
        expect(latest?.ms).toBe(Date.parse('2026-07-09T20:29:00Z'));
    });

    it('sorts published desc, unpublished/invalid last, ties by label then id', () => {
        const options = buildSortedTemplateSelectOptions([
            {
                name: 'b-id',
                label: '乙模板',
                publishTimestamps: ['2026-01-01T00:00:00Z'],
                formatPublishedAtLabel: (value) => value || '未发布',
            },
            {
                name: 'a-id',
                label: '甲模板',
                publishTimestamps: ['2026-06-01T00:00:00Z'],
                formatPublishedAtLabel: (value) => value || '未发布',
            },
            {
                name: 'z-id',
                label: '未发布模板',
                publishTimestamps: [''],
                formatPublishedAtLabel: (value) => value || '未发布',
            },
            {
                name: 'bad-id',
                label: '坏时间',
                publishTimestamps: ['not-a-date'],
                formatPublishedAtLabel: (value) => value || '未发布',
            },
            {
                name: 'a2-id',
                label: '甲模板',
                publishTimestamps: ['2026-06-01T00:00:00Z'],
                formatPublishedAtLabel: (value) => value || '未发布',
            },
        ]);

        expect(options.map((option) => option.name)).toEqual([
            'a-id',
            'a2-id',
            'b-id',
            'bad-id',
            'z-id',
        ]);
    });

    it('uses stable label then id compare for equal timestamps', () => {
        const order = compareByLatestPublishTime(
            { label: '同名', name: 'b', latestPublishMs: 10 },
            { label: '同名', name: 'a', latestPublishMs: 10 },
        );

        expect(order).toBeGreaterThan(0);
    });
});
