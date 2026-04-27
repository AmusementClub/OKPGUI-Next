use crate::entity_naming::{
    build_copy_name, import_conflict_error, next_available_copy_id, next_available_copy_name,
    normalize_optional_name, normalize_required_value, ImportConflictStrategy,
    ENTITY_ID_MAX_CHARS, ENTITY_NAME_MAX_CHARS,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const TEMPLATE_REGEX_MAX_CHARS: usize = 4096;
const CONFIG_SCHEMA_VERSION: u32 = 2;
const TEMPLATE_REVISION_CONFLICT_PREFIX: &str = "TEMPLATE_REVISION_CONFLICT:";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableTemplate {
    pub ep_pattern: String,
    #[serde(default)]
    pub resolution_pattern: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContentTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub markdown: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub site_notes: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuickPublishTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub ep_pattern: String,
    #[serde(default)]
    pub resolution_pattern: String,
    #[serde(default)]
    pub title_pattern: String,
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub about: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub default_profile: String,
    #[serde(default)]
    pub default_sites: SiteSelection,
    #[serde(default)]
    pub body_markdown: String,
    #[serde(default)]
    pub body_html: String,
    #[serde(default)]
    pub shared_content_template_id: Option<String>,
    #[serde(default, rename = "content_template_id", skip_serializing)]
    pub legacy_content_template_id: Option<String>,
    #[serde(default)]
    pub publish_history: SitePublishHistory,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub revision: u64,
}

impl From<Template> for PortableTemplate {
    fn from(template: Template) -> Self {
        Self {
            ep_pattern: template.ep_pattern,
            resolution_pattern: template.resolution_pattern,
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
            resolution_pattern: template.resolution_pattern,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportedQuickPublishTemplateFile {
    #[serde(default)]
    id: String,
    template: QuickPublishTemplate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportedContentTemplateFile {
    #[serde(default)]
    id: String,
    template: ContentTemplate,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedTemplatePayload {
    pub name: String,
    pub template: Template,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedQuickPublishTemplatePayload {
    pub id: String,
    pub template: QuickPublishTemplate,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedContentTemplatePayload {
    pub id: String,
    pub template: ContentTemplate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TemplateRevisionConflictPayload {
    pub entity_id: String,
    pub current_revision: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum TemplateImportFileFormat {
    Wrapped(ImportedTemplateFile),
    Portable(PortableTemplate),
    Raw(Template),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum QuickPublishTemplateImportFileFormat {
    Wrapped(ImportedQuickPublishTemplateFile),
    Raw(QuickPublishTemplate),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ContentTemplateImportFileFormat {
    Wrapped(ImportedContentTemplateFile),
    Raw(ContentTemplate),
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
    #[serde(default)]
    pub last_published_resolution: String,
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
    #[serde(default)]
    pub last_published_resolution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Template {
    pub ep_pattern: String,
    #[serde(default)]
    pub resolution_pattern: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_config_schema_version")]
    pub schema_version: u32,
    pub last_used_template: Option<String>,
    #[serde(default)]
    pub last_used_quick_publish_template: Option<String>,
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub okp_executable_path: String,
    #[serde(default)]
    pub templates: HashMap<String, Template>,
    #[serde(default)]
    pub quick_publish_templates: HashMap<String, QuickPublishTemplate>,
    #[serde(default)]
    pub content_templates: HashMap<String, ContentTemplate>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: default_config_schema_version(),
            last_used_template: None,
            last_used_quick_publish_template: None,
            proxy: ProxyConfig::default(),
            okp_executable_path: String::new(),
            templates: HashMap::new(),
            quick_publish_templates: HashMap::new(),
            content_templates: HashMap::new(),
        }
    }
}

fn default_config_schema_version() -> u32 {
    CONFIG_SCHEMA_VERSION
}

fn revision_conflict_error(
    entity_label: &str,
    entity_id: &str,
    current_revision: Option<u64>,
) -> String {
    let message = if current_revision.is_some() {
        format!(
            "{}\"{}\"已被其他会话更新，请重新加载、覆盖保存，或另存为副本。",
            entity_label, entity_id
        )
    } else {
        format!(
            "{}\"{}\"已被其他会话删除，请重新加载、覆盖保存，或另存为副本。",
            entity_label, entity_id
        )
    };
    let payload = TemplateRevisionConflictPayload {
        entity_id: entity_id.to_string(),
        current_revision,
        message,
    };

    let serialized = serde_json::to_string(&payload).unwrap_or_else(|_| {
        String::from(
            "{\"entity_id\":\"\",\"current_revision\":null,\"message\":\"模板保存冲突。\"}",
        )
    });

    format!("{}{}", TEMPLATE_REVISION_CONFLICT_PREFIX, serialized)
}

fn resolve_next_template_revision(
    entity_label: &str,
    entity_id: &str,
    current_revision: Option<u64>,
    expected_revision: Option<u64>,
) -> Result<u64, String> {
    match expected_revision {
        Some(expected_revision) => {
            let current_revision = current_revision.unwrap_or(0);

            if current_revision != expected_revision {
                return Err(revision_conflict_error(
                    entity_label,
                    entity_id,
                    Some(current_revision),
                ));
            }

            Ok(current_revision.saturating_add(1))
        }
        None => {
            if current_revision.is_some() {
                return Err(revision_conflict_error(
                    entity_label,
                    entity_id,
                    current_revision,
                ));
            }

            Ok(1)
        }
    }
}

fn validate_template_regex_field(field_label: &str, pattern: &str) -> Result<(), String> {
    if pattern.trim().is_empty() {
        return Ok(());
    }

    let pattern_length = pattern.chars().count();
    if pattern_length > TEMPLATE_REGEX_MAX_CHARS {
        return Err(format!(
            "{}不能超过 {} 个字符。",
            field_label, TEMPLATE_REGEX_MAX_CHARS
        ));
    }

    Regex::new(pattern).map_err(|error| format!("{}格式无效: {}", field_label, error))?;
    Ok(())
}

fn validate_template_regex_patterns(ep_pattern: &str, resolution_pattern: &str) -> Result<(), String> {
    validate_template_regex_field("集数正则", ep_pattern)?;
    validate_template_regex_field("分辨率正则", resolution_pattern)?;
    Ok(())
}

fn normalize_template_storage_name(value: &str) -> Result<String, String> {
    normalize_required_value(value, "模板名称", ENTITY_NAME_MAX_CHARS)
}

fn normalize_quick_publish_template_for_storage(
    template: &mut QuickPublishTemplate,
) -> Result<String, String> {
    let template_id = normalize_required_value(&template.id, "快速发布模板 ID", ENTITY_ID_MAX_CHARS)?;
    let template_name = normalize_optional_name(&template.name, &template_id, "模板名称", ENTITY_NAME_MAX_CHARS)?;

    template.id = template_id.clone();
    template.name = template_name;
    template.default_profile = template.default_profile.trim().to_string();
    template.shared_content_template_id = template
        .shared_content_template_id
        .take()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
    template.legacy_content_template_id = None;

    validate_quick_publish_template_for_storage(template)?;
    Ok(template_id)
}

fn normalize_content_template_for_storage(template: &mut ContentTemplate) -> Result<String, String> {
    let template_id = normalize_required_value(&template.id, "正文模板 ID", ENTITY_ID_MAX_CHARS)?;
    let template_name = normalize_optional_name(&template.name, &template_id, "模板名称", ENTITY_NAME_MAX_CHARS)?;

    template.id = template_id.clone();
    template.name = template_name;

    Ok(template_id)
}

fn resolve_existing_key<T>(existing: &HashMap<String, T>, candidate: Option<String>) -> Option<String> {
    let candidate = candidate?;
    if existing.contains_key(candidate.as_str()) {
        return Some(candidate);
    }

    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    if existing.contains_key(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn resolve_import_name_conflict<T>(
    desired_name: String,
    existing: &HashMap<String, T>,
    strategy: ImportConflictStrategy,
) -> Result<String, String> {
    if !existing.contains_key(desired_name.as_str()) {
        return Ok(desired_name);
    }

    match strategy {
        ImportConflictStrategy::Reject => Err(import_conflict_error(&desired_name)),
        ImportConflictStrategy::Overwrite => Ok(desired_name),
        ImportConflictStrategy::Copy => {
            Ok(next_available_copy_name(&desired_name, existing, ENTITY_NAME_MAX_CHARS))
        }
    }
}

fn resolve_import_id_conflict<T>(
    desired_id: String,
    existing: &HashMap<String, T>,
    strategy: ImportConflictStrategy,
) -> Result<String, String> {
    if !existing.contains_key(desired_id.as_str()) {
        return Ok(desired_id);
    }

    match strategy {
        ImportConflictStrategy::Reject => Err(import_conflict_error(&desired_id)),
        ImportConflictStrategy::Overwrite => Ok(desired_id),
        ImportConflictStrategy::Copy => {
            Ok(next_available_copy_id(&desired_id, existing, ENTITY_ID_MAX_CHARS))
        }
    }
}

fn validate_template_for_storage(template: &Template) -> Result<(), String> {
    validate_template_regex_patterns(&template.ep_pattern, &template.resolution_pattern)
}

fn validate_quick_publish_template_for_storage(template: &QuickPublishTemplate) -> Result<(), String> {
    validate_template_regex_patterns(&template.ep_pattern, &template.resolution_pattern)
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
        let mut config: AppConfig = serde_json::from_str(&data).unwrap_or_default();
        migrate_config(&mut config);
        config
    } else {
        AppConfig::default()
    }
}

fn migrate_config(config: &mut AppConfig) {
    migrate_quick_publish_templates(config);
    config.last_used_template = resolve_existing_key(&config.templates, config.last_used_template.take());
    config.last_used_quick_publish_template = resolve_existing_key(
        &config.quick_publish_templates,
        config.last_used_quick_publish_template.take(),
    );
    config.schema_version = CONFIG_SCHEMA_VERSION;
}

fn migrate_quick_publish_templates(config: &mut AppConfig) {
    let content_templates = config.content_templates.clone();

    for (template_id, template) in config.quick_publish_templates.iter_mut() {
        migrate_quick_publish_template(template, &content_templates);
        template.id = template_id.clone();
        if template.name.trim().is_empty() {
            template.name = template_id.clone();
        } else {
            template.name = template.name.trim().to_string();
        }
    }

    for (template_id, template) in config.content_templates.iter_mut() {
        template.id = template_id.clone();
        if template.name.trim().is_empty() {
            template.name = template_id.clone();
        } else {
            template.name = template.name.trim().to_string();
        }
    }
}

fn migrate_quick_publish_template(
    template: &mut QuickPublishTemplate,
    content_templates: &HashMap<String, ContentTemplate>,
) {
    let legacy_template_id = template.legacy_content_template_id.take();

    if template.shared_content_template_id.is_none()
        && template.body_markdown.trim().is_empty()
        && template.body_html.trim().is_empty()
    {
        if let Some(content_template_id) = legacy_template_id.as_deref() {
            if let Some(content_template) = content_templates.get(content_template_id) {
                template.body_markdown = content_template.markdown.clone();
                template.body_html = content_template.html.clone();
            }
        }
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
pub fn save_template(
    app: AppHandle,
    name: String,
    template: Template,
    previous_name: Option<String>,
) -> Result<ImportedTemplatePayload, String> {
    let normalized_name = normalize_template_storage_name(&name)?;
    validate_template_for_storage(&template)?;

    let mut config = load_config(&app);
    if let Some(previous_name) = previous_name.filter(|value| !value.trim().is_empty()) {
        if previous_name != normalized_name && config.templates.contains_key(&normalized_name) {
            return Err(format!("已存在同名模板: {}", normalized_name));
        }

        if previous_name != normalized_name {
            config.templates.remove(&previous_name);
        }
    }

    config.templates.insert(normalized_name.clone(), template.clone());
    config.last_used_template = Some(normalized_name.clone());
    save_config_to_disk(&app, &config);
    Ok(ImportedTemplatePayload {
        name: normalized_name,
        template,
    })
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
pub fn save_quick_publish_template(
    app: AppHandle,
    mut template: QuickPublishTemplate,
    expected_revision: Option<u64>,
) -> Result<ImportedQuickPublishTemplatePayload, String> {
    let template_id = normalize_quick_publish_template_for_storage(&mut template)?;

    let mut config = load_config(&app);
    let current_revision = config
        .quick_publish_templates
        .get(&template_id)
        .map(|existing| existing.revision);
    template.revision = resolve_next_template_revision(
        "发布模板",
        &template_id,
        current_revision,
        expected_revision,
    )?;
    config
        .quick_publish_templates
        .insert(template_id.clone(), template.clone());
    config.last_used_quick_publish_template = Some(template_id.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedQuickPublishTemplatePayload {
        id: template_id,
        template,
    })
}

#[tauri::command]
pub fn delete_quick_publish_template(app: AppHandle, id: String) -> Result<(), String> {
    let mut config = load_config(&app);
    if config.quick_publish_templates.remove(&id).is_none() {
        return Err(format!("未找到快速发布模板: {}", id));
    }

    if config.last_used_quick_publish_template.as_deref() == Some(&id) {
        config.last_used_quick_publish_template = None;
    }

    save_config_to_disk(&app, &config);
    Ok(())
}

#[tauri::command]
pub fn save_content_template(
    app: AppHandle,
    mut template: ContentTemplate,
    expected_revision: Option<u64>,
) -> Result<ImportedContentTemplatePayload, String> {
    let template_id = normalize_content_template_for_storage(&mut template)?;

    let mut config = load_config(&app);
    let current_revision = config
        .content_templates
        .get(&template_id)
        .map(|existing| existing.revision);
    template.revision = resolve_next_template_revision(
        "公共正文模板",
        &template_id,
        current_revision,
        expected_revision,
    )?;
    config
        .content_templates
        .insert(template_id.clone(), template.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedContentTemplatePayload {
        id: template_id,
        template,
    })
}

#[tauri::command]
pub fn delete_content_template(app: AppHandle, id: String) -> Result<(), String> {
    let mut config = load_config(&app);
    if config.content_templates.remove(&id).is_none() {
        return Err(format!("未找到正文模板: {}", id));
    }

    for template in config.quick_publish_templates.values_mut() {
        if template.shared_content_template_id.as_deref() == Some(id.as_str()) {
            template.shared_content_template_id = None;
            template.revision = template.revision.saturating_add(1);
        }
    }

    save_config_to_disk(&app, &config);
    Ok(())
}

#[tauri::command]
pub fn update_quick_publish_template_publish_history(
    app: AppHandle,
    id: String,
    updates: Vec<TemplatePublishHistoryUpdate>,
) -> Result<(), String> {
    let mut config = load_config(&app);
    let template = config
        .quick_publish_templates
        .get_mut(&id)
        .ok_or_else(|| format!("未找到快速发布模板: {}", id))?;

    for update in updates {
        let history_entry = template
            .publish_history
            .get_mut(&update.site_key)
            .ok_or_else(|| format!("不支持的站点代码: {}", update.site_key))?;
        history_entry.last_published_at = update.last_published_at;
        history_entry.last_published_episode = update.last_published_episode;
        history_entry.last_published_resolution = update.last_published_resolution;
    }

    template.revision = template.revision.saturating_add(1);

    save_config_to_disk(&app, &config);
    Ok(())
}

#[tauri::command]
pub fn export_quick_publish_template_to_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<(), String> {
    let config = load_config(&app);
    let template = config
        .quick_publish_templates
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("未找到快速发布模板: {}", id))?;

    let export_payload = ImportedQuickPublishTemplateFile {
        id,
        template,
    };

    let export_path = PathBuf::from(&path);
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建导出目录: {}", error))?;
    }

    let file_content = serde_json::to_string_pretty(&export_payload)
        .map_err(|error| format!("无法序列化快速发布模板文件: {}", error))?;

    std::fs::write(&export_path, file_content)
        .map_err(|error| format!("无法导出快速发布模板文件: {}", error))?;

    Ok(())
}

#[tauri::command]
pub fn import_quick_publish_template_from_file(
    app: AppHandle,
    path: String,
    conflict_strategy: Option<ImportConflictStrategy>,
) -> Result<ImportedQuickPublishTemplatePayload, String> {
    let import_path = PathBuf::from(&path);
    let file_content = std::fs::read_to_string(&import_path)
        .map_err(|error| format!("无法读取快速发布模板文件: {}", error))?;

    let import_file: QuickPublishTemplateImportFileFormat = serde_json::from_str(&file_content)
        .map_err(|error| format!("快速发布模板文件格式无效: {}", error))?;

    let fallback_id = import_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("imported-quick-publish-template")
        .to_string();

    let (id, mut template) = match import_file {
        QuickPublishTemplateImportFileFormat::Wrapped(file) => {
            let imported_id = file.id.trim().to_string();
            let resolved_id = if imported_id.is_empty() {
                fallback_id.clone()
            } else {
                imported_id
            };

            (resolved_id, file.template)
        }
        QuickPublishTemplateImportFileFormat::Raw(template) => {
            let imported_id = template.id.trim().to_string();
            let resolved_id = if imported_id.is_empty() {
                fallback_id.clone()
            } else {
                imported_id
            };

            (resolved_id, template)
        }
    };

    let mut config = load_config(&app);
    let strategy = conflict_strategy.unwrap_or_default();
    let normalized_id = normalize_required_value(&id, "快速发布模板 ID", ENTITY_ID_MAX_CHARS)?;
    let final_id = resolve_import_id_conflict(
        normalized_id.clone(),
        &config.quick_publish_templates,
        strategy,
    )?;

    template.id = final_id.clone();
    template.name = normalize_optional_name(&template.name, &normalized_id, "模板名称", ENTITY_NAME_MAX_CHARS)?;
    if final_id != normalized_id {
        template.name = build_copy_name(&template.name, ENTITY_NAME_MAX_CHARS);
    }
    let final_id = normalize_quick_publish_template_for_storage(&mut template)?;
    let current_revision = config
        .quick_publish_templates
        .get(&final_id)
        .map(|existing| existing.revision)
        .unwrap_or(0);
    template.revision = current_revision.saturating_add(1);

    migrate_quick_publish_template(&mut template, &config.content_templates);
    config
        .quick_publish_templates
        .insert(final_id.clone(), template.clone());
    config.last_used_quick_publish_template = Some(final_id.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedQuickPublishTemplatePayload {
        id: final_id,
        template,
    })
}

#[tauri::command]
pub fn export_content_template_to_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<(), String> {
    let config = load_config(&app);
    let template = config
        .content_templates
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("未找到正文模板: {}", id))?;

    let export_payload = ImportedContentTemplateFile {
        id,
        template,
    };

    let export_path = PathBuf::from(&path);
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建导出目录: {}", error))?;
    }

    let file_content = serde_json::to_string_pretty(&export_payload)
        .map_err(|error| format!("无法序列化正文模板文件: {}", error))?;

    std::fs::write(&export_path, file_content)
        .map_err(|error| format!("无法导出正文模板文件: {}", error))?;

    Ok(())
}

#[tauri::command]
pub fn import_content_template_from_file(
    app: AppHandle,
    path: String,
    conflict_strategy: Option<ImportConflictStrategy>,
) -> Result<ImportedContentTemplatePayload, String> {
    let import_path = PathBuf::from(&path);
    let file_content = std::fs::read_to_string(&import_path)
        .map_err(|error| format!("无法读取正文模板文件: {}", error))?;

    let import_file: ContentTemplateImportFileFormat = serde_json::from_str(&file_content)
        .map_err(|error| format!("正文模板文件格式无效: {}", error))?;

    let fallback_id = import_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("imported-content-template")
        .to_string();

    let (id, mut template) = match import_file {
        ContentTemplateImportFileFormat::Wrapped(file) => {
            let imported_id = file.id.trim().to_string();
            let resolved_id = if imported_id.is_empty() {
                fallback_id.clone()
            } else {
                imported_id
            };

            (resolved_id, file.template)
        }
        ContentTemplateImportFileFormat::Raw(template) => {
            let imported_id = template.id.trim().to_string();
            let resolved_id = if imported_id.is_empty() {
                fallback_id.clone()
            } else {
                imported_id
            };

            (resolved_id, template)
        }
    };

    let mut config = load_config(&app);
    let strategy = conflict_strategy.unwrap_or_default();
    let normalized_id = normalize_required_value(&id, "正文模板 ID", ENTITY_ID_MAX_CHARS)?;
    let final_id = resolve_import_id_conflict(
        normalized_id.clone(),
        &config.content_templates,
        strategy,
    )?;

    template.id = final_id.clone();
    template.name = normalize_optional_name(&template.name, &normalized_id, "模板名称", ENTITY_NAME_MAX_CHARS)?;
    if final_id != normalized_id {
        template.name = build_copy_name(&template.name, ENTITY_NAME_MAX_CHARS);
    }
    let final_id = normalize_content_template_for_storage(&mut template)?;
    let current_revision = config
        .content_templates
        .get(&final_id)
        .map(|existing| existing.revision)
        .unwrap_or(0);
    template.revision = current_revision.saturating_add(1);

    config
        .content_templates
        .insert(final_id.clone(), template.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedContentTemplatePayload {
        id: final_id,
        template,
    })
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
        history_entry.last_published_resolution = update.last_published_resolution;
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
pub fn import_template_from_file(
    app: AppHandle,
    path: String,
    conflict_strategy: Option<ImportConflictStrategy>,
) -> Result<ImportedTemplatePayload, String> {
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

    let normalized_name = normalize_template_storage_name(&name)?;
    validate_template_for_storage(&template)?;

    let mut config = load_config(&app);
    let final_name = resolve_import_name_conflict(
        normalized_name,
        &config.templates,
        conflict_strategy.unwrap_or_default(),
    )?;

    config.templates.insert(final_name.clone(), template.clone());
    config.last_used_template = Some(final_name.clone());
    save_config_to_disk(&app, &config);

    Ok(ImportedTemplatePayload {
        name: final_name,
        template,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(config.templates.is_empty());
        assert!(config.quick_publish_templates.is_empty());
        assert!(config.content_templates.is_empty());
        assert_eq!(config.proxy.proxy_type, "none");
        assert!(config.okp_executable_path.is_empty());
        assert!(config.last_used_template.is_none());
        assert!(config.last_used_quick_publish_template.is_none());
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
            resolution_pattern: "(?P<res>1080p)".to_string(),
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

    #[test]
    fn test_legacy_config_defaults_new_quick_publish_fields() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "last_used_template": "legacy",
                "proxy": { "proxy_type": "none", "proxy_host": "" },
                "okp_executable_path": "",
                "templates": {}
            }"#,
        )
        .expect("legacy config should deserialize");

        assert!(config.quick_publish_templates.is_empty());
        assert!(config.content_templates.is_empty());
        assert!(config.last_used_quick_publish_template.is_none());
    }

    #[test]
    fn test_quick_publish_template_roundtrip() {
        let config = AppConfig {
            last_used_quick_publish_template: Some("demo-template".to_string()),
            quick_publish_templates: HashMap::from([(
                "demo-template".to_string(),
                QuickPublishTemplate {
                    id: "demo-template".to_string(),
                    name: "Demo Template".to_string(),
                    summary: "summary".to_string(),
                    title: "[Group] Show - 01 [1080p]".to_string(),
                    ep_pattern: "(?P<ep>\\d+)".to_string(),
                    resolution_pattern: "(?P<res>1080p)".to_string(),
                    title_pattern: "<ep>".to_string(),
                    poster: "poster".to_string(),
                    about: "about".to_string(),
                    tags: "Anime".to_string(),
                    default_profile: "default".to_string(),
                    default_sites: SiteSelection {
                        dmhy: true,
                        nyaa: false,
                        acgrip: false,
                        bangumi: true,
                        acgnx_asia: false,
                        acgnx_global: false,
                    },
                    body_markdown: "body markdown".to_string(),
                    body_html: "<p>body html</p>".to_string(),
                    shared_content_template_id: Some("content-1".to_string()),
                    legacy_content_template_id: None,
                    publish_history: SitePublishHistory::default(),
                    updated_at: "2026-03-14T00:00:00Z".to_string(),
                    revision: 4,
                },
            )]),
            content_templates: HashMap::from([(
                "content-1".to_string(),
                ContentTemplate {
                    id: "content-1".to_string(),
                    name: "Intro".to_string(),
                    summary: "content summary".to_string(),
                    markdown: "# markdown".to_string(),
                    html: "<p>html</p>".to_string(),
                    site_notes: "notes".to_string(),
                    updated_at: "2026-03-14T00:00:00Z".to_string(),
                    revision: 2,
                },
            )]),
            ..AppConfig::default()
        };

        let serialized = serde_json::to_string(&config).expect("config should serialize");
        let restored: AppConfig = serde_json::from_str(&serialized).expect("config should deserialize");

        assert_eq!(
            restored.last_used_quick_publish_template.as_deref(),
            Some("demo-template")
        );
        assert_eq!(restored.quick_publish_templates.len(), 1);
        assert_eq!(restored.content_templates.len(), 1);
        assert_eq!(
            restored.quick_publish_templates["demo-template"]
                .shared_content_template_id
                .as_deref(),
            Some("content-1")
        );
        assert_eq!(
            restored.quick_publish_templates["demo-template"].body_markdown,
            "body markdown"
        );
        assert_eq!(restored.content_templates["content-1"].name, "Intro");
        assert_eq!(restored.quick_publish_templates["demo-template"].revision, 4);
        assert_eq!(restored.content_templates["content-1"].revision, 2);
    }

    #[test]
    fn test_legacy_quick_publish_template_migrates_content_into_body_fields() {
        let mut config: AppConfig = serde_json::from_str(
            r#"{
                "proxy": { "proxy_type": "none", "proxy_host": "" },
                "quick_publish_templates": {
                    "demo-template": {
                        "id": "demo-template",
                        "name": "Demo Template",
                        "content_template_id": "content-1"
                    }
                },
                "content_templates": {
                    "content-1": {
                        "id": "content-1",
                        "name": "Shared",
                        "markdown": "legacy markdown",
                        "html": "<p>legacy html</p>"
                    }
                }
            }"#,
        )
        .expect("legacy quick publish config should deserialize");

        migrate_quick_publish_templates(&mut config);

        let migrated = config.quick_publish_templates["demo-template"].clone();
        assert_eq!(migrated.body_markdown, "legacy markdown");
        assert_eq!(migrated.body_html, "<p>legacy html</p>");
        assert!(migrated.shared_content_template_id.is_none());
        assert!(migrated.legacy_content_template_id.is_none());
    }

    #[test]
    fn test_validate_template_for_storage_accepts_valid_regex_fields() {
        let template = Template {
            ep_pattern: r"(?P<ep>\d+)".to_string(),
            resolution_pattern: r"(?P<res>1080p|2160p)".to_string(),
            ..Template::default()
        };

        validate_template_for_storage(&template).expect("expected valid regex patterns to pass");
    }

    #[test]
    fn test_validate_template_for_storage_rejects_invalid_episode_regex() {
        let template = Template {
            ep_pattern: "(".to_string(),
            ..Template::default()
        };

        let error = validate_template_for_storage(&template)
            .expect_err("expected invalid episode regex to be rejected");

        assert!(error.contains("集数正则"));
    }

    #[test]
    fn test_validate_quick_publish_template_for_storage_rejects_overlong_resolution_regex() {
        let template = QuickPublishTemplate {
            resolution_pattern: "a".repeat(TEMPLATE_REGEX_MAX_CHARS + 1),
            ..QuickPublishTemplate::default()
        };

        let error = validate_quick_publish_template_for_storage(&template)
            .expect_err("expected overlong resolution regex to be rejected");

        assert!(error.contains("分辨率正则"));
        assert!(error.contains(&TEMPLATE_REGEX_MAX_CHARS.to_string()));
    }

    #[test]
    fn test_normalize_quick_publish_template_for_storage_trims_identifier_and_name() {
        let mut template = QuickPublishTemplate {
            id: "  season-template  ".to_string(),
            name: "  季度模板  ".to_string(),
            ..QuickPublishTemplate::default()
        };

        let template_id = normalize_quick_publish_template_for_storage(&mut template)
            .expect("expected template metadata to normalize");

        assert_eq!(template_id, "season-template");
        assert_eq!(template.id, "season-template");
        assert_eq!(template.name, "季度模板");
    }

    #[test]
    fn test_normalize_quick_publish_template_for_storage_rejects_overlong_name() {
        let mut template = QuickPublishTemplate {
            id: "season-template".to_string(),
            name: "a".repeat(ENTITY_NAME_MAX_CHARS + 1),
            ..QuickPublishTemplate::default()
        };

        let error = normalize_quick_publish_template_for_storage(&mut template)
            .expect_err("expected overlong names to be rejected");

        assert!(error.contains(&ENTITY_NAME_MAX_CHARS.to_string()));
    }

    #[test]
    fn test_resolve_import_name_conflict_creates_copy_name() {
        let existing = HashMap::from([("季度模板".to_string(), Template::default())]);

        let resolved = resolve_import_name_conflict(
            "季度模板".to_string(),
            &existing,
            ImportConflictStrategy::Copy,
        )
        .expect("expected copy strategy to resolve name conflict");

        assert_eq!(resolved, "季度模板 副本");
    }

    #[test]
    fn test_resolve_import_id_conflict_creates_copy_id() {
        let existing = HashMap::from([("season-template".to_string(), QuickPublishTemplate::default())]);

        let resolved = resolve_import_id_conflict(
            "season-template".to_string(),
            &existing,
            ImportConflictStrategy::Copy,
        )
        .expect("expected copy strategy to resolve id conflict");

        assert_eq!(resolved, "season-template-copy");
    }

    #[test]
    fn test_resolve_next_template_revision_advances_on_matching_revision() {
        let next_revision = resolve_next_template_revision(
            "发布模板",
            "season-template",
            Some(3),
            Some(3),
        )
        .expect("expected matching revision to advance");

        assert_eq!(next_revision, 4);
    }

    #[test]
    fn test_resolve_next_template_revision_rejects_stale_revision() {
        let error = resolve_next_template_revision(
            "发布模板",
            "season-template",
            Some(4),
            Some(3),
        )
        .expect_err("expected stale revision to be rejected");

        assert!(error.starts_with(TEMPLATE_REVISION_CONFLICT_PREFIX));

        let payload: TemplateRevisionConflictPayload = serde_json::from_str(
            error.trim_start_matches(TEMPLATE_REVISION_CONFLICT_PREFIX),
        )
        .expect("expected structured revision conflict payload");

        assert_eq!(payload.entity_id, "season-template");
        assert_eq!(payload.current_revision, Some(4));
        assert!(payload.message.contains("其他会话更新"));
    }

    #[test]
    fn test_resolve_next_template_revision_rejects_creation_without_expected_revision_on_existing_id() {
        let error = resolve_next_template_revision(
            "公共正文模板",
            "shared-tail",
            Some(2),
            None,
        )
        .expect_err("expected unsafely creating over an existing id to be rejected");

        assert!(error.starts_with(TEMPLATE_REVISION_CONFLICT_PREFIX));
    }
}
