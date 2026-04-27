use tauri::AppHandle;

use crate::profile::{
    load_profiles, normalize_site_cookie_text, save_profiles, set_site_cookie_text,
    sync_profile_cookies,
};
use crate::publish::SitePublishResult;

pub(crate) fn persist_updated_site_cookies(
    app: &AppHandle,
    profile_name: &str,
    results: &[SitePublishResult],
) {
    if results
        .iter()
        .all(|result| updated_cookie_text_for_persistence(result).is_none())
    {
        return;
    }

    let mut profiles = load_profiles(app);
    let Some(profile) = profiles.profiles.get_mut(profile_name) else {
        return;
    };

    for result in results {
        if let Some(cookie_text) = updated_cookie_text_for_persistence(result) {
            set_site_cookie_text(
                &mut profile.site_cookies,
                &result.site_code,
                normalize_site_cookie_text(cookie_text, &profile.user_agent),
            );
        }
    }

    sync_profile_cookies(profile);
    save_profiles(app, &profiles);
}

pub(crate) fn updated_cookie_text_for_persistence(result: &SitePublishResult) -> Option<&str> {
    if result.success {
        result.updated_cookie_text.as_deref()
    } else {
        None
    }
}

pub(crate) fn build_publish_summary(results: &[SitePublishResult]) -> (bool, String) {
    let failed_sites = results
        .iter()
        .filter(|result| !result.success)
        .map(|result| result.site_label.clone())
        .collect::<Vec<_>>();

    if failed_sites.is_empty() {
        (true, format!("{} 个站点全部发布完成", results.len()))
    } else {
        (
            false,
            format!("以下站点发布失败: {}", failed_sites.join("、")),
        )
    }
}