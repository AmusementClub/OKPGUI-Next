/**
 * Stable serialization for dirty-checking template-like objects.
 * Volatile persistence metadata is zeroed so a save that only bumps
 * timestamps/revisions still compares equal to the pre-save content.
 */
export function serializeForComparison<T extends object>(template: T): string {
    return JSON.stringify({
        ...template,
        updated_at: '',
        revision: 0,
    });
}
