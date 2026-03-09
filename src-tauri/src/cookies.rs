use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chromiumoxide::cdp::browser_protocol::network::Cookie;
use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message as WsMessage, WebSocket};

const DEBUG_ENDPOINT_TIMEOUT: Duration = Duration::from_secs(15);
const DEBUG_ENDPOINT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const COOKIE_POLL_INTERVAL: Duration = Duration::from_millis(750);

const DMHY_COOKIE_DOMAINS: &[&str] = &["share.dmhy.org", ".dmhy.org"];
const NYAA_COOKIE_DOMAINS: &[&str] = &["nyaa.si", ".nyaa.si"];
const ACGRIP_COOKIE_DOMAINS: &[&str] = &["acg.rip", ".acg.rip"];
const BANGUMI_COOKIE_DOMAINS: &[&str] = &["bangumi.moe", ".bangumi.moe"];
const ACGNX_ASIA_COOKIE_DOMAINS: &[&str] = &["share.acgnx.se", ".acgnx.se"];
const ACGNX_GLOBAL_COOKIE_DOMAINS: &[&str] = &["www.acgnx.se", ".acgnx.se"];

#[derive(Debug, Clone, Copy)]
struct SiteConfig {
    code: &'static str,
    login_url: &'static str,
    cookie_domains: &'static [&'static str],
}

const SITE_CONFIGS: &[SiteConfig] = &[
    SiteConfig {
        code: "dmhy",
        login_url: "https://share.dmhy.org/topics/add",
        cookie_domains: DMHY_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "nyaa",
        login_url: "https://nyaa.si/login",
        cookie_domains: NYAA_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgrip",
        login_url: "https://acg.rip/signin",
        cookie_domains: ACGRIP_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "bangumi",
        login_url: "https://bangumi.moe/",
        cookie_domains: BANGUMI_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgnx_asia",
        login_url: "https://share.acgnx.se/",
        cookie_domains: ACGNX_ASIA_COOKIE_DOMAINS,
    },
    SiteConfig {
        code: "acgnx_global",
        login_url: "https://www.acgnx.se/",
        cookie_domains: ACGNX_GLOBAL_COOKIE_DOMAINS,
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct CapturedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub expires: i64,
}

impl From<&Cookie> for CapturedCookie {
    fn from(cookie: &Cookie) -> Self {
        Self {
            name: cookie.name.clone(),
            value: cookie.value.clone(),
            domain: cookie.domain.clone(),
            path: cookie.path.clone(),
            secure: cookie.secure,
            expires: cookie_expiration(cookie),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct CookieCaptureStatus {
    cookies: Vec<CapturedCookie>,
    browser_closed: bool,
    completed: bool,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct CookieCaptureRuntimeState {
    cookies: Vec<CapturedCookie>,
    browser_closed: bool,
    completed: bool,
    error: Option<String>,
}

struct CookieCaptureHandle {
    state: Arc<Mutex<CookieCaptureRuntimeState>>,
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl CookieCaptureHandle {
    fn snapshot(&self) -> CookieCaptureStatus {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        CookieCaptureStatus {
            cookies: state.cookies.clone(),
            browser_closed: state.browser_closed,
            completed: state.completed,
            error: state.error.clone(),
        }
    }
}

type CookieCaptureRegistry = Mutex<HashMap<String, CookieCaptureHandle>>;

static COOKIE_CAPTURE_REGISTRY: OnceLock<CookieCaptureRegistry> = OnceLock::new();
static NEXT_COOKIE_CAPTURE_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn capture_registry() -> &'static CookieCaptureRegistry {
    COOKIE_CAPTURE_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_site_config(site: &str) -> Result<&'static SiteConfig, String> {
    SITE_CONFIGS
        .iter()
        .find(|config| config.code == site)
        .ok_or_else(|| format!("未知站点: {}", site))
}

#[cfg(test)]
fn get_login_url(site: &str) -> Result<&'static str, String> {
    Ok(get_site_config(site)?.login_url)
}

#[cfg(test)]
fn get_cookie_domains(site: &str) -> Vec<&'static str> {
    get_site_config(site)
        .map(|config| config.cookie_domains.to_vec())
        .unwrap_or_default()
}

fn cookie_expiration(cookie: &Cookie) -> i64 {
    if cookie.expires.is_finite() && cookie.expires > 0.0 {
        cookie.expires.floor() as i64
    } else {
        0
    }
}

fn normalize_cookie_domain(domain: &str) -> &str {
    domain.trim().trim_start_matches('.')
}

fn matches_site_domain(domain: &str, candidates: &[&str]) -> bool {
    let normalized_domain = normalize_cookie_domain(domain);

    candidates.iter().any(|candidate| {
        let normalized_candidate = normalize_cookie_domain(candidate);
        normalized_domain == normalized_candidate
            || normalized_domain.ends_with(&format!(".{}", normalized_candidate))
    })
}

fn filter_site_cookies(cookies: Vec<Cookie>, site: &SiteConfig) -> Vec<CapturedCookie> {
    let mut seen = HashSet::new();
    let mut filtered = Vec::new();

    for cookie in cookies.into_iter().rev() {
        if !matches_site_domain(&cookie.domain, site.cookie_domains) {
            continue;
        }

        let key = format!(
            "{}\0{}\0{}",
            normalize_cookie_domain(&cookie.domain),
            cookie.path,
            cookie.name
        );

        if seen.insert(key) {
            filtered.push(CapturedCookie::from(&cookie));
        }
    }

    filtered.reverse();
    filtered
}

fn find_browser_executable() -> Result<PathBuf, String> {
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ];

    for path in &candidates {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let chrome_path =
            PathBuf::from(&local_app_data).join(r"Google\Chrome\Application\chrome.exe");
        if chrome_path.exists() {
            return Ok(chrome_path);
        }

        let edge_path =
            PathBuf::from(&local_app_data).join(r"Microsoft\Edge\Application\msedge.exe");
        if edge_path.exists() {
            return Ok(edge_path);
        }
    }

    Err("未找到 Chrome 或 Edge 浏览器，请确认已经安装 Chrome 或 Edge".to_string())
}

fn create_cookie_capture_profile_dir(site: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    let profile_dir = std::env::temp_dir().join(format!(
        "okpgui-next-cdp-{}-{}-{}",
        site,
        std::process::id(),
        timestamp
    ));

    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("无法创建浏览器配置目录: {}", e))?;

    Ok(profile_dir)
}

struct BrowserProcess {
    child: Child,
    profile_dir: PathBuf,
}

impl BrowserProcess {
    fn launch(browser_path: &Path, site: &SiteConfig) -> Result<Self, String> {
        let profile_dir = create_cookie_capture_profile_dir(site.code)?;
        let args = vec![
            "--remote-debugging-port=0".to_string(),
            "--remote-debugging-address=127.0.0.1".to_string(),
            format!("--user-data-dir={}", profile_dir.display()),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--disable-background-timer-throttling".to_string(),
            "--disable-backgrounding-occluded-windows".to_string(),
            "--disable-renderer-backgrounding".to_string(),
            "--disable-gpu".to_string(),
            "--disable-extensions".to_string(),
            "--new-window".to_string(),
            site.login_url.to_string(),
        ];

        let command_preview = format!(
            "\"{}\" {}",
            browser_path.display(),
            args.iter()
                .map(|arg| format!("{:?}", arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        println!("[cookies] Launch command: {}", command_preview);

        let child = Command::new(browser_path)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(&profile_dir);
                format!("启动浏览器失败: {}", e)
            })?;

        println!("[cookies] Browser PID: {}", child.id());

        Ok(Self { child, profile_dir })
    }

    fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child
            .try_wait()
            .map_err(|e| format!("无法检查浏览器进程状态: {}", e))
    }

    fn wait_for_debug_ws_url(&mut self, timeout: Duration) -> Result<String, String> {
        let started_at = Instant::now();
        let mut last_error = None;
        let mut attempt = 0u32;

        while started_at.elapsed() < timeout {
            attempt += 1;

            if let Some(status) = self.try_wait()? {
                let exit_code = status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "无退出码".to_string());

                return Err(format!(
                    "浏览器在调试端点就绪前已退出: {}（退出码: {}）。请检查是否被安全软件拦截，或是否弹出了浏览器错误提示。",
                    status, exit_code
                ));
            }

            match read_devtools_active_port(&self.profile_dir) {
                Ok(Some(ws_url)) => {
                    println!("[cookies] Using DevToolsActivePort endpoint: {}", ws_url);
                    return Ok(ws_url);
                }
                Ok(None) => {
                    if attempt <= 3 || attempt % 10 == 0 {
                        println!(
                            "[cookies] Waiting for DevToolsActivePort attempt #{} in {}",
                            attempt,
                            self.profile_dir.display()
                        );
                    }
                    last_error = Some("尚未生成 DevToolsActivePort 文件".to_string());
                }
                Err(err) => {
                    if attempt <= 3 || attempt % 10 == 0 {
                        println!(
                            "[cookies] Waiting for DevToolsActivePort attempt #{} failed: {}",
                            attempt, err
                        );
                    }
                    last_error = Some(err);
                }
            }

            thread::sleep(DEBUG_ENDPOINT_POLL_INTERVAL);
        }

        Err(format!(
            "Chrome 调试端点未在 {:?} 内就绪: {}",
            timeout,
            last_error.unwrap_or_else(|| "未知错误".to_string())
        ))
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }

        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }
}

fn read_devtools_active_port(profile_dir: &Path) -> Result<Option<String>, String> {
    let active_port_path = profile_dir.join("DevToolsActivePort");

    if !active_port_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&active_port_path)
        .map_err(|e| format!("无法读取 DevToolsActivePort 文件: {}", e))?;

    let mut lines = contents.lines();
    let port = lines
        .next()
        .ok_or_else(|| "DevToolsActivePort 文件缺少端口号".to_string())?
        .trim()
        .parse::<u16>()
        .map_err(|e| format!("DevToolsActivePort 文件中的端口号无效: {}", e))?;
    let ws_path = lines
        .next()
        .ok_or_else(|| "DevToolsActivePort 文件缺少 WebSocket 路径".to_string())?
        .trim();

    let normalized_ws_path = if ws_path.starts_with('/') {
        ws_path.to_string()
    } else {
        format!("/{}", ws_path)
    };

    Ok(Some(format!(
        "ws://127.0.0.1:{}{}",
        port, normalized_ws_path
    )))
}

type CdpSocket = WebSocket<MaybeTlsStream<TcpStream>>;

struct CdpClient {
    socket: CdpSocket,
    next_id: u64,
}

impl CdpClient {
    fn connect(ws_url: &str) -> Result<Self, String> {
        let (socket, _) = connect(ws_url).map_err(|e| format!("连接 Chrome CDP 失败: {}", e))?;
        Ok(Self { socket, next_id: 1 })
    }

    fn send_command(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let command_id = self.next_id;
        self.next_id += 1;

        let request = json!({
            "id": command_id,
            "method": method,
            "params": params,
        });

        self.socket
            .send(WsMessage::Text(request.to_string().into()))
            .map_err(|e| format!("发送 CDP 命令 {} 失败: {}", method, e))?;

        loop {
            let message = self
                .socket
                .read()
                .map_err(|e| format!("读取 CDP 消息失败: {}", e))?;

            match message {
                WsMessage::Text(text) => {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|e| format!("解析 CDP 消息 JSON 失败: {}", e))?;

                    if value.get("id").and_then(Value::as_u64) == Some(command_id) {
                        if let Some(error) = value.get("error") {
                            return Err(format!("CDP 命令 {} 返回错误: {}", method, error));
                        }

                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                WsMessage::Ping(payload) => {
                    self.socket
                        .send(WsMessage::Pong(payload))
                        .map_err(|e| format!("回复 CDP Ping 失败: {}", e))?;
                }
                WsMessage::Pong(_) | WsMessage::Binary(_) | WsMessage::Frame(_) => {}
                WsMessage::Close(frame) => {
                    let detail = frame
                        .map(|frame| frame.reason.to_string())
                        .filter(|reason| !reason.is_empty())
                        .unwrap_or_else(|| "浏览器关闭了连接".to_string());
                    return Err(format!("CDP WebSocket 已关闭: {}", detail));
                }
            }
        }
    }

    fn get_cookies(&mut self) -> Result<Vec<Cookie>, String> {
        let result = self.send_command("Storage.getCookies", json!({}))?;
        let cookies_value = result
            .get("cookies")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));

        serde_json::from_value(cookies_value).map_err(|e| format!("解析浏览器 Cookie 失败: {}", e))
    }
}

struct CookieCaptureSession {
    site: &'static SiteConfig,
    browser: BrowserProcess,
    client: CdpClient,
}

impl CookieCaptureSession {
    fn start(site_code: &str) -> Result<Self, String> {
        let site = get_site_config(site_code)?;
        let browser_path = find_browser_executable()?;

        println!("[cookies] === Starting cookie capture for site: {} ===", site.code);
        println!("[cookies] URL: {}", site.login_url);
        println!("[cookies] Browser: {}", browser_path.display());

        let mut browser = BrowserProcess::launch(&browser_path, site)?;
        println!("[cookies] User data dir: {}", browser.profile_dir.display());

        let ws_url = browser.wait_for_debug_ws_url(DEBUG_ENDPOINT_TIMEOUT)?;
        println!("[cookies] Browser launched successfully, CDP URL: {}", ws_url);

        let client = CdpClient::connect(&ws_url)?;
        println!(
            "[cookies] CDP websocket connected. User should now log in and come back to the app when done."
        );

        Ok(Self {
            site,
            browser,
            client,
        })
    }

    fn snapshot_cookies(&mut self) -> Result<Vec<CapturedCookie>, String> {
        let cookies = self.client.get_cookies()?;
        Ok(filter_site_cookies(cookies, self.site))
    }

    fn run_until_stopped(
        &mut self,
        stop_flag: &AtomicBool,
        state: &Arc<Mutex<CookieCaptureRuntimeState>>,
    ) -> Result<(), String> {
        match self.snapshot_cookies() {
            Ok(cookies) => update_runtime_state(state, |current| current.cookies = cookies),
            Err(err) => println!("[cookies] Initial cookie snapshot failed: {}", err),
        }

        let mut poll_count = 0u64;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            if let Some(status) = self.browser.try_wait()? {
                let exit_code = status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "无退出码".to_string());
                println!(
                    "[cookies] Browser closed by user: {} (exit_code={})",
                    status, exit_code
                );
                update_runtime_state(state, |current| current.browser_closed = true);
                break;
            }

            thread::sleep(COOKIE_POLL_INTERVAL);
            poll_count += 1;

            match self.snapshot_cookies() {
                Ok(cookies) => {
                    if poll_count <= 3 || poll_count % 10 == 0 {
                        println!(
                            "[cookies] Poll #{}: found {} relevant cookies for {}",
                            poll_count,
                            cookies.len(),
                            self.site.code
                        );
                    }
                    update_runtime_state(state, |current| current.cookies = cookies);
                }
                Err(err) => {
                    if let Some(status) = self.browser.try_wait()? {
                        let exit_code = status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "无退出码".to_string());
                        println!(
                            "[cookies] Cookie polling stopped because browser closed: {} (exit_code={}, error={})",
                            status, exit_code, err
                        );
                        update_runtime_state(state, |current| current.browser_closed = true);
                        break;
                    }

                    return Err(err);
                }
            }
        }

        match self.snapshot_cookies() {
            Ok(final_cookies) => update_runtime_state(state, |current| {
                if !final_cookies.is_empty() || current.cookies.is_empty() {
                    current.cookies = final_cookies;
                }
            }),
            Err(err) => println!("[cookies] Final cookie snapshot failed: {}", err),
        }

        println!("[cookies] Cookie capture worker finished for {}", self.site.code);
        update_runtime_state(state, |current| current.completed = true);
        Ok(())
    }
}

fn update_runtime_state(
    state: &Arc<Mutex<CookieCaptureRuntimeState>>,
    update: impl FnOnce(&mut CookieCaptureRuntimeState),
) {
    let mut current = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    update(&mut current);
}

fn run_cookie_capture_worker(
    site_code: String,
    state: Arc<Mutex<CookieCaptureRuntimeState>>,
    stop_flag: Arc<AtomicBool>,
) {
    let result = (|| {
        let mut session = CookieCaptureSession::start(&site_code)?;
        session.run_until_stopped(stop_flag.as_ref(), &state)
    })();

    if let Err(err) = result {
        println!("[cookies] Cookie capture worker failed for {}: {}", site_code, err);
        update_runtime_state(&state, |current| {
            current.error = Some(err);
            current.completed = true;
        });
    }
}

fn remove_capture_session(session_id: &str) -> Option<CookieCaptureHandle> {
    capture_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id)
}

fn stop_capture_handle(mut handle: CookieCaptureHandle) -> CookieCaptureStatus {
    handle.stop_flag.store(true, Ordering::Relaxed);

    if let Some(join_handle) = handle.join_handle.take() {
        if join_handle.join().is_err() {
            update_runtime_state(&handle.state, |current| {
                if current.error.is_none() {
                    current.error = Some("Cookie 捕获线程异常退出".to_string());
                }
                current.completed = true;
            });
        }
    }

    handle.snapshot()
}

fn finish_cookie_capture_sync(session_id: String) -> Result<CookieCaptureStatus, String> {
    let handle = remove_capture_session(&session_id)
        .ok_or_else(|| format!("未找到 Cookie 获取会话: {}", session_id))?;
    Ok(stop_capture_handle(handle))
}

fn cancel_cookie_capture_sync(session_id: String) {
    if let Some(handle) = remove_capture_session(&session_id) {
        let _ = stop_capture_handle(handle);
    }
}

#[tauri::command]
pub async fn start_cookie_capture(site: String) -> Result<String, String> {
    get_site_config(&site)?;

    let session_sequence = NEXT_COOKIE_CAPTURE_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("cookie-capture-{}-{}", std::process::id(), session_sequence);
    let state = Arc::new(Mutex::new(CookieCaptureRuntimeState::default()));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let worker_state = Arc::clone(&state);
    let worker_stop_flag = Arc::clone(&stop_flag);
    let worker_site = site.clone();
    let worker_name = format!("cookie-capture-{}", session_sequence);

    let join_handle = thread::Builder::new()
        .name(worker_name)
        .spawn(move || run_cookie_capture_worker(worker_site, worker_state, worker_stop_flag))
        .map_err(|e| format!("无法启动 Cookie 获取线程: {}", e))?;

    capture_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            session_id.clone(),
            CookieCaptureHandle {
                state,
                stop_flag,
                join_handle: Some(join_handle),
            },
        );

    Ok(session_id)
}

#[tauri::command]
pub async fn finish_cookie_capture(session_id: String) -> Result<Vec<CapturedCookie>, String> {
    let status = tokio::task::spawn_blocking(move || finish_cookie_capture_sync(session_id))
        .await
        .map_err(|e| format!("Cookie capture task failed: {}", e))??;

    if !status.cookies.is_empty() {
        return Ok(status.cookies);
    }

    if let Some(error) = status.error {
        return Err(error);
    }

    Ok(status.cookies)
}

#[tauri::command]
pub async fn cancel_cookie_capture(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || cancel_cookie_capture_sync(session_id))
        .await
        .map_err(|e| format!("Cookie capture task failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_login_url() {
        assert_eq!(
            get_login_url("nyaa").expect("expected nyaa login URL"),
            "https://nyaa.si/login"
        );
        assert!(get_login_url("unknown").is_err());
    }

    #[test]
    fn test_get_cookie_domains() {
        let domains = get_cookie_domains("nyaa");
        assert_eq!(domains, vec!["nyaa.si", ".nyaa.si"]);
    }

    #[test]
    fn test_matches_site_domain() {
        assert!(matches_site_domain(".nyaa.si", NYAA_COOKIE_DOMAINS));
        assert!(matches_site_domain("upload.nyaa.si", NYAA_COOKIE_DOMAINS));
        assert!(!matches_site_domain("example.com", NYAA_COOKIE_DOMAINS));
        assert!(!matches_site_domain("totallynotnyaa.si", NYAA_COOKIE_DOMAINS));
    }
}
