// Iframe srcdoc previews are separate documents. Bundled @fontsource @font-face
// rules and parent --font-sans / --font-mono custom properties do not cross
// into them, so iframe styles cannot use var(--font-*). These literal stacks
// give best-effort visual consistency with explicit CJK fallbacks.

export const IFRAME_SANS_FONT_STACK =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export const IFRAME_MONO_FONT_STACK =
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans SC", monospace';
