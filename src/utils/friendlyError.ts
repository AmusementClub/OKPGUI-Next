/**
 * Shared user-facing error message mapping.
 *
 * Same extraction contract as `readFriendlyError` in services/ai.ts
 * (string passthrough, Error.message, else fallback), plus a conservative
 * filter that hides obviously technical English noise (Rust join/panic/IO
 * details, JS engine errors, stack frames) behind the localized fallback.
 * Curated backend copy is Chinese, so any message containing CJK passes
 * through untouched.
 */

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

const JS_ENGINE_ERROR_NAMES = new Set([
    'TypeError',
    'ReferenceError',
    'SyntaxError',
    'RangeError',
    'EvalError',
    'URIError',
]);

const TECHNICAL_ERROR_PATTERNS: RegExp[] = [
    /\bos error \d+\b/i,
    /\bJoinError\b/,
    /\bpanicked at\b/i,
    /\bstack backtrace\b/i,
    /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET)\b/,
    /^error(?:\[[^\]]*\])?:/i,
    /^\s*at\s+\S+\s+\(/m,
];

export function friendlyErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && JS_ENGINE_ERROR_NAMES.has(error.name)) {
        return fallback;
    }
    const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    const message = raw.trim();
    if (!message) {
        return fallback;
    }
    if (CJK_PATTERN.test(message)) {
        return message;
    }
    if (TECHNICAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
        return fallback;
    }
    return message;
}
