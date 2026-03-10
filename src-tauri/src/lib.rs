mod config;
mod cookies;
mod profile;
mod publish;
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
            profile::get_profiles,
            profile::get_profile_list,
            profile::save_profile,
            profile::delete_profile,
            profile::update_profile_cookies,
            torrent::parse_torrent,
            title_pattern::match_title,
            cookies::start_cookie_capture,
            cookies::finish_cookie_capture,
            cookies::cancel_cookie_capture,
            cookies::test_site_login,
            publish::publish,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
