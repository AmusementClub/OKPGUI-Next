use crate::config::load_config;
use crate::domain::cookie::{get_site_config, LoginTestResult, SiteConfig};
use crate::profile::build_site_cookie_header;

use regex::Regex;
use reqwest::header::{COOKIE, HeaderMap, HeaderValue, USER_AGENT};
use reqwest::{Client, Proxy, StatusCode};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::AppHandle;

const DEFAULT_TEST_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

fn resolve_test_proxy(app: &AppHandle) -> Option<String> {
    let config = load_config(app);
    if config.proxy.proxy_type == "http" {
        let proxy_host = config.proxy.proxy_host.trim();
        if !proxy_host.is_empty() {
            return Some(proxy_host.to_string());
        }
    }

    None
}

fn build_test_client(
    user_agent: &str,
    cookie_header: &str,
    proxy_url: Option<&str>,
) -> Result<Client, String> {
    let mut headers = HeaderMap::new();

    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(if user_agent.trim().is_empty() {
            DEFAULT_TEST_USER_AGENT
        } else {
            user_agent.trim()
        })
        .map_err(|e| format!("无效的 User-Agent: {}", e))?,
    );

    headers.insert(
        COOKIE,
        HeaderValue::from_str(cookie_header).map_err(|e| format!("无效的 Cookie 请求头: {}", e))?,
    );

    let mut client_builder = Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none());

    if let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        client_builder = client_builder.proxy(
            Proxy::all(proxy_url).map_err(|e| format!("无效的代理地址 {}: {}", proxy_url, e))?,
        );
    }

    client_builder
        .build()
        .map_err(|e| format!("创建登录测试客户端失败: {}", e))
}

fn response_body_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn truncate_detail(detail: &str) -> String {
    let collapsed = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let truncated: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        format!("{}...", truncated)
    } else {
        truncated
    }
}

fn dmhy_team_select_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<select name="team_id" id="team_id">[\s\S]*?</select>"#)
            .expect("valid dmhy team select regex")
    })
}

fn dmhy_team_option_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<option value="(?P<value>\d+)" label="(?P<name>[^"]+)""#)
            .expect("valid dmhy team option regex")
    })
}

fn acgrip_team_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"class="panel-title-right">([\s\S]*?)</div>"#)
            .expect("valid acgrip team regex")
    })
}

fn acgrip_personal_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"class="panel-title">([\s\S]*?)</div>"#)
            .expect("valid acgrip personal regex")
    })
}

fn acgrip_token_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"<meta\s+name="csrf-token"\s+content="([^"]+)"\s*/?>"#)
            .expect("valid acgrip csrf regex")
    })
}

fn contains_name(names: &[String], expected_name: &str) -> bool {
    names.iter()
        .any(|name| name.trim().eq_ignore_ascii_case(expected_name.trim()))
}

async fn perform_site_login_test(
    site: &'static SiteConfig,
    cookie_text: &str,
    user_agent: &str,
    expected_name: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<LoginTestResult, String> {
    let cookie_context = build_site_cookie_header(
        cookie_text,
        site.test_url,
        site.cookie_domains,
        user_agent,
    )?;
    if cookie_context.cookie_header.trim().is_empty() {
        return Ok(LoginTestResult {
            success: false,
            message: "没有可用于该站点测试的 Cookie。".to_string(),
        });
    }

    let client = build_test_client(
        &cookie_context.user_agent,
        &cookie_context.cookie_header,
        proxy_url,
    )?;
    let response = client
        .get(site.test_url)
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败: {}", site.code, e))?;
    let status = response.status();
    let body_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取 {} 响应失败: {}", site.code, e))?;
    let body = response_body_to_string(&body_bytes);
    let expected_name = expected_name.map(str::trim).filter(|name| !name.is_empty());

    match site.code {
        "dmhy" => {
            if !status.is_success() {
                return Ok(LoginTestResult {
                    success: false,
                    message: format!(
                        "动漫花园请求失败: HTTP {} {}",
                        status.as_u16(),
                        truncate_detail(&body)
                    ),
                });
            }

            if body.contains(r#"<div class="nav_title text_bold"><img src="/images/login.gif" align="middle" />&nbsp;登入發佈系統</div>"#) {
                return Ok(LoginTestResult {
                    success: false,
                    message: "动漫花园登录失效，请重新获取 Cookie。".to_string(),
                });
            }

            if let Some(expected_name) = expected_name {
                let Some(team_select) = dmhy_team_select_regex().find(&body) else {
                    return Ok(LoginTestResult {
                        success: false,
                        message: "动漫花园登录页已打开，但未找到发布身份列表。".to_string(),
                    });
                };

                let team_names = dmhy_team_option_regex()
                    .captures_iter(team_select.as_str())
                    .filter_map(|capture| capture.name("name").map(|value| value.as_str().to_string()))
                    .collect::<Vec<_>>();

                if !contains_name(&team_names, expected_name) {
                    return Ok(LoginTestResult {
                        success: false,
                        message: format!("动漫花园已登录，但账号没有发布身份“{}”。", expected_name),
                    });
                }
            }

            Ok(LoginTestResult {
                success: true,
                message: "动漫花园登录测试通过。".to_string(),
            })
        }
        "nyaa" => {
            if !status.is_success() {
                return Ok(LoginTestResult {
                    success: false,
                    message: format!(
                        "Nyaa 请求失败: HTTP {} {}",
                        status.as_u16(),
                        truncate_detail(&body)
                    ),
                });
            }

            if body.contains("You are not logged in") {
                return Ok(LoginTestResult {
                    success: false,
                    message: "Nyaa 登录失效，请重新获取 Cookie。".to_string(),
                });
            }

            Ok(LoginTestResult {
                success: true,
                message: "Nyaa 登录测试通过。".to_string(),
            })
        }
        "acgrip" => {
            if !status.is_success() {
                return Ok(LoginTestResult {
                    success: false,
                    message: format!(
                        "ACG.RIP 请求失败: HTTP {} {}",
                        status.as_u16(),
                        truncate_detail(&body)
                    ),
                });
            }

            if body.contains("继续操作前请注册或者登录") {
                return Ok(LoginTestResult {
                    success: false,
                    message: "ACG.RIP 登录失效，请重新获取 Cookie。".to_string(),
                });
            }

            if acgrip_token_regex().captures(&body).is_none() {
                return Ok(LoginTestResult {
                    success: false,
                    message: "ACG.RIP 登录页已打开，但缺少提交所需的 CSRF Token。".to_string(),
                });
            }

            if let Some(expected_name) = expected_name {
                let current_name = acgrip_team_regex()
                    .captures(&body)
                    .or_else(|| acgrip_personal_regex().captures(&body))
                    .and_then(|capture| capture.get(1))
                    .map(|value| value.as_str().trim().to_string())
                    .unwrap_or_default();

                if current_name.is_empty() || !current_name.eq_ignore_ascii_case(expected_name) {
                    return Ok(LoginTestResult {
                        success: false,
                        message: format!(
                            "ACG.RIP 当前账户为“{}”，与配置的发布身份“{}”不一致。",
                            if current_name.is_empty() { "未知" } else { current_name.as_str() },
                            expected_name
                        ),
                    });
                }
            }

            Ok(LoginTestResult {
                success: true,
                message: "ACG.RIP 登录测试通过。".to_string(),
            })
        }
        "bangumi" => {
            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Ok(LoginTestResult {
                    success: false,
                    message: "萌番组登录失效，请重新获取 Cookie。".to_string(),
                });
            }

            if !status.is_success() {
                return Ok(LoginTestResult {
                    success: false,
                    message: format!(
                        "萌番组请求失败: HTTP {} {}",
                        status.as_u16(),
                        truncate_detail(&body)
                    ),
                });
            }

            let teams: Value = serde_json::from_slice(&body_bytes).map_err(|e| {
                format!("解析萌番组团队信息失败: {}，响应片段: {}", e, truncate_detail(&body))
            })?;
            let team_names = teams
                .as_array()
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if team_names.is_empty() {
                return Ok(LoginTestResult {
                    success: false,
                    message: "萌番组登录失效，未返回可用团队。".to_string(),
                });
            }

            if let Some(expected_name) = expected_name {
                if !contains_name(&team_names, expected_name) {
                    return Ok(LoginTestResult {
                        success: false,
                        message: format!("萌番组已登录，但账号没有发布身份“{}”。", expected_name),
                    });
                }
            }

            Ok(LoginTestResult {
                success: true,
                message: "萌番组登录测试通过。".to_string(),
            })
        }
        _ => Err(format!("暂不支持该站点的登录测试: {}", site.code)),
    }
}

pub(crate) async fn test_site_login(
    app: &AppHandle,
    site: &str,
    cookie_text: &str,
    user_agent: Option<&str>,
    expected_name: Option<&str>,
) -> Result<LoginTestResult, String> {
    let site = get_site_config(site)?;
    let proxy_url = resolve_test_proxy(app);
    perform_site_login_test(
        site,
        cookie_text,
        user_agent.unwrap_or_default(),
        expected_name,
        proxy_url.as_deref(),
    )
    .await
}