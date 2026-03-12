import { Disclosure, Transition } from '@headlessui/react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    CalendarClock,
    ChevronDown,
    Cookie,
    Upload,
    Loader2,
    LogIn,
    Trash2,
    UserCircle,
} from 'lucide-react';
import CookieCaptureDialog, {
    CapturedCookie,
    CookieCaptureDialogMode,
    getCapturedCookieKey,
} from '../components/CookieCaptureDialog';
import {
    buildCookieTextFromCapturedCookies,
    buildMergedCookieText,
    buildSiteCookiesFromMergedCookieText,
    emptySiteCookies,
    getCookiePanelSummary,
    getRemainingTextClass,
    getSiteCookieText,
    SiteCookies,
    updateSiteCookies,
} from '../utils/cookieUtils';
import {
    getSiteLoginMessageClass,
    getSiteLoginStateBadgeClass,
    getSiteLoginStateLabel,
    SiteLoginStatus,
} from '../utils/siteStatus';

interface Profile {
    cookies: string;
    site_cookies: SiteCookies;
    user_agent: string;
    dmhy_name: string;
    nyaa_name: string;
    acgrip_name: string;
    bangumi_name: string;
    acgnx_asia_name: string;
    acgnx_asia_token: string;
    acgnx_global_name: string;
    acgnx_global_token: string;
}

interface CookieDialogState {
    siteCode: string;
    siteLabel: string;
    userAgent: string;
    mode: CookieCaptureDialogMode;
    cookies: CapturedCookie[];
    selectedCookieKeys: string[];
    isCaptureReady: boolean;
    errorMessage?: string;
}

interface CookieCaptureResult {
    cookies: CapturedCookie[];
    user_agent: string;
}

interface CookieImportResult {
    site_cookies: SiteCookies;
    user_agent: string;
}

interface SiteConfig {
    code: string;
    label: string;
    nameField: keyof Profile;
    tokenField?: keyof Profile;
    loginEnabled: boolean;
}

interface SiteLoginTestResult {
    success: boolean;
    message: string;
}

interface SiteLoginTestState {
    status: SiteLoginStatus;
    message: string;
}

const defaultProfile: Profile = {
    cookies: '',
    site_cookies: emptySiteCookies(),
    user_agent: '',
    dmhy_name: '',
    nyaa_name: '',
    acgrip_name: '',
    bangumi_name: '',
    acgnx_asia_name: '',
    acgnx_asia_token: '',
    acgnx_global_name: '',
    acgnx_global_token: '',
};

const cookieSites: SiteConfig[] = [
    { code: 'dmhy', label: '动漫花园', nameField: 'dmhy_name', loginEnabled: true },
    { code: 'nyaa', label: 'Nyaa', nameField: 'nyaa_name', loginEnabled: true },
    { code: 'acgrip', label: 'ACG.RIP', nameField: 'acgrip_name', loginEnabled: true },
    { code: 'bangumi', label: '萌番组', nameField: 'bangumi_name', loginEnabled: true },
];

const sites: SiteConfig[] = [
    ...cookieSites,
    {
        code: 'acgnx_asia',
        label: 'ACGNx Asia',
        nameField: 'acgnx_asia_name',
        tokenField: 'acgnx_asia_token',
        loginEnabled: false,
    },
    {
        code: 'acgnx_global',
        label: 'ACGNx Global',
        nameField: 'acgnx_global_name',
        tokenField: 'acgnx_global_token',
        loginEnabled: false,
    },
];

function getErrorMessage(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return '获取 Cookie 失败，请重试。';
}

function updateProfileSiteCookies(profile: Profile, siteCode: string, rawText: string): Profile {
    const siteCookies = updateSiteCookies(profile.site_cookies, siteCode, rawText);
    return {
        ...profile,
        site_cookies: siteCookies,
        cookies: buildMergedCookieText(siteCookies, profile.user_agent),
    };
}

function normalizeProfile(profile?: Partial<Profile>): Profile {
    const mergedFallbackCookies = typeof profile?.cookies === 'string' ? profile.cookies : '';
    const mergedFallbackSiteCookies = buildSiteCookiesFromMergedCookieText(mergedFallbackCookies);

    const siteCookies: SiteCookies = {
        dmhy: {
            raw_text:
                profile?.site_cookies?.dmhy?.raw_text ?? mergedFallbackSiteCookies.dmhy.raw_text,
        },
        nyaa: {
            raw_text:
                profile?.site_cookies?.nyaa?.raw_text ?? mergedFallbackSiteCookies.nyaa.raw_text,
        },
        acgrip: {
            raw_text:
                profile?.site_cookies?.acgrip?.raw_text ?? mergedFallbackSiteCookies.acgrip.raw_text,
        },
        bangumi: {
            raw_text:
                profile?.site_cookies?.bangumi?.raw_text ?? mergedFallbackSiteCookies.bangumi.raw_text,
        },
    };

    return {
        ...defaultProfile,
        ...profile,
        site_cookies: siteCookies,
        cookies: buildMergedCookieText(siteCookies, profile?.user_agent ?? '') || mergedFallbackCookies,
    };
}

export default function IdentityPage() {
    const [profileList, setProfileList] = useState<string[]>([]);
    const [currentProfileName, setCurrentProfileName] = useState('');
    const [newProfileName, setNewProfileName] = useState('');
    const [profile, setProfile] = useState<Profile>(defaultProfile);
    const [loginSite, setLoginSite] = useState<string | null>(null);
    const [cookieDialog, setCookieDialog] = useState<CookieDialogState | null>(null);
    const [siteLoginTests, setSiteLoginTests] = useState<Record<string, SiteLoginTestState>>({});

    const captureRequestIdRef = useRef(0);
    const captureSessionIdRef = useRef<string | null>(null);
    const cookiePanels = useMemo(
        () =>
            cookieSites.map((site) => {
                const rawText = getSiteCookieText(profile.site_cookies, site.code);
                return {
                    site,
                    rawText,
                    summary: getCookiePanelSummary(rawText),
                };
            }),
        [profile.site_cookies],
    );

    useEffect(() => {
        loadProfileList();
        loadLastProfile();
    }, []);

    useEffect(() => {
        return () => {
            const sessionId = captureSessionIdRef.current;
            if (!sessionId) {
                return;
            }

            captureSessionIdRef.current = null;
            void invoke('cancel_cookie_capture', { sessionId }).catch((error) => {
                console.error('取消 Cookie 获取失败:', error);
            });
        };
    }, []);

    const loadProfileList = async () => {
        try {
            const list = await invoke<string[]>('get_profile_list');
            setProfileList(list);
        } catch (error) {
            console.error('加载配置列表失败:', error);
        }
    };

    const loadLastProfile = async () => {
        try {
            const store = await invoke<{
                last_used: string | null;
                profiles: Record<string, Profile>;
            }>('get_profiles');

            const initialProfileName = store.last_used ?? (store.profiles.default ? 'default' : null);

            if (initialProfileName && store.profiles[initialProfileName]) {
                setCurrentProfileName(initialProfileName);
                setProfile(normalizeProfile(store.profiles[initialProfileName]));
                setSiteLoginTests({});
            }
        } catch (error) {
            console.error('加载配置失败:', error);
        }
    };

    const loadProfile = async (name: string) => {
        try {
            const store = await invoke<{
                profiles: Record<string, Profile>;
            }>('get_profiles');

            if (store.profiles[name]) {
                setCurrentProfileName(name);
                setProfile(normalizeProfile(store.profiles[name]));
                setSiteLoginTests({});
            }
        } catch (error) {
            console.error('加载配置失败:', error);
        }
    };

    const persistProfileToDisk = async (profileToSave: Profile, explicitName?: string) => {
        const name =
            explicitName?.trim() ||
            currentProfileName.trim() ||
            newProfileName.trim() ||
            'default';

        try {
            await invoke('save_profile', { name, profile: profileToSave });
            setProfile(profileToSave);
            setCurrentProfileName(name);
            setNewProfileName('');
            await loadProfileList();
            return true;
        } catch (error) {
            console.error('自动保存配置失败:', error);
            return false;
        }
    };

    const autosaveProfile = (profileToSave: Profile = profile, explicitName?: string) => {
        void persistProfileToDisk(
            {
                ...profileToSave,
                cookies: buildMergedCookieText(
                    profileToSave.site_cookies,
                    profileToSave.user_agent,
                ),
            },
            explicitName,
        );
    };

    const getProfileWithFieldValue = (field: keyof Profile, value: string): Profile =>
        ({ ...profile, [field]: value } as Profile);

    const deleteProfile = async () => {
        if (!currentProfileName) {
            return;
        }

        try {
            await invoke('delete_profile', { name: currentProfileName });
            setCurrentProfileName('');
            setProfile(defaultProfile);
            setSiteLoginTests({});
            await loadProfileList();
        } catch (error) {
            console.error('删除配置失败:', error);
        }
    };

    const clearSiteLoginTest = (siteCode: string) => {
        setSiteLoginTests((current) => {
            if (!(siteCode in current)) {
                return current;
            }

            const nextState = { ...current };
            delete nextState[siteCode];
            return nextState;
        });
    };

    const closeCookieDialog = () => {
        captureRequestIdRef.current += 1;
        const sessionId = captureSessionIdRef.current;
        captureSessionIdRef.current = null;
        setCookieDialog(null);
        setLoginSite(null);

        if (sessionId) {
            void invoke('cancel_cookie_capture', { sessionId }).catch((error) => {
                console.error('取消 Cookie 获取失败:', error);
            });
        }
    };

    const handleLogin = (siteCode: string) => {
        const site = cookieSites.find((item) => item.code === siteCode);
        if (!site) {
            return;
        }

        const requestId = captureRequestIdRef.current + 1;
        captureRequestIdRef.current = requestId;
        captureSessionIdRef.current = null;
        setLoginSite(siteCode);
        setCookieDialog({
            siteCode,
            siteLabel: site.label,
            userAgent: profile.user_agent,
            mode: 'confirm',
            cookies: [],
            selectedCookieKeys: [],
            isCaptureReady: false,
        });

        invoke<string>('start_cookie_capture', { site: siteCode })
            .then((sessionId) => {
                if (captureRequestIdRef.current !== requestId) {
                    void invoke('cancel_cookie_capture', { sessionId }).catch((error) => {
                        console.error('取消过期 Cookie 获取会话失败:', error);
                    });
                    return;
                }

                captureSessionIdRef.current = sessionId;
                setLoginSite(null);
                setCookieDialog((current) =>
                    current && current.siteCode === siteCode
                        ? {
                              ...current,
                              isCaptureReady: true,
                              errorMessage: undefined,
                          }
                        : current,
                );
            })
            .catch((error) => {
                if (captureRequestIdRef.current !== requestId) {
                    return;
                }

                captureSessionIdRef.current = null;
                setLoginSite(null);
                setCookieDialog((current) =>
                    current && current.siteCode === siteCode
                        ? {
                              ...current,
                              mode: 'error',
                              isCaptureReady: false,
                              errorMessage: getErrorMessage(error),
                          }
                        : current,
                );
            });
    };

    const handleLoginSuccess = async () => {
        const sessionId = captureSessionIdRef.current;
        if (!sessionId) {
            setCookieDialog((current) =>
                current
                    ? {
                          ...current,
                          mode: 'error',
                          errorMessage: '浏览器尚未准备好，请稍候再试。',
                      }
                    : current,
            );
            return;
        }
        captureSessionIdRef.current = null;
        setCookieDialog((current) =>
            current
                ? {
                      ...current,
                      mode: 'loading',
                      errorMessage: undefined,
                  }
                : current,
        );

        try {
            const captureResult = await invoke<CookieCaptureResult>('finish_cookie_capture', {
                sessionId,
            });
            const cookies = captureResult.cookies;

            if (cookies.length === 0) {
                setCookieDialog((current) =>
                    current
                        ? {
                              ...current,
                              mode: 'error',
                              cookies: [],
                              selectedCookieKeys: [],
                              isCaptureReady: true,
                              errorMessage: '未捕获到 Cookie，请确认登录成功后重试。',
                          }
                        : current,
                );
                return;
            }

            setCookieDialog((current) =>
                current
                    ? {
                          ...current,
                          userAgent: captureResult.user_agent,
                          mode: 'select',
                          cookies,
                          selectedCookieKeys: cookies.map(getCapturedCookieKey),
                          isCaptureReady: true,
                          errorMessage: undefined,
                      }
                    : current,
            );
        } catch (error) {
            setCookieDialog((current) =>
                current
                    ? {
                          ...current,
                          mode: 'error',
                          isCaptureReady: true,
                          errorMessage: getErrorMessage(error),
                      }
                    : current,
            );
        }
    };

    const handleLoginFailed = () => {
        closeCookieDialog();
    };

    const toggleAllCookies = (checked: boolean) => {
        setCookieDialog((current) =>
            current
                ? {
                      ...current,
                      selectedCookieKeys: checked
                          ? current.cookies.map(getCapturedCookieKey)
                          : [],
                  }
                : current,
        );
    };

    const toggleCookieSelection = (cookieKey: string) => {
        setCookieDialog((current) => {
            if (!current) {
                return current;
            }

            const isSelected = current.selectedCookieKeys.includes(cookieKey);
            return {
                ...current,
                selectedCookieKeys: isSelected
                    ? current.selectedCookieKeys.filter((key) => key !== cookieKey)
                    : [...current.selectedCookieKeys, cookieKey],
            };
        });
    };

    const saveSelectedCookies = () => {
        if (!cookieDialog) {
            return;
        }

        const selectedCookieKeySet = new Set(cookieDialog.selectedCookieKeys);
        const selectedCookies = cookieDialog.cookies.filter((cookie) =>
            selectedCookieKeySet.has(getCapturedCookieKey(cookie)),
        );

        if (selectedCookies.length === 0) {
            return;
        }

        const nextSiteRawText = buildCookieTextFromCapturedCookies(
            cookieDialog.userAgent,
            selectedCookies,
        );
        const nextProfile = {
            ...updateProfileSiteCookies(profile, cookieDialog.siteCode, nextSiteRawText),
            user_agent: cookieDialog.userAgent,
        };
        nextProfile.cookies = buildMergedCookieText(nextProfile.site_cookies, nextProfile.user_agent);
        setProfile(nextProfile);
        clearSiteLoginTest(cookieDialog.siteCode);
        void persistProfileToDisk(nextProfile);

        closeCookieDialog();
    };

    const updateField = (field: keyof Profile, value: string) => {
        setProfile((current) => ({ ...current, [field]: value }));
    };

    const updateSiteCookieText = (siteCode: string, rawText: string) => {
        clearSiteLoginTest(siteCode);
        setProfile((current) => updateProfileSiteCookies(current, siteCode, rawText));
    };

    const handleImportCookies = async () => {
        try {
            const selectedPath = await open({
                multiple: false,
                filters: [
                    { name: 'Cookie Files', extensions: ['txt', 'cookie', 'cookies'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });

            if (!selectedPath || Array.isArray(selectedPath)) {
                return;
            }

            const result = await invoke<CookieImportResult>('import_cookie_file', {
                cookiePath: selectedPath,
                fallbackUserAgent: profile.user_agent.trim() || null,
            });

            const nextProfile: Profile = {
                ...profile,
                site_cookies: result.site_cookies,
                user_agent: result.user_agent,
                cookies: buildMergedCookieText(result.site_cookies, result.user_agent),
            };

            setProfile(nextProfile);
            setSiteLoginTests({});
            await persistProfileToDisk(nextProfile);
        } catch (error) {
            console.error('导入 Cookie 文件失败:', error);
        }
    };

    const handleSiteLoginTest = async (siteCode: string) => {
        const site = cookieSites.find((item) => item.code === siteCode);
        if (!site) {
            return;
        }

        const rawText = getSiteCookieText(profile.site_cookies, siteCode);
        if (!rawText.trim()) {
            setSiteLoginTests((current) => ({
                ...current,
                [siteCode]: {
                    status: 'error',
                    message: `请先添加 ${site.label} 的 Cookie。`,
                },
            }));
            return;
        }

        setSiteLoginTests((current) => ({
            ...current,
            [siteCode]: {
                status: 'testing',
                message: `正在测试 ${site.label} 登录状态...`,
            },
        }));

        try {
            const expectedName = String(profile[site.nameField] ?? '').trim();
            const result = await invoke<SiteLoginTestResult>('test_site_login', {
                site: siteCode,
                cookieText: rawText,
                userAgent: profile.user_agent.trim() || null,
                expectedName: expectedName || null,
            });

            setSiteLoginTests((current) => ({
                ...current,
                [siteCode]: {
                    status: result.success ? 'success' : 'error',
                    message: result.message,
                },
            }));
        } catch (error) {
            setSiteLoginTests((current) => ({
                ...current,
                [siteCode]: {
                    status: 'error',
                    message: getErrorMessage(error),
                },
            }));
        }
    };

    return (
        <>
            <div className="flex h-full flex-col overflow-y-auto">
                <div className="space-y-5 p-6">
                    <section>
                        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-400">
                            <UserCircle size={16} />
                            身份配置管理
                        </h2>
                        <div className="flex gap-2">
                            <select
                                value={currentProfileName}
                                onChange={(event) => loadProfile(event.target.value)}
                                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                                <option value="">选择配置...</option>
                                {profileList.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            <input
                                type="text"
                                value={newProfileName}
                                onChange={(event) => setNewProfileName(event.target.value)}
                                onBlur={(event) => {
                                    const trimmedName = event.target.value.trim();
                                    if (trimmedName) {
                                        autosaveProfile(profile, trimmedName);
                                    }
                                }}
                                placeholder="新配置名称（失焦自动创建）"
                                className="w-52 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            />
                            <button
                                onClick={deleteProfile}
                                disabled={!currentProfileName}
                                className="flex items-center gap-1.5 rounded-lg bg-red-600/80 px-3 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                <Trash2 size={14} />
                                删除
                            </button>
                        </div>
                    </section>

                    <section>
                        <label className="mb-1 block text-xs text-slate-500">UA</label>
                        <input
                            type="text"
                            value={profile.user_agent}
                            onChange={(event) => updateField('user_agent', event.target.value)}
                            onBlur={(event) =>
                                autosaveProfile(getProfileWithFieldValue('user_agent', event.target.value))
                            }
                            placeholder="留空则使用默认UA"
                            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                    </section>
                    <section>
                        <h2 className="mb-3 text-sm font-medium text-slate-400">站点账号配置</h2>
                        <div className="space-y-3">
                            {sites.map((site) => (
                                <div
                                    key={site.code}
                                    className="rounded-lg border border-slate-700 bg-slate-800/50 p-3"
                                >
                                    <div className="mb-2 flex items-center justify-between">
                                        <span className="text-sm font-medium text-slate-300">
                                            {site.label}
                                        </span>
                                        {site.loginEnabled && (
                                            <button
                                                onClick={() => handleLogin(site.code)}
                                                disabled={loginSite !== null}
                                                className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {loginSite === site.code ? (
                                                    <>
                                                        <Loader2 size={12} className="animate-spin" />
                                                        处理中...
                                                    </>
                                                ) : (
                                                    <>
                                                        <LogIn size={12} />
                                                        登录并获取 Cookie
                                                    </>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <label className="mb-1 block text-xs text-slate-500">
                                                发布账号名称
                                            </label>
                                            <input
                                                type="text"
                                                value={profile[site.nameField] as string}
                                                onChange={(event) =>
                                                    updateField(site.nameField, event.target.value)
                                                }
                                                onBlur={(event) =>
                                                    autosaveProfile(
                                                        getProfileWithFieldValue(
                                                            site.nameField,
                                                            event.target.value,
                                                        ),
                                                    )
                                                }
                                                placeholder={`${site.label} 账号名称`}
                                                className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </div>
                                        {site.tokenField && (
                                            <div>
                                                <label className="mb-1 block text-xs text-slate-500">
                                                    API 令牌
                                                </label>
                                                <input
                                                    type="text"
                                                    value={profile[site.tokenField] as string}
                                                    onChange={(event) =>
                                                        updateField(site.tokenField!, event.target.value)
                                                    }
                                                    onBlur={(event) =>
                                                        autosaveProfile(
                                                            getProfileWithFieldValue(
                                                                site.tokenField!,
                                                                event.target.value,
                                                            ),
                                                        )
                                                    }
                                                    placeholder="API 令牌"
                                                    className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section>
                        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-400">
                            <Cookie size={16} />
                            站点 Cookie
                        </h2>
                        <div className="mb-3 flex justify-end">
                            <button
                                type="button"
                                onClick={() => {
                                    void handleImportCookies();
                                }}
                                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-500/20"
                            >
                                <Upload size={14} />
                                导入自定义 Cookie 文件
                            </button>
                        </div>
                        <div className="space-y-3">
                            {cookiePanels.map(({ site, rawText, summary }, index) => (
                                <Disclosure key={site.code} defaultOpen={index === 0}>
                                    {({ open }) => (
                                        <div
                                            className={`overflow-hidden rounded-lg border bg-slate-800/50 transition-[border-color,background-color,box-shadow] duration-200 ease-out ${
                                                open
                                                    ? 'border-slate-600 bg-slate-800/70 shadow-[0_18px_36px_rgba(2,6,23,0.18)]'
                                                    : 'border-slate-700'
                                            }`}
                                        >
                                            <Disclosure.Button
                                                as="div"
                                                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-[background-color,padding] duration-200 ease-out ${
                                                    open ? 'bg-slate-800/60' : 'hover:bg-slate-800/80'
                                                }`}
                                            >
                                                <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-4">
                                                    <span className="text-sm font-medium text-slate-100">
                                                        {site.label}
                                                    </span>
                                                    <span className="text-xs text-slate-400">
                                                        {summary.earliestExpiryText}
                                                    </span>
                                                    <span
                                                        className={`text-xs ${getRemainingTextClass(summary.earliestExpiry)}`}
                                                    >
                                                        {summary.remainingText}
                                                    </span>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-2">
                                                    {siteLoginTests[site.code] && (
                                                        <span
                                                            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${getSiteLoginStateBadgeClass(siteLoginTests[site.code].status)}`}
                                                            title={siteLoginTests[site.code].message}
                                                        >
                                                            {getSiteLoginStateLabel(siteLoginTests[site.code].status)}
                                                        </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onMouseDown={(event) => event.stopPropagation()}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            void handleSiteLoginTest(site.code);
                                                        }}
                                                        disabled={siteLoginTests[site.code]?.status === 'testing'}
                                                        title={siteLoginTests[site.code]?.message ?? `测试 ${site.label} 登录`}
                                                        className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        {siteLoginTests[site.code]?.status === 'testing' ? (
                                                            <>
                                                                <Loader2 size={12} className="animate-spin" />
                                                                测试中...
                                                            </>
                                                        ) : (
                                                            '测试登录'
                                                        )}
                                                    </button>
                                                    <ChevronDown
                                                        size={16}
                                                        className={`shrink-0 text-slate-500 transition-transform duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? 'rotate-180' : ''}`}
                                                    />
                                                </div>
                                            </Disclosure.Button>
                                            <Transition
                                                show={open}
                                                as="div"
                                                enter="transition duration-180 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                                enterFrom="opacity-0 -translate-y-1"
                                                enterTo="opacity-100 translate-y-0"
                                                leave="transition duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]"
                                                leaveFrom="opacity-100 translate-y-0"
                                                leaveTo="opacity-0 -translate-y-1"
                                                className="overflow-hidden"
                                            >
                                                <Disclosure.Panel
                                                    static
                                                    className="space-y-3 border-t border-slate-700 px-4 py-4"
                                                >
                                                    <div className="flex items-center gap-2 text-xs text-slate-500">
                                                        <CalendarClock size={14} />
                                                        共 {summary.cookieCount} 条 Cookie
                                                    </div>
                                                    {siteLoginTests[site.code]?.message && (
                                                        <p
                                                            className={`text-xs ${getSiteLoginMessageClass(siteLoginTests[site.code].status)}`}
                                                        >
                                                            {siteLoginTests[site.code].message}
                                                        </p>
                                                    )}
                                                    <textarea
                                                        value={rawText}
                                                        onChange={(event) =>
                                                            updateSiteCookieText(site.code, event.target.value)
                                                        }
                                                        onBlur={(event) =>
                                                            autosaveProfile(
                                                                updateProfileSiteCookies(
                                                                    profile,
                                                                    site.code,
                                                                    event.target.value,
                                                                ),
                                                            )
                                                        }
                                                        placeholder={`在这里查看或粘贴 ${site.label} 的 Cookie 内容...`}
                                                        rows={8}
                                                        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                                    />
                                                </Disclosure.Panel>
                                            </Transition>
                                        </div>
                                    )}
                                </Disclosure>
                            ))}
                        </div>
                        <p className="mt-2 text-xs text-slate-600">
                            提示：每个面板只保存对应站点的 Cookie。面板标题显示该站点最早到期的 Cookie 时间和剩余天数。
                        </p>
                    </section>
                </div>
            </div>

            <CookieCaptureDialog
                isOpen={cookieDialog !== null}
                mode={cookieDialog?.mode ?? 'confirm'}
                siteLabel={cookieDialog?.siteLabel ?? ''}
                cookies={cookieDialog?.cookies ?? []}
                selectedCookieKeys={cookieDialog?.selectedCookieKeys ?? []}
                errorMessage={cookieDialog?.errorMessage}
                isCaptureReady={cookieDialog?.isCaptureReady ?? false}
                onConfirmLogin={handleLoginSuccess}
                onReportFailure={handleLoginFailed}
                onClose={closeCookieDialog}
                onToggleAll={toggleAllCookies}
                onToggleCookie={toggleCookieSelection}
                onSubmitSelection={saveSelectedCookies}
            />
        </>
    );
}



