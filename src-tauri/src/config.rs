use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableTemplate {
    pub ep_pattern: String,
    pub title_pattern: String,
    pub poster: String,
    pub about: String,
    pub tags: String,
    pub description: String,
    #[serde(default)]
    pub description_html: String,
    pub profile: String,
    pub title: String,
    #[serde(default)]
    pub publish_history: SitePublishHistory,
}

impl From<Template> for PortableTemplate {
    fn from(template: Template) -> Self {
        Self {
            ep_pattern: template.ep_pattern,
            title_pattern: template.title_pattern,
            poster: template.poster,
            about: template.about,
            tags: template.tags,
            description: template.description,
            description_html: template.description_html,
            profile: template.profile,
            title: template.title,
            publish_history: template.publish_history,
        }
    }
}

impl From<PortableTemplate> for Template {
    fn from(template: PortableTemplate) -> Self {
        Self {
            ep_pattern: template.ep_pattern,
            title_pattern: template.title_pattern,
            poster: template.poster,
            about: template.about,
            tags: template.tags,
            description: template.description,
            description_html: template.description_html,
            profile: template.profile,
            title: template.title,
            publish_history: template.publish_history,
            sites: SiteSelection::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportedTemplateFile {
    #[serde(default)]
    name: String,
    template: PortableTemplate,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedTemplatePayload {
    pub name: String,
    pub template: Template,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum TemplateImportFileFormat {
    Wrapped(ImportedTemplateFile),
    Portable(PortableTemplate),
    Raw(Template),
}

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
pub struct SitePublishHistoryEntry {
    #[serde(default)]
    pub last_published_at: String,
    #[serde(default)]
    pub last_published_episode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SitePublishHistory {
    #[serde(default)]
    pub dmhy: SitePublishHistoryEntry,
    #[serde(default)]
    pub nyaa: SitePublishHistoryEntry,
    #[serde(default)]
    pub acgrip: SitePublishHistoryEntry,
    #[serde(default)]
    pub bangumi: SitePublishHistoryEntry,
    #[serde(default)]
    pub acgnx_asia: SitePublishHistoryEntry,
    #[serde(default)]
    pub acgnx_global: SitePublishHistoryEntry,
}

impl SitePublishHistory {
    fn get_mut(&mut self, site_key: &str) -> Option<&mut SitePublishHistoryEntry> {
        match site_key {
            "dmhy" => Some(&mut self.dmhy),
            "nyaa" => Some(&mut self.nyaa),
            "acgrip" => Some(&mut self.acgrip),
            "bangumi" => Some(&mut self.bangumi),
            "acgnx_asia" => Some(&mut self.acgnx_asia),
            "acgnx_global" => Some(&mut self.acgnx_global),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TemplatePublishHistoryUpdate {
    pub site_key: String,
    pub last_published_at: String,
    pub last_published_episode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Template {
    pub ep_pattern: String,
    pub title_pattern: String,
    pub poster: String,
    pub about: String,
    pub tags: String,
    pub description: String,
    #[serde(default)]
    pub description_html: String,
    pub profile: String,
    pub title: String,
    #[serde(default)]
    pub publish_history: SitePublishHistory,
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

#[tauri::command]
pub fn update_template_publish_history(
    app: AppHandle,
    name: String,
    updates: Vec<TemplatePublishHistoryUpdate>,
) -> Result<(), String> {
    let mut config = load_config(&app);
    let template = config
        .templates
        .get_mut(&name)
        .ok_or_else(|| format!("未找到模板: {}", name))?;

    for update in updates {
        let history_entry = template
            .publish_history
            .get_mut(&update.site_key)
            .ok_or_else(|| format!("不支持的站点代码: {}", update.site_key))?;
        history_entry.last_published_at = update.last_published_at;
        history_entry.last_published_episode = update.last_published_episode;
    }

    save_config_to_disk(&app, &config);
    Ok(())
}

#[tauri::command]
pub fn export_template_to_file(app: AppHandle, name: String, path: String) -> Result<(), String> {
    let config = load_config(&app);
    let template = config
        .templates
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("未找到模板: {}", name))?;

    let export_payload = ImportedTemplateFile {
        name,
        template: template.into(),
    };

    let export_path = PathBuf::from(&path);
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建导出目录: {}", error))?;
    }

    let file_content = serde_json::to_string_pretty(&export_payload)
        .map_err(|error| format!("无法序列化模板文件: {}", error))?;

    std::fs::write(&export_path, file_content)
        .map_err(|error| format!("无法导出模板文件: {}", error))?;

    Ok(())
}

#[tauri::command]
pub fn import_template_from_file(app: AppHandle, path: String) -> Result<ImportedTemplatePayload, String> {
    let import_path = PathBuf::from(&path);
    let file_content = std::fs::read_to_string(&import_path)
        .map_err(|error| format!("无法读取模板文件: {}", error))?;

    let import_file: TemplateImportFileFormat = serde_json::from_str(&file_content)
        .map_err(|error| format!("模板文件格式无效: {}", error))?;

    let (name, template) = match import_file {
        TemplateImportFileFormat::Wrapped(file) => {
            let imported_name = file.name.trim().to_string();
            let fallback_name = import_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("imported-template")
                .to_string();
            let resolved_name = if imported_name.is_empty() {
                fallback_name
            } else {
                imported_name
            };

            (resolved_name, Template::from(file.template))
        }
        TemplateImportFileFormat::Portable(template) => ( 
            import_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("imported-template")
                .to_string(),
            Template::from(template),
        ),
        TemplateImportFileFormat::Raw(template) => {
            let fallback_name = import_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("imported-template")
                .to_string();
            (
                fallback_name,
                Template {
                    sites: SiteSelection::default(),
                    ..template
                },
            )
        }
    };

    let mut config = load_config(&app);
    config.templates.insert(name.clone(), template.clone());
    config.last_used_template = Some(name.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedTemplatePayload { name, template })
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

    #[test]
    fn test_portable_template_omits_site_selection() {
        let template = Template {
            ep_pattern: "(?P<ep>\\d+)".to_string(),
            title_pattern: "<ep>".to_string(),
            poster: "poster".to_string(),
            about: "about".to_string(),
            tags: "tags".to_string(),
            description: "description".to_string(),
            description_html: "<p>description</p>".to_string(),
            profile: "profile".to_string(),
            title: "title".to_string(),
            publish_history: SitePublishHistory::default(),
            sites: SiteSelection {
                dmhy: true,
                nyaa: true,
                acgrip: false,
                bangumi: false,
                acgnx_asia: false,
                acgnx_global: true,
            },
        };

        let portable = PortableTemplate::from(template);
        let restored = Template::from(portable);

        assert!(!restored.sites.dmhy);
        assert!(!restored.sites.nyaa);
        assert!(!restored.sites.acgnx_global);
    }
}
