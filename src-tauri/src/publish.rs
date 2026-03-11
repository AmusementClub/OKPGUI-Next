use crate::config::{load_config, Template};
use crate::profile::{
    get_site_cookie_text, load_profiles, normalize_site_cookie_text, resolve_site_cookie_user_agent,
    save_profiles, set_site_cookie_text, site_cookie_has_entries, sync_profile_cookies, Profile,
};
use encoding_rs::GB18030;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const REQUIRED_OKP_TAG_FILES: &[&str] = &[
    "acgnx_asia.json",
    "acgnx_global.json",
    "acgrip.json",
    "bangumi.json",
    "dmhy.json",
    "nyaa.json",
];
const KEEP_PUBLISH_COOKIES_FOR_DEBUG: bool = true;

static PUBLISH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishRequest {
    pub torrent_path: String,
    pub template_name: String,
    pub profile_name: String,
    pub template: Template,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishOutput {
    pub site_code: String,
    pub site_label: String,
    pub line: String,
    pub is_stderr: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishSiteComplete {
    pub site_code: String,
    pub site_label: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishComplete {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
enum OkpLaunchMode {
    Direct,
    DotnetDll,
}

#[derive(Debug, Clone)]
struct ResolvedOkpExecutable {
    executable_path: PathBuf,
    working_dir: PathBuf,
    launch_mode: OkpLaunchMode,
}

#[derive(Debug, Clone)]
struct PublishArtifacts {
    workspace_dir: PathBuf,
    template_path: PathBuf,
    cookies_path: PathBuf,
    markdown_description_path: PathBuf,
    html_description_path: PathBuf,
    log_path: PathBuf,
}

#[derive(Debug, Clone)]
struct SitePublishConfig {
    code: &'static str,
    label: &'static str,
    account_name: String,
    token: Option<String>,
    enabled: bool,
    uses_cookie: bool,
}

#[derive(Debug, Clone)]
struct SitePublishResult {
    site_code: String,
    site_label: String,
    success: bool,
    message: String,
    updated_cookie_text: Option<String>,
}

impl SitePublishConfig {
    fn build_result(
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

struct PublishGuard;

impl PublishGuard {
    fn acquire() -> Result<Self, String> {
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

fn emit_publish_event<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit(event, payload);
}

fn emit_publish_output(
    app: &AppHandle,
    site_code: &str,
    site_label: &str,
    line: impl Into<String>,
    is_stderr: bool,
) {
    emit_publish_event(
        app,
        "publish-output",
        PublishOutput {
            site_code: site_code.to_string(),
            site_label: site_label.to_string(),
            line: line.into(),
            is_stderr,
        },
    );
}

fn emit_publish_site_complete(app: &AppHandle, result: &SitePublishResult) {
    emit_publish_event(
        app,
        "publish-site-complete",
        PublishSiteComplete {
            site_code: result.site_code.clone(),
            site_label: result.site_label.clone(),
            success: result.success,
            message: result.message.clone(),
        },
    );
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

    let metadata = std::fs::metadata(&configured)
        .map_err(|e| format!("无法读取已选择的 OKP 可执行文件：{} ({})", configured.display(), e))?;

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

    let working_dir = configured.parent().map(Path::to_path_buf).ok_or_else(|| {
        format!(
            "无法确定 OKP 可执行文件所在目录：{}",
            configured.display()
        )
    })?;

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

fn find_okp_executable(app: &AppHandle) -> Result<ResolvedOkpExecutable, String> {
    let config = load_config(app);
    resolve_selected_okp_executable(&config.okp_executable_path)
}

fn validate_torrent_path(torrent_path: &str) -> Result<PathBuf, String> {
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
    if !KEEP_PUBLISH_COOKIES_FOR_DEBUG {
        let _ = std::fs::remove_file(&artifacts.cookies_path);
    }
    let _ = std::fs::remove_file(&artifacts.markdown_description_path);
    let _ = std::fs::remove_file(&artifacts.html_description_path);

    if !keep_log {
        let _ = std::fs::remove_file(&artifacts.log_path);
    }

    if !KEEP_PUBLISH_COOKIES_FOR_DEBUG {
        let _ = std::fs::remove_dir(&artifacts.workspace_dir);
    }
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

fn collect_site_publish_configs(template: &Template, profile: &Profile) -> Vec<SitePublishConfig> {
    vec![
        SitePublishConfig {
            code: "dmhy",
            label: site_label("dmhy"),
            account_name: profile.dmhy_name.clone(),
            token: None,
            enabled: template.sites.dmhy,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "nyaa",
            label: site_label("nyaa"),
            account_name: profile.nyaa_name.clone(),
            token: None,
            enabled: template.sites.nyaa,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "acgrip",
            label: site_label("acgrip"),
            account_name: profile.acgrip_name.clone(),
            token: None,
            enabled: template.sites.acgrip,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "bangumi",
            label: site_label("bangumi"),
            account_name: profile.bangumi_name.clone(),
            token: None,
            enabled: template.sites.bangumi,
            uses_cookie: true,
        },
        SitePublishConfig {
            code: "acgnx_asia",
            label: site_label("acgnx_asia"),
            account_name: profile.acgnx_asia_name.clone(),
            token: Some(profile.acgnx_asia_token.clone()),
            enabled: template.sites.acgnx_asia,
            uses_cookie: false,
        },
        SitePublishConfig {
            code: "acgnx_global",
            label: site_label("acgnx_global"),
            account_name: profile.acgnx_global_name.clone(),
            token: Some(profile.acgnx_global_token.clone()),
            enabled: template.sites.acgnx_global,
            uses_cookie: false,
        },
    ]
}

fn build_site_publish_cookie_text(site: &SitePublishConfig, profile: &Profile) -> Result<String, String> {
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

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn site_prefers_html_content(site_code: &str) -> bool {
    matches!(site_code, "dmhy" | "bangumi" | "acgnx_asia" | "acgnx_global")
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

    if !site.uses_cookie && site.token.as_deref().unwrap_or_default().trim().is_empty() {
        return Err(format!("{} 的 API Token 不能为空。", site.label));
    }

    write_publish_description_files(template, artifacts)?;

    let description_file_name = select_publish_content_path(template, site, artifacts)?
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法生成发布内容文件名。".to_string())?;

    let mut toml_content = String::new();
    toml_content.push_str(&format!(
        "display_name = \"{}\"\n",
        escape_toml_string(&template.title)
    ));

    if !template.ep_pattern.trim().is_empty() {
        toml_content.push_str(&format!("filename_regex = '''{}'''\n", template.ep_pattern));
    }

    if !template.poster.trim().is_empty() {
        toml_content.push_str(&format!(
            "poster = \"{}\"\n",
            escape_toml_string(&template.poster)
        ));
    }

    if !template.about.trim().is_empty() {
        toml_content.push_str(&format!(
            "about = \"{}\"\n",
            escape_toml_string(&template.about)
        ));
    }

    let tags: Vec<&str> = template
        .tags
        .split(',')
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect();
    if !tags.is_empty() {
        let tags_str: Vec<String> = tags
            .iter()
            .map(|tag| format!("\"{}\"", escape_toml_string(tag)))
            .collect();
        toml_content.push_str(&format!("tags = [{}]\n", tags_str.join(", ")));
    }

    toml_content.push('\n');
    toml_content.push_str("[[intro_template]]\n");
    toml_content.push_str(&format!("site = \"{}\"\n", site.code));
    toml_content.push_str(&format!(
        "name = \"{}\"\n",
        escape_toml_string(&site.account_name)
    ));
    toml_content.push_str(&format!("content = \"{}\"\n", description_file_name));

    if !user_agent.trim().is_empty() {
        toml_content.push_str(&format!(
            "user_agent = \"{}\"\n",
            escape_toml_string(user_agent)
        ));
    }

    if let Some(token) = site.token.as_deref().filter(|value| !value.trim().is_empty()) {
        toml_content.push_str(&format!(
            "cookie = \"{}\"\n",
            escape_toml_string(token)
        ));
    }

    if config.proxy.proxy_type == "http" && !config.proxy.proxy_host.trim().is_empty() {
        toml_content.push_str(&format!(
            "proxy = \"{}\"\n",
            escape_toml_string(config.proxy.proxy_host.trim())
        ));
    }

    std::fs::write(&artifacts.template_path, &toml_content)
        .map_err(|e| format!("写入 template.toml 失败: {}", e))?;

    Ok(())
}

fn spawn_output_reader<R>(
    reader: R,
    app: AppHandle,
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

                    emit_publish_output(&app, &site_code, &site_label, decode_publish_output(&buffer), is_stderr);
                }
                Err(error) => {
                    emit_publish_output(
                        &app,
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

fn run_site_publish(
    app: &AppHandle,
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
        let cookie_text = build_site_publish_cookie_text(site, profile)?;
        let site_user_agent = resolve_site_cookie_user_agent(&cookie_text, &profile.user_agent);

        generate_site_template_toml(app, template, site, &artifacts, &site_user_agent)?;

        std::fs::write(&artifacts.cookies_path, &cookie_text)
            .map_err(|e| format!("写入 cookies.txt 失败: {}", e))?;
        emit_publish_output(
            app,
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

        let command_arguments = vec![
            torrent_path.display().to_string(),
            "-s".to_string(),
            artifacts.template_path.display().to_string(),
            "--no_reaction".to_string(),
            "--log_file".to_string(),
            artifacts.log_path.display().to_string(),
            "--cookies".to_string(),
            artifacts.cookies_path.display().to_string(),
        ];

        let command_preview = okp_core
            .preview_parts(&command_arguments)
            .into_iter()
            .map(|argument| format_command_argument(&argument))
            .collect::<Vec<_>>()
            .join(" ");

        emit_publish_output(
            app,
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
                site.code.to_string(),
                site.label.to_string(),
                false,
            )
        });
        let mut stderr_handle = child.stderr.take().map(|stderr| {
            spawn_output_reader(
                stderr,
                app.clone(),
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

        let updated_cookie_text = std::fs::read_to_string(&artifacts.cookies_path).ok();

        if status.success() {
            cleanup_publish_artifacts(&artifacts, false);
            Ok(site.build_result(true, format!("{} 发布完成", site.label), updated_cookie_text))
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

fn persist_updated_site_cookies(app: &AppHandle, profile_name: &str, results: &[SitePublishResult]) {
    if results.iter().all(|result| result.updated_cookie_text.is_none()) {
        return;
    }

    let mut profiles = load_profiles(app);
    let Some(profile) = profiles.profiles.get_mut(profile_name) else {
        return;
    };

    for result in results {
        if let Some(cookie_text) = &result.updated_cookie_text {
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

fn build_publish_summary(results: &[SitePublishResult]) -> (bool, String) {
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

fn run_publish(app: &AppHandle, request: &PublishRequest) -> Result<String, String> {
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
        let okp_core = okp_core.clone();
        let torrent_path = torrent_path.clone();
        let template = request.template.clone();
        let profile = profile.clone();
        let site_for_join = site.clone();

        let handle = std::thread::spawn(move || {
            let result = run_site_publish(&app_handle, &okp_core, &torrent_path, &template, &profile, &site);
            emit_publish_site_complete(&app_handle, &result);
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

#[tauri::command]
pub async fn publish(app: AppHandle, request: PublishRequest) -> Result<(), String> {
    let app_handle = app.clone();
    let request_payload = request.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_publish(&app_handle, &request_payload))
        .await
        .map_err(|error| format!("发布任务执行失败: {}", error))?;

    let completion = match &result {
        Ok(message) => PublishComplete {
            success: true,
            message: message.clone(),
        },
        Err(message) => PublishComplete {
            success: false,
            message: message.clone(),
        },
    };

    emit_publish_event(&app, "publish-complete", completion);
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_site_publish_cookie_text_rejects_missing_cookie_site() {
        let site = SitePublishConfig {
            code: "bangumi",
            label: "萌番组",
            account_name: "Team".to_string(),
            token: None,
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
    fn test_find_okp_executable_requires_selected_path() {
        let error =
            resolve_selected_okp_executable("   ").expect_err("expected empty configured path to error");
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
            "okpgui-next-publish-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
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
}
