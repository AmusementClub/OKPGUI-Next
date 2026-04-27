import { describe, expect, it } from 'vitest';
import { renderMarkdownToSafePreviewHtml } from './markdown';

function parsePreview(html: string) {
    return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('renderMarkdownToSafePreviewHtml', () => {
    it('removes event handlers while preserving inline styles', () => {
        const body = parsePreview(
            renderMarkdownToSafePreviewHtml('<img src="x" onerror="alert(1)" style="width: 120px; border-radius: 8px;">'),
        );

        const image = body.querySelector('img');

        expect(image).not.toBeNull();
        expect(image?.getAttribute('onerror')).toBeNull();
        expect(image?.style.width).toBe('120px');
        expect(image?.style.borderRadius).toBe('8px');
        expect(image?.style.maxWidth).toBe('min(100%, 1000px)');
        expect(image?.style.height).toBe('auto');
    });

    it('strips javascript links but keeps safe styling on the element', () => {
        const body = parsePreview(
            renderMarkdownToSafePreviewHtml('<a href="javascript:alert(1)" style="color: red; text-decoration: none;">click</a>'),
        );

        const link = body.querySelector('a');

        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBeNull();
        expect(link?.style.color).toBe('red');
        expect(link?.style.textDecoration).toBe('none');
    });

    it('removes dangerous container tags but keeps safe inline styles', () => {
        const body = parsePreview(
            renderMarkdownToSafePreviewHtml(
                '<style>body{display:none}</style><iframe src="https://example.com"></iframe><p style="margin: 0; color: blue;">ok</p>',
            ),
        );

        const paragraph = body.querySelector('p');

        expect(body.querySelector('style')).toBeNull();
        expect(body.querySelector('iframe')).toBeNull();
        expect(paragraph).not.toBeNull();
        expect(paragraph?.style.margin).toMatch(/^0/);
        expect(paragraph?.style.color).toBe('blue');
    });

    it('preserves regular markdown formatting in preview output', () => {
        const body = parsePreview(renderMarkdownToSafePreviewHtml('**bold** and <span style="font-weight: 600;">inline</span>'));

        expect(body.querySelector('strong')?.textContent).toBe('bold');
        expect(body.querySelector('span')?.style.fontWeight).toBe('600');
    });
});