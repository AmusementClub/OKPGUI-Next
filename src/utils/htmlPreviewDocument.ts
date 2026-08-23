import { IFRAME_MONO_FONT_STACK, IFRAME_SANS_FONT_STACK } from './iframeFonts';
import type { ResolvedTheme } from './theme';

interface PreviewPalette {
    colorScheme: ResolvedTheme;
    background: string;
    text: string;
    link: string;
    border: string;
    preBackground: string;
    quoteText: string;
    emptyText: string;
}

const PREVIEW_PALETTES: Record<ResolvedTheme, PreviewPalette> = {
    dark: {
        colorScheme: 'dark',
        background: '#0f172a',
        text: '#cbd5e1',
        link: '#22d3ee',
        border: '#334155',
        preBackground: '#020617',
        quoteText: '#94a3b8',
        emptyText: '#64748b',
    },
    light: {
        colorScheme: 'light',
        background: '#ffffff',
        text: '#334155',
        link: '#0891b2',
        border: '#cbd5e1',
        preBackground: '#f1f5f9',
        quoteText: '#64748b',
        emptyText: '#94a3b8',
    },
};

export function buildHtmlPreviewDocument(html: string, theme: ResolvedTheme, emptyText: string) {
    const palette = PREVIEW_PALETTES[theme];
    const body = html.trim()
        ? html
        : `<p class="okp-html-preview-empty">${emptyText}</p>`;

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_blank" />
  <style>
    :root { color-scheme: ${palette.colorScheme}; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: ${palette.background};
      color: ${palette.text};
      font: 14px/1.7 ${IFRAME_SANS_FONT_STACK};
      word-break: break-word;
    }
    a { color: ${palette.link}; }
    img { max-width: 100%; height: auto; border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid ${palette.border}; padding: 8px 10px; }
    code, pre {
      font-family: ${IFRAME_MONO_FONT_STACK};
    }
    pre {
      overflow-x: auto;
      padding: 14px;
      border-radius: 12px;
      background: ${palette.preBackground};
    }
    blockquote {
      margin: 0 0 16px;
      padding-left: 16px;
      border-left: 4px solid rgba(16, 185, 129, 0.65);
      color: ${palette.quoteText};
    }
    .okp-html-preview-empty {
      margin: 0;
      padding: 32px 0;
      text-align: center;
      color: ${palette.emptyText};
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}
