import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

function escapeHtml(value: string) {
    return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const markdownRenderer = new MarkdownIt({
    html: true,
    breaks: true,
    highlight(code, language) {
        if (language && hljs.getLanguage(language)) {
            return `<pre class="hljs"><code>${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
        }

        return `<pre class="hljs"><code>${hljs.highlightAuto(code).value || escapeHtml(code)}</code></pre>`;
    },
    linkify: false,
    typographer: false,
});

const previewSanitizerConfig = {
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
};

function applyResponsiveImageConstraints(html: string) {
    if (typeof DOMParser === 'undefined') {
        return html;
    }

    const parser = new DOMParser();
    const document = parser.parseFromString(html, 'text/html');

    document.querySelectorAll('img').forEach((image) => {
        image.style.maxWidth = 'min(100%, 1000px)';
        image.style.height = 'auto';
    });

    return document.body.innerHTML;
}

export function renderMarkdownToHtml(markdown: string) {
    return applyResponsiveImageConstraints(markdownRenderer.render(markdown));
}

export function sanitizeHtmlForPreview(html: string) {
    return DOMPurify.sanitize(html, previewSanitizerConfig);
}

export function renderMarkdownToSafePreviewHtml(markdown: string) {
    return applyResponsiveImageConstraints(sanitizeHtmlForPreview(markdownRenderer.render(markdown)));
}