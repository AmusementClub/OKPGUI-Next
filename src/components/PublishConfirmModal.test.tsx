import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocalPublishRecordFields } from './PublishConfirmModal';

describe('LocalPublishRecordFields', () => {
    it('labels editable values as local-history-only metadata', () => {
        const html = renderToStaticMarkup(
            <LocalPublishRecordFields
                episode="02"
                resolution="1080p"
                onEpisodeChange={vi.fn()}
                onResolutionChange={vi.fn()}
            />,
        );

        expect(html).toContain('本地发布记录');
        expect(html).toContain('仅用于本地发布历史，不会修改最终标题或站点发布内容。');
        expect(html).toContain('aria-label="本地发布记录集数"');
        expect(html).toContain('value="02"');
        expect(html).toContain('aria-label="本地发布记录分辨率"');
        expect(html).toContain('value="1080p"');
    });
});
