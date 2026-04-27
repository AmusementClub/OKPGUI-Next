pub use crate::domain::cookie::{CookieCaptureResult, LoginTestResult};

#[cfg(test)]
fn get_login_url(site: &str) -> Result<&'static str, String> {
    crate::domain::cookie::get_login_url(site)
}

#[cfg(test)]
fn get_cookie_domains(site: &str) -> Vec<&'static str> {
    crate::domain::cookie::get_cookie_domains(site)
}

#[cfg(test)]
fn matches_site_domain(domain: &str, candidates: &[&str]) -> bool {
    crate::services::cookie_capture_service::matches_site_domain(domain, candidates)
}

#[cfg(test)]
fn browser_path_candidates(path_env: Option<&std::ffi::OsStr>) -> Vec<std::path::PathBuf> {
    crate::services::cookie_capture_service::browser_path_candidates(path_env)
}

#[cfg(test)]
fn collect_browser_executable_candidates(
    path_env: Option<&std::ffi::OsStr>,
    home_dir: Option<&std::path::Path>,
    local_app_data: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    crate::services::cookie_capture_service::collect_browser_executable_candidates(
        path_env,
        home_dir,
        local_app_data,
    )
}

#[tauri::command]
pub async fn start_cookie_capture(site: String) -> Result<String, String> {
    crate::commands::profile_commands::start_cookie_capture(site).await
}

#[tauri::command]
pub async fn finish_cookie_capture(session_id: String) -> Result<CookieCaptureResult, String> {
    crate::commands::profile_commands::finish_cookie_capture(session_id).await
}

#[tauri::command]
pub async fn cancel_cookie_capture(session_id: String) -> Result<(), String> {
    crate::commands::profile_commands::cancel_cookie_capture(session_id).await
}

#[tauri::command]
pub async fn test_site_login(
    app: tauri::AppHandle,
    site: String,
    cookie_text: String,
    user_agent: Option<String>,
    expected_name: Option<String>,
) -> Result<LoginTestResult, String> {
    crate::commands::profile_commands::test_site_login(
        app,
        site,
        cookie_text,
        user_agent,
        expected_name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn test_get_login_url() {
        assert_eq!(
            get_login_url("nyaa").expect("expected nyaa login URL"),
            "https://nyaa.si/login"
        );
        assert!(get_login_url("unknown").is_err());
    }

    #[test]
    fn test_get_cookie_domains() {
        let domains = get_cookie_domains("nyaa");
        assert_eq!(domains, vec!["nyaa.si", ".nyaa.si"]);
    }

    #[test]
    fn test_matches_site_domain() {
        let domains = get_cookie_domains("nyaa");
        assert!(matches_site_domain(".nyaa.si", &domains));
        assert!(matches_site_domain("upload.nyaa.si", &domains));
        assert!(!matches_site_domain("example.com", &domains));
        assert!(!matches_site_domain("totallynotnyaa.si", &domains));
    }

    fn create_temp_browser_file(file_name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "okpgui-next-browser-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("expected browser temp dir to be created");
        let browser_path = root.join(file_name);
        std::fs::write(&browser_path, "browser").expect("expected browser file to be created");
        (root, browser_path)
    }

    #[test]
    fn test_browser_path_candidates_detect_path_entry() {
        #[cfg(target_os = "windows")]
        let command_name = "chrome.exe";
        #[cfg(target_os = "macos")]
        let command_name = "Google Chrome";
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let command_name = "google-chrome";

        let (root, browser_path) = create_temp_browser_file(command_name);
        let path_env = OsString::from(root.as_os_str());
        let candidates = browser_path_candidates(Some(path_env.as_os_str()));

        assert!(candidates.contains(&browser_path));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_collect_browser_candidates_include_local_app_data_paths() {
        let (root, browser_path) = create_temp_browser_file("chrome.exe");
        let local_app_data = root.join("LocalAppData");
        let chrome_dir = local_app_data.join(r"Google\Chrome\Application");
        std::fs::create_dir_all(&chrome_dir).expect("expected local app data browser dir");
        let local_browser = chrome_dir.join("chrome.exe");
        std::fs::write(&local_browser, "browser").expect("expected local browser file");

        let candidates = collect_browser_executable_candidates(
            None,
            None,
            Some(local_app_data.as_path()),
        );

        assert!(candidates.contains(&local_browser));
        assert!(!candidates.contains(&browser_path));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_collect_browser_candidates_include_home_applications() {
        let root = std::env::temp_dir().join(format!(
            "okpgui-next-macos-browser-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let browser_path = root.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        std::fs::create_dir_all(
            browser_path
                .parent()
                .expect("expected browser parent directory"),
        )
        .expect("expected macOS browser dir");
        std::fs::write(&browser_path, "browser").expect("expected macOS browser file");

        let candidates = collect_browser_executable_candidates(None, Some(root.as_path()), None);
        assert!(candidates.contains(&browser_path));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    #[test]
    fn test_collect_browser_candidates_include_linux_path_entries() {
        let (root, browser_path) = create_temp_browser_file("google-chrome");
        let path_env = OsString::from(root.as_os_str());
        let candidates = collect_browser_executable_candidates(
            Some(path_env.as_os_str()),
            None,
            None,
        );

        assert!(candidates.contains(&browser_path));

        let _ = std::fs::remove_dir_all(root);
    }
}