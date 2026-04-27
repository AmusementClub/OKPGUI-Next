use crate::entity_naming::{normalize_required_value, ENTITY_NAME_MAX_CHARS};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use time::macros::format_description;
use time::OffsetDateTime;

const DMHY_COOKIE_DOMAINS: &[&str] = &["share.dmhy.org", ".dmhy.org"];
const NYAA_COOKIE_DOMAINS: &[&str] = &["nyaa.si", ".nyaa.si"];
const ACGRIP_COOKIE_DOMAINS: &[&str] = &["acg.rip", ".acg.rip"];
const BANGUMI_COOKIE_DOMAINS: &[&str] = &["bangumi.moe", ".bangumi.moe"];
const DEFAULT_COOKIE_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_COOKIE_EXPIRES_UNIX_SECONDS: i64 = 4_070_908_800;
const HTTP_COOKIE_DATE_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[weekday repr:short], [day padding:zero] [month repr:short] [year] [hour]:[minute]:[second] GMT");
const PROFILE_STORE_SCHEMA_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStore {
    #[serde(default = "default_profile_store_schema_version")]
    pub schema_version: u32,
    pub last_used: Option<String>,
    pub profiles: HashMap<String, Profile>,
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self {
            schema_version: default_profile_store_schema_version(),
            last_used: None,
            profiles: HashMap::new(),
        }
    }
}

fn default_profile_store_schema_version() -> u32 {
    PROFILE_STORE_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize)]
pub struct CookieImportResult {
    pub site_cookies: SiteCookies,
    pub user_agent: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedProfilePayload {
    pub name: String,
    pub profile: Profile,
}

#[derive(Debug, Clone)]
pub struct ResolvedCookieHeader {
    pub user_agent: String,
    pub cookie_header: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct CustomCookieLine {
    request_url: String,
    cookie_header: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CookieRecord {
    request_url: String,
    domain: String,
    path: String,
    secure: bool,
    expires: String,
    name: String,
    value: String,
}

#[derive(Debug, Clone, Default)]
struct ParsedCookieText {
    user_agent: Option<String>,
    custom_cookies: Vec<CustomCookieLine>,
    netscape_cookies: Vec<NetscapeCookieLine>,
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

fn normalized_user_agent(user_agent: &str) -> String {
    let trimmed = user_agent.trim();
    if trimmed.is_empty() {
        DEFAULT_COOKIE_USER_AGENT.to_string()
    } else {
        trimmed.to_string()
    }
}

fn matches_site_domain(domain: &str, candidates: &[&str]) -> bool {
    let normalized_domain = normalize_domain(domain);

    candidates.iter().any(|candidate| {
        let normalized_candidate = normalize_domain(candidate);
        normalized_domain == normalized_candidate
            || normalized_domain.ends_with(&format!(".{}", normalized_candidate))
    })
}

fn parse_cookie_payload(cookie_text: &str) -> ParsedCookieText {
    let mut parsed = ParsedCookieText::default();

    for raw_line in cookie_text.lines() {
        let trimmed_line = raw_line.trim();
        if trimmed_line.is_empty() {
            continue;
        }

        if trimmed_line.eq_ignore_ascii_case("# Netscape HTTP Cookie File") {
            continue;
        }

        let lower_line = trimmed_line.to_ascii_lowercase();
        if lower_line.starts_with("user-agent:") {
            let user_agent = raw_line
                .split_once('\t')
                .map(|(_, value)| value.trim())
                .or_else(|| raw_line.split_once(':').map(|(_, value)| value.trim()))
                .unwrap_or_default();
            if !user_agent.is_empty() {
                parsed.user_agent = Some(user_agent.to_string());
            }
            continue;
        }

        if let Some((request_url, cookie_header)) = raw_line.split_once('\t') {
            let request_url = request_url.trim();
            if request_url.starts_with("http://") || request_url.starts_with("https://") {
                let cookie_header = cookie_header.trim();
                if !cookie_header.is_empty() {
                    parsed.custom_cookies.push(CustomCookieLine {
                        request_url: request_url.to_string(),
                        cookie_header: cookie_header.to_string(),
                    });
                    continue;
                }
            }
        }

        let normalized_line = if let Some(http_only_line) = raw_line.strip_prefix("#HttpOnly_") {
            http_only_line
        } else {
            if trimmed_line.starts_with('#') {
                continue;
            }
            raw_line
        };

        let parts: Vec<&str> = normalized_line.split('\t').collect();
        if parts.len() < 7 {
            continue;
        }

        parsed.netscape_cookies.push(NetscapeCookieLine {
            domain: parts[0].trim().to_string(),
            include_subdomains: parts[1].trim().to_string(),
            path: parts[2].trim().to_string(),
            secure: parts[3].trim().to_string(),
            expires: parts[4].trim().to_string(),
            name: parts[5].trim().to_string(),
            value: parts[6..].join("\t"),
        });
    }

    parsed
}

fn unix_cookie_expiry_to_http_date(expires: &str) -> String {
    let unix_seconds = expires
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_COOKIE_EXPIRES_UNIX_SECONDS);

    OffsetDateTime::from_unix_timestamp(unix_seconds)
        .unwrap_or_else(|_| OffsetDateTime::from_unix_timestamp(DEFAULT_COOKIE_EXPIRES_UNIX_SECONDS).expect("valid fallback timestamp"))
        .format(HTTP_COOKIE_DATE_FORMAT)
        .unwrap_or_else(|_| "Thu, 01 Jan 2099 00:00:00 GMT".to_string())
}

fn canonical_request_url(domain: &str) -> String {
    format!("https://{}", normalize_domain(domain))
}

fn normalize_cookie_record(record: CookieRecord) -> CookieRecord {
    CookieRecord {
        request_url: if record.request_url.trim().is_empty() {
            canonical_request_url(&record.domain)
        } else {
            record.request_url.trim().to_string()
        },
        domain: normalize_domain(&record.domain).to_string(),
        path: if record.path.trim().is_empty() {
            "/".to_string()
        } else {
            record.path.trim().to_string()
        },
        secure: record.secure,
        expires: if record.expires.trim().is_empty() {
            "Thu, 01 Jan 2099 00:00:00 GMT".to_string()
        } else {
            record.expires.trim().to_string()
        },
        name: record.name.trim().to_string(),
        value: record.value.to_string(),
    }
}

fn deduplicate_cookie_records(records: Vec<CookieRecord>) -> Vec<CookieRecord> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::new();

    for record in records.into_iter().rev() {
        let record = normalize_cookie_record(record);
        let key = format!(
            "{}\0{}\0{}",
            normalize_domain(&record.domain),
            record.path,
            record.name
        );

        if seen.insert(key) {
            deduplicated.push(record);
        }
    }

    deduplicated.reverse();
    deduplicated
}

fn parse_custom_cookie_record(line: &CustomCookieLine) -> Option<CookieRecord> {
    let request_url = Url::parse(&line.request_url).ok()?;
    let host = request_url.host_str()?.to_string();

    let mut parts = line
        .cookie_header
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());

    let (name, value) = parts.next()?.split_once('=')?;
    let mut domain = host;
    let mut path = "/".to_string();
    let mut expires = String::new();
    let mut secure = false;

    for part in parts {
        if part.eq_ignore_ascii_case("secure") {
            secure = true;
            continue;
        }

        let Some((key, value)) = part.split_once('=') else {
            continue;
        };

        match key.trim().to_ascii_lowercase().as_str() {
            "domain" => domain = value.trim().to_string(),
            "path" => path = value.trim().to_string(),
            "expires" => expires = value.trim().to_string(),
            _ => {}
        }
    }

    Some(CookieRecord {
        request_url: line.request_url.clone(),
        domain,
        path,
        secure,
        expires,
        name: name.trim().to_string(),
        value: value.to_string(),
    })
}

fn netscape_cookie_to_record(cookie: NetscapeCookieLine) -> CookieRecord {
    CookieRecord {
        request_url: canonical_request_url(&cookie.domain),
        domain: cookie.domain,
        path: cookie.path,
        secure: normalize_true_false_flag(&cookie.secure, false) == "TRUE",
        expires: unix_cookie_expiry_to_http_date(&cookie.expires),
        name: cookie.name,
        value: cookie.value,
    }
}

fn collect_cookie_records(parsed: ParsedCookieText) -> Vec<CookieRecord> {
    let mut records = parsed
        .custom_cookies
        .iter()
        .filter_map(parse_custom_cookie_record)
        .collect::<Vec<_>>();

    records.extend(parsed.netscape_cookies.into_iter().map(netscape_cookie_to_record));
    deduplicate_cookie_records(records)
}

fn normalize_true_false_flag(flag: &str, default_value: bool) -> String {
    match flag.trim().to_ascii_uppercase().as_str() {
        "TRUE" => "TRUE".to_string(),
        "FALSE" => "FALSE".to_string(),
        _ => {
            if default_value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
    }
}

fn format_cookie_text(user_agent: &str, cookies: Vec<CookieRecord>) -> String {
    let cookies = deduplicate_cookie_records(cookies);
    if cookies.is_empty() {
        return String::new();
    }

    let mut lines = vec![format!("user-agent:\t{}", normalized_user_agent(user_agent))];
    lines.extend(cookies.into_iter().map(|cookie| {
        let secure_suffix = if cookie.secure { "; secure" } else { "" };
        format!(
            "{}\t{}={}; domain={}; path={}; expires={}{}",
            cookie.request_url,
            cookie.name,
            cookie.value,
            cookie.domain,
            cookie.path,
            cookie.expires,
            secure_suffix
        )
    }));
    lines.join("\n")
}

fn resolve_cookie_user_agent(parsed: &ParsedCookieText, fallback_user_agent: &str) -> String {
    parsed
        .user_agent
        .as_deref()
        .map(normalized_user_agent)
        .unwrap_or_else(|| normalized_user_agent(fallback_user_agent))
}

pub fn site_cookie_has_entries(cookie_text: &str) -> bool {
    !collect_cookie_records(parse_cookie_payload(cookie_text)).is_empty()
}

pub fn normalize_site_cookie_text(cookie_text: &str, fallback_user_agent: &str) -> String {
    let parsed = parse_cookie_payload(cookie_text);
    let user_agent = resolve_cookie_user_agent(&parsed, fallback_user_agent);
    let cookies = collect_cookie_records(parsed);
    format_cookie_text(&user_agent, cookies)
}

pub fn resolve_site_cookie_user_agent(cookie_text: &str, fallback_user_agent: &str) -> String {
    let parsed = parse_cookie_payload(cookie_text);
    resolve_cookie_user_agent(&parsed, fallback_user_agent)
}

pub fn split_site_cookies(cookie_text: &str, fallback_user_agent: &str) -> SiteCookies {
    let parsed = parse_cookie_payload(cookie_text);
    let user_agent = resolve_cookie_user_agent(&parsed, fallback_user_agent);
    let cookies = collect_cookie_records(parsed);

    let filter_site = |site_code: &str| {
        let domains = site_cookie_domains(site_code);
        let filtered = cookies
            .iter()
            .filter(|cookie| matches_site_domain(&cookie.domain, domains))
            .cloned()
            .collect::<Vec<_>>();
        SiteCookieStore {
            raw_text: format_cookie_text(&user_agent, filtered),
        }
    };

    SiteCookies {
        dmhy: filter_site("dmhy"),
        nyaa: filter_site("nyaa"),
        acgrip: filter_site("acgrip"),
        bangumi: filter_site("bangumi"),
    }
}

pub fn merge_site_cookies(site_cookies: &SiteCookies, fallback_user_agent: &str) -> String {
    let user_agent = [
        &site_cookies.dmhy.raw_text,
        &site_cookies.nyaa.raw_text,
        &site_cookies.acgrip.raw_text,
        &site_cookies.bangumi.raw_text,
    ]
    .into_iter()
    .find_map(|raw_text| {
        let parsed = parse_cookie_payload(raw_text);
        parsed.user_agent.map(|value| normalized_user_agent(&value))
    })
    .unwrap_or_else(|| normalized_user_agent(fallback_user_agent));

    let mut cookies = Vec::new();
    for raw_text in [
        &site_cookies.dmhy.raw_text,
        &site_cookies.nyaa.raw_text,
        &site_cookies.acgrip.raw_text,
        &site_cookies.bangumi.raw_text,
    ] {
        cookies.extend(collect_cookie_records(parse_cookie_payload(raw_text)));
    }

    format_cookie_text(&user_agent, cookies)
}

pub fn build_site_cookie_header(
    cookie_text: &str,
    request_url: &str,
    site_domains: &[&str],
    fallback_user_agent: &str,
) -> Result<ResolvedCookieHeader, String> {
    let request_url = Url::parse(request_url)
        .map_err(|error| format!("无效的测试地址 {}: {}", request_url, error))?;
    let parsed = parse_cookie_payload(cookie_text);
    let user_agent = resolve_cookie_user_agent(&parsed, fallback_user_agent);
    let mut pairs = Vec::new();

    for cookie in collect_cookie_records(parsed) {
        let Some(host) = request_url.host_str() else {
            continue;
        };

        if !matches_site_domain(&cookie.domain, site_domains)
            || !matches_site_domain(host, &[cookie.domain.as_str()])
        {
            continue;
        }

        if cookie.secure && request_url.scheme() != "https" {
            continue;
        }

        let cookie_path = if cookie.path.is_empty() { "/" } else { cookie.path.as_str() };
        if !request_url.path().starts_with(cookie_path) {
            continue;
        }

        pairs.push(format!("{}={}", cookie.name, cookie.value));
    }

    Ok(ResolvedCookieHeader {
        user_agent,
        cookie_header: pairs.join("; "),
    })
}

pub fn get_site_cookie_text<'a>(site_cookies: &'a SiteCookies, site_code: &str) -> &'a str {
    match site_code {
        "dmhy" => &site_cookies.dmhy.raw_text,
        "nyaa" => &site_cookies.nyaa.raw_text,
        "acgrip" => &site_cookies.acgrip.raw_text,
        "bangumi" => &site_cookies.bangumi.raw_text,
        _ => "",
    }
}

pub fn set_site_cookie_text(site_cookies: &mut SiteCookies, site_code: &str, raw_text: String) {
    match site_code {
        "dmhy" => site_cookies.dmhy.raw_text = raw_text,
        "nyaa" => site_cookies.nyaa.raw_text = raw_text,
        "acgrip" => site_cookies.acgrip.raw_text = raw_text,
        "bangumi" => site_cookies.bangumi.raw_text = raw_text,
        _ => {}
    }
}

pub fn sync_profile_cookies(profile: &mut Profile) {
    if profile.site_cookies.is_empty() && !profile.cookies.trim().is_empty() {
        profile.site_cookies = split_site_cookies(&profile.cookies, &profile.user_agent);
    }

    profile.site_cookies.dmhy.raw_text =
        normalize_site_cookie_text(&profile.site_cookies.dmhy.raw_text, &profile.user_agent);
    profile.site_cookies.nyaa.raw_text =
        normalize_site_cookie_text(&profile.site_cookies.nyaa.raw_text, &profile.user_agent);
    profile.site_cookies.acgrip.raw_text =
        normalize_site_cookie_text(&profile.site_cookies.acgrip.raw_text, &profile.user_agent);
    profile.site_cookies.bangumi.raw_text =
        normalize_site_cookie_text(&profile.site_cookies.bangumi.raw_text, &profile.user_agent);

    if !profile.site_cookies.is_empty() {
        profile.cookies = merge_site_cookies(&profile.site_cookies, &profile.user_agent);
    }
}

fn normalize_profile_name(value: &str) -> Result<String, String> {
    normalize_required_value(value, "身份配置名称", ENTITY_NAME_MAX_CHARS)
}

fn normalize_store(store: &mut ProfileStore) {
    store.schema_version = PROFILE_STORE_SCHEMA_VERSION;
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
pub fn save_profile(
    app: AppHandle,
    name: String,
    mut profile: Profile,
    previous_name: Option<String>,
) -> Result<SavedProfilePayload, String> {
    let normalized_name = normalize_profile_name(&name)?;
    sync_profile_cookies(&mut profile);
    let mut store = load_profiles(&app);
    if let Some(previous_name) = previous_name.filter(|value| !value.trim().is_empty()) {
        if previous_name != normalized_name && store.profiles.contains_key(&normalized_name) {
            return Err(format!("已存在同名身份配置: {}", normalized_name));
        }

        if previous_name != normalized_name {
            store.profiles.remove(&previous_name);
        }
    }

    store.profiles.insert(normalized_name.clone(), profile.clone());
    store.last_used = Some(normalized_name.clone());
    save_profiles(&app, &store);

    Ok(SavedProfilePayload {
        name: normalized_name,
        profile,
    })
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
        profile.site_cookies = split_site_cookies(&profile.cookies, &profile.user_agent);
        sync_profile_cookies(profile);
        save_profiles(&app, &store);
    }
}

#[tauri::command]
pub fn import_cookie_file(cookie_path: String, fallback_user_agent: Option<String>) -> Result<CookieImportResult, String> {
    let raw_text = std::fs::read_to_string(&cookie_path)
        .map_err(|error| format!("读取 Cookie 文件失败: {} ({})", cookie_path, error))?;
    let fallback_user_agent = fallback_user_agent.unwrap_or_default();
    let site_cookies = split_site_cookies(&raw_text, &fallback_user_agent);
    let user_agent = resolve_site_cookie_user_agent(&raw_text, &fallback_user_agent);

    if site_cookies.is_empty() {
        return Err("未在导入的 Cookie 文件中识别到受支持站点的 Cookie。".to_string());
    }

    Ok(CookieImportResult {
        site_cookies,
        user_agent,
    })
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
        assert_eq!(store.schema_version, PROFILE_STORE_SCHEMA_VERSION);
        assert!(store.profiles.is_empty());
        assert!(store.last_used.is_none());
    }

    #[test]
    fn test_normalize_profile_name_rejects_control_chars() {
        let error = normalize_profile_name("bad\nprofile")
            .expect_err("expected control characters to be rejected");

        assert!(error.contains("控制字符"));
    }

    #[test]
    fn test_normalize_profile_name_rejects_overlong_values() {
        let error = normalize_profile_name(&"a".repeat(ENTITY_NAME_MAX_CHARS + 1))
            .expect_err("expected overlong names to be rejected");

        assert!(error.contains(&ENTITY_NAME_MAX_CHARS.to_string()));
    }

    #[test]
    fn test_split_and_merge_site_cookies() {
        let cookie_text = [
            "user-agent:\tMozilla/5.0 Test",
            "https://share.dmhy.org\tdmhy_sid=abc; domain=.dmhy.org; path=/; expires=Tue, 01 Jan 2030 00:00:00 GMT",
            "https://nyaa.si\tnyaa_sid=def; domain=.nyaa.si; path=/; expires=Tue, 01 Jan 2030 00:00:00 GMT; secure",
        ]
        .join("\n");

        let site_cookies = split_site_cookies(&cookie_text, "");
        assert!(site_cookies.dmhy.raw_text.contains("dmhy_sid"));
        assert!(site_cookies.nyaa.raw_text.contains("nyaa_sid"));
        assert!(site_cookies.acgrip.raw_text.is_empty());

        let merged = merge_site_cookies(&site_cookies, "");
        assert!(merged.contains("dmhy_sid"));
        assert!(merged.contains("nyaa_sid"));
        assert!(merged.contains("user-agent:\tMozilla/5.0 Test"));
    }

    #[test]
    fn test_sync_profile_cookies_migrates_legacy_cookie_text() {
        let mut profile = Profile {
            user_agent: "Mozilla/5.0 Migrated".to_string(),
            cookies: [
                "# Netscape HTTP Cookie File",
                ".bangumi.moe\tTRUE\t/\tFALSE\t1893456000\tbgm_sid\txyz",
            ]
            .join("\n"),
            ..Profile::default()
        };

        sync_profile_cookies(&mut profile);

        assert!(profile.site_cookies.bangumi.raw_text.contains("bgm_sid"));
        assert!(profile.site_cookies.bangumi.raw_text.contains("user-agent:\tMozilla/5.0 Migrated"));
        assert!(profile.cookies.contains("https://bangumi.moe"));
    }

    #[test]
    fn test_merge_site_cookies_outputs_okp_custom_format() {
        let merged = merge_site_cookies(&SiteCookies {
            bangumi: SiteCookieStore {
                raw_text: [
                    "user-agent:\tMozilla/5.0 Test",
                    "https://bangumi.moe\tbgm_sid=xyz; domain=.bangumi.moe; path=/; expires=Tue, 01 Jan 2030 00:00:00 GMT",
                ]
                .join("\n"),
            },
            ..SiteCookies::default()
        }, "");

        assert!(merged.contains("user-agent:\tMozilla/5.0 Test"));
        assert!(merged.contains("https://bangumi.moe\tbgm_sid=xyz; domain=bangumi.moe; path=/; expires=Tue, 01 Jan 2030 00:00:00 GMT"));
    }

    #[test]
    fn test_build_site_cookie_header_uses_custom_format() {
        let resolved = build_site_cookie_header(
            [
                "user-agent:\tMozilla/5.0 Test",
                "https://bangumi.moe\tbgm_sid=xyz; domain=.bangumi.moe; path=/; expires=Tue, 01 Jan 2030 00:00:00 GMT",
            ]
            .join("\n")
            .as_str(),
            "https://bangumi.moe/api/team/myteam",
            BANGUMI_COOKIE_DOMAINS,
            "",
        )
        .expect("expected cookie header to build");

        assert_eq!(resolved.user_agent, "Mozilla/5.0 Test");
        assert_eq!(resolved.cookie_header, "bgm_sid=xyz");
    }
}
