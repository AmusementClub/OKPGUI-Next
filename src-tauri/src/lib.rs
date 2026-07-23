mod ai;
mod atomic_file;
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
        .setup(|app| {
            // Reconcile any in-flight credential rotation journal before normal AI use.
            // Idempotent / fail closed; never exposes secrets over IPC.
            commands::ai_commands::init_ai_credential_journal_recovery(app.handle().clone());
            // Optional durable AI debug store under app_local_data_dir.
            // No network; safe with AI disabled; corrupt store is isolated without panic.
            commands::ai_commands::init_ai_debug_store(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::get_config_load_error,
            config::save_template,
            config::delete_template,
            config::set_last_used_template,
            config::set_last_used_quick_publish_template,
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
            profile::import_cookie_file,
            torrent::parse_torrent,
            title_pattern::parse_title_details,
            cookies::start_cookie_capture,
            cookies::finish_cookie_capture,
            cookies::cancel_cookie_capture,
            cookies::test_site_login,
            // Raw PublishRequest publish IPC retired: use prepare_plan + publish_prepared_plan only.
            // publish::publish / publish_legacy remain internal helpers (unregistered).
            commands::publish_commands::prepare_plan,
            commands::publish_commands::inspect_plan,
            commands::publish_commands::invalidate_plan,
            commands::publish_commands::set_plan_acknowledgements,
            commands::publish_commands::publish_prepared_plan,
            commands::ai_commands::ai_validate_custom_header,
            commands::ai_commands::ai_get_settings,
            commands::ai_commands::ai_save_settings,
            commands::ai_commands::ai_has_secret,
            commands::ai_commands::ai_clear_secret,
            commands::ai_commands::ai_discover_media,
            // MediaInfo is a backend-owned AiJob: start / poll / result; cancel via ai_cancel_job.
            // Absolute per-file probe paths are never accepted as IPC authority.
            commands::ai_commands::ai_start_media_info,
            commands::ai_commands::ai_poll_media_info,
            commands::ai_commands::ai_get_media_info_result,
            commands::ai_commands::ai_extract_vision_images,
            commands::ai_commands::ai_normalize_vision_image,
            // Plan-token Vision: list candidates from bound final content, bind after
            // explicit over-cap selection, then formal audit attaches provider image parts.
            commands::ai_commands::ai_list_plan_vision_candidates,
            commands::ai_commands::ai_bind_plan_vision,
            // TemplateSelection is a backend-owned AiJob: start / poll; cancel via ai_cancel_job.
            // Seed mint only on Succeeded; cancel/stale/late completion never hand off a seed.
            commands::ai_commands::ai_start_template_selection,
            commands::ai_commands::ai_poll_template_selection,
            // Recognition is a backend-owned AiJob: start / poll; cancel via ai_cancel_job.
            // Validated result only on Succeeded; cancel/stale/late completion never surfaces it.
            // ai_recognize remains as a one-shot compatibility path over the same lifecycle.
            commands::ai_commands::ai_start_recognition,
            commands::ai_commands::ai_poll_recognition,
            commands::ai_commands::ai_recognize,
            commands::ai_commands::ai_prepare_template_seed,
            commands::ai_commands::ai_inspect_template_seed,
            commands::ai_commands::ai_consume_template_seed,
            commands::ai_commands::ai_redact_value,
            commands::ai_commands::ai_project_context,
            commands::ai_commands::ai_compute_audit,
            // Start returns PENDING+job_id immediately; poll reads plan-bound terminal evidence.
            // Job lifecycle mutations (start/complete/mark_stale) are crate-private only.
            // Webview may read status or cancel; it cannot forge job records.
            // No credential get command and no webview job creation/completion.
            commands::ai_commands::ai_start_formal_audit,
            commands::ai_commands::ai_poll_formal_audit,
            commands::ai_commands::ai_get_job,
            commands::ai_commands::ai_list_jobs,
            commands::ai_commands::ai_cancel_job,
            // Non-secret debug-record IPC only (bounded retention; no raw bodies/secrets).
            // Export returns safe basename metadata only (redacted bundle + canary scan).
            commands::ai_commands::ai_list_debug_records,
            commands::ai_commands::ai_clear_debug_records,
            commands::ai_commands::ai_export_debug_records,
            commands::ai_commands::ai_open_debug_directory,
            commands::ai_commands::ai_build_capability_probe,
            commands::ai_commands::ai_classify_capability_probe,
            commands::ai_commands::ai_list_models,
            commands::ai_commands::ai_run_capability_probe,
            commands::ai_commands::ai_get_capability_status,
            commands::ai_commands::ai_connection_identity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Cancel unfinished AI jobs on process exit so late completions cannot bind.
            if let tauri::RunEvent::Exit = event {
                commands::ai_commands::cancel_unfinished_ai_jobs_on_exit();
            }
        });
}
