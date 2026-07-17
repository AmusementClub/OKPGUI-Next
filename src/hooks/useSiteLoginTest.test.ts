import { describe, expect, it } from 'vitest';
import { emptySiteCookies } from '../utils/cookieUtils';
import {
    buildSiteLoginInvokeArgs,
    getSiteLoginCredentials,
    ProfileLike,
    siteDefinitions,
} from './useSiteLoginTest';

function createProfile(overrides: Partial<ProfileLike> = {}): ProfileLike {
    return {
        user_agent: '',
        site_cookies: emptySiteCookies(),
        ...overrides,
    };
}

describe('getSiteLoginCredentials', () => {
    const acgrip = siteDefinitions.find((site) => site.key === 'acgrip')!;

    it('uses the ACG.RIP API token without requiring a cookie', () => {
        const siteCookies = emptySiteCookies();
        siteCookies.acgrip.raw_text = '# stale Cookie data';

        const credentials = getSiteLoginCredentials(
            acgrip,
            createProfile({ acgrip_api_token: '  secret-token  ', site_cookies: siteCookies }),
        );

        expect(credentials).toEqual({
            apiToken: 'secret-token',
            cookieText: '',
        });
        expect(buildSiteLoginInvokeArgs(acgrip, createProfile(), credentials)).toEqual({
            site: 'acgrip',
            cookieText: '',
            userAgent: null,
            expectedName: null,
            apiToken: 'secret-token',
        });
    });

    it('keeps the Cookie fallback when the ACG.RIP API token is empty', () => {
        const siteCookies = emptySiteCookies();
        siteCookies.acgrip.raw_text = '# HTTP Cookie File\n.acg.rip\tTRUE\t/\tFALSE\t0\tsession\tvalue';

        const credentials = getSiteLoginCredentials(
            acgrip,
            createProfile({ acgrip_api_token: ' ', site_cookies: siteCookies }),
        );

        expect(credentials.apiToken).toBe('');
        expect(credentials.cookieText).toContain('session');
    });
});
