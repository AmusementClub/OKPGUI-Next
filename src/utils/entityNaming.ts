export const ENTITY_NAME_MAX_LENGTH = 128;
export const ENTITY_ID_MAX_LENGTH = 128;

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const WINDOWS_RESERVED_FILENAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const IMPORT_CONFLICT_PREFIX = 'IMPORT_CONFLICT:';

export type ImportConflictStrategy = 'reject' | 'overwrite' | 'copy';

export function sanitizeEntityNameInput(
    value: string,
    maxLength = ENTITY_NAME_MAX_LENGTH,
): string {
    return clampCharacters(value.replace(CONTROL_CHAR_PATTERN, ''), maxLength);
}

export function trimEntityName(value: string): string {
    return value.trim();
}

export function createCopyEntityName(
    value: string,
    fallback: string,
    maxLength = ENTITY_NAME_MAX_LENGTH,
): string {
    const baseName = trimEntityName(value) || trimEntityName(fallback) || 'item';
    return buildCopyCandidate(baseName, ' 副本', maxLength);
}

export function sanitizeExportFileStem(value: string, fallback = 'export'): string {
    const sanitized = clampCharacters(
        trimEntityName(value)
            .replace(WINDOWS_RESERVED_FILENAME_PATTERN, '-')
            .replace(/[. ]+$/g, ''),
        ENTITY_NAME_MAX_LENGTH,
    ).trim();

    return sanitized || fallback;
}

export function parseImportConflictName(error: unknown): string | null {
    if (typeof error !== 'string' || !error.startsWith(IMPORT_CONFLICT_PREFIX)) {
        return null;
    }

    return error.slice(IMPORT_CONFLICT_PREFIX.length);
}

function buildCopyCandidate(baseName: string, suffix: string, maxLength: number): string {
    const suffixLength = Array.from(suffix).length;
    if (suffixLength >= maxLength) {
        return clampCharacters(suffix, maxLength);
    }

    const availableBaseLength = maxLength - suffixLength;
    const truncatedBase = clampCharacters(trimEntityName(baseName), availableBaseLength).trimEnd();

    return `${truncatedBase || 'item'}${suffix}`;
}

function clampCharacters(value: string, maxLength: number): string {
    return Array.from(value).slice(0, maxLength).join('');
}