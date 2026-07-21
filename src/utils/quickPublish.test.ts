import { describe, expect, it } from 'vitest';
import {
    formatTemplateTimestamp,
    getPublishedVersionLabel,
} from './quickPublish';

// K4 canonical strings: the shared formatters keep HomePage's labels
// ('不适用'/'未发布'). Changing them is a standalone product decision.
describe('shared publish formatters (K4 canonical strings)', () => {
    it('labels a missing publish timestamp as 未发布', () => {
        expect(formatTemplateTimestamp('')).toBe('未发布');
        expect(formatTemplateTimestamp('   ')).toBe('未发布');
    });

    it('labels a missing published version as 不适用', () => {
        expect(
            getPublishedVersionLabel({
                last_published_at: '',
                last_published_episode: '',
                last_published_resolution: '',
            }),
        ).toBe('不适用');
    });

    it('combines episode and resolution when both are present', () => {
        expect(
            getPublishedVersionLabel({
                last_published_at: '2026-07-01T00:00:00.000Z',
                last_published_episode: '02',
                last_published_resolution: '1080p',
            }),
        ).toBe('02 / 1080p');
    });
});
