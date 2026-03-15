import type { CapturedCookie } from '../components/CookieCaptureDialog';

export interface SiteCookieStore {
    raw_text: string;
}

export interface SiteCookies {
    dmhy: SiteCookieStore;
    nyaa: SiteCookieStore;
    acgrip: SiteCookieStore;
    bangumi: SiteCookieStore;
}

export const COOKIE_SITE_CODES = ['dmhy', 'nyaa', 'acgrip', 'bangumi'] as const;

export type CookieSiteCode = (typeof COOKIE_SITE_CODES)[number];

export interface CookiePanelSummary {
    cookieCount: number;
    earliestExpiry: number | null;
    earliestExpiryText: string;
    remainingText: string;
}

export interface ParsedCustomCookieLine {
    requestUrl: string;
    cookieHeader: string;
}

interface ParsedCookieHeader {
    domain: string;
    path: string;
    secure: boolean;
    expiresText: string;
    expiresEpochSeconds: number | null;
    name: string;
    value: string;
}

const DEFAULT_COOKIE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export const siteCookieDomains: Record<CookieSiteCode, string[]> = {
    dmhy: ['share.dmhy.org', '.dmhy.org'],
    nyaa: ['nyaa.si', '.nyaa.si'],
    acgrip: ['acg.rip', '.acg.rip'],
    bangumi: ['bangumi.moe', '.bangumi.moe'],
};

function isCookieSiteCode(siteCode: string): siteCode is CookieSiteCode {
    return COOKIE_SITE_CODES.includes(siteCode as CookieSiteCode);
}

function createSiteCookies(mapper: (siteCode: CookieSiteCode) => SiteCookieStore): SiteCookies {
    return {
        dmhy: mapper('dmhy'),
        nyaa: mapper('nyaa'),
        acgrip: mapper('acgrip'),
        bangumi: mapper('bangumi'),
    };
}

export const emptySiteCookies = (): SiteCookies => createSiteCookies(() => ({ raw_text: '' }));

export function normalizeDomain(domain: string): string {
    return domain.trim().replace(/^\./, '');
}

export function matchesSiteDomain(domain: string, candidates: string[]): boolean {
    const normalizedDomain = normalizeDomain(domain);

    return candidates.some((candidate) => {
        const normalizedCandidate = normalizeDomain(candidate);
        return (
            normalizedDomain === normalizedCandidate ||
            normalizedDomain.endsWith(`.${normalizedCandidate}`)
        );
    });
}

export function resolveCookieUserAgent(userAgent?: string | null): string {
    const trimmed = userAgent?.trim() ?? '';
    return trimmed || DEFAULT_COOKIE_USER_AGENT;
}

export function parseCustomCookieText(cookieText: string): {
    userAgent: string;
    cookieLines: ParsedCustomCookieLine[];
} {
    let userAgent = '';
    const cookieLines: ParsedCustomCookieLine[] = [];

    for (const rawLine of cookieText.split(/\r?\n/)) {
        const trimmedLine = rawLine.trim();
        if (!trimmedLine) {
            continue;
        }

        if (trimmedLine.toLowerCase().startsWith('user-agent:')) {
            const [, value = ''] = rawLine.split(/:\s*|\t/, 2);
            userAgent = value.trim();
            continue;
        }

        const parts = rawLine.split('\t');
        if (parts.length < 2) {
            continue;
        }

        const [requestUrl, ...cookieHeaderParts] = parts;
        const requestUrlText = requestUrl.trim();
        if (!/^https?:\/\//i.test(requestUrlText)) {
            continue;
        }

        const cookieHeader = cookieHeaderParts.join('\t').trim();
        if (!cookieHeader) {
            continue;
        }

        cookieLines.push({
            requestUrl: requestUrlText,
            cookieHeader,
        });
    }

    return {
        userAgent: resolveCookieUserAgent(userAgent),
        cookieLines,
    };
}

function formatHttpCookieExpiry(expiresEpochSeconds: number): string {
    if (!Number.isFinite(expiresEpochSeconds) || expiresEpochSeconds <= 0) {
        return 'Thu, 01 Jan 2099 00:00:00 GMT';
    }

    return new Date(expiresEpochSeconds * 1000).toUTCString().replace('UTC', 'GMT');
}

function getCookieLineKey(line: ParsedCustomCookieLine): string {
    const parsedHeader = parseCookieHeader(line.cookieHeader, line.requestUrl);
    return [normalizeDomain(parsedHeader.domain), parsedHeader.path, parsedHeader.name].join('\u0000');
}

function deduplicateCookieLines(lines: ParsedCustomCookieLine[]): ParsedCustomCookieLine[] {
    const seen = new Set<string>();
    const deduplicated: ParsedCustomCookieLine[] = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        const lineKey = getCookieLineKey(line);

        if (seen.has(lineKey)) {
            continue;
        }

        seen.add(lineKey);
        deduplicated.unshift(line);
    }

    return deduplicated;
}

export function parseCookieHeader(cookieHeader: string, requestUrl: string): ParsedCookieHeader {
    const parts = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean);
    const [namePart = 'invalid=', ...attributeParts] = parts;
    const [name = 'invalid', ...valueParts] = namePart.split('=');
    const value = valueParts.join('=');

    let domain = '';
    let path = '/';
    let secure = false;
    let expiresText = '';

    for (const attribute of attributeParts) {
        if (/^secure$/i.test(attribute)) {
            secure = true;
            continue;
        }

        const [key, ...attributeValueParts] = attribute.split('=');
        const attributeValue = attributeValueParts.join('=').trim();
        switch (key.trim().toLowerCase()) {
            case 'domain':
                domain = attributeValue;
                break;
            case 'path':
                path = attributeValue || '/';
                break;
            case 'expires':
                expiresText = attributeValue;
                break;
            default:
                break;
        }
    }

    if (!domain) {
        try {
            domain = new URL(requestUrl).hostname;
        } catch {
            domain = '';
        }
    }

    const expiresDate = expiresText ? new Date(expiresText) : null;
    const expiresEpochSeconds = expiresDate && !Number.isNaN(expiresDate.getTime())
        ? Math.floor(expiresDate.getTime() / 1000)
        : null;

    return {
        domain,
        path: path || '/',
        secure,
        expiresText: expiresText || 'Thu, 01 Jan 2099 00:00:00 GMT',
        expiresEpochSeconds,
        name: name.trim(),
        value,
    };
}

export function buildCookieTextFromCapturedCookies(
    userAgent: string,
    capturedCookies: CapturedCookie[],
): string {
    const cookieLines = capturedCookies.map((cookie) => ({
        requestUrl: `https://${normalizeDomain(cookie.domain)}`,
        cookieHeader: `${cookie.name}=${cookie.value}; domain=${normalizeDomain(cookie.domain)}; path=${cookie.path || '/'}; expires=${formatHttpCookieExpiry(cookie.expires)}${cookie.secure ? '; secure' : ''}`,
    }));

    return buildCustomCookieText(userAgent, cookieLines);
}

export function buildCustomCookieText(userAgent: string, cookieLines: ParsedCustomCookieLine[]): string {
    if (cookieLines.length === 0) {
        return '';
    }

    const lines = [`user-agent:\t${resolveCookieUserAgent(userAgent)}`];
    lines.push(
        ...deduplicateCookieLines(cookieLines).map((line) => `${line.requestUrl}\t${line.cookieHeader}`),
    );
    return lines.join('\n');
}

export function extractSiteCookieText(cookieText: string, siteCode: string): string {
    const { userAgent, cookieLines } = parseCustomCookieText(cookieText);
    const domains = isCookieSiteCode(siteCode) ? siteCookieDomains[siteCode] : [];
    const siteLines = cookieLines.filter((line) => {
        const parsedHeader = parseCookieHeader(line.cookieHeader, line.requestUrl);
        return matchesSiteDomain(parsedHeader.domain, domains);
    });
    return buildCustomCookieText(userAgent, siteLines);
}

export function buildSiteCookiesFromMergedCookieText(cookieText: string): SiteCookies {
    return createSiteCookies((siteCode) => ({ raw_text: extractSiteCookieText(cookieText, siteCode) }));
}

export function buildMergedCookieText(siteCookies: SiteCookies, fallbackUserAgent: string): string {
    const rawTexts = [
        siteCookies.dmhy.raw_text,
        siteCookies.nyaa.raw_text,
        siteCookies.acgrip.raw_text,
        siteCookies.bangumi.raw_text,
    ];
    const firstUserAgent = rawTexts
        .map((rawText) => parseCustomCookieText(rawText).userAgent)
        .find((value) => value.trim().length > 0);

    const userAgent = resolveCookieUserAgent(firstUserAgent || fallbackUserAgent);
    const cookieLines = rawTexts.flatMap((rawText) => parseCustomCookieText(rawText).cookieLines);
    return buildCustomCookieText(userAgent, cookieLines);
}

export function getSiteCookieText(siteCookies: SiteCookies, siteCode: string): string {
    return isCookieSiteCode(siteCode) ? siteCookies[siteCode].raw_text : '';
}

export function updateSiteCookies(siteCookies: SiteCookies, siteCode: string, rawText: string): SiteCookies {
    return isCookieSiteCode(siteCode)
        ? { ...siteCookies, [siteCode]: { raw_text: rawText } }
        : siteCookies;
}

function formatExpiryDate(epochSeconds: number | null): string {
    if (!epochSeconds || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
        return '无有效过期时间';
    }

    const date = new Date(epochSeconds * 1000);
    if (Number.isNaN(date.getTime())) {
        return '无有效过期时间';
    }

    return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDaysRemaining(epochSeconds: number | null): string {
    if (!epochSeconds || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
        return '--';
    }

    const millisecondsRemaining = epochSeconds * 1000 - Date.now();
    const totalDays = Math.max(1, Math.ceil(Math.abs(millisecondsRemaining) / 86400000));
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    const durationText = years > 0 ? `${years} 年${days > 0 ? ` ${days} 天` : ''}` : `${totalDays} 天`;

    return millisecondsRemaining >= 0 ? `剩余 ${durationText}` : `已过期 ${durationText}`;
}

export function getRemainingTextClass(earliestExpiry: number | null): string {
    if (!earliestExpiry || !Number.isFinite(earliestExpiry) || earliestExpiry <= 0) {
        return 'text-slate-500';
    }

    const millisecondsRemaining = earliestExpiry * 1000 - Date.now();
    if (millisecondsRemaining < 0) {
        return 'text-red-300';
    }

    if (millisecondsRemaining <= 7 * 86400000) {
        return 'text-yellow-300';
    }

    return 'text-emerald-300';
}

export function getCookiePanelSummary(rawText: string): CookiePanelSummary {
    const { cookieLines } = parseCustomCookieText(rawText);
    const expiryValues = cookieLines
        .map((line) => parseCookieHeader(line.cookieHeader, line.requestUrl).expiresEpochSeconds)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const earliestExpiry = expiryValues.length > 0 ? Math.min(...expiryValues) : null;

    return {
        cookieCount: cookieLines.length,
        earliestExpiry,
        earliestExpiryText: formatExpiryDate(earliestExpiry),
        remainingText: formatDaysRemaining(earliestExpiry),
    };
}