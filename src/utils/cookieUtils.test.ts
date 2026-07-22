import { describe, expect, it } from 'vitest';
import {
    buildMergedCookieText,
    emptySiteCookies,
    mergeImportedSiteCookies,
} from './cookieUtils';

const PROFILE_USER_AGENT = 'MyApp/1.0 (profile-agent)';

function siteCookiesWithDmhy(rawText: string) {
    const siteCookies = emptySiteCookies();
    siteCookies.dmhy.raw_text = rawText;
    return siteCookies;
}

describe('buildMergedCookieText user agent fallback', () => {
    it('uses the profile user agent when no site cookie carries one', () => {
        const siteCookies = siteCookiesWithDmhy(
            'https://share.dmhy.org\tsession=abc; path=/',
        );

        const merged = buildMergedCookieText(siteCookies, PROFILE_USER_AGENT);

        expect(merged).toContain(`user-agent:\t${PROFILE_USER_AGENT}`);
        expect(merged).not.toContain('Chrome/');
    });

    it('prefers the user agent stored in the cookie text over the profile one', () => {
        const siteCookies = siteCookiesWithDmhy(
            'user-agent:\tFileAgent/2.0\nhttps://share.dmhy.org\tsession=abc; path=/',
        );

        const merged = buildMergedCookieText(siteCookies, PROFILE_USER_AGENT);

        expect(merged).toContain('user-agent:\tFileAgent/2.0');
        expect(merged).not.toContain(PROFILE_USER_AGENT);
    });
});

describe('mergeImportedSiteCookies', () => {
    it('replaces sites present in the import and preserves sites absent from it', () => {
        const existing = emptySiteCookies();
        existing.dmhy.raw_text = 'user-agent:\tAgent\nhttps://share.dmhy.org\told=1; path=/';
        existing.nyaa.raw_text = 'user-agent:\tAgent\nhttps://nyaa.si\tkeep=1; path=/';
        existing.acgrip.raw_text = 'user-agent:\tAgent\nhttps://acg.rip\tkeep=2; path=/';
        existing.bangumi.raw_text = 'user-agent:\tAgent\nhttps://bangumi.moe\told=2; path=/';

        // Import only covers dmhy and bangumi; nyaa/acgrip are absent.
        const imported = emptySiteCookies();
        imported.dmhy.raw_text = 'user-agent:\tAgent\nhttps://share.dmhy.org\tnew=1; path=/';
        imported.bangumi.raw_text = 'user-agent:\tAgent\nhttps://bangumi.moe\tnew=2; path=/';

        const merged = mergeImportedSiteCookies(existing, imported);

        expect(merged.dmhy.raw_text).toBe(imported.dmhy.raw_text);
        expect(merged.bangumi.raw_text).toBe(imported.bangumi.raw_text);
        expect(merged.nyaa.raw_text).toBe(existing.nyaa.raw_text);
        expect(merged.acgrip.raw_text).toBe(existing.acgrip.raw_text);
    });

    it('ignores imported entries that are only whitespace', () => {
        const existing = emptySiteCookies();
        existing.dmhy.raw_text = 'user-agent:\tAgent\nhttps://share.dmhy.org\told=1; path=/';

        const imported = emptySiteCookies();
        imported.dmhy.raw_text = '   ';

        const merged = mergeImportedSiteCookies(existing, imported);

        expect(merged.dmhy.raw_text).toBe(existing.dmhy.raw_text);
    });
});
