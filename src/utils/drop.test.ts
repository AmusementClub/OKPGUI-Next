import { describe, expect, it } from 'vitest';
import {
    extractDroppedFilePath,
    extractPathFromUriList,
    normalizeDroppedFilePath,
} from './drop';

describe('normalizeDroppedFilePath', () => {
    it('strips the leading slash on Windows drive URIs', () => {
        expect(normalizeDroppedFilePath('file:///C:/a.torrent')).toBe('C:/a.torrent');
    });

    it('keeps the leading slash on POSIX URIs', () => {
        expect(normalizeDroppedFilePath('file:///home/u/a.torrent')).toBe('/home/u/a.torrent');
    });

    it('decodes percent-escapes in file URIs', () => {
        expect(normalizeDroppedFilePath('file:///C:/a%20b.torrent')).toBe('C:/a b.torrent');
    });

    it('returns plain paths untouched', () => {
        expect(normalizeDroppedFilePath('D:\\releases\\a.torrent')).toBe('D:\\releases\\a.torrent');
        expect(normalizeDroppedFilePath('/home/u/100%.torrent')).toBe('/home/u/100%.torrent');
    });
});

describe('extractDroppedFilePath', () => {
    it('picks the first torrent path and normalizes it', () => {
        expect(
            extractDroppedFilePath(['/tmp/notes.txt', 'file:///C:/a.torrent']),
        ).toBe('C:/a.torrent');
    });

    it('returns null when no path matches the extension', () => {
        expect(extractDroppedFilePath(['/tmp/notes.txt'])).toBeNull();
        expect(extractDroppedFilePath([])).toBeNull();
    });
});

describe('extractPathFromUriList', () => {
    it('extracts the path from a text/uri-list payload, skipping comments', () => {
        const uriList = '# comment\nfile:///home/u/a.torrent\r\nfile:///home/u/b.txt';

        expect(extractPathFromUriList(uriList)).toBe('/home/u/a.torrent');
    });

    it('returns null when the list has no matching entry', () => {
        expect(extractPathFromUriList('# nothing\nfile:///home/u/b.txt')).toBeNull();
    });
});
