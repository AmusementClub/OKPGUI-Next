use crate::config::load_config;
use crate::profile::{load_profiles, save_profiles, split_site_cookies, sync_profile_cookies};
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

static PUBLISH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishRequest {
    pub torrent_path: String,
    pub template_name: String,
    pub profile_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishOutput {
    pub line: String,
    pub is_stderr: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishComplete {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
struct ResolvedOkpExecutable {
    executable_path: PathBuf,
    working_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct PublishArtifacts {
    workspace_dir: PathBuf,
    template_path: PathBuf,
    cookies_path: PathBuf,
    description_path: PathBuf,
    log_path: PathBuf,
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

fn emit_publish_output(app: &AppHandle, line: impl Into<String>, is_stderr: bool) {
    let _ = app.emit(
        "publish-output",
        PublishOutput {
            line: line.into(),
            is_stderr,
        },
    );
}

fn resolve_selected_okp_executable(configured_path: &str) -> Result<ResolvedOkpExecutable, String> {
    let configured_path = configured_path.trim();
    if configured_path.is_empty() {
        return Err("未选择 OKP 可执行文件，请先在首页选择 OKP.Core.exe。".to_string());
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
            "已选择的 OKP 可执行文件不是文件：{}，请重新选择 OKP.Core.exe。",
            configured.display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let extension = configured
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("exe") {
            return Err("已选择的 OKP 可执行文件不是 .exe 文件，请重新选择 OKP.Core.exe。".to_string());
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
        return Err(format!(
            "所选文件不是 .torrent 文件：{}",
            torrent.display()
        ));
    }

    Ok(torrent)
}

fn create_publish_artifacts(app: &AppHandle) -> Result<PublishArtifacts, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))?;

    let publish_root = data_dir.join("publish");
    std::fs::create_dir_all(&publish_root)
        .map_err(|e| format!("无法创建发布工作目录: {}", e))?;

    let run_id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let workspace_dir = publish_root.join(run_id);
    std::fs::create_dir_all(&workspace_dir)
        .map_err(|e| format!("无法创建发布工作目录: {}", e))?;

    Ok(PublishArtifacts {
        template_path: workspace_dir.join("template.toml"),
        cookies_path: workspace_dir.join("cookies.txt"),
        description_path: workspace_dir.join("description.md"),
        log_path: workspace_dir.join("okp.log"),
        workspace_dir,
    })
}

fn cleanup_publish_artifacts(artifacts: &PublishArtifacts, keep_log: bool) {
    let _ = std::fs::remove_file(&artifacts.template_path);
    let _ = std::fs::remove_file(&artifacts.cookies_path);
    let _ = std::fs::remove_file(&artifacts.description_path);

    if !keep_log {
        let _ = std::fs::remove_file(&artifacts.log_path);
    }

    let _ = std::fs::remove_dir(&artifacts.workspace_dir);
}

fn generate_template_toml(
    app: &AppHandle,
    template_name: &str,
    profile_name: &str,
    artifacts: &PublishArtifacts,
) -> Result<(), String> {
    let config = load_config(app);
    let profiles = load_profiles(app);

    let template = config
        .templates
        .get(template_name)
        .ok_or_else(|| format!("模板不存在: {}", template_name))?;

    if template.title.trim().is_empty() {
        return Err("标题不能为空，请先填写标题。".to_string());
    }

    let profile = profiles
        .profiles
        .get(profile_name)
        .ok_or_else(|| format!("配置不存在: {}", profile_name))?;

    let description_file_name = artifacts
        .description_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法生成发布内容文件名。".to_string())?;

    std::fs::write(&artifacts.description_path, &template.description)
        .map_err(|e| format!("写入 description.md 失败: {}", e))?;

    let mut toml_content = String::new();
    toml_content.push_str(&format!(
        "display_name = \"{}\"\n",
        template.title.replace('"', "\\\"")
    ));

    if !template.ep_pattern.trim().is_empty() {
        toml_content.push_str(&format!("filename_regex = '''{}'''\n", template.ep_pattern));
    }

    if !template.poster.is_empty() {
        toml_content.push_str(&format!(
            "poster = \"{}\"\n",
            template.poster.replace('"', "\\\"")
        ));
    }

    if !template.about.is_empty() {
        toml_content.push_str(&format!(
            "about = \"{}\"\n",
            template.about.replace('"', "\\\"")
        ));
    }

    let tags: Vec<&str> = template
        .tags
        .split(',')
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .collect();
    if !tags.is_empty() {
        let tags_str: Vec<String> = tags.iter().map(|tag| format!("\"{}\"", tag)).collect();
        toml_content.push_str(&format!("tags = [{}]\n", tags_str.join(", ")));
    }

    toml_content.push('\n');

    let proxy_str = if config.proxy.proxy_type == "http" && !config.proxy.proxy_host.is_empty() {
        Some(config.proxy.proxy_host.clone())
    } else {
        None
    };

    let sites = &template.sites;
    let site_configs: Vec<(&str, &str, bool)> = vec![
        ("dmhy", &profile.dmhy_name, sites.dmhy),
        ("nyaa", &profile.nyaa_name, sites.nyaa),
        ("acgrip", &profile.acgrip_name, sites.acgrip),
        ("bangumi", &profile.bangumi_name, sites.bangumi),
        ("acgnx_asia", &profile.acgnx_asia_name, sites.acgnx_asia),
        ("acgnx_global", &profile.acgnx_global_name, sites.acgnx_global),
    ];

    if site_configs.iter().all(|(_, _, enabled)| !*enabled) {
        return Err("至少选择一个发布站点后才能发布。".to_string());
    }

    for (site_code, account_name, enabled) in site_configs {
        if !enabled {
            continue;
        }

        toml_content.push_str("[[intro_template]]\n");
        toml_content.push_str(&format!("site = \"{}\"\n", site_code));
        toml_content.push_str(&format!(
            "name = \"{}\"\n",
            account_name.replace('"', "\\\"")
        ));
        toml_content.push_str(&format!("content = \"{}\"\n", description_file_name));

        if !profile.user_agent.is_empty() {
            toml_content.push_str(&format!(
                "user_agent = \"{}\"\n",
                profile.user_agent.replace('"', "\\\"")
            ));
        }

        if let Some(ref proxy) = proxy_str {
            toml_content.push_str(&format!("proxy = \"{}\"\n", proxy));
        }

        toml_content.push('\n');
    }

    std::fs::write(&artifacts.template_path, &toml_content)
        .map_err(|e| format!("写入 template.toml 失败: {}", e))?;

    let merged_cookies = {
        let mut normalized_profile = profile.clone();
        sync_profile_cookies(&mut normalized_profile);
        normalized_profile.cookies
    };
    std::fs::write(&artifacts.cookies_path, &merged_cookies)
        .map_err(|e| format!("写入 cookies.txt 失败: {}", e))?;

    Ok(())
}

fn spawn_output_reader<R>(reader: R, app: AppHandle, is_stderr: bool) -> JoinHandle<()>
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

                    emit_publish_output(&app, String::from_utf8_lossy(&buffer).to_string(), is_stderr);
                }
                Err(error) => {
                    emit_publish_output(&app, format!("读取 OKP 输出失败: {}", error), true);
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

fn run_publish(app: &AppHandle, request: &PublishRequest) -> Result<String, String> {
    let _publish_guard = PublishGuard::acquire()?;

    let okp_core = find_okp_executable(app)?;
    let torrent_path = validate_torrent_path(&request.torrent_path)?;
    let artifacts = create_publish_artifacts(app)?;

    if let Err(error) = generate_template_toml(app, &request.template_name, &request.profile_name, &artifacts) {
        cleanup_publish_artifacts(&artifacts, false);
        return Err(error);
    }

    emit_publish_output(
        app,
        format!("启动 OKP.Core: {}", okp_core.executable_path.display()),
        false,
    );

    let mut child = match Command::new(&okp_core.executable_path)
        .current_dir(&okp_core.working_dir)
        .arg(&torrent_path)
        .arg("-s")
        .arg(&artifacts.template_path)
        .arg("--cookies")
        .arg(&artifacts.cookies_path)
        .arg("--no_reaction")
        .arg("--log_file")
        .arg(&artifacts.log_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            cleanup_publish_artifacts(&artifacts, false);
            return Err(format!("启动 OKP.Core 失败: {}", error));
        }
    };

    let mut stdout_handle = child
        .stdout
        .take()
        .map(|stdout| spawn_output_reader(stdout, app.clone(), false));
    let mut stderr_handle = child
        .stderr
        .take()
        .map(|stderr| spawn_output_reader(stderr, app.clone(), true));

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            if let Some(handle) = stdout_handle.take() {
                let _ = handle.join();
            }
            if let Some(handle) = stderr_handle.take() {
                let _ = handle.join();
            }
            cleanup_publish_artifacts(&artifacts, true);
            return Err(format!("等待 OKP.Core 完成失败: {}", error));
        }
    };

    if let Some(handle) = stdout_handle.take() {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle.take() {
        let _ = handle.join();
    }

    if artifacts.cookies_path.exists() {
        if let Ok(updated_cookies) = std::fs::read_to_string(&artifacts.cookies_path) {
            let mut profiles = load_profiles(app);
            if let Some(profile) = profiles.profiles.get_mut(&request.profile_name) {
                profile.cookies = updated_cookies;
                profile.site_cookies = split_site_cookies(&profile.cookies);
                sync_profile_cookies(profile);
                save_profiles(app, &profiles);
            }
        }
    }

    if status.success() {
        cleanup_publish_artifacts(&artifacts, false);
        Ok("发布完成".to_string())
    } else {
        let failure_message = build_failure_message(status.code(), &artifacts.log_path);
        cleanup_publish_artifacts(&artifacts, true);
        Err(failure_message)
    }
}

#[tauri::command]
pub async fn publish(app: AppHandle, request: PublishRequest) -> Result<(), String> {
    let result = run_publish(&app, &request);

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

    let _ = app.emit("publish-complete", completion);
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "okpgui-next-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn create_packaged_okp_dir(root: &Path) -> PathBuf {
        let executable = root.join("OKP.Core.exe");
        std::fs::write(&executable, []).unwrap();

        let tags_dir = root.join("config").join("tags");
        std::fs::create_dir_all(&tags_dir).unwrap();
        for file_name in REQUIRED_OKP_TAG_FILES {
            std::fs::write(tags_dir.join(file_name), b"{}").unwrap();
        }

        executable
    }

    #[test]
    fn test_find_okp_executable_uses_selected_path() {
        let temp_dir = unique_test_dir("configured-okp");
        let executable = create_packaged_okp_dir(&temp_dir);

        let configured = executable.to_string_lossy().to_string();
        let resolved =
            resolve_selected_okp_executable(&configured).expect("expected configured path to resolve");

        assert_eq!(resolved.executable_path, executable);
        assert_eq!(resolved.working_dir, temp_dir);

        let _ = std::fs::remove_dir_all(&resolved.working_dir);
    }

    #[test]
    fn test_find_okp_executable_requires_selected_path() {
        let error =
            resolve_selected_okp_executable("   ").expect_err("expected empty configured path to error");
        assert!(error.contains("未选择 OKP 可执行文件"));
    }

    #[test]
    fn test_find_okp_executable_returns_error_when_missing() {
        let missing_path = std::env::temp_dir().join(format!(
            "okpgui-next-test-missing-{}.exe",
            std::process::id()
        ));
        let configured = missing_path.to_string_lossy().to_string();
        let error = resolve_selected_okp_executable(&configured)
            .expect_err("expected missing configured path to error");

        assert!(error.contains("已选择的 OKP 可执行文件不存在"));
    }

    #[test]
    fn test_find_okp_executable_requires_packaged_config() {
        let temp_dir = unique_test_dir("missing-tags");
        let executable = temp_dir.join("OKP.Core.exe");
        std::fs::write(&executable, []).unwrap();

        let error = resolve_selected_okp_executable(&executable.to_string_lossy())
            .expect_err("expected missing config to error");

        assert!(error.contains("config/tags"));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_validate_torrent_path_accepts_existing_torrent() {
        let temp_dir = unique_test_dir("torrent-ok");
        let torrent = temp_dir.join("sample.torrent");
        std::fs::write(&torrent, b"torrent").unwrap();

        let validated = validate_torrent_path(&torrent.to_string_lossy())
            .expect("expected torrent path to validate");

        assert_eq!(validated, torrent);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_validate_torrent_path_requires_torrent_extension() {
        let temp_dir = unique_test_dir("torrent-extension");
        let not_torrent = temp_dir.join("sample.txt");
        std::fs::write(&not_torrent, b"not-a-torrent").unwrap();

        let error = validate_torrent_path(&not_torrent.to_string_lossy())
            .expect_err("expected non-torrent path to error");

        assert!(error.contains("不是 .torrent 文件"));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
