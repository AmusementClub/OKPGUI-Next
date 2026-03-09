use crate::config::load_config;
use crate::profile::{load_profiles, save_profiles, split_site_cookies, sync_profile_cookies};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

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

/// Find OKP.Core.exe - look in the same directory as our executable
fn find_okp_core() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("鏃犳硶鑾峰彇绋嬪簭璺緞: {}", e))?
        .parent()
        .ok_or("鏃犳硶鑾峰彇绋嬪簭鐩綍")?
        .to_path_buf();

    let okp_core = exe_dir.join("OKP.Core.exe");
    if okp_core.exists() {
        return Ok(okp_core);
    }

    // Also check current working directory
    let cwd = std::env::current_dir().unwrap_or_default();
    let okp_core_cwd = cwd.join("OKP.Core.exe");
    if okp_core_cwd.exists() {
        return Ok(okp_core_cwd);
    }

    Err("未找到 OKP.Core.exe，请将其放在程序目录中。".to_string())
}

/// Generate a template.toml file for OKP.Core
fn generate_template_toml(
    app: &AppHandle,
    template_name: &str,
    profile_name: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let config = load_config(app);
    let profiles = load_profiles(app);

    let template = config
        .templates
        .get(template_name)
        .ok_or_else(|| format!("模板不存在: {}", template_name))?;

    let profile = profiles
        .profiles
        .get(profile_name)
        .ok_or_else(|| format!("配置不存在: {}", profile_name))?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("鏃犳硶鑾峰彇鏁版嵁鐩綍: {}", e))?;
    std::fs::create_dir_all(&data_dir).ok();

    let template_path = data_dir.join("template.toml");
    let cookies_path = data_dir.join("cookies.txt");

    // Build the TOML content
    let mut toml_content = String::new();

    // Basic fields
    toml_content.push_str(&format!(
        "display_name = \"{}\"\n",
        template.title.replace('\"', "\\\"")
    ));

    if !template.ep_pattern.is_empty() {
        toml_content.push_str(&format!("filename_regex = '''{} '''\n", template.ep_pattern));
    }

    if !template.poster.is_empty() {
        toml_content.push_str(&format!(
            "poster = \"{}\"\n",
            template.poster.replace('\"', "\\\"")
        ));
    }

    if !template.about.is_empty() {
        toml_content.push_str(&format!(
            "about = \"{}\"\n",
            template.about.replace('\"', "\\\"")
        ));
    }

    // Tags
    let tags: Vec<&str> = template
        .tags
        .split(',')
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if !tags.is_empty() {
        let tags_str: Vec<String> = tags.iter().map(|t| format!("\"{}\"", t)).collect();
        toml_content.push_str(&format!("tags = [{}]\n", tags_str.join(", ")));
    }

    toml_content.push('\n');

    // Proxy
    let proxy_str = if config.proxy.proxy_type == "http" && !config.proxy.proxy_host.is_empty() {
        Some(config.proxy.proxy_host.clone())
    } else {
        None
    };

    // Per-site intro templates
    let sites = &template.sites;
    let site_configs: Vec<(&str, &str, bool)> = vec![
        ("dmhy", &profile.dmhy_name, sites.dmhy),
        ("nyaa", &profile.nyaa_name, sites.nyaa),
        ("acgrip", &profile.acgrip_name, sites.acgrip),
        ("bangumi", &profile.bangumi_name, sites.bangumi),
        ("acgnx_asia", &profile.acgnx_asia_name, sites.acgnx_asia),
        ("acgnx_global", &profile.acgnx_global_name, sites.acgnx_global),
    ];

    for (site_code, account_name, enabled) in site_configs {
        if !enabled {
            continue;
        }

        toml_content.push_str("[[intro_template]]\n");
        toml_content.push_str(&format!("site = \"{}\"\n", site_code));
        toml_content.push_str(&format!(
            "name = \"{}\"\n",
            account_name.replace('\"', "\\\"")
        ));

        // Description content
        let desc = template.description.replace('\"', "\\\"");
        toml_content.push_str(&format!("content = \"\"\"{}\"\"\"\n", desc));

        // User agent
        if !profile.user_agent.is_empty() {
            toml_content.push_str(&format!(
                "user_agent = \"{}\"\n",
                profile.user_agent.replace('\"', "\\\"")
            ));
        }

        // Proxy
        if let Some(ref proxy) = proxy_str {
            toml_content.push_str(&format!("proxy = \"{}\"\n", proxy));
        }

        toml_content.push('\n');
    }

    // Write template.toml
    std::fs::write(&template_path, &toml_content)
        .map_err(|e| format!("鍐欏叆 template.toml 澶辫触: {}", e))?;

    // Write cookies.txt
    let merged_cookies = {
        let mut normalized_profile = profile.clone();
        sync_profile_cookies(&mut normalized_profile);
        normalized_profile.cookies
    };
    std::fs::write(&cookies_path, &merged_cookies)
        .map_err(|e| format!("写入 cookies.txt 失败: {}", e))?;

    Ok((template_path, cookies_path))
}

#[tauri::command]
pub async fn publish(app: AppHandle, request: PublishRequest) -> Result<(), String> {
    let okp_core = find_okp_core()?;
    let (template_path, cookies_path) =
        generate_template_toml(&app, &request.template_name, &request.profile_name)?;

    // Spawn OKP.Core process
    let mut child = Command::new(&okp_core)
        .arg(&request.torrent_path)
        .arg("-s")
        .arg(&template_path)
        .arg("-c")
        .arg(&cookies_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("鍚姩 OKP.Core 澶辫触: {}", e))?;

    // Read stdout in a thread
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_stdout = app.clone();
    let app_stderr = app.clone();

    let stdout_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_stdout.emit(
                        "publish-output",
                        PublishOutput {
                            line,
                            is_stderr: false,
                        },
                    );
                }
            }
        }
    });

    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_stderr.emit(
                        "publish-output",
                        PublishOutput {
                            line,
                            is_stderr: true,
                        },
                    );
                }
            }
        }
    });

    // Wait for the process to complete
    let status = child
        .wait()
        .map_err(|e| format!("绛夊緟 OKP.Core 瀹屾垚澶辫触: {}", e))?;

    // Wait for reader threads
    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    // Emit completion event
    let _ = app.emit(
        "publish-complete",
        PublishComplete {
            success: status.success(),
            message: if status.success() {
                "鍙戝竷瀹屾垚".to_string()
            } else {
                format!("鍙戝竷澶辫触锛岄€€鍑虹爜: {:?}", status.code())
            },
        },
    );

    // Re-read cookies in case OKP.Core refreshed them
    if cookies_path.exists() {
        if let Ok(updated_cookies) = std::fs::read_to_string(&cookies_path) {
            let mut profiles = load_profiles(&app);
            if let Some(profile) = profiles.profiles.get_mut(&request.profile_name) {
                profile.cookies = updated_cookies;
                profile.site_cookies = split_site_cookies(&profile.cookies);
                sync_profile_cookies(profile);
                save_profiles(&app, &profiles);
            }
        }
    }

    if status.success() {
        Ok(())
    } else {
        Err(format!("OKP.Core 閫€鍑虹爜: {:?}", status.code()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_okp_core_returns_result() {
        // This test just verifies the function doesn't panic
        let _ = find_okp_core();
    }
}
