import { useMemo } from 'react';
import type { PublishConsoleSite } from '../components/ConsoleModal';
import {
    getCookiePanelSummary,
    getRemainingTextClass,
    getSiteCookieText,
} from '../utils/cookieUtils';
import {
    siteDefinitions,
    type ProfileLike,
    type SiteDefinition,
    type SiteLoginTestState,
} from './useSiteLoginTest';

export interface SiteRow {
    site: SiteDefinition;
    selectable: boolean;
    selectDisabledReason: string;
    identityText: string;
    identityClass: string;
    identityTitle: string;
    loginState: SiteLoginTestState | undefined;
    publishState: PublishConsoleSite | null;
}

interface UseSiteRowsOptions {
    publishSites: Record<string, PublishConsoleSite>;
    selectedProfileData: ProfileLike | null;
    siteLoginTests: Record<string, SiteLoginTestState>;
    /**
     * Refresh trigger only — the row body reads publish state from
     * `publishSites`, but consumers that render publish history inline pass
     * their history object here so rows recompute when it changes. Pages
     * without that need pass `undefined`.
     */
    publishHistory?: unknown;
}

export function useSiteRows({
    publishSites,
    selectedProfileData,
    siteLoginTests,
    publishHistory,
}: UseSiteRowsOptions): SiteRow[] {
    return useMemo(
        () =>
            siteDefinitions.map((site) => {
                const publishState = publishSites[site.key] ?? null;
                const loginState = siteLoginTests[site.key];

                if (!selectedProfileData) {
                    return {
                        site,
                        selectable: false,
                        selectDisabledReason: '请先选择身份配置',
                        identityText: '未选择身份',
                        identityClass: 'text-slate-500',
                        identityTitle: '请先选择身份配置',
                        loginState,
                        publishState,
                    };
                }

                if (site.loginEnabled) {
                    const tokenValue = site.tokenField
                        ? String(selectedProfileData[site.tokenField] ?? '').trim()
                        : '';
                    if (tokenValue) {
                        return {
                            site,
                            selectable: true,
                            selectDisabledReason: '',
                            identityText: 'API Token 已配置',
                            identityClass: 'text-emerald-300',
                            identityTitle: `${site.label} 将优先使用 API Token`,
                            loginState,
                            publishState,
                        };
                    }

                    const rawText = getSiteCookieText(selectedProfileData.site_cookies, site.key);
                    const summary = getCookiePanelSummary(rawText);
                    const hasCookies = summary.cookieCount > 0;

                    return {
                        site,
                        selectable: hasCookies,
                        selectDisabledReason: hasCookies
                            ? ''
                            : `请先在身份页面配置 ${site.label} 的 Cookie`,
                        identityText: hasCookies
                            ? `${summary.remainingText} / ${summary.earliestExpiryText}`
                            : '未配置 Cookie',
                        identityClass: hasCookies
                            ? getRemainingTextClass(summary.earliestExpiry)
                            : 'text-slate-500',
                        identityTitle: hasCookies
                            ? `${site.label} 已配置 ${summary.cookieCount} 条 Cookie`
                            : `尚未配置 ${site.label} Cookie`,
                        loginState,
                        publishState,
                    };
                }

                const accountName = String(selectedProfileData[site.nameField] ?? '').trim();
                const tokenValue = site.tokenField
                    ? String(selectedProfileData[site.tokenField] ?? '').trim()
                    : '';
                const hasToken = tokenValue.length > 0;

                return {
                    site,
                    selectable: hasToken,
                    selectDisabledReason: hasToken
                        ? ''
                        : `${site.label} 缺少 API 令牌`,
                    identityText: hasToken
                        ? accountName.length > 0
                            ? 'API 身份已配置'
                            : 'API 令牌已配置'
                        : '缺少 API 令牌',
                    identityClass: hasToken ? 'text-emerald-300' : 'text-yellow-300',
                    identityTitle: hasToken
                        ? `${site.label} 已配置 API 令牌`
                        : `${site.label} 需要 API 令牌`,
                    loginState,
                    publishState,
                };
            }),
        [publishSites, selectedProfileData, siteLoginTests, publishHistory],
    );
}
