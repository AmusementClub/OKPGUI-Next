import { describe, expect, it } from 'vitest';
import {
    ENTITY_NAME_MAX_LENGTH,
    createCopyEntityName,
    parseImportConflictName,
    sanitizeEntityNameInput,
    sanitizeExportFileStem,
} from './entityNaming';

describe('entityNaming', () => {
    it('removes control characters and enforces the 128 character limit', () => {
        const value = sanitizeEntityNameInput(`bad\n${'a'.repeat(ENTITY_NAME_MAX_LENGTH + 5)}`);

        expect(value).not.toContain('\n');
        expect(Array.from(value)).toHaveLength(ENTITY_NAME_MAX_LENGTH);
    });

    it('creates copy names without exceeding the maximum length', () => {
        const copyName = createCopyEntityName('a'.repeat(ENTITY_NAME_MAX_LENGTH), '未命名模板');

        expect(copyName.endsWith(' 副本')).toBe(true);
        expect(Array.from(copyName)).toHaveLength(ENTITY_NAME_MAX_LENGTH);
    });

    it('extracts import conflict names from backend errors', () => {
        expect(parseImportConflictName('IMPORT_CONFLICT:季度模板')).toBe('季度模板');
        expect(parseImportConflictName('普通错误')).toBeNull();
    });

    it('sanitizes export file names for Windows', () => {
        expect(sanitizeExportFileStem('季度:模板?.json', 'template')).toBe('季度-模板-.json');
    });
});