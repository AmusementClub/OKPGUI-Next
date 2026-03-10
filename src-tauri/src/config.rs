use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SiteSelection {
    pub dmhy: bool,
    pub nyaa: bool,
    pub acgrip: bool,
    pub bangumi: bool,
    pub acgnx_asia: bool,
    pub acgnx_global: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Template {
    pub ep_pattern: String,
    pub title_pattern: String,
    pub poster: String,
    pub about: String,
    pub tags: String,
    pub description: String,
    pub profile: String,
    pub title: String,
    pub sites: SiteSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub proxy_type: String,
    pub proxy_host: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            proxy_type: "none".to_string(),
            proxy_host: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub last_used_template: Option<String>,
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub okp_executable_path: String,
    pub templates: HashMap<String, Template>,
}

fn config_path(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("okpgui_config.json")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = config_path(app);
    if path.exists() {
        let data = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn save_config_to_disk(app: &AppHandle, config: &AppConfig) {
    let path = config_path(app);
    if let Ok(data) = serde_json::to_string_pretty(config) {
        std::fs::write(path, data).ok();
    }
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
pub fn get_template_list(app: AppHandle) -> Vec<String> {
    let config = load_config(&app);
    config.templates.keys().cloned().collect()
}

#[tauri::command]
pub fn save_template(app: AppHandle, name: String, template: Template) {
    let mut config = load_config(&app);
    config.templates.insert(name.clone(), template);
    config.last_used_template = Some(name);
    save_config_to_disk(&app, &config);
}

#[tauri::command]
pub fn delete_template(app: AppHandle, name: String) {
    let mut config = load_config(&app);
    config.templates.remove(&name);
    if config.last_used_template.as_deref() == Some(&name) {
        config.last_used_template = None;
    }
    save_config_to_disk(&app, &config);
}

#[tauri::command]
pub fn save_proxy(app: AppHandle, proxy_type: String, proxy_host: String) {
    let mut config = load_config(&app);
    config.proxy = ProxyConfig {
        proxy_type,
        proxy_host,
    };
    save_config_to_disk(&app, &config);
}

#[tauri::command]
pub fn get_proxy(app: AppHandle) -> ProxyConfig {
    load_config(&app).proxy
}

#[tauri::command]
pub fn save_okp_executable_path(app: AppHandle, okp_executable_path: String) {
    let mut config = load_config(&app);
    config.okp_executable_path = okp_executable_path;
    save_config_to_disk(&app, &config);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert!(config.templates.is_empty());
        assert_eq!(config.proxy.proxy_type, "none");
        assert!(config.okp_executable_path.is_empty());
        assert!(config.last_used_template.is_none());
    }

    #[test]
    fn test_site_selection_default() {
        let sites = SiteSelection::default();
        assert!(!sites.dmhy);
        assert!(!sites.nyaa);
        assert!(!sites.acgrip);
        assert!(!sites.bangumi);
        assert!(!sites.acgnx_asia);
        assert!(!sites.acgnx_global);
    }
}
