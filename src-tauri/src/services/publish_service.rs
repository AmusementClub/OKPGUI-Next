use tauri::AppHandle;

use crate::publish::{
    collect_site_publish_configs, find_okp_executable, run_site_publish, validate_torrent_path,
    PublishGuard, PublishRequest,
};
use crate::publish::publish_events::emit_publish_site_complete;
use crate::publish::publish_history::{build_publish_summary, persist_updated_site_cookies};
use crate::profile::load_profiles;

pub fn run_publish(app: &AppHandle, request: &PublishRequest) -> Result<String, String> {
    let _publish_guard = PublishGuard::acquire()?;

    let okp_core = find_okp_executable(app)?;
    let torrent_path = validate_torrent_path(&request.torrent_path)?;
    let profiles = load_profiles(app);
    let profile = profiles
        .profiles
        .get(&request.profile_name)
        .cloned()
        .ok_or_else(|| format!("配置不存在: {}", request.profile_name))?;

    let selected_sites = collect_site_publish_configs(&request.template, &profile)
        .into_iter()
        .filter(|site| site.enabled)
        .collect::<Vec<_>>();

    if selected_sites.is_empty() {
        return Err("至少选择一个发布站点后才能发布。".to_string());
    }

    let mut handles = Vec::new();
    for site in selected_sites {
        let app_handle = app.clone();
        let publish_id = request.publish_id.clone();
        let okp_core = okp_core.clone();
        let torrent_path = torrent_path.clone();
        let template = request.template.clone();
        let profile = profile.clone();
        let site_for_join = site.clone();

        let handle = std::thread::spawn(move || {
            let result = run_site_publish(
                &app_handle,
                &publish_id,
                &okp_core,
                &torrent_path,
                &template,
                &profile,
                &site,
            );
            emit_publish_site_complete(&app_handle, &publish_id, &result);
            result
        });

        handles.push((site_for_join, handle));
    }

    let mut results = Vec::new();
    for (site, handle) in handles {
        let result = match handle.join() {
            Ok(result) => result,
            Err(_) => site.build_result(false, format!("{} 发布线程异常退出", site.label), None),
        };
        results.push(result);
    }

    persist_updated_site_cookies(app, &request.profile_name, &results);
    let (success, message) = build_publish_summary(&results);

    if success {
        Ok(message)
    } else {
        Err(message)
    }
}