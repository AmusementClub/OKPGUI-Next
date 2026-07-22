use tauri::AppHandle;

use crate::profile::{
    normalize_site_cookie_text, profile_store_lock, save_profiles, set_site_cookie_text,
    sync_profile_cookies, try_load_profiles,
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

    // Serialize against IdentityPage autosave: load-mutate-save must be atomic
    // or a concurrent save_profile can lose these cookie updates (or vice versa).
    let _guard = profile_store_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut profiles = match try_load_profiles(app) {
        Ok(profiles) => profiles,
        Err(error) => {
            // Never clobber a corrupt profile store with defaults.
            eprintln!("[okpgui] 跳过发布后的 Cookie 持久化: {}", error);
            return;
        }
    };
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
    if let Err(error) = save_profiles(app, &profiles) {
        eprintln!("[okpgui] 发布后的 Cookie 持久化失败: {}", error);
    }
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
