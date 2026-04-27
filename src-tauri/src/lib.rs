mod commands;
mod config;
mod cookies;
mod domain;
mod entity_naming;
mod profile;
mod publish;
mod services;
mod title_pattern;
mod torrent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::get_template_list,
            config::save_template,
            config::delete_template,
            config::save_proxy,
            config::get_proxy,
            config::save_okp_executable_path,
            config::save_quick_publish_template,
            config::delete_quick_publish_template,
            config::save_content_template,
            config::delete_content_template,
            config::update_template_publish_history,
            config::update_quick_publish_template_publish_history,
            config::export_quick_publish_template_to_file,
            config::import_quick_publish_template_from_file,
            config::export_content_template_to_file,
            config::import_content_template_from_file,
            config::export_template_to_file,
            config::import_template_from_file,
            profile::get_profiles,
            profile::get_profile_list,
            profile::save_profile,
            profile::delete_profile,
            profile::update_profile_cookies,
            profile::import_cookie_file,
            torrent::parse_torrent,
            title_pattern::parse_title_details,
            title_pattern::match_title,
            title_pattern::extract_episode_value,
            title_pattern::extract_resolution_value,
            cookies::start_cookie_capture,
            cookies::finish_cookie_capture,
            cookies::cancel_cookie_capture,
            cookies::test_site_login,
            publish::publish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
