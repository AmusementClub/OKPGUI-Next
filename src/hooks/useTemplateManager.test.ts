import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from '../utils/markdown';
import {
    createDefaultContentTemplate,
    createDefaultQuickPublishTemplate,
} from '../utils/quickPublish';
import { createCopyDraft } from './useTemplateManager';

describe('createCopyDraft', () => {
    it('regenerates QuickPublish HTML from copied Markdown', () => {
        const source = {
            ...createDefaultQuickPublishTemplate(),
            id: 'source-template',
            name: '源模板',
            body_markdown: '**新的正文**',
            body_html: '<p>旧的自定义 HTML</p>',
        };

        const copy = createCopyDraft(source, '未命名模板');

        expect(copy.body_markdown).toBe(source.body_markdown);
        expect(copy.body_html).toBe(renderMarkdownToHtml(source.body_markdown));
        expect(source.body_html).toBe('<p>旧的自定义 HTML</p>');
    });

    it('regenerates ContentTemplate HTML from copied Markdown', () => {
        const source = {
            ...createDefaultContentTemplate(),
            id: 'source-content',
            name: '公共正文',
            markdown: '# 新的正文',
            html: '<p>旧的自定义 HTML</p>',
        };

        const copy = createCopyDraft(source, '未命名正文模板');

        expect(copy.markdown).toBe(source.markdown);
        expect(copy.html).toBe(renderMarkdownToHtml(source.markdown));
        expect(source.html).toBe('<p>旧的自定义 HTML</p>');
    });
});
