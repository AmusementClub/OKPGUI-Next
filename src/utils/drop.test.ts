import { describe, expect, it } from 'vitest';
import {
    extractDroppedFilePath,
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

    it('falls back to the undecoded path on malformed percent-escapes', () => {
        expect(normalizeDroppedFilePath('file:///home/u/100%.torrent')).toBe('/home/u/100%.torrent');
        expect(normalizeDroppedFilePath('file:///C:/a%zz.torrent')).toBe('C:/a%zz.torrent');
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
