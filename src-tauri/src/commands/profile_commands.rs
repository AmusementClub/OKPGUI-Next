use crate::domain::cookie::LoginTestResult;

pub async fn start_cookie_capture(site: String) -> Result<String, String> {
    crate::services::cookie_capture_service::start_cookie_capture(site).await
}

pub async fn finish_cookie_capture(
    session_id: String,
) -> Result<crate::domain::cookie::CookieCaptureResult, String> {
    crate::services::cookie_capture_service::finish_cookie_capture(session_id).await
}

pub async fn cancel_cookie_capture(session_id: String) -> Result<(), String> {
    crate::services::cookie_capture_service::cancel_cookie_capture(session_id).await
}

pub async fn test_site_login(
    app: tauri::AppHandle,
    site: String,
    cookie_text: String,
    user_agent: Option<String>,
    expected_name: Option<String>,
) -> Result<LoginTestResult, String> {
    crate::services::login_test_service::test_site_login(
        &app,
        &site,
        &cookie_text,
        user_agent.as_deref(),
        expected_name.as_deref(),
    )
    .await
}