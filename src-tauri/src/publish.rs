use crate::ai::redaction::RedactionPolicy;
use crate::config::{load_config, Template};
use crate::profile::{
    get_site_cookie_text, load_profiles, normalize_site_cookie_text,
    resolve_site_cookie_user_agent, site_cookie_has_entries, Profile,
};
use encoding_rs::GB18030;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub mod publish_events;
pub mod publish_history;

const REQUIRED_OKP_TAG_FILES: &[&str] = &[
    "acgnx_asia.json",
    "acgnx_global.json",
    "acgrip.json",
    "bangumi.json",
    "dmhy.json",
    "nyaa.json",
];
const OKP_VERSION_OUTPUT_MAX_CHARS: usize = 240;

static PUBLISH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishRequest {
    pub publish_id: String,
    pub torrent_path: String,
    pub profile_name: String,
    pub template: Template,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishOutput {
    pub publish_id: String,
    pub site_code: String,
    pub site_label: String,
    pub line: String,
    pub is_stderr: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishSiteComplete {
    pub publish_id: String,
    pub site_code: String,
    pub site_label: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishComplete {
    pub publish_id: String,
    pub success: bool,
    pub message: String,
}

/// Direct native binary vs `dotnet` DLL launch for the selected OKP.Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OkpLaunchMode {
    Direct,
    DotnetDll,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedOkpExecutable {
    executable_path: PathBuf,
    working_dir: PathBuf,
    launch_mode: OkpLaunchMode,
}

/// Private OKP executable identity bound into a prepared plan.
/// Never serialized into public plan DTOs (raw paths must not leave Rust).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OkpExecutableIdentity {
    /// Canonical selected executable path (private; never exposed in plan responses).
    canonical_path: PathBuf,
    /// Direct binary vs `dotnet` DLL launch mode captured at bind time.
    launch_mode: OkpLaunchMode,
    /// SHA-256 of executable file bytes at bind time (`sha256:<hex>`).
    executable_digest: String,
}

impl OkpExecutableIdentity {
    /// Capture identity from an already-resolved OKP executable.
    pub(crate) fn from_resolved(resolved: &ResolvedOkpExecutable) -> Result<Self, String> {
        let executable_digest = hash_okp_executable_bytes(&resolved.executable_path)?;
        Ok(Self {
            canonical_path: resolved.executable_path.clone(),
            launch_mode: resolved.launch_mode,
            executable_digest,
        })
    }

    pub(crate) fn launch_mode(&self) -> OkpLaunchMode {
        self.launch_mode
    }

    pub(crate) fn executable_digest(&self) -> &str {
        &self.executable_digest
    }

    /// Re-resolve the **bound** path (never live app config) through the normal
    /// OKP flow and verify path / launch mode / file-byte digest have not changed.
    /// On success returns the exact `ResolvedOkpExecutable` that was revalidated,
    /// so prepared-plan publish can launch identity A without re-reading config B.
    /// Error messages never include the raw executable path.
    pub(crate) fn revalidate(&self) -> Result<ResolvedOkpExecutable, String> {
        let path_str = self.canonical_path.to_string_lossy();
        let resolved = resolve_selected_okp_executable(&path_str)
            .map_err(|_| "OKP 可执行文件已失效，请重新执行发布前检查。".to_string())?;
        if resolved.executable_path != self.canonical_path {
            return Err("OKP 可执行文件已失效，请重新执行发布前检查。".to_string());
        }
        if resolved.launch_mode != self.launch_mode {
            return Err("OKP 可执行文件启动方式已变化，请重新执行发布前检查。".to_string());
        }
        let digest = hash_okp_executable_bytes(&resolved.executable_path)
            .map_err(|_| "无法验证 OKP 可执行文件身份，请重新执行发布前检查。".to_string())?;
        if digest != self.executable_digest {
            return Err("OKP 可执行文件已被替换，请重新执行发布前检查。".to_string());
        }
        Ok(resolved)
    }
}

/// Outcome of binding the live-configured OKP into a prepared plan.
///
/// Produced from **one** live resolve so prepare never mixes two independent
/// resolves (blocker collection vs identity capture). Carries the same
/// `ResolvedOkpExecutable` used for OKP local checks when resolution succeeds.
#[derive(Debug, Clone)]
pub(crate) enum ConfiguredOkpBindResult {
    /// Private identity + the resolved executable used to capture it.
    Bound {
        identity: OkpExecutableIdentity,
        resolved: ResolvedOkpExecutable,
    },
    /// Live config could not resolve OKP. `error` is from that single resolve
    /// (legacy live-config message shape); caller must add it as a local blocker.
    Unresolved { error: String },
    /// Resolved locally but path/mode/digest capture failed — must not leave unbound.
    /// `resolved` is still usable for OKP local checks (e.g. version gates).
    IdentityCaptureFailed { resolved: ResolvedOkpExecutable },
}

/// Domain-safe bridge: resolve the selected OKP path/launch mode and capture
/// private executable identity (path + mode + file-byte SHA-256).
pub(crate) fn capture_okp_executable_identity(
    configured_path: &str,
) -> Result<OkpExecutableIdentity, String> {
    let resolved = resolve_selected_okp_executable(configured_path)?;
    OkpExecutableIdentity::from_resolved(&resolved)
}

/// Capture identity for the currently configured OKP executable, if any.
pub(crate) fn capture_configured_okp_identity(
    app: &AppHandle,
) -> Result<OkpExecutableIdentity, String> {
    let resolved = find_okp_executable(app)?;
    OkpExecutableIdentity::from_resolved(&resolved)
}

/// Pure bind from an already-attempted resolve (single-resolve contract for prepare).
/// Used by [`bind_configured_okp_for_prepare`] and unit tests — never re-resolves.
pub(crate) fn bind_resolved_okp_for_prepare(
    resolved: Result<ResolvedOkpExecutable, String>,
) -> ConfiguredOkpBindResult {
    match resolved {
        Err(error) => ConfiguredOkpBindResult::Unresolved { error },
        Ok(resolved) => match OkpExecutableIdentity::from_resolved(&resolved) {
            Ok(identity) => ConfiguredOkpBindResult::Bound { identity, resolved },
            Err(_) => ConfiguredOkpBindResult::IdentityCaptureFailed { resolved },
        },
    }
}

/// Resolve live-configured OKP once and capture private identity for plan prepare.
/// Callers must use the returned resolved executable for OKP local checks — do not
/// call [`find_okp_executable`] / [`collect_publish_local_blockers`] again.
pub(crate) fn bind_configured_okp_for_prepare(app: &AppHandle) -> ConfiguredOkpBindResult {
    bind_resolved_okp_for_prepare(find_okp_executable(app))
}

/// Apply a single prepare-time OKP bind result into identity + local blockers.
///
/// Performs **no second live OKP resolve**. Bound/capture-failed reuse the same
/// resolved executable for OKP local checks; unresolved injects the single resolve
/// error (legacy live-config message) plus non-OKP local checks.
pub(crate) fn prepare_local_blockers_and_okp_identity(
    app: &AppHandle,
    request: &PublishRequest,
    bind: ConfiguredOkpBindResult,
) -> (Option<OkpExecutableIdentity>, Vec<String>) {
    match bind {
        ConfiguredOkpBindResult::Bound { identity, resolved } => {
            let blockers =
                collect_publish_local_blockers_with_resolved_okp(app, request, &resolved);
            (Some(identity), blockers)
        }
        ConfiguredOkpBindResult::IdentityCaptureFailed { resolved } => {
            let mut blockers =
                collect_publish_local_blockers_with_resolved_okp(app, request, &resolved);
            let capture = okp_identity_capture_blocker();
            if !blockers.contains(&capture) {
                blockers.push(capture);
            }
            (None, blockers)
        }
        ConfiguredOkpBindResult::Unresolved { error } => {
            let blockers =
                collect_publish_local_blockers_with_okp_resolve_error(app, request, error);
            (None, blockers)
        }
    }
}

/// Path-free local blocker when OKP resolved but identity digest/hash could not be captured.
pub(crate) fn okp_identity_capture_blocker() -> String {
    "无法验证 OKP 可执行文件身份，请重新执行发布前检查。".to_string()
}

/// Path-free gate when a prepared plan has no bound OKP identity at publish time.
pub(crate) fn okp_identity_unbound_blocker() -> String {
    "OKP 可执行文件身份未绑定，请重新执行发布前检查。".to_string()
}

fn hash_okp_executable_bytes(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|_| "无法读取 OKP 可执行文件身份，请重新执行发布前检查。".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[derive(Debug, Clone)]
pub(crate) struct PublishArtifacts {
    workspace_dir: PathBuf,
    template_path: PathBuf,
    cookies_path: PathBuf,
    markdown_description_path: PathBuf,
    html_description_path: PathBuf,
    log_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct SitePublishConfig {
    pub(crate) code: &'static str,
    pub(crate) label: &'static str,
    pub(crate) account_name: String,
    pub(crate) token: Option<String>,
    pub(crate) api_token: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) uses_cookie: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SitePublishResult {
    site_code: String,
    site_label: String,
    success: bool,
    message: String,
    updated_cookie_text: Option<String>,
}

#[derive(Debug, Serialize)]
struct SiteTemplateToml<'a> {
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename_regex: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution_regex: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    about: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tags: Vec<&'a str>,
    intro_template: Vec<SiteTemplateIntroToml<'a>>,
}

#[derive(Debug, Serialize)]
struct SiteTemplateIntroToml<'a> {
    site: &'a str,
    name: &'a str,
    content: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_agent: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cookie: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy: Option<&'a str>,
}

impl SitePublishConfig {
    pub(crate) fn build_result(
        &self,
        success: bool,
        message: impl Into<String>,
        updated_cookie_text: Option<String>,
    ) -> SitePublishResult {
        SitePublishResult {
            site_code: self.code.to_string(),
            site_label: self.label.to_string(),
            success,
            message: message.into(),
            updated_cookie_text,
        }
    }
}

pub(crate) struct PublishGuard;

impl PublishGuard {
    pub(crate) fn acquire() -> Result<Self, String> {
        if PUBLISH_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Ok(Self)
        } else {
            Err("当前已有一个发布任务在运行，请等待其完成后再试。".to_string())
        }
    }
}

impl Drop for PublishGuard {
    fn drop(&mut self) {
        PUBLISH_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

fn emit_publish_output(
    app: &AppHandle,
    publish_id: &str,
    site_code: &str,
    site_label: &str,
    line: impl Into<String>,
    is_stderr: bool,
) {
    publish_events::emit_publish_output(app, publish_id, site_code, site_label, line, is_stderr);
}

fn decode_publish_output(buffer: &[u8]) -> String {
    match String::from_utf8(buffer.to_vec()) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        Err(_) => {
            #[cfg(target_os = "windows")]
            {
                let (decoded, _, had_errors) = GB18030.decode(buffer);
                if !had_errors {
                    return decoded.trim_start_matches('\u{feff}').to_string();
                }
            }

            String::from_utf8_lossy(buffer)
                .trim_start_matches('\u{feff}')
                .to_string()
        }
    }
}

fn okp_selection_label() -> &'static str {
    "OKP.Core 可执行文件或 DLL"
}

impl ResolvedOkpExecutable {
    /// Private path of the selected executable (never for public serialization).
    pub(crate) fn executable_path(&self) -> &Path {
        &self.executable_path
    }

    pub(crate) fn launch_mode(&self) -> OkpLaunchMode {
        self.launch_mode
    }

    fn preview_parts(&self, arguments: &[String]) -> Vec<String> {
        match self.launch_mode {
            OkpLaunchMode::Direct => std::iter::once(self.executable_path.display().to_string())
                .chain(arguments.iter().cloned())
                .collect(),
            OkpLaunchMode::DotnetDll => std::iter::once("dotnet".to_string())
                .chain(std::iter::once(self.executable_path.display().to_string()))
                .chain(arguments.iter().cloned())
                .collect(),
        }
    }

    fn configure_command(&self, command: &mut Command, arguments: &[String]) {
        match self.launch_mode {
            OkpLaunchMode::Direct => {
                command.args(arguments);
            }
            OkpLaunchMode::DotnetDll => {
                command.arg(&self.executable_path).args(arguments);
            }
        }
    }

    fn program(&self) -> &Path {
        match self.launch_mode {
            OkpLaunchMode::Direct => &self.executable_path,
            OkpLaunchMode::DotnetDll => Path::new("dotnet"),
        }
    }
}

fn parse_okp_semantic_version_candidate(candidate: &str) -> Option<Version> {
    let candidate = candidate.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric()
            && character != '.'
            && character != '-'
            && character != '+'
    });
    let candidate = candidate
        .strip_prefix('v')
        .or_else(|| candidate.strip_prefix('V'))
        .unwrap_or(candidate);
    Version::parse(candidate).ok()
}

fn parse_okp_semantic_version(output: &str) -> Option<Version> {
    output
        .split_whitespace()
        .find_map(parse_okp_semantic_version_candidate)
}

fn okp_version_supports_acgrip_api_token(version: &Version) -> bool {
    version >= &Version::new(1, 2, 1)
}

fn summarize_okp_version_output(stdout: &str, stderr: &str) -> String {
    let combined = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    let collapsed = combined.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let summary: String = chars.by_ref().take(OKP_VERSION_OUTPUT_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{}...", summary)
    } else {
        summary
    }
}

fn query_okp_semantic_version(okp_core: &ResolvedOkpExecutable) -> Result<Version, String> {
    let arguments = vec!["--version".to_string()];
    let mut command = Command::new(okp_core.program());
    command
        .current_dir(&okp_core.working_dir)
        .env("DOTNET_CLI_FORCE_UTF8_ENCODING", "1")
        .env("DOTNET_SYSTEM_CONSOLE_OUTPUT_ENCODING", "utf-8")
        .env("DOTNET_SYSTEM_CONSOLE_INPUT_ENCODING", "utf-8")
        .stdin(Stdio::null());
    okp_core.configure_command(&mut command, &arguments);

    let output = command
        .output()
        .map_err(|error| format!("执行 OKP.Core --version 失败: {}", error))?;
    let stdout = decode_publish_output(&output.stdout);
    let stderr = decode_publish_output(&output.stderr);
    let output_summary = summarize_okp_version_output(&stdout, &stderr);

    if !output.status.success() {
        let exit_code = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "未知".to_string());
        return Err(if output_summary.is_empty() {
            format!("OKP.Core --version 失败，退出码: {}。", exit_code)
        } else {
            format!(
                "OKP.Core --version 失败，退出码: {}，输出: {}",
                exit_code, output_summary
            )
        });
    }

    parse_okp_semantic_version(&stdout)
        .or_else(|| parse_okp_semantic_version(&stderr))
        .ok_or_else(|| {
            if output_summary.is_empty() {
                "OKP.Core --version 未返回可识别的版本号。".to_string()
            } else {
                format!(
                    "无法从 OKP.Core --version 输出中识别版本号: {}",
                    output_summary
                )
            }
        })
}

fn ensure_okp_supports_acgrip_api_token(
    okp_core: &ResolvedOkpExecutable,
) -> Result<String, String> {
    let version = query_okp_semantic_version(okp_core).map_err(|error| {
        format!(
            "无法确认 OKP.Core 是否支持 ACG.RIP API Token：{} API Token 发布需要 OKP.Core >= 1.2.1；请升级 OKP.Core，或清空 API Token 后使用 Cookie。",
            error
        )
    })?;

    if !okp_version_supports_acgrip_api_token(&version) {
        return Err(format!(
            "当前 OKP.Core 版本为 {}，ACG.RIP API Token 发布需要 OKP.Core >= 1.2.1；请升级 OKP.Core，或清空 API Token 后使用 Cookie。",
            version
        ));
    }

    Ok(version.to_string())
}

fn site_requires_okp_acgrip_api_token_support(site: &SitePublishConfig) -> bool {
    site.code == "acgrip"
        && site
            .api_token
            .as_deref()
            .and_then(optional_trimmed)
            .is_some()
}

fn resolve_selected_okp_executable(configured_path: &str) -> Result<ResolvedOkpExecutable, String> {
    let configured_path = configured_path.trim();
    if configured_path.is_empty() {
        return Err(format!(
            "未选择 OKP 可执行文件，请先在首页选择 {}。",
            okp_selection_label()
        ));
    }

    let configured = PathBuf::from(configured_path);
    if !configured.exists() {
        return Err(format!(
            "已选择的 OKP 可执行文件不存在：{}，请重新选择。",
            configured.display()
        ));
    }

    let metadata = std::fs::metadata(&configured).map_err(|e| {
        format!(
            "无法读取已选择的 OKP 可执行文件：{} ({})",
            configured.display(),
            e
        )
    })?;

    if !metadata.is_file() {
        return Err(format!(
            "已选择的 OKP 文件不是文件：{}，请重新选择 {}。",
            configured.display(),
            okp_selection_label()
        ));
    }

    let extension = configured
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();

    let launch_mode = if extension.eq_ignore_ascii_case("dll") {
        OkpLaunchMode::DotnetDll
    } else {
        OkpLaunchMode::Direct
    };

    #[cfg(target_os = "windows")]
    {
        if !extension.eq_ignore_ascii_case("exe") && !extension.eq_ignore_ascii_case("dll") {
            return Err("Windows 仅支持选择 OKP.Core.exe 或 OKP.Core.dll。".to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if extension.eq_ignore_ascii_case("exe") {
            return Err("当前系统不能直接运行 Windows .exe，请选择当前平台的 OKP.Core 可执行文件，或选择 OKP.Core.dll 并安装 dotnet 运行时。".to_string());
        }
    }

    let working_dir = configured
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("无法确定 OKP 可执行文件所在目录：{}", configured.display()))?;

    let tags_dir = working_dir.join("config").join("tags");
    let missing_files: Vec<&str> = REQUIRED_OKP_TAG_FILES
        .iter()
        .copied()
        .filter(|name| !tags_dir.join(name).is_file())
        .collect();

    if !missing_files.is_empty() {
        return Err(format!(
            "已选择的 OKP 可执行文件目录缺少运行所需的配置文件：{}。请重新选择包含 config/tags 的 OKP.Core 发布目录。",
            missing_files.join(", ")
        ));
    }

    Ok(ResolvedOkpExecutable {
        executable_path: configured,
        working_dir,
        launch_mode,
    })
}

pub(crate) fn find_okp_executable(app: &AppHandle) -> Result<ResolvedOkpExecutable, String> {
    let config = load_config(app);
    resolve_selected_okp_executable(&config.okp_executable_path)
}

pub(crate) fn validate_torrent_path(torrent_path: &str) -> Result<PathBuf, String> {
    let torrent_path = torrent_path.trim();
    if torrent_path.is_empty() {
        return Err("未选择种子文件，请先选择 .torrent 文件。".to_string());
    }

    let torrent = PathBuf::from(torrent_path);
    if !torrent.exists() {
        return Err(format!("种子文件不存在：{}", torrent.display()));
    }

    let metadata = std::fs::metadata(&torrent)
        .map_err(|e| format!("无法读取种子文件：{} ({})", torrent.display(), e))?;

    if !metadata.is_file() {
        return Err(format!("种子路径不是文件：{}", torrent.display()));
    }

    let is_torrent = torrent
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);

    if !is_torrent {
        return Err(format!("所选文件不是 .torrent 文件：{}", torrent.display()));
    }

    Ok(torrent)
}

fn create_publish_artifacts(app: &AppHandle, site_code: &str) -> Result<PublishArtifacts, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))?;

    let publish_root = data_dir.join("publish");
    std::fs::create_dir_all(&publish_root).map_err(|e| format!("无法创建发布工作目录: {}", e))?;

    let run_id = format!(
        "{}-{}-{}",
        site_code,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let workspace_dir = publish_root.join(run_id);
    std::fs::create_dir_all(&workspace_dir).map_err(|e| format!("无法创建发布工作目录: {}", e))?;

    Ok(PublishArtifacts {
        template_path: workspace_dir.join("template.toml"),
        cookies_path: workspace_dir.join("cookies.txt"),
        markdown_description_path: workspace_dir.join("description.md"),
        html_description_path: workspace_dir.join("description.html"),
        log_path: workspace_dir.join("okp.log"),
        workspace_dir,
    })
}

fn cleanup_publish_artifacts(artifacts: &PublishArtifacts, keep_log: bool) {
    let _ = std::fs::remove_file(&artifacts.template_path);
    let _ = std::fs::remove_file(&artifacts.cookies_path);
    let _ = std::fs::remove_file(&artifacts.markdown_description_path);
    let _ = std::fs::remove_file(&artifacts.html_description_path);

    if !keep_log {
        let _ = std::fs::remove_file(&artifacts.log_path);
    }

    let _ = std::fs::remove_dir(&artifacts.workspace_dir);
}

fn site_label(site_code: &str) -> &'static str {
    match site_code {
        "dmhy" => "动漫花园",
        "nyaa" => "Nyaa",
        "acgrip" => "ACG.RIP",
        "bangumi" => "萌番组",
        "acgnx_asia" => "ACGNx Asia",
        "acgnx_global" => "ACGNx Global",
        _ => "未知站点",
    }
}

pub(crate) fn collect_site_publish_configs(
    template: &Template,
    profile: &Profile,
) -> Vec<SitePublishConfig> {
    vec![
        SitePublishConfig {
            code: "dmhy",
            label: site_label("dmhy"),
            account_name: profile.dmhy_name.clone(),
            token: None,
            api_token: None,
            enabled: template.sites.dmhy,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "nyaa",
            label: site_label("nyaa"),
            account_name: profile.nyaa_name.clone(),
            token: None,
            api_token: None,
            enabled: template.sites.nyaa,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "acgrip",
            label: site_label("acgrip"),
            account_name: profile.acgrip_name.clone(),
            token: None,
            api_token: Some(profile.acgrip_api_token.clone()),
            enabled: template.sites.acgrip,
            uses_cookie: profile.acgrip_api_token.trim().is_empty(),
        },
        SitePublishConfig {
            code: "bangumi",
            label: site_label("bangumi"),
            account_name: profile.bangumi_name.clone(),
            token: None,
            api_token: None,
            enabled: template.sites.bangumi,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "acgnx_asia",
            label: site_label("acgnx_asia"),
            account_name: profile.acgnx_asia_name.clone(),
            token: Some(profile.acgnx_asia_token.clone()),
            api_token: None,
            enabled: template.sites.acgnx_asia,
            uses_cookie: false,
        },
        SitePublishConfig {
            code: "acgnx_global",
            label: site_label("acgnx_global"),
            account_name: profile.acgnx_global_name.clone(),
            token: Some(profile.acgnx_global_token.clone()),
            api_token: None,
            enabled: template.sites.acgnx_global,
            uses_cookie: false,
        },
    ]
}

/// Collect the checks that must pass before a prepared plan can be confirmed.
/// This is a pre-consume mirror of deterministic local publish gates (including the
/// side-effect-light OKP version query for ACG.RIP API Token). Publish execution
/// performs the same checks again immediately before consuming the one-shot plan token.
///
/// Resolves OKP from **live app config**. Use this for legacy `run_publish` paths.
/// Prepare-time binding must use [`bind_configured_okp_for_prepare`] +
/// [`prepare_local_blockers_and_okp_identity`] (single resolve). Prepared-plan
/// publish after identity bind must use
/// [`collect_publish_local_blockers_with_resolved_okp`] with the bound executable
/// so live-config drift cannot false-block or leak a config-path error.
pub(crate) fn collect_publish_local_blockers(
    app: &AppHandle,
    request: &PublishRequest,
) -> Vec<String> {
    // Resolve OKP once so the acgrip API-token version gate can reuse it.
    let resolved_okp = find_okp_executable(app);
    match resolved_okp {
        Ok(okp) => collect_publish_local_blockers_with_resolved_okp(app, request, &okp),
        Err(error) => collect_publish_local_blockers_with_okp_resolve_error(app, request, error),
    }
}

/// Collect local blockers when live OKP resolve already failed (legacy message).
/// Does not re-resolve OKP.
pub(crate) fn collect_publish_local_blockers_with_okp_resolve_error(
    app: &AppHandle,
    request: &PublishRequest,
    okp_resolve_error: String,
) -> Vec<String> {
    let profiles = load_profiles(app);
    let profile = profiles.profiles.get(&request.profile_name);
    let selected_sites = profile
        .map(|profile| {
            collect_site_publish_configs(&request.template, profile)
                .into_iter()
                .filter(|site| site.enabled)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    collect_publish_local_blockers_with(
        request,
        profile,
        selected_sites,
        None,
        Some(okp_resolve_error),
    )
}

/// Collect local blockers using a caller-supplied already-resolved OKP executable.
///
/// Prepared-plan publish must call this with the bound/revalidated identity A so
/// OKP-related local checks (including the acgrip API-token version gate) never
/// re-resolve from live app config. Live config may have switched to another valid
/// executable B or become missing/invalid; that must not false-block a plan bound
/// to A, nor surface a live-config path error. Invalid bound A still fails closed
/// via identity revalidation before this helper runs (or via version gates on A).
pub(crate) fn collect_publish_local_blockers_with_resolved_okp(
    app: &AppHandle,
    request: &PublishRequest,
    resolved_okp: &ResolvedOkpExecutable,
) -> Vec<String> {
    let profiles = load_profiles(app);
    let profile = profiles.profiles.get(&request.profile_name);
    let selected_sites = profile
        .map(|profile| {
            collect_site_publish_configs(&request.template, profile)
                .into_iter()
                .filter(|site| site.enabled)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    collect_publish_local_blockers_with(request, profile, selected_sites, Some(resolved_okp), None)
}

/// Core local-blocker collection used by the live-config and bound-OKP helpers
/// and unit tests. When `resolved_okp` is `Some`, OKP-related checks use that
/// executable only — callers must not pass a live-config resolve error alongside it.
/// `selected_sites` are the enabled sites to validate; when empty and a profile is present,
/// an "at least one site" blocker is produced.
fn collect_publish_local_blockers_with(
    request: &PublishRequest,
    profile: Option<&Profile>,
    selected_sites: Vec<SitePublishConfig>,
    resolved_okp: Option<&ResolvedOkpExecutable>,
    okp_resolve_error: Option<String>,
) -> Vec<String> {
    let mut blockers = Vec::new();
    let redaction_policy = RedactionPolicy::default();
    let mut add_blocker = |message: String| {
        let message = redaction_policy.redact_text(&message);
        if !blockers.contains(&message) {
            blockers.push(message);
        }
    };

    if let Some(error) = okp_resolve_error {
        add_blocker(error);
    }
    if let Err(error) = validate_torrent_path(&request.torrent_path) {
        add_blocker(error);
    }
    if request.template.title.trim().is_empty() {
        add_blocker("标题不能为空，请先填写标题。".to_string());
    }

    let Some(profile) = profile else {
        add_blocker(format!("配置不存在: {}", request.profile_name));
        return blockers;
    };

    if selected_sites.is_empty() {
        add_blocker("至少选择一个发布站点后才能发布。".to_string());
        return blockers;
    }

    let mut acgrip_version_checked = false;
    for site in selected_sites {
        let has_token = site
            .token
            .as_deref()
            .and_then(optional_trimmed)
            .or_else(|| site.api_token.as_deref().and_then(optional_trimmed))
            .is_some();
        if !site.uses_cookie && !has_token {
            add_blocker(format!("{} 的 API Token 不能为空。", site.label));
        }
        if site.uses_cookie {
            if let Err(error) = build_site_publish_cookie_text(&site, profile) {
                add_blocker(error);
            }
        }

        // Mirror run_site_publish: when acgrip uses a non-empty API token, gate on OKP version
        // before the plan token is consumed. Reuse the already-resolved executable and query
        // the version at most once even if multiple acgrip API-token sites are present.
        if site_requires_okp_acgrip_api_token_support(&site) && !acgrip_version_checked {
            acgrip_version_checked = true;
            if let Some(okp_core) = resolved_okp {
                if let Err(error) = ensure_okp_supports_acgrip_api_token(okp_core) {
                    add_blocker(error);
                }
            }
        }

        let markdown = request.template.description.trim();
        let html = request.template.description_html.trim();
        if matches!(site.code, "nyaa" | "acgrip") && markdown.is_empty() {
            add_blocker(format!(
                "{} 需要 Markdown 发布内容，请先填写 Markdown，或不要只保留 HTML。",
                site.label
            ));
        }
        if site_prefers_html_content(site.code) && markdown.is_empty() && html.is_empty() {
            add_blocker(format!(
                "{} 需要 HTML 内容，或可转换为 HTML 的 Markdown 发布内容，请先填写 HTML 或 Markdown。",
                site.label
            ));
        }
    }

    blockers
}

fn build_site_publish_cookie_text(
    site: &SitePublishConfig,
    profile: &Profile,
) -> Result<String, String> {
    if site.uses_cookie {
        let raw_text = get_site_cookie_text(&profile.site_cookies, site.code);
        if !site_cookie_has_entries(raw_text) {
            return Err(format!(
                "{} 缺少有效 Cookie。请先在身份管理器获取并保存对应站点的 Cookie 后再发布。",
                site.label
            ));
        }

        let normalized = normalize_site_cookie_text(raw_text, &profile.user_agent);
        if !site_cookie_has_entries(&normalized) {
            return Err(format!("{} 缺少可用于发布的 Cookie。", site.label));
        }

        return Ok(normalized);
    }

    let user_agent = resolve_site_cookie_user_agent("", &profile.user_agent);
    Ok(format!("user-agent:\t{}", user_agent))
}

fn optional_non_empty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn optional_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn serialize_site_template_toml(
    template: &Template,
    site: &SitePublishConfig,
    description_file_name: &str,
    user_agent: &str,
    proxy: Option<&str>,
) -> Result<String, String> {
    let tags: Vec<&str> = template
        .tags
        .split(',')
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect();

    let document = SiteTemplateToml {
        display_name: &template.title,
        filename_regex: optional_non_empty(&template.ep_pattern),
        resolution_regex: optional_non_empty(&template.resolution_pattern),
        poster: optional_non_empty(&template.poster),
        about: optional_non_empty(&template.about),
        tags,
        intro_template: vec![SiteTemplateIntroToml {
            site: site.code,
            name: &site.account_name,
            content: description_file_name,
            user_agent: optional_non_empty(user_agent),
            cookie: site.token.as_deref().and_then(optional_trimmed),
            api_token: site.api_token.as_deref().and_then(optional_trimmed),
            proxy,
        }],
    };

    toml::to_string(&document).map_err(|error| format!("序列化 template.toml 失败: {}", error))
}

fn site_prefers_html_content(site_code: &str) -> bool {
    matches!(
        site_code,
        "dmhy" | "bangumi" | "acgnx_asia" | "acgnx_global"
    )
}

fn select_publish_content_path<'a>(
    template: &Template,
    site: &SitePublishConfig,
    artifacts: &'a PublishArtifacts,
) -> Result<&'a Path, String> {
    let markdown = template.description.trim();
    let html = template.description_html.trim();

    if matches!(site.code, "nyaa" | "acgrip") && markdown.is_empty() {
        return Err(format!(
            "{} 需要 Markdown 发布内容，请先填写 Markdown，或不要只保留 HTML。",
            site.label
        ));
    }

    if site_prefers_html_content(site.code) {
        if !html.is_empty() {
            return Ok(&artifacts.html_description_path);
        }

        if !markdown.is_empty() {
            return Ok(&artifacts.markdown_description_path);
        }

        return Err(format!(
            "{} 需要 HTML 内容，或可转换为 HTML 的 Markdown 发布内容，请先填写 HTML 或 Markdown。",
            site.label
        ));
    }

    Ok(&artifacts.markdown_description_path)
}

fn write_publish_description_files(
    template: &Template,
    artifacts: &PublishArtifacts,
) -> Result<(), String> {
    std::fs::write(&artifacts.markdown_description_path, &template.description)
        .map_err(|e| format!("写入 description.md 失败: {}", e))?;

    if template.description_html.trim().is_empty() {
        let _ = std::fs::remove_file(&artifacts.html_description_path);
        return Ok(());
    }

    std::fs::write(&artifacts.html_description_path, &template.description_html)
        .map_err(|e| format!("写入 description.html 失败: {}", e))?;

    Ok(())
}

fn generate_site_template_toml(
    app: &AppHandle,
    template: &Template,
    site: &SitePublishConfig,
    artifacts: &PublishArtifacts,
    user_agent: &str,
) -> Result<(), String> {
    let config = load_config(app);

    if template.title.trim().is_empty() {
        return Err("标题不能为空，请先填写标题。".to_string());
    }

    let has_token = site
        .token
        .as_deref()
        .and_then(optional_trimmed)
        .or_else(|| site.api_token.as_deref().and_then(optional_trimmed))
        .is_some();
    if !site.uses_cookie && !has_token {
        return Err(format!("{} 的 API Token 不能为空。", site.label));
    }

    write_publish_description_files(template, artifacts)?;

    let description_file_name = select_publish_content_path(template, site, artifacts)?
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法生成发布内容文件名。".to_string())?;

    let proxy = if config.proxy.proxy_type == "http" {
        optional_trimmed(&config.proxy.proxy_host)
    } else {
        None
    };

    let toml_content =
        serialize_site_template_toml(template, site, description_file_name, user_agent, proxy)?;

    std::fs::write(&artifacts.template_path, &toml_content)
        .map_err(|e| format!("写入 template.toml 失败: {}", e))?;

    Ok(())
}

fn spawn_output_reader<R>(
    reader: R,
    app: AppHandle,
    publish_id: String,
    site_code: String,
    site_label: String,
    is_stderr: bool,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();

        loop {
            buffer.clear();

            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                        buffer.pop();
                    }

                    emit_publish_output(
                        &app,
                        &publish_id,
                        &site_code,
                        &site_label,
                        decode_publish_output(&buffer),
                        is_stderr,
                    );
                }
                Err(error) => {
                    emit_publish_output(
                        &app,
                        &publish_id,
                        &site_code,
                        &site_label,
                        format!("读取 OKP 输出失败: {}", error),
                        true,
                    );
                    break;
                }
            }
        }
    })
}

fn build_failure_message(status_code: Option<i32>, log_path: &Path) -> String {
    let exit_code = status_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "未知".to_string());

    if log_path.exists() {
        format!(
            "发布失败，退出码: {}。日志已保存到 {}",
            exit_code,
            log_path.display()
        )
    } else {
        format!("发布失败，退出码: {}。", exit_code)
    }
}

fn format_command_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".to_string();
    }

    if argument.contains([' ', '\t', '"']) {
        format!("\"{}\"", argument.replace('"', "\\\""))
    } else {
        argument.to_string()
    }
}

pub(crate) fn run_site_publish(
    app: &AppHandle,
    publish_id: &str,
    okp_core: &ResolvedOkpExecutable,
    torrent_path: &Path,
    template: &Template,
    profile: &Profile,
    site: &SitePublishConfig,
) -> SitePublishResult {
    let artifacts = match create_publish_artifacts(app, site.code) {
        Ok(artifacts) => artifacts,
        Err(error) => return site.build_result(false, error, None),
    };

    let result = (|| -> Result<SitePublishResult, String> {
        let api_token_mode = site
            .api_token
            .as_deref()
            .and_then(optional_trimmed)
            .is_some();
        if site_requires_okp_acgrip_api_token_support(site) {
            let detected_version = ensure_okp_supports_acgrip_api_token(okp_core)?;
            emit_publish_output(
                app,
                publish_id,
                site.code,
                site.label,
                format!(
                    "已确认 OKP.Core {} 支持 ACG.RIP API Token。",
                    detected_version
                ),
                false,
            );
        }
        let cookie_text = if api_token_mode {
            None
        } else {
            Some(build_site_publish_cookie_text(site, profile)?)
        };
        let site_user_agent = resolve_site_cookie_user_agent(
            cookie_text.as_deref().unwrap_or_default(),
            &profile.user_agent,
        );

        generate_site_template_toml(app, template, site, &artifacts, &site_user_agent)?;

        emit_publish_output(
            app,
            publish_id,
            site.code,
            site.label,
            format!(
                "{} 使用 {} 认证。",
                site.label,
                if site.uses_cookie {
                    "Cookie"
                } else {
                    "API Token"
                }
            ),
            false,
        );

        let mut command_arguments = vec![
            torrent_path.display().to_string(),
            "-s".to_string(),
            artifacts.template_path.display().to_string(),
            "--no_reaction".to_string(),
            "--log_file".to_string(),
            artifacts.log_path.display().to_string(),
        ];
        if let Some(cookie_text) = cookie_text.as_deref() {
            std::fs::write(&artifacts.cookies_path, cookie_text)
                .map_err(|e| format!("写入 cookies.txt 失败: {}", e))?;
            emit_publish_output(
                app,
                publish_id,
                site.code,
                site.label,
                format!(
                    "已生成 {} 的 Cookie 文件: {} ({} 字节)",
                    site.label,
                    artifacts.cookies_path.display(),
                    cookie_text.len()
                ),
                false,
            );
            command_arguments.extend([
                "--cookies".to_string(),
                artifacts.cookies_path.display().to_string(),
            ]);
        }

        let command_preview = okp_core
            .preview_parts(&command_arguments)
            .into_iter()
            .map(|argument| format_command_argument(&argument))
            .collect::<Vec<_>>()
            .join(" ");

        emit_publish_output(
            app,
            publish_id,
            site.code,
            site.label,
            format!("{} 命令行: {}", site.label, command_preview),
            false,
        );

        let mut command = Command::new(okp_core.program());
        command
            .current_dir(&okp_core.working_dir)
            .env("DOTNET_CLI_FORCE_UTF8_ENCODING", "1")
            .env("DOTNET_SYSTEM_CONSOLE_OUTPUT_ENCODING", "utf-8")
            .env("DOTNET_SYSTEM_CONSOLE_INPUT_ENCODING", "utf-8")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        okp_core.configure_command(&mut command, &command_arguments);

        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 OKP.Core 失败: {}", error))?;

        let mut stdout_handle = child.stdout.take().map(|stdout| {
            spawn_output_reader(
                stdout,
                app.clone(),
                publish_id.to_string(),
                site.code.to_string(),
                site.label.to_string(),
                false,
            )
        });
        let mut stderr_handle = child.stderr.take().map(|stderr| {
            spawn_output_reader(
                stderr,
                app.clone(),
                publish_id.to_string(),
                site.code.to_string(),
                site.label.to_string(),
                true,
            )
        });

        let status = child
            .wait()
            .map_err(|error| format!("等待 OKP.Core 完成失败: {}", error))?;

        if let Some(handle) = stdout_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_handle.take() {
            let _ = handle.join();
        }

        let updated_cookie_text = site
            .uses_cookie
            .then(|| std::fs::read_to_string(&artifacts.cookies_path).ok())
            .flatten();

        if status.success() {
            cleanup_publish_artifacts(&artifacts, false);
            Ok(site.build_result(
                true,
                format!("{} 发布完成", site.label),
                updated_cookie_text,
            ))
        } else {
            let failure_message = build_failure_message(status.code(), &artifacts.log_path);
            cleanup_publish_artifacts(&artifacts, true);
            Ok(site.build_result(
                false,
                format!("{}: {}", site.label, failure_message),
                updated_cookie_text,
            ))
        }
    })();

    match result {
        Ok(result) => result,
        Err(error) => {
            emit_publish_output(
                app,
                publish_id,
                site.code,
                site.label,
                format!("{} 预处理失败: {}", site.label, error),
                true,
            );
            cleanup_publish_artifacts(&artifacts, true);
            site.build_result(false, error, None)
        }
    }
}

pub async fn publish(app: AppHandle, request: PublishRequest) -> Result<(), String> {
    crate::commands::publish_commands::publish_legacy(app, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn test_parse_okp_semantic_version_accepts_release_and_build_metadata() {
        let plain =
            parse_okp_semantic_version("1.2.1").expect("expected plain semantic version to parse");
        let official = parse_okp_semantic_version("1.2.1+3f36bb1486f87606296a5ed7165cae12b3f5d255")
            .expect("expected upstream informational version to parse");
        let prefixed = parse_okp_semantic_version("OKP.Core v1.10.0\n")
            .expect("expected prefixed semantic version to parse");

        assert_eq!((plain.major, plain.minor, plain.patch), (1, 2, 1));
        assert!(plain.pre.is_empty());
        assert_eq!(
            official.to_string(),
            "1.2.1+3f36bb1486f87606296a5ed7165cae12b3f5d255"
        );
        assert_eq!((prefixed.major, prefixed.minor, prefixed.patch), (1, 10, 0));
    }

    #[test]
    fn test_parse_okp_semantic_version_rejects_malformed_values() {
        for output in ["", "not-a-version", "1.2", "01.2.1", "1.2.1-01"] {
            assert!(
                parse_okp_semantic_version(output).is_none(),
                "expected {output:?} to be rejected"
            );
        }
    }

    #[test]
    fn test_okp_version_gate_uses_semantic_version_precedence() {
        for supported in ["1.2.1", "1.2.1+commit", "1.2.2-beta.1", "2.0.0"] {
            let version =
                parse_okp_semantic_version(supported).expect("expected supported fixture to parse");
            assert!(
                okp_version_supports_acgrip_api_token(&version),
                "expected {supported} to pass"
            );
        }

        for unsupported in ["1.2.0", "1.2.1-rc.1", "1.1.99"] {
            let version = parse_okp_semantic_version(unsupported)
                .expect("expected unsupported fixture to parse");
            assert!(
                !okp_version_supports_acgrip_api_token(&version),
                "expected {unsupported} to fail"
            );
        }
    }

    #[test]
    fn test_acgrip_api_token_version_gate_only_applies_to_non_empty_token() {
        let mut site = SitePublishConfig {
            code: "acgrip",
            label: "ACG.RIP",
            account_name: "Uploader".to_string(),
            token: None,
            api_token: Some(" api-token ".to_string()),
            enabled: true,
            uses_cookie: false,
        };

        assert!(site_requires_okp_acgrip_api_token_support(&site));

        site.api_token = Some("   ".to_string());
        site.uses_cookie = true;
        assert!(!site_requires_okp_acgrip_api_token_support(&site));

        site.code = "acgnx_asia";
        site.api_token = Some("api-token".to_string());
        site.uses_cookie = false;
        assert!(!site_requires_okp_acgrip_api_token_support(&site));
    }

    #[cfg(unix)]
    #[test]
    fn test_query_okp_semantic_version_runs_selected_core() {
        let executable_path =
            create_test_okp_version_script("1.2.1+3f36bb1486f87606296a5ed7165cae12b3f5d255", 0);
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected test OKP path to resolve");

        let version = query_okp_semantic_version(&resolved)
            .expect("expected test OKP version query to succeed");

        assert_eq!((version.major, version.minor, version.patch), (1, 2, 1));
        assert!(okp_version_supports_acgrip_api_token(&version));

        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_ensure_okp_supports_acgrip_api_token_rejects_old_core() {
        let executable_path = create_test_okp_version_script("1.2.0+old-build", 0);
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected test OKP path to resolve");

        let error = ensure_okp_supports_acgrip_api_token(&resolved)
            .expect_err("expected old OKP version to be rejected");

        assert!(
            error.contains("1.2.0+old-build"),
            "unexpected error: {error}"
        );
        assert!(error.contains(">= 1.2.1"), "unexpected error: {error}");
        assert!(error.contains("Cookie"), "unexpected error: {error}");

        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_collect_publish_local_blockers_old_okp_blocks_acgrip_api_token_once() {
        let counter_path = std::env::temp_dir().join(format!(
            "okpgui-next-okp-version-count-{}-{}",
            std::process::id(),
            TEST_PATH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&counter_path);
        let executable_path =
            create_test_okp_version_script_with_counter("1.2.0+old-build", 0, &counter_path);
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected test OKP path to resolve");

        let torrent_path = std::env::temp_dir().join(format!(
            "okpgui-next-publish-blocker-torrent-{}-{}.torrent",
            std::process::id(),
            TEST_PATH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&torrent_path, b"d4:infod4:name4:testee").expect("expected torrent fixture");

        let profile = Profile {
            acgrip_name: "Uploader".to_string(),
            acgrip_api_token: "api-token-123".to_string(),
            ..Profile::default()
        };
        let mut template = Template::default();
        template.title = "Example Release".to_string();
        template.description = "# markdown description".to_string();
        template.sites.acgrip = true;

        // Two enabled acgrip API-token sites: version must be queried once.
        let selected_sites = vec![
            SitePublishConfig {
                code: "acgrip",
                label: "ACG.RIP",
                account_name: "Uploader".to_string(),
                token: None,
                api_token: Some("api-token-123".to_string()),
                enabled: true,
                uses_cookie: false,
            },
            SitePublishConfig {
                code: "acgrip",
                label: "ACG.RIP Mirror",
                account_name: "Uploader".to_string(),
                token: None,
                api_token: Some("api-token-456".to_string()),
                enabled: true,
                uses_cookie: false,
            },
        ];

        let request = PublishRequest {
            publish_id: "test-publish".to_string(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "default".to_string(),
            template,
        };

        let blockers = collect_publish_local_blockers_with(
            &request,
            Some(&profile),
            selected_sites,
            Some(&resolved),
            None,
        );

        let version_blocker = blockers
            .iter()
            .find(|blocker| blocker.contains("1.2.0+old-build") || blocker.contains(">= 1.2.1"))
            .cloned()
            .expect("expected old OKP.Core version blocker for acgrip API token");
        assert!(
            version_blocker.contains("1.2.0+old-build"),
            "unexpected blocker: {version_blocker}"
        );
        assert!(
            version_blocker.contains(">= 1.2.1"),
            "unexpected blocker: {version_blocker}"
        );
        // Deduped: one blocker even with two acgrip API-token sites.
        let version_blocker_count = blockers
            .iter()
            .filter(|blocker| blocker.contains(">= 1.2.1"))
            .count();
        assert_eq!(version_blocker_count, 1);

        let counter = std::fs::read_to_string(&counter_path).unwrap_or_default();
        let query_count = counter.lines().filter(|line| !line.is_empty()).count();
        assert_eq!(
            query_count, 1,
            "expected a single OKP --version probe, got {query_count}: {counter:?}"
        );

        let _ = std::fs::remove_file(&torrent_path);
        let _ = std::fs::remove_file(&counter_path);
        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    /// Prepared-plan local checks must use the bound/resolved OKP only.
    /// A live-config resolve error (missing path, switched invalid B, etc.) must not
    /// be mixed in when the caller already supplies identity A.
    #[cfg(unix)]
    #[test]
    fn test_collect_publish_local_blockers_with_bound_okp_ignores_live_config_resolve_error() {
        let executable_path = create_test_okp_version_script("1.2.1+bound-a", 0);
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected bound OKP A to resolve");

        let torrent_path = std::env::temp_dir().join(format!(
            "okpgui-next-publish-blocker-bound-{}-{}.torrent",
            std::process::id(),
            TEST_PATH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&torrent_path, b"d4:infod4:name4:testee").expect("expected torrent fixture");

        let profile = Profile {
            acgrip_name: "Uploader".to_string(),
            acgrip_api_token: "api-token-123".to_string(),
            ..Profile::default()
        };
        let mut template = Template::default();
        template.title = "Example Release".to_string();
        template.description = "# markdown description".to_string();
        template.sites.acgrip = true;

        let selected_sites = vec![SitePublishConfig {
            code: "acgrip",
            label: "ACG.RIP",
            account_name: "Uploader".to_string(),
            token: None,
            api_token: Some("api-token-123".to_string()),
            enabled: true,
            uses_cookie: false,
        }];

        let request = PublishRequest {
            publish_id: "test-publish-bound".to_string(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "default".to_string(),
            template,
        };

        // Bound-path contract: Some(resolved A) + None resolve error.
        // Even if live config would report a missing/invalid path, prepared publish
        // must not inject that error when checking against bound A.
        let live_config_error =
            "未选择 OKP 可执行文件，请先在首页选择 OKP.Core 可执行文件或 DLL。".to_string();
        let blockers_bound = collect_publish_local_blockers_with(
            &request,
            Some(&profile),
            selected_sites.clone(),
            Some(&resolved),
            None,
        );
        assert!(
            blockers_bound
                .iter()
                .all(|b| !b.contains("未选择 OKP") && !b.contains("不存在")),
            "bound OKP path must not surface live-config resolve errors: {blockers_bound:?}"
        );
        assert!(
            blockers_bound
                .iter()
                .all(|b| !b.contains(">= 1.2.1") && !b.contains("1.2.0")),
            "sufficient bound OKP A must not version-block: {blockers_bound:?}"
        );

        // Contrast: live-config helper path surfaces the resolve error when no OKP is bound.
        let blockers_live_err = collect_publish_local_blockers_with(
            &request,
            Some(&profile),
            selected_sites,
            None,
            Some(live_config_error.clone()),
        );
        assert!(
            blockers_live_err.iter().any(|b| b.contains("未选择 OKP")),
            "live-config path should still surface resolve errors: {blockers_live_err:?}"
        );

        let _ = std::fs::remove_file(&torrent_path);
        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    #[test]
    fn test_build_site_publish_cookie_text_rejects_missing_cookie_site() {
        let site = SitePublishConfig {
            code: "bangumi",
            label: "萌番组",
            account_name: "Team".to_string(),
            token: None,
            api_token: None,
            enabled: true,
            uses_cookie: true,
        };

        let error = build_site_publish_cookie_text(&site, &Profile::default())
            .expect_err("expected missing cookie error");

        assert!(error.contains("萌番组"));
    }

    #[test]
    fn test_build_site_publish_cookie_text_for_token_site_generates_user_agent_file() {
        let site = SitePublishConfig {
            code: "acgnx_asia",
            label: "ACGNx Asia",
            account_name: "Uploader".to_string(),
            token: Some("token-123".to_string()),
            api_token: None,
            enabled: true,
            uses_cookie: false,
        };

        let profile = Profile {
            user_agent: "Mozilla/5.0 Publish".to_string(),
            ..Profile::default()
        };

        let cookie_text = build_site_publish_cookie_text(&site, &profile)
            .expect("expected token site cookie file");

        assert_eq!(cookie_text, "user-agent:\tMozilla/5.0 Publish");
    }

    #[test]
    fn test_collect_acgrip_publish_config_prefers_api_token() {
        let mut template = Template::default();
        template.sites.acgrip = true;
        let profile = Profile {
            acgrip_name: "Uploader".to_string(),
            acgrip_api_token: "  api-token-123  ".to_string(),
            ..Profile::default()
        };

        let site = collect_site_publish_configs(&template, &profile)
            .into_iter()
            .find(|site| site.code == "acgrip")
            .expect("expected ACG.RIP publish config");

        assert!(site.enabled);
        assert!(!site.uses_cookie);
        assert_eq!(site.api_token.as_deref(), Some("  api-token-123  "));
        assert!(site.token.is_none());
    }

    #[test]
    fn test_collect_acgrip_publish_config_falls_back_to_cookie() {
        let profile = Profile {
            acgrip_api_token: "   ".to_string(),
            ..Profile::default()
        };

        let site = collect_site_publish_configs(&Template::default(), &profile)
            .into_iter()
            .find(|site| site.code == "acgrip")
            .expect("expected ACG.RIP publish config");

        assert!(site.uses_cookie);
    }

    #[test]
    fn test_acgrip_cookie_fallback_rejects_missing_cookie() {
        let site = SitePublishConfig {
            code: "acgrip",
            label: "ACG.RIP",
            account_name: "Uploader".to_string(),
            token: None,
            api_token: Some(String::new()),
            enabled: true,
            uses_cookie: true,
        };

        let error = build_site_publish_cookie_text(&site, &Profile::default())
            .expect_err("expected missing ACG.RIP cookie error");

        assert!(error.contains("ACG.RIP"));
        assert!(error.contains("Cookie"));
    }

    #[test]
    fn test_find_okp_executable_requires_selected_path() {
        let error = resolve_selected_okp_executable("   ")
            .expect_err("expected empty configured path to error");
        assert!(error.contains("未选择 OKP 可执行文件"));
    }

    #[test]
    fn test_select_publish_content_path_prefers_html_for_html_sites() {
        let template = Template {
            description: "# md".to_string(),
            description_html: "<p>html</p>".to_string(),
            ..Template::default()
        };
        let site = SitePublishConfig {
            code: "dmhy",
            label: "动漫花园",
            account_name: "Team".to_string(),
            token: None,
            api_token: None,
            enabled: true,
            uses_cookie: true,
        };
        let artifacts = PublishArtifacts {
            workspace_dir: PathBuf::from("workspace"),
            template_path: PathBuf::from("template.toml"),
            cookies_path: PathBuf::from("cookies.txt"),
            markdown_description_path: PathBuf::from("description.md"),
            html_description_path: PathBuf::from("description.html"),
            log_path: PathBuf::from("okp.log"),
        };

        let path = select_publish_content_path(&template, &site, &artifacts)
            .expect("expected html-capable site to accept html content");

        assert_eq!(path, Path::new("description.html"));
    }

    #[test]
    fn test_select_publish_content_path_requires_markdown_for_acgrip() {
        let template = Template {
            description: String::new(),
            description_html: "<p>html only</p>".to_string(),
            ..Template::default()
        };
        let site = SitePublishConfig {
            code: "acgrip",
            label: "ACG.RIP",
            account_name: "Team".to_string(),
            token: None,
            api_token: None,
            enabled: true,
            uses_cookie: true,
        };
        let artifacts = PublishArtifacts {
            workspace_dir: PathBuf::from("workspace"),
            template_path: PathBuf::from("template.toml"),
            cookies_path: PathBuf::from("cookies.txt"),
            markdown_description_path: PathBuf::from("description.md"),
            html_description_path: PathBuf::from("description.html"),
            log_path: PathBuf::from("okp.log"),
        };

        let error = select_publish_content_path(&template, &site, &artifacts)
            .expect_err("expected bbcode site to require markdown input");

        assert!(error.contains("ACG.RIP"));
    }

    #[test]
    fn test_select_publish_content_path_requires_any_content_for_html_sites() {
        let template = Template {
            description: String::new(),
            description_html: String::new(),
            ..Template::default()
        };
        let site = SitePublishConfig {
            code: "dmhy",
            label: "动漫花园",
            account_name: "Team".to_string(),
            token: None,
            api_token: None,
            enabled: true,
            uses_cookie: true,
        };
        let artifacts = PublishArtifacts {
            workspace_dir: PathBuf::from("workspace"),
            template_path: PathBuf::from("template.toml"),
            cookies_path: PathBuf::from("cookies.txt"),
            markdown_description_path: PathBuf::from("description.md"),
            html_description_path: PathBuf::from("description.html"),
            log_path: PathBuf::from("okp.log"),
        };

        let error = select_publish_content_path(&template, &site, &artifacts)
            .expect_err("expected html-first site to require html or markdown content");

        assert!(error.contains("动漫花园"));
    }

    fn create_test_okp_layout(file_name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "okpgui-next-publish-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            TEST_PATH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let tags_dir = root.join("config").join("tags");
        std::fs::create_dir_all(&tags_dir).expect("expected tags dir to be created");

        for file in REQUIRED_OKP_TAG_FILES {
            std::fs::write(tags_dir.join(file), "{}")
                .expect("expected required OKP tag file to be created");
        }

        let executable_path = root.join(file_name);
        std::fs::write(&executable_path, "test").expect("expected dummy executable to be created");
        executable_path
    }

    #[cfg(unix)]
    fn create_test_okp_version_script(version_output: &str, exit_code: i32) -> PathBuf {
        create_test_okp_version_script_with_counter(version_output, exit_code, Path::new(""))
    }

    #[cfg(unix)]
    fn create_test_okp_version_script_with_counter(
        version_output: &str,
        exit_code: i32,
        counter_path: &Path,
    ) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let executable_path = create_test_okp_layout("OKP.Core");
        let counter_line = if counter_path.as_os_str().is_empty() {
            String::new()
        } else {
            // Record each --version invocation so tests can assert single-probe behavior.
            format!("printf '1\\n' >> '{}'\n", counter_path.display())
        };
        let script = format!(
            "#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 64\n{}printf '%s\\n' '{}'\nexit {}\n",
            counter_line, version_output, exit_code
        );
        std::fs::write(&executable_path, script)
            .expect("expected test OKP version script to be written");
        let mut permissions = std::fs::metadata(&executable_path)
            .expect("expected test OKP script metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable_path, permissions)
            .expect("expected test OKP script to be executable");
        executable_path
    }

    fn create_test_publish_artifacts(prefix: &str) -> PublishArtifacts {
        let workspace_dir = std::env::temp_dir().join(format!(
            "okpgui-next-{}-{}-{}",
            prefix,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&workspace_dir).expect("expected workspace dir to be created");

        PublishArtifacts {
            template_path: workspace_dir.join("template.toml"),
            cookies_path: workspace_dir.join("cookies.txt"),
            markdown_description_path: workspace_dir.join("description.md"),
            html_description_path: workspace_dir.join("description.html"),
            log_path: workspace_dir.join("okp.log"),
            workspace_dir,
        }
    }

    fn write_test_publish_artifacts(artifacts: &PublishArtifacts) {
        std::fs::write(&artifacts.template_path, "cookie = \"token-123\"")
            .expect("expected template file to be written");
        std::fs::write(&artifacts.cookies_path, "session=value")
            .expect("expected cookies file to be written");
        std::fs::write(&artifacts.markdown_description_path, "# description")
            .expect("expected markdown description file to be written");
        std::fs::write(&artifacts.html_description_path, "<p>description</p>")
            .expect("expected html description file to be written");
        std::fs::write(&artifacts.log_path, "publish log")
            .expect("expected log file to be written");
    }

    fn create_test_site_publish_config() -> SitePublishConfig {
        SitePublishConfig {
            code: "dmhy",
            label: "动漫花园",
            account_name: "Team".to_string(),
            token: Some("token-123".to_string()),
            api_token: None,
            enabled: true,
            uses_cookie: false,
        }
    }

    #[test]
    fn test_template_toml_serialization_preserves_regex_values() {
        let template = Template {
            title: "Example Release".to_string(),
            ep_pattern: "abc'''\nproxy = \"http://evil.example:8080\"\n#".to_string(),
            resolution_pattern: "1080p'''\n[[intro_template]]\nsite = \"evil\"\nname = \"attacker\"\ncontent = \"pwn.md\"\n#".to_string(),
            poster: "poster.png".to_string(),
            about: "about text".to_string(),
            tags: "tag-a, tag-b".to_string(),
            ..Template::default()
        };
        let site = create_test_site_publish_config();

        let toml_content = serialize_site_template_toml(
            &template,
            &site,
            "description.md",
            "Mozilla/5.0 Publish",
            Some("http://proxy.local:8080"),
        )
        .expect("expected template.toml serialization to succeed");

        let parsed: toml::Value = toml::from_str(&toml_content)
            .expect("expected serialized template.toml to parse back successfully");

        assert_eq!(
            parsed.get("filename_regex").and_then(toml::Value::as_str),
            Some(template.ep_pattern.as_str())
        );
        assert_eq!(
            parsed.get("resolution_regex").and_then(toml::Value::as_str),
            Some(template.resolution_pattern.as_str())
        );
        assert!(parsed.get("proxy").is_none());

        let intro_templates = parsed
            .get("intro_template")
            .and_then(toml::Value::as_array)
            .expect("expected intro_template array");
        assert_eq!(intro_templates.len(), 1);

        let intro = intro_templates[0]
            .as_table()
            .expect("expected intro_template entry to be a table");
        assert_eq!(
            intro.get("site").and_then(toml::Value::as_str),
            Some("dmhy")
        );
        assert_eq!(
            intro.get("name").and_then(toml::Value::as_str),
            Some("Team")
        );
        assert_eq!(
            intro.get("content").and_then(toml::Value::as_str),
            Some("description.md")
        );
        assert_eq!(
            intro.get("proxy").and_then(toml::Value::as_str),
            Some("http://proxy.local:8080")
        );
    }

    #[test]
    fn test_template_toml_serialization_round_trips_expected_structure() {
        let template = Template {
            title: "Example Release".to_string(),
            ep_pattern: r"(?P<ep>\d+)".to_string(),
            resolution_pattern: r"(?P<res>1080p)".to_string(),
            poster: "poster.png".to_string(),
            about: "about text".to_string(),
            tags: "tag-a, tag-b".to_string(),
            ..Template::default()
        };
        let site = create_test_site_publish_config();

        let toml_content = serialize_site_template_toml(
            &template,
            &site,
            "description.md",
            "Mozilla/5.0 Publish",
            Some("http://proxy.local:8080"),
        )
        .expect("expected template.toml serialization to succeed");

        let parsed: toml::Value = toml::from_str(&toml_content)
            .expect("expected serialized template.toml to parse back successfully");

        assert_eq!(
            parsed.get("display_name").and_then(toml::Value::as_str),
            Some("Example Release")
        );
        assert_eq!(
            parsed.get("poster").and_then(toml::Value::as_str),
            Some("poster.png")
        );
        assert_eq!(
            parsed.get("about").and_then(toml::Value::as_str),
            Some("about text")
        );

        let tags = parsed
            .get("tags")
            .and_then(toml::Value::as_array)
            .expect("expected tags array to be present");
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].as_str(), Some("tag-a"));
        assert_eq!(tags[1].as_str(), Some("tag-b"));

        let intro_templates = parsed
            .get("intro_template")
            .and_then(toml::Value::as_array)
            .expect("expected intro_template array");
        assert_eq!(intro_templates.len(), 1);

        let intro = intro_templates[0]
            .as_table()
            .expect("expected intro_template entry to be a table");
        assert_eq!(
            intro.get("user_agent").and_then(toml::Value::as_str),
            Some("Mozilla/5.0 Publish")
        );
        assert_eq!(
            intro.get("cookie").and_then(toml::Value::as_str),
            Some("token-123")
        );
        assert!(intro.get("api_token").is_none());
    }

    #[test]
    fn test_acgrip_api_token_serializes_safely_without_cookie() {
        let api_token = "api-token-123\"\nnot-a-new-key";
        let site = SitePublishConfig {
            code: "acgrip",
            label: "ACG.RIP",
            account_name: "Uploader".to_string(),
            token: None,
            api_token: Some(api_token.to_string()),
            enabled: true,
            uses_cookie: false,
        };
        let template = Template {
            title: "Example Release".to_string(),
            description: "# description".to_string(),
            ..Template::default()
        };

        let toml_content = serialize_site_template_toml(
            &template,
            &site,
            "description.md",
            "Mozilla/5.0 Publish",
            None,
        )
        .expect("expected ACG.RIP template serialization to succeed");
        let parsed: toml::Value =
            toml::from_str(&toml_content).expect("expected serialized ACG.RIP template to parse");
        let intro = parsed
            .get("intro_template")
            .and_then(toml::Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(toml::Value::as_table)
            .expect("expected ACG.RIP intro template");

        assert_eq!(
            intro.get("api_token").and_then(toml::Value::as_str),
            Some(api_token)
        );
        assert!(intro.get("cookie").is_none());
    }

    #[test]
    fn test_cleanup_publish_artifacts_removes_workspace_after_success() {
        let artifacts = create_test_publish_artifacts("publish-cleanup-success");
        write_test_publish_artifacts(&artifacts);

        cleanup_publish_artifacts(&artifacts, false);

        assert!(!artifacts.template_path.exists());
        assert!(!artifacts.cookies_path.exists());
        assert!(!artifacts.markdown_description_path.exists());
        assert!(!artifacts.html_description_path.exists());
        assert!(!artifacts.log_path.exists());
        assert!(!artifacts.workspace_dir.exists());
    }

    #[test]
    fn test_cleanup_publish_artifacts_removes_sensitive_files_after_failure() {
        let artifacts = create_test_publish_artifacts("publish-cleanup-failure");
        write_test_publish_artifacts(&artifacts);

        cleanup_publish_artifacts(&artifacts, true);

        assert!(!artifacts.template_path.exists());
        assert!(!artifacts.cookies_path.exists());
        assert!(!artifacts.markdown_description_path.exists());
        assert!(!artifacts.html_description_path.exists());
        assert!(artifacts.log_path.exists());
        assert!(artifacts.workspace_dir.exists());

        let _ = std::fs::remove_dir_all(&artifacts.workspace_dir);
    }

    #[test]
    fn test_updated_cookie_text_for_persistence_requires_success() {
        let result = SitePublishResult {
            site_code: "dmhy".to_string(),
            site_label: "动漫花园".to_string(),
            success: false,
            message: "publish failed".to_string(),
            updated_cookie_text: Some(
                "user-agent:\tMozilla/5.0\nhttps://share.dmhy.org\tdmhy_sid=bad".to_string(),
            ),
        };

        assert_eq!(
            publish_history::updated_cookie_text_for_persistence(&result),
            None
        );
    }

    #[test]
    fn test_updated_cookie_text_for_persistence_allows_successful_updates() {
        let result = SitePublishResult {
            site_code: "dmhy".to_string(),
            site_label: "动漫花园".to_string(),
            success: true,
            message: "publish succeeded".to_string(),
            updated_cookie_text: Some(
                "user-agent:\tMozilla/5.0\nhttps://share.dmhy.org\tdmhy_sid=good".to_string(),
            ),
        };

        assert_eq!(
            publish_history::updated_cookie_text_for_persistence(&result),
            Some("user-agent:\tMozilla/5.0\nhttps://share.dmhy.org\tdmhy_sid=good")
        );
    }

    #[test]
    fn test_find_okp_executable_allows_dll() {
        let executable_path = create_test_okp_layout("OKP.Core.dll");
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected dll OKP path to resolve");

        match resolved.launch_mode {
            OkpLaunchMode::DotnetDll => {}
            OkpLaunchMode::Direct => panic!("expected dll OKP path to use dotnet launch mode"),
        }

        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent")
                .to_path_buf(),
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_find_okp_executable_allows_non_windows_binary() {
        let executable_path = create_test_okp_layout("OKP.Core");
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("expected unix OKP path to resolve");

        match resolved.launch_mode {
            OkpLaunchMode::Direct => {}
            OkpLaunchMode::DotnetDll => panic!("expected direct launch mode for native binary"),
        }

        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent")
                .to_path_buf(),
        );
    }

    #[test]
    fn okp_identity_revalidation_passes_when_unchanged() {
        let executable_path = create_test_okp_layout("OKP.Core.dll");
        let identity = capture_okp_executable_identity(&executable_path.display().to_string())
            .expect("expected OKP identity capture");
        assert_eq!(identity.launch_mode(), OkpLaunchMode::DotnetDll);
        assert!(identity.executable_digest().starts_with("sha256:"));
        let resolved = identity
            .revalidate()
            .expect("unchanged executable identity must revalidate");
        assert_eq!(resolved.executable_path(), executable_path.as_path());
        assert_eq!(resolved.launch_mode(), OkpLaunchMode::DotnetDll);
        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    #[test]
    fn okp_identity_revalidation_detects_same_path_replacement() {
        let executable_path = create_test_okp_layout("OKP.Core.dll");
        let path_str = executable_path.display().to_string();
        let identity =
            capture_okp_executable_identity(&path_str).expect("expected OKP identity capture");
        // Same path, different file bytes (replacement attack).
        std::fs::write(&executable_path, b"replaced-okp-bytes").expect("replace executable");
        let error = identity
            .revalidate()
            .expect_err("replaced executable must fail revalidation");
        assert!(
            error.contains("替换") || error.contains("重新执行"),
            "unexpected error: {error}"
        );
        assert!(
            !error.contains(&path_str),
            "revalidation error must not expose OKP path: {error}"
        );
        let _ = std::fs::remove_dir_all(
            executable_path
                .parent()
                .expect("expected executable parent"),
        );
    }

    #[test]
    fn okp_identity_revalidate_returns_bound_executable_despite_alternate_valid_path() {
        // Config drift regression: revalidate must resolve identity A's bound path,
        // not switch to another valid executable B that live config might point at.
        let path_a = create_test_okp_layout("OKP.Core.dll");
        let path_b = create_test_okp_layout("OKP.Core.dll");
        assert_ne!(path_a, path_b);
        let identity = capture_okp_executable_identity(&path_a.display().to_string())
            .expect("capture identity A");
        // Alternate valid executable B exists; identity remains bound to A.
        let _ = capture_okp_executable_identity(&path_b.display().to_string())
            .expect("B is independently valid");
        let resolved = identity
            .revalidate()
            .expect("bound A must still revalidate");
        assert_eq!(
            resolved.executable_path(),
            path_a.as_path(),
            "revalidate-and-resolve must return bound A, not alternate B"
        );
        assert_ne!(resolved.executable_path(), path_b.as_path());
        let _ = std::fs::remove_dir_all(path_a.parent().expect("parent A"));
        let _ = std::fs::remove_dir_all(path_b.parent().expect("parent B"));
    }

    #[test]
    fn okp_identity_capture_blocker_messages_are_path_free() {
        let path = "/secret/path/to/OKP.Core.dll";
        let capture_msg = okp_identity_capture_blocker();
        let unbound_msg = okp_identity_unbound_blocker();
        assert!(!capture_msg.contains(path));
        assert!(!unbound_msg.contains(path));
        assert!(capture_msg.contains("OKP"));
        assert!(unbound_msg.contains("OKP"));
    }

    #[test]
    fn bind_resolved_okp_for_prepare_unresolved_fail_closed_preserves_error() {
        // Single-resolve contract: Unresolved carries the one resolve error and never
        // produces an identity. Prepare must inject that error as a local blocker so a
        // plan cannot be publishable with okp_identity=None after an unresolved bind.
        let error = "未选择 OKP 可执行文件，请先在首页选择 OKP.Core 可执行文件或 DLL。".to_string();
        let bind = bind_resolved_okp_for_prepare(Err(error.clone()));
        match bind {
            ConfiguredOkpBindResult::Unresolved { error: got } => assert_eq!(got, error),
            other => panic!("expected Unresolved, got {other:?}"),
        }
    }

    #[test]
    fn bind_resolved_okp_for_prepare_bound_reuses_same_resolved_executable() {
        // Bound identity and resolved executable come from the same resolve — prepare
        // must use this resolved path for OKP local checks (no second live resolve).
        let executable_path = create_test_okp_layout("OKP.Core.dll");
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("resolve test OKP");
        let expected_path = resolved.executable_path().to_path_buf();
        let bind = bind_resolved_okp_for_prepare(Ok(resolved));
        match bind {
            ConfiguredOkpBindResult::Bound { identity, resolved } => {
                assert_eq!(resolved.executable_path(), expected_path.as_path());
                let revalidated = identity.revalidate().expect("identity revalidates");
                assert_eq!(revalidated.executable_path(), expected_path.as_path());
                assert_eq!(
                    revalidated.executable_path(),
                    resolved.executable_path(),
                    "identity binding and prepare local-check executable must be the same path"
                );
            }
            other => panic!("expected Bound, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(executable_path.parent().expect("parent"));
    }

    #[test]
    fn prepare_bind_unresolved_never_yields_identity() {
        // Fail-closed: any Unresolved bind result has no identity material for the plan.
        let bind = bind_resolved_okp_for_prepare(Err(
            "已选择的 OKP 可执行文件不存在：/secret/okp/OKP.Core.dll，请重新选择。".into(),
        ));
        assert!(matches!(bind, ConfiguredOkpBindResult::Unresolved { .. }));
        if let ConfiguredOkpBindResult::Unresolved { error } = bind {
            // Legacy live-config error shape is preserved from the single resolve.
            assert!(error.contains("不存在"));
        }
    }

    #[test]
    fn bind_resolved_okp_for_prepare_identity_capture_failed_keeps_resolved_path() {
        // Resolve succeeds, then the executable vanishes before hash capture.
        // Prepare must keep the resolved executable for OKP local checks and treat
        // identity as unbound (caller adds path-free capture blocker).
        let executable_path = create_test_okp_layout("OKP.Core.dll");
        let resolved = resolve_selected_okp_executable(&executable_path.display().to_string())
            .expect("resolve");
        let expected_path = resolved.executable_path().to_path_buf();
        let _ = std::fs::remove_file(&executable_path);
        let bind = bind_resolved_okp_for_prepare(Ok(resolved));
        match bind {
            ConfiguredOkpBindResult::IdentityCaptureFailed { resolved } => {
                assert_eq!(resolved.executable_path(), expected_path.as_path());
            }
            other => panic!("expected IdentityCaptureFailed, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(executable_path.parent().expect("parent"));
    }
}
