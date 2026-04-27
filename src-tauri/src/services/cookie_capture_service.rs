use crate::domain::cookie::{get_site_config, CapturedCookie, CookieCaptureResult, SiteConfig};

use chromiumoxide::cdp::browser_protocol::network::Cookie;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message as WsMessage, WebSocket};

const DEBUG_ENDPOINT_TIMEOUT: Duration = Duration::from_secs(15);
const DEBUG_ENDPOINT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const COOKIE_POLL_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Serialize)]
struct CookieCaptureStatus {
    cookies: Vec<CapturedCookie>,
    user_agent: String,
    browser_closed: bool,
    completed: bool,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct CookieCaptureRuntimeState {
    cookies: Vec<CapturedCookie>,
    user_agent: String,
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
            user_agent: state.user_agent.clone(),
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

fn normalize_cookie_domain(domain: &str) -> &str {
    domain.trim().trim_start_matches('.')
}

pub(crate) fn matches_site_domain(domain: &str, candidates: &[&str]) -> bool {
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

fn push_browser_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if seen.insert(path.clone()) && path.is_file() {
        candidates.push(path);
    }
}

pub(crate) fn browser_path_candidates(path_env: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(path_env) = path_env else {
        return Vec::new();
    };

    #[cfg(target_os = "windows")]
    let commands = ["chrome.exe", "msedge.exe", "chromium.exe"];
    #[cfg(target_os = "macos")]
    let commands = ["Google Chrome", "Microsoft Edge", "Chromium"];
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let commands = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
    ];

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for directory in std::env::split_paths(path_env) {
        for command in &commands {
            push_browser_candidate(&mut candidates, &mut seen, directory.join(command));
        }
    }

    candidates
}

pub(crate) fn collect_browser_executable_candidates(
    path_env: Option<&OsStr>,
    _home_dir: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    #[cfg(target_os = "windows")]
    {
        for path in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ] {
            push_browser_candidate(&mut candidates, &mut seen, PathBuf::from(path));
        }

        if let Some(local_app_data) = local_app_data {
            push_browser_candidate(
                &mut candidates,
                &mut seen,
                local_app_data.join(r"Google\Chrome\Application\chrome.exe"),
            );
            push_browser_candidate(
                &mut candidates,
                &mut seen,
                local_app_data.join(r"Microsoft\Edge\Application\msedge.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        for path in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            push_browser_candidate(&mut candidates, &mut seen, PathBuf::from(path));
        }

        if let Some(home_dir) = _home_dir {
            push_browser_candidate(
                &mut candidates,
                &mut seen,
                home_dir.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            );
            push_browser_candidate(
                &mut candidates,
                &mut seen,
                home_dir.join("Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            );
            push_browser_candidate(
                &mut candidates,
                &mut seen,
                home_dir.join("Applications/Chromium.app/Contents/MacOS/Chromium"),
            );
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        for path in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/snap/bin/chromium",
        ] {
            push_browser_candidate(&mut candidates, &mut seen, PathBuf::from(path));
        }
    }

    for path in browser_path_candidates(path_env) {
        push_browser_candidate(&mut candidates, &mut seen, path);
    }

    candidates
}

fn find_browser_executable() -> Result<PathBuf, String> {
    collect_browser_executable_candidates(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").as_deref().map(Path::new),
        std::env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
    )
    .into_iter()
    .next()
    .ok_or_else(|| {
        "未找到可用的 Chromium 内核浏览器，请确认已经安装 Chrome、Chromium 或 Edge。".to_string()
    })
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

        let child = std::process::Command::new(browser_path)
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

    fn get_user_agent(&mut self) -> Result<String, String> {
        let result = self.send_command("Browser.getVersion", json!({}))?;
        result
            .get("userAgent")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "无法从浏览器调试接口获取 User-Agent。".to_string())
    }
}

struct CookieCaptureSession {
    site: &'static SiteConfig,
    browser: BrowserProcess,
    client: CdpClient,
    user_agent: String,
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

        let mut client = CdpClient::connect(&ws_url)?;
        let user_agent = client.get_user_agent()?;
        println!(
            "[cookies] CDP websocket connected. User should now log in and come back to the app when done."
        );

        Ok(Self {
            site,
            browser,
            client,
            user_agent,
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
        update_runtime_state(state, |current| current.user_agent = self.user_agent.clone());

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

pub(crate) async fn start_cookie_capture(site: String) -> Result<String, String> {
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

pub(crate) async fn finish_cookie_capture(session_id: String) -> Result<CookieCaptureResult, String> {
    let status = tokio::task::spawn_blocking(move || finish_cookie_capture_sync(session_id))
        .await
        .map_err(|e| format!("Cookie capture task failed: {}", e))??;

    if !status.cookies.is_empty() {
        return Ok(CookieCaptureResult {
            cookies: status.cookies,
            user_agent: status.user_agent,
        });
    }

    if let Some(error) = status.error {
        return Err(error);
    }

    Ok(CookieCaptureResult {
        cookies: status.cookies,
        user_agent: status.user_agent,
    })
}

pub(crate) async fn cancel_cookie_capture(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || cancel_cookie_capture_sync(session_id))
        .await
        .map_err(|e| format!("Cookie capture task failed: {}", e))?;
    Ok(())
}