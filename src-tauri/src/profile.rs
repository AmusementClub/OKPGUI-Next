use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DMHY_COOKIE_DOMAINS: &[&str] = &["share.dmhy.org", ".dmhy.org"];
const NYAA_COOKIE_DOMAINS: &[&str] = &["nyaa.si", ".nyaa.si"];
const ACGRIP_COOKIE_DOMAINS: &[&str] = &["acg.rip", ".acg.rip"];
const BANGUMI_COOKIE_DOMAINS: &[&str] = &["bangumi.moe", ".bangumi.moe"];

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SiteCookieStore {
    #[serde(default)]
    pub raw_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SiteCookies {
    #[serde(default)]
    pub dmhy: SiteCookieStore,
    #[serde(default)]
    pub nyaa: SiteCookieStore,
    #[serde(default)]
    pub acgrip: SiteCookieStore,
    #[serde(default)]
    pub bangumi: SiteCookieStore,
}

impl SiteCookies {
    pub fn is_empty(&self) -> bool {
        self.dmhy.raw_text.trim().is_empty()
            && self.nyaa.raw_text.trim().is_empty()
            && self.acgrip.raw_text.trim().is_empty()
            && self.bangumi.raw_text.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Profile {
    #[serde(default)]
    pub cookies: String,
    #[serde(default)]
    pub site_cookies: SiteCookies,
    #[serde(default)]
    pub user_agent: String,
    #[serde(default)]
    pub dmhy_name: String,
    #[serde(default)]
    pub nyaa_name: String,
    #[serde(default)]
    pub acgrip_name: String,
    #[serde(default)]
    pub bangumi_name: String,
    #[serde(default)]
    pub acgnx_asia_name: String,
    #[serde(default)]
    pub acgnx_asia_token: String,
    #[serde(default)]
    pub acgnx_global_name: String,
    #[serde(default)]
    pub acgnx_global_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileStore {
    pub last_used: Option<String>,
    pub profiles: HashMap<String, Profile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NetscapeCookieLine {
    domain: String,
    include_subdomains: String,
    path: String,
    secure: String,
    expires: String,
    name: String,
    value: String,
}

fn profile_path(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("okpgui_profile.json")
}

fn site_cookie_domains(site: &str) -> &'static [&'static str] {
    match site {
        "dmhy" => DMHY_COOKIE_DOMAINS,
        "nyaa" => NYAA_COOKIE_DOMAINS,
        "acgrip" => ACGRIP_COOKIE_DOMAINS,
        "bangumi" => BANGUMI_COOKIE_DOMAINS,
        _ => &[],
    }
}

fn normalize_domain(domain: &str) -> &str {
    domain.trim().trim_start_matches('.')
}

fn matches_site_domain(domain: &str, candidates: &[&str]) -> bool {
    let normalized_domain = normalize_domain(domain);

    candidates.iter().any(|candidate| {
        let normalized_candidate = normalize_domain(candidate);
        normalized_domain == normalized_candidate
            || normalized_domain.ends_with(&format!(".{}", normalized_candidate))
    })
}

fn parse_cookie_text(cookie_text: &str) -> Vec<NetscapeCookieLine> {
    let mut cookies = Vec::new();

    for raw_line in cookie_text.lines() {
        let trimmed_line = raw_line.trim();
        if trimmed_line.is_empty()
            || trimmed_line == "# Netscape HTTP Cookie File"
            || trimmed_line.starts_with('#')
        {
            continue;
        }

        let parts: Vec<&str> = raw_line.split('\t').collect();
        if parts.len() < 7 {
            continue;
        }

        cookies.push(NetscapeCookieLine {
            domain: parts[0].to_string(),
            include_subdomains: parts[1].to_string(),
            path: parts[2].to_string(),
            secure: parts[3].to_string(),
            expires: parts[4].to_string(),
            name: parts[5].to_string(),
            value: parts[6..].join("\t"),
        });
    }

    cookies
}

fn deduplicate_netscape_cookies(cookies: Vec<NetscapeCookieLine>) -> Vec<NetscapeCookieLine> {
    let mut seen = std::collections::HashSet::new();
    let mut deduplicated = Vec::new();

    for cookie in cookies.into_iter().rev() {
        let key = format!(
            "{}\0{}\0{}",
            normalize_domain(&cookie.domain),
            cookie.path,
            cookie.name
        );

        if seen.insert(key) {
            deduplicated.push(cookie);
        }
    }

    deduplicated.reverse();
    deduplicated
}

fn format_cookie_text(cookies: Vec<NetscapeCookieLine>) -> String {
    let cookies = deduplicate_netscape_cookies(cookies);
    if cookies.is_empty() {
        return String::new();
    }

    let mut lines = vec!["# Netscape HTTP Cookie File".to_string()];
    lines.extend(cookies.into_iter().map(|cookie| {
        [
            cookie.domain,
            cookie.include_subdomains,
            cookie.path,
            cookie.secure,
            cookie.expires,
            cookie.name,
            cookie.value,
        ]
        .join("\t")
    }));
    lines.join("\n")
}

pub fn split_site_cookies(cookie_text: &str) -> SiteCookies {
    let cookies = parse_cookie_text(cookie_text);
    let filter_site = |site_code: &str| {
        let domains = site_cookie_domains(site_code);
        let filtered: Vec<NetscapeCookieLine> = cookies
            .iter()
            .filter(|cookie| matches_site_domain(&cookie.domain, domains))
            .cloned()
            .collect();
        SiteCookieStore {
            raw_text: format_cookie_text(filtered),
        }
    };

    SiteCookies {
        dmhy: filter_site("dmhy"),
        nyaa: filter_site("nyaa"),
        acgrip: filter_site("acgrip"),
        bangumi: filter_site("bangumi"),
    }
}

pub fn merge_site_cookies(site_cookies: &SiteCookies) -> String {
    let mut cookies = Vec::new();
    for raw_text in [
        &site_cookies.dmhy.raw_text,
        &site_cookies.nyaa.raw_text,
        &site_cookies.acgrip.raw_text,
        &site_cookies.bangumi.raw_text,
    ] {
        cookies.extend(parse_cookie_text(raw_text));
    }
    format_cookie_text(cookies)
}

pub fn sync_profile_cookies(profile: &mut Profile) {
    if profile.site_cookies.is_empty() && !profile.cookies.trim().is_empty() {
        profile.site_cookies = split_site_cookies(&profile.cookies);
    }

    if !profile.site_cookies.is_empty() {
        profile.cookies = merge_site_cookies(&profile.site_cookies);
    }
}

fn normalize_store(store: &mut ProfileStore) {
    for profile in store.profiles.values_mut() {
        sync_profile_cookies(profile);
    }
}

pub fn load_profiles(app: &AppHandle) -> ProfileStore {
    let path = profile_path(app);
    let mut store = if path.exists() {
        let data = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        ProfileStore::default()
    };

    normalize_store(&mut store);
    store
}

pub fn save_profiles(app: &AppHandle, store: &ProfileStore) {
    let path = profile_path(app);
    if let Ok(data) = serde_json::to_string_pretty(store) {
        std::fs::write(path, data).ok();
    }
}

#[tauri::command]
pub fn get_profiles(app: AppHandle) -> ProfileStore {
    load_profiles(&app)
}

#[tauri::command]
pub fn get_profile_list(app: AppHandle) -> Vec<String> {
    let store = load_profiles(&app);
    store.profiles.keys().cloned().collect()
}

#[tauri::command]
pub fn save_profile(app: AppHandle, name: String, mut profile: Profile) {
    sync_profile_cookies(&mut profile);
    let mut store = load_profiles(&app);
    store.profiles.insert(name.clone(), profile);
    store.last_used = Some(name);
    save_profiles(&app, &store);
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, name: String) {
    let mut store = load_profiles(&app);
    store.profiles.remove(&name);
    if store.last_used.as_deref() == Some(&name) {
        store.last_used = None;
    }
    save_profiles(&app, &store);
}

#[tauri::command]
pub fn update_profile_cookies(app: AppHandle, name: String, cookies: String) {
    let mut store = load_profiles(&app);
    if let Some(profile) = store.profiles.get_mut(&name) {
        profile.cookies = cookies;
        profile.site_cookies = split_site_cookies(&profile.cookies);
        sync_profile_cookies(profile);
        save_profiles(&app, &store);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_profile() {
        let profile = Profile::default();
        assert!(profile.cookies.is_empty());
        assert!(profile.site_cookies.is_empty());
        assert!(profile.dmhy_name.is_empty());
        assert!(profile.nyaa_name.is_empty());
    }

    #[test]
    fn test_default_store() {
        let store = ProfileStore::default();
        assert!(store.profiles.is_empty());
        assert!(store.last_used.is_none());
    }

    #[test]
    fn test_split_and_merge_site_cookies() {
        let cookie_text = [
            "# Netscape HTTP Cookie File",
            ".dmhy.org\tTRUE\t/\tFALSE\t1893456000\tdmhy_sid\tabc",
            ".nyaa.si\tTRUE\t/\tFALSE\t1893456000\tnyaa_sid\tdef",
        ]
        .join("\n");

        let site_cookies = split_site_cookies(&cookie_text);
        assert!(site_cookies.dmhy.raw_text.contains("dmhy_sid"));
        assert!(site_cookies.nyaa.raw_text.contains("nyaa_sid"));
        assert!(site_cookies.acgrip.raw_text.is_empty());

        let merged = merge_site_cookies(&site_cookies);
        assert!(merged.contains("dmhy_sid"));
        assert!(merged.contains("nyaa_sid"));
    }

    #[test]
    fn test_sync_profile_cookies_migrates_legacy_cookie_text() {
        let mut profile = Profile {
            cookies: [
                "# Netscape HTTP Cookie File",
                ".bangumi.moe\tTRUE\t/\tFALSE\t1893456000\tbgm_sid\txyz",
            ]
            .join("\n"),
            ..Profile::default()
        };

        sync_profile_cookies(&mut profile);

        assert!(profile.site_cookies.bangumi.raw_text.contains("bgm_sid"));
        assert!(profile.cookies.contains("bgm_sid"));
    }
}
