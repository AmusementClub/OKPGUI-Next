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

    try {
        return decodeURIComponent(normalized);
    } catch {
        // Malformed percent-escapes (e.g. a literal '%' in the filename) must not
        // throw inside the drop handler; fall back to the undecoded path.
        return normalized;
    }
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
