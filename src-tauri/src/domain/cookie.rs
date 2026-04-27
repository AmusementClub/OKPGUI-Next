use chromiumoxide::cdp::browser_protocol::network::Cookie;
use serde::Serialize;

const DMHY_COOKIE_DOMAINS: &[&str] = &["share.dmhy.org", ".dmhy.org"];
const NYAA_COOKIE_DOMAINS: &[&str] = &["nyaa.si", ".nyaa.si"];
const ACGRIP_COOKIE_DOMAINS: &[&str] = &["acg.rip", ".acg.rip"];
const BANGUMI_COOKIE_DOMAINS: &[&str] = &["bangumi.moe", ".bangumi.moe"];
const ACGNX_ASIA_COOKIE_DOMAINS: &[&str] = &["share.acgnx.se", ".acgnx.se"];
const ACGNX_GLOBAL_COOKIE_DOMAINS: &[&str] = &["www.acgnx.se", ".acgnx.se"];

#[derive(Debug, Clone, Copy)]
pub(crate) struct SiteConfig {
    pub(crate) code: &'static str,
    pub(crate) login_url: &'static str,
    pub(crate) test_url: &'static str,
    pub(crate) cookie_domains: &'static [&'static str],
}

const SITE_CONFIGS: &[SiteConfig] = &[
    SiteConfig {
        code: "dmhy",
        login_url: "https://share.dmhy.org/topics/add",
        test_url: "https://share.dmhy.org/topics/add",
        cookie_domains: DMHY_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "nyaa",
        login_url: "https://nyaa.si/login",
        test_url: "https://nyaa.si/upload",
        cookie_domains: NYAA_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgrip",
        login_url: "https://acg.rip/users/sign_in",
        test_url: "https://acg.rip/cp/posts/upload",
        cookie_domains: ACGRIP_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "bangumi",
        login_url: "https://bangumi.moe/",
        test_url: "https://bangumi.moe/api/team/myteam",
        cookie_domains: BANGUMI_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgnx_asia",
        login_url: "https://share.acgnx.se/",
        test_url: "https://share.acgnx.se/",
        cookie_domains: ACGNX_ASIA_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgnx_global",
        login_url: "https://www.acgnx.se/",
        test_url: "https://www.acgnx.se/",
        cookie_domains: ACGNX_GLOBAL_COOKIE_DOMAINS,
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct LoginTestResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CookieCaptureResult {
    pub cookies: Vec<CapturedCookie>,
    pub user_agent: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapturedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub expires: i64,
}

impl From<&Cookie> for CapturedCookie {
    fn from(cookie: &Cookie) -> Self {
        Self {
            name: cookie.name.clone(),
            value: cookie.value.clone(),
            domain: cookie.domain.clone(),
            path: cookie.path.clone(),
            secure: cookie.secure,
            expires: cookie_expiration(cookie),
        }
    }
}

fn cookie_expiration(cookie: &Cookie) -> i64 {
    if cookie.expires.is_finite() && cookie.expires > 0.0 {
        cookie.expires.floor() as i64
    } else {
        0
    }
}

pub(crate) fn get_site_config(site: &str) -> Result<&'static SiteConfig, String> {
    SITE_CONFIGS
        .iter()
        .find(|config| config.code == site)
        .ok_or_else(|| format!("未知站点: {}", site))
}

#[cfg(test)]
pub(crate) fn get_login_url(site: &str) -> Result<&'static str, String> {
    Ok(get_site_config(site)?.login_url)
}

#[cfg(test)]
pub(crate) fn get_cookie_domains(site: &str) -> Vec<&'static str> {
    get_site_config(site)
        .map(|config| config.cookie_domains.to_vec())
        .unwrap_or_default()
}