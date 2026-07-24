import { expect, it, vi } from 'vitest';
import { renderElement } from '../test-utils/react';
import TemplateSelect from './TemplateSelect';

it('truncates a long selected name without overlaying the publish time', async () => {
    const longName = '20 Seiki Denki Mokuroku'.repeat(4);
    const rendered = await renderElement(
        <TemplateSelect
            options={[
                {
                    name: longName,
                    label: longName,
                    latestPublishedAtLabel: '2026-07-24 20:45',
                },
            ]}
            value={longName}
            onChange={vi.fn()}
        />,
    );

    try {
        const selectInput = rendered.container.querySelector<HTMLInputElement>(
            'input[aria-label="选择模板"]',
        );
        const publishedAt = rendered.container.querySelector<HTMLElement>(
            '[aria-label="上次发布时间"]',
        );

        expect(selectInput?.value).toBe(longName);
        expect(selectInput?.className).toContain('min-w-0');
        expect(selectInput?.className).toContain('flex-1');
        expect(selectInput?.className).toContain('truncate');
        expect(publishedAt?.className).toContain('shrink-0');
        expect(publishedAt?.className).not.toContain('absolute');
    } finally {
        await rendered.unmount();
    }
});
