/**
 * Normalizes a single dropped path from a drag-drop source.
 *
 * Some platforms deliver file URIs instead of plain filesystem paths:
 * - Windows drive URIs (`file:///C:/a.torrent`) must lose the leading slash
 *   so the backend receives `C:/a.torrent`.
 * - POSIX URIs (`file:///home/u/a.torrent`) keep their leading slash.
 * Percent-escapes in file URIs are decoded; plain paths are returned as-is
 * (a literal `%` in a real path must not be decoded).
 */
export function normalizeDroppedFilePath(path: string): string {
    const trimmed = path.trim();

    if (!/^file:\/\//i.test(trimmed)) {
        return trimmed;
    }

    let normalized = trimmed.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:[\/]/.test(normalized)) {
        normalized = normalized.slice(1);
    }

    return decodeURIComponent(normalized);
}

/** Picks the first dropped path with the given extension and normalizes it. */
export function extractDroppedFilePath(
    paths: readonly string[],
    extension = '.torrent',
): string | null {
    const normalizedExtension = extension.toLowerCase();
    const match = paths.find((path) => path.toLowerCase().endsWith(normalizedExtension));
    return match ? normalizeDroppedFilePath(match) : null;
}

/**
 * Fallback for drop sources that only expose `text/uri-list` data: one URI per
 * line, `#` lines are comments. Returns the first matching normalized path.
 */
export function extractPathFromUriList(uriList: string, extension = '.torrent'): string | null {
    const paths = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

    return extractDroppedFilePath(paths, extension);
}
