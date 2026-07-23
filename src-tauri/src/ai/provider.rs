use crate::ai::credentials::{validate_custom_header_name, AuthMode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderMode {
    Auto,
    Responses,
    Chat,
    AnthropicMessages,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    #[default]
    Unknown,
    Probing,
    Ready,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityIdentity {
    pub digest: String,
    pub provider: ProviderKind,
    pub mode: ProviderMode,
    pub endpoint: String,
    pub model: String,
}

impl CapabilityIdentity {
    #[allow(clippy::too_many_arguments)]
    pub fn from_connection(
        provider: ProviderKind,
        endpoint: &str,
        model: &str,
        mode: ProviderMode,
        auth_mode: AuthMode,
        custom_header_name: Option<&str>,
        secret: Option<&str>,
    ) -> Self {
        let canonical = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            provider as u8,
            endpoint.trim_end_matches('/'),
            model,
            mode as u8,
            auth_mode as u8,
            custom_header_name.unwrap_or_default(),
            secret.unwrap_or_default(),
        );
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Self {
            digest: format!("sha256:{}", hex::encode(hasher.finalize())),
            provider,
            mode,
            endpoint: endpoint.trim_end_matches('/').to_string(),
            model: model.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderRequest {
    pub method: String,
    pub url: String,
    pub body: Value,
    pub managed_auth_header: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityProbeResult {
    pub state: CapabilityState,
    pub provider: ProviderKind,
    pub mode: ProviderMode,
    pub status: u16,
    pub message: String,
    pub usage: Option<ProviderUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFailureKind {
    Unsupported,
    Authentication,
    RateLimited,
    Server,
    Timeout,
    Schema,
    Refusal,
    Malformed,
    /// Explicit HTTP 3xx: provider clients never follow redirects.
    Redirect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub kind: ProviderFailureKind,
    pub status: Option<u16>,
    pub message: String,
}

pub fn build_no_redirect_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("provider client build failed: {error}"))
}

/// V2 minimal strict probe schema. Local validation requires `{"ok": true}`.
pub fn minimal_probe_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ok": { "type": "boolean" }
        },
        "required": ["ok"],
        "additionalProperties": false
    })
}

/// True only when the structured object is the exact V2 probe payload.
pub fn validate_minimal_probe_object(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 1 && object.get("ok").and_then(Value::as_bool) == Some(true)
    })
}

pub fn build_probe_request(
    provider: ProviderKind,
    mode: ProviderMode,
    endpoint: &str,
    model: &str,
    schema: &Value,
    auth_mode: AuthMode,
) -> Result<ProviderRequest, String> {
    build_structured_request(
        provider,
        mode,
        endpoint,
        model,
        schema,
        auth_mode,
        "okpgui_probe",
        "Return the JSON object {\"ok\":true}.",
        128,
    )
}

/// Build a no-redirect Models list request for OpenAI-compatible or Anthropic endpoints.
pub fn build_models_list_request(
    provider: ProviderKind,
    endpoint: &str,
    auth_mode: AuthMode,
) -> Result<ProviderRequest, String> {
    if !matches!(endpoint.split(':').next(), Some("http") | Some("https")) {
        return Err("provider endpoint must use http or https".to_string());
    }
    let base = endpoint.trim_end_matches('/');
    let url = match provider {
        ProviderKind::OpenAi | ProviderKind::Anthropic => format!("{base}/models"),
    };
    Ok(ProviderRequest {
        method: "GET".to_string(),
        url,
        body: Value::Null,
        managed_auth_header: managed_auth_header(auth_mode),
    })
}

/// Parse a Models API response into non-secret model ids only.
/// Never returns response bodies or secrets; empty lists are a soft success (manual model still works).
pub fn parse_models_list_response(
    provider: ProviderKind,
    status: u16,
    body: &str,
) -> Result<Vec<String>, ProviderFailure> {
    if !(200..300).contains(&status) {
        return Err(classify_http_failure(status, body));
    }
    let parsed: Value = serde_json::from_str(body).map_err(|_| ProviderFailure {
        kind: ProviderFailureKind::Malformed,
        status: Some(status),
        message: "provider returned malformed JSON while listing models".to_string(),
    })?;
    if has_provider_error(&parsed) {
        return Err(ProviderFailure {
            kind: ProviderFailureKind::Schema,
            status: Some(status),
            message: "provider returned an error while listing models".to_string(),
        });
    }

    let mut ids = match provider {
        ProviderKind::OpenAi => parse_openai_model_ids(&parsed),
        ProviderKind::Anthropic => parse_anthropic_model_ids(&parsed),
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn parse_openai_model_ids(value: &Value) -> Vec<String> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect()
}

fn parse_anthropic_model_ids(value: &Value) -> Vec<String> {
    // Anthropic Models API returns `{ "data": [ { "id": "..." }, ... ] }` (same shape as OpenAI-compatible).
    // Also accept a top-level array for tolerant fixtures.
    if let Some(ids) = value
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(ToOwned::to_owned)
                })
                .collect::<Vec<_>>()
        })
        .filter(|ids| !ids.is_empty())
    {
        return ids;
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect()
}

/// Classify a probe HTTP response and require the V2 minimal `{"ok":true}` object.
/// JSON-mode-only or wrong-shape payloads stay Unsupported; never echoes bodies.
pub fn classify_and_validate_probe_response(
    provider: ProviderKind,
    mode: ProviderMode,
    status: u16,
    body: &str,
) -> CapabilityProbeResult {
    let mut result = classify_probe_response(provider, mode, status, body);
    if result.state != CapabilityState::Ready {
        return result;
    }
    match extract_structured_json(provider, mode, body) {
        Ok(value) if validate_minimal_probe_object(&value) => result,
        Ok(_) => {
            result.state = CapabilityState::Unsupported;
            result.message =
                "provider returned a structured object that failed local probe validation"
                    .to_string();
            result
        }
        Err(failure) => {
            result.state = match failure.kind {
                ProviderFailureKind::Unsupported
                | ProviderFailureKind::Schema
                | ProviderFailureKind::Malformed
                | ProviderFailureKind::Refusal => CapabilityState::Unsupported,
                _ => CapabilityState::Failed,
            };
            result.message = failure.message;
            result
        }
    }
}

/// Build a strict structured-output request for OpenAI-compatible or Anthropic helpers.
#[allow(clippy::too_many_arguments)]
pub fn build_structured_request(
    provider: ProviderKind,
    mode: ProviderMode,
    endpoint: &str,
    model: &str,
    schema: &Value,
    auth_mode: AuthMode,
    schema_name: &str,
    user_prompt: &str,
    max_tokens: u32,
) -> Result<ProviderRequest, String> {
    if model.trim().is_empty() {
        return Err("model is required".to_string());
    }
    if !matches!(endpoint.split(':').next(), Some("http") | Some("https")) {
        return Err("provider endpoint must use http or https".to_string());
    }

    let base = endpoint.trim_end_matches('/');
    let resolved_mode = resolve_mode(provider, mode);
    let (url, body) = match (provider, resolved_mode) {
        (ProviderKind::OpenAi, ProviderMode::Responses) => (
            format!("{base}/responses"),
            json!({
                "model": model,
                "input": [{"role": "user", "content": [{"type": "input_text", "text": user_prompt}]}],
                "text": {"format": {"type": "json_schema", "name": schema_name, "strict": true, "schema": schema}}
            }),
        ),
        (ProviderKind::OpenAi, ProviderMode::Chat) => (
            format!("{base}/chat/completions"),
            json!({
                "model": model,
                "messages": [{"role": "user", "content": user_prompt}],
                "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": true, "schema": schema}}
            }),
        ),
        (ProviderKind::Anthropic, ProviderMode::AnthropicMessages) => (
            format!("{base}/messages"),
            json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": user_prompt}],
                "output_config": {"format": {"type": "json_schema", "schema": schema}}
            }),
        ),
        _ => return Err("provider and mode combination is unsupported".to_string()),
    };

    Ok(ProviderRequest {
        method: "POST".to_string(),
        url,
        body,
        managed_auth_header: managed_auth_header(auth_mode),
    })
}

/// Execute a provider request with managed authorization. Never logs secrets.
pub async fn send_managed_provider_request(
    client: &Client,
    request: &ProviderRequest,
    auth_mode: AuthMode,
    custom_header_name: Option<&str>,
    secret: Option<&str>,
    provider: ProviderKind,
) -> Result<(u16, String), String> {
    let mut builder = client.request(
        request
            .method
            .parse()
            .map_err(|_| "invalid provider HTTP method".to_string())?,
        &request.url,
    );

    // GET model-list requests carry no JSON body; formal/probe POSTs always send one.
    if !request.body.is_null() {
        builder = builder
            .header("content-type", "application/json")
            .json(&request.body);
    }

    if provider == ProviderKind::Anthropic {
        builder = builder.header("anthropic-version", "2023-06-01");
    }

    match auth_mode {
        AuthMode::Bearer => {
            let token = secret.ok_or_else(|| "provider credential is required".to_string())?;
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        AuthMode::AnthropicApiKey => {
            let token = secret.ok_or_else(|| "provider credential is required".to_string())?;
            builder = builder.header("x-api-key", token);
        }
        AuthMode::CustomHeader => {
            // Revalidate at send time even if settings bypassed save-time validation.
            let header = resolve_custom_auth_header_name(custom_header_name)?;
            let token = secret.ok_or_else(|| "provider credential is required".to_string())?;
            builder = builder.header(header.as_str(), token);
        }
        AuthMode::None => {}
    }

    let response = builder.send().await.map_err(|error| {
        format!(
            "provider request failed: {}",
            sanitize_transport_error(error)
        )
    })?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| {
        format!(
            "provider response read failed: {}",
            sanitize_transport_error(error)
        )
    })?;
    Ok((status, body))
}

/// Revalidate a custom auth header name immediately before it is sent.
/// Rejects empty, control-character, and managed/transport header names.
pub fn resolve_custom_auth_header_name(custom_header_name: Option<&str>) -> Result<String, String> {
    let header = custom_header_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "custom auth mode requires a header name".to_string())?;
    validate_custom_header_name(header)
}

fn sanitize_transport_error(error: reqwest::Error) -> String {
    // reqwest errors can include URLs; strip them via without_url (takes self by value).
    // Take ownership so without_url can consume the error (reqwest::Error is not Clone).
    let text = error.without_url().to_string();
    text.chars().take(240).collect()
}

/// Extract the strict structured JSON object from a successful provider response body.
pub fn extract_structured_json(
    provider: ProviderKind,
    mode: ProviderMode,
    body: &str,
) -> Result<Value, ProviderFailure> {
    let resolved_mode = resolve_mode(provider, mode);
    let parsed: Value = serde_json::from_str(body).map_err(|_| ProviderFailure {
        kind: ProviderFailureKind::Malformed,
        status: None,
        message: "provider returned malformed JSON".to_string(),
    })?;
    if has_provider_error(&parsed) {
        return Err(ProviderFailure {
            kind: ProviderFailureKind::Schema,
            status: None,
            message: "provider returned an error payload".to_string(),
        });
    }
    if has_refusal(provider, resolved_mode, &parsed) {
        return Err(ProviderFailure {
            kind: ProviderFailureKind::Refusal,
            status: None,
            message: "provider refused the request".to_string(),
        });
    }
    extract_structured_object(provider, resolved_mode, &parsed).ok_or_else(|| ProviderFailure {
        kind: ProviderFailureKind::Schema,
        status: None,
        message: "provider returned JSON mode or an incompatible shape, not strict schema"
            .to_string(),
    })
}

fn extract_structured_object(
    provider: ProviderKind,
    mode: ProviderMode,
    value: &Value,
) -> Option<Value> {
    match (provider, mode) {
        (ProviderKind::OpenAi, ProviderMode::Responses) => {
            if let Some(parsed) = value.get("output_parsed").filter(|item| item.is_object()) {
                return Some(parsed.clone());
            }
            // Some Responses deployments expose a top-level structured text field.
            if let Some(parsed) = value
                .get("output_text")
                .and_then(Value::as_str)
                .and_then(parse_json_object_string)
            {
                return Some(parsed);
            }
            value
                .get("output")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        if let Some(parsed) = item.get("parsed").filter(|child| child.is_object()) {
                            return Some(parsed.clone());
                        }
                        item.get("content")
                            .and_then(Value::as_array)
                            .and_then(|content| content.iter().find_map(extract_json_content_value))
                    })
                })
        }
        // Real OpenAI Chat structured-output wire puts a JSON object string in
        // choices[0].message.content; prefer native `parsed` when present.
        (ProviderKind::OpenAi, ProviderMode::Chat) => {
            if let Some(parsed) = value
                .pointer("/choices/0/message/parsed")
                .filter(|item| item.is_object())
            {
                return Some(parsed.clone());
            }
            match value.pointer("/choices/0/message/content") {
                Some(Value::String(text)) => parse_json_object_string(text),
                Some(object) if object.is_object() => Some(object.clone()),
                _ => None,
            }
        }
        (ProviderKind::Anthropic, ProviderMode::AnthropicMessages) => value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find_map(extract_json_content_value)),
        _ => None,
    }
}

/// Parse a provider text payload only when it is a JSON object (not array/primitive/free text).
fn parse_json_object_string(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .filter(Value::is_object)
}

/// Whether an HTTP status is an explicit unsupported-endpoint classification
/// that may trigger Auto mode's single Responses→Chat fallback.
pub fn is_unsupported_endpoint_status(status: u16) -> bool {
    status == 404
}

/// Modes to attempt for a formal structured call.
/// Auto on OpenAI tries Responses first, then Chat only after an unsupported-endpoint
/// failure. Auth/rate/schema failures never widen the attempt list.
pub fn formal_attempt_modes(provider: ProviderKind, mode: ProviderMode) -> Vec<ProviderMode> {
    match (provider, mode) {
        (ProviderKind::OpenAi, ProviderMode::Auto) => {
            vec![ProviderMode::Responses, ProviderMode::Chat]
        }
        (provider, mode) => vec![resolve_mode(provider, mode)],
    }
}

/// Formal audit/template selection modes after a Ready capability probe.
///
/// When Auto previously resolved to a concrete mode (e.g. Chat after Responses 404),
/// stick to that mode so formal work does not reopen Responses. Explicit configured
/// modes and narrow 404 Auto fallback semantics are preserved when no resolved mode
/// is recorded yet.
pub fn formal_attempt_modes_for_ready_capability(
    provider: ProviderKind,
    configured_mode: ProviderMode,
    resolved_mode: Option<ProviderMode>,
) -> Vec<ProviderMode> {
    if let Some(resolved) = resolved_mode {
        // Probe-proven mode is never Auto; treat it as explicit.
        return formal_attempt_modes(provider, resolved);
    }
    formal_attempt_modes(provider, configured_mode)
}

/// Decide whether Auto may continue from a failed attempt to the next mode.
/// Only OpenAI Auto Responses → Chat on explicit unsupported endpoint (404).
pub fn auto_fallback_allowed(
    provider: ProviderKind,
    configured_mode: ProviderMode,
    attempted_mode: ProviderMode,
    failure: &ProviderFailure,
) -> bool {
    matches!(
        (provider, configured_mode, attempted_mode, failure.kind),
        (
            ProviderKind::OpenAi,
            ProviderMode::Auto,
            ProviderMode::Responses,
            ProviderFailureKind::Unsupported
        )
    ) && failure.status.is_some_and(is_unsupported_endpoint_status)
}

/// Accept provider-native structured objects (`parsed` / `json`) and real wire text
/// that is a JSON object string (`output_text` / typed json text). Unvalidated free
/// text and non-object JSON remain rejected.
fn extract_json_content_value(value: &Value) -> Option<Value> {
    if let Some(parsed) = value.get("parsed").filter(|item| item.is_object()) {
        return Some(parsed.clone());
    }
    if let Some(json_value) = value.get("json").filter(|item| item.is_object()) {
        return Some(json_value.clone());
    }
    let type_name = value.get("type").and_then(Value::as_str);
    // Real OpenAI Responses structured text often arrives as output_text with a JSON string.
    if matches!(
        type_name,
        Some("output_text")
            | Some("text")
            | Some("json")
            | Some("output_json")
            | Some("json_schema")
    ) {
        if let Some(parsed) = value.get("parsed").filter(|item| item.is_object()) {
            return Some(parsed.clone());
        }
        if let Some(json_value) = value.get("json").filter(|item| item.is_object()) {
            return Some(json_value.clone());
        }
        if let Some(parsed) = value
            .get("text")
            .and_then(Value::as_str)
            .and_then(parse_json_object_string)
        {
            return Some(parsed);
        }
    }
    None
}

fn resolve_mode(provider: ProviderKind, mode: ProviderMode) -> ProviderMode {
    match (provider, mode) {
        (ProviderKind::OpenAi, ProviderMode::Auto) => ProviderMode::Responses,
        (ProviderKind::Anthropic, ProviderMode::Auto) => ProviderMode::AnthropicMessages,
        (_, selected) => selected,
    }
}

fn managed_auth_header(auth_mode: AuthMode) -> Option<String> {
    match auth_mode {
        AuthMode::Bearer => Some("authorization".to_string()),
        AuthMode::AnthropicApiKey => Some("x-api-key".to_string()),
        AuthMode::CustomHeader | AuthMode::None => None,
    }
}

pub fn classify_probe_response(
    provider: ProviderKind,
    mode: ProviderMode,
    status: u16,
    body: &str,
) -> CapabilityProbeResult {
    let resolved_mode = resolve_mode(provider, mode);
    let parsed = serde_json::from_str::<Value>(body).ok();
    let failure = if !(200..300).contains(&status) {
        Some(classify_http_failure(status, body))
    } else if parsed.as_ref().is_some_and(|value| {
        has_provider_error(value) || has_refusal(provider, resolved_mode, value)
    }) {
        Some(ProviderFailure {
            kind: if parsed
                .as_ref()
                .is_some_and(|value| has_refusal(provider, resolved_mode, value))
            {
                ProviderFailureKind::Refusal
            } else {
                ProviderFailureKind::Schema
            },
            status: Some(status),
            message: "provider did not return a valid strict-schema result".to_string(),
        })
    } else if parsed.is_none() {
        Some(ProviderFailure {
            kind: ProviderFailureKind::Malformed,
            status: Some(status),
            message: "provider returned malformed JSON".to_string(),
        })
    } else if !has_structured_success(provider, resolved_mode, parsed.as_ref().unwrap()) {
        Some(ProviderFailure {
            kind: ProviderFailureKind::Schema,
            status: Some(status),
            message: "provider returned JSON mode or an incompatible shape, not strict schema"
                .to_string(),
        })
    } else {
        None
    };

    match failure {
        Some(failure) => CapabilityProbeResult {
            state: match failure.kind {
                ProviderFailureKind::Unsupported
                | ProviderFailureKind::Schema
                | ProviderFailureKind::Malformed
                | ProviderFailureKind::Refusal => CapabilityState::Unsupported,
                // Redirects and transport/auth failures are connection failures, not mode unsupported.
                ProviderFailureKind::Redirect
                | ProviderFailureKind::Authentication
                | ProviderFailureKind::RateLimited
                | ProviderFailureKind::Server
                | ProviderFailureKind::Timeout => CapabilityState::Failed,
            },
            provider,
            mode: resolved_mode,
            status,
            message: failure.message,
            usage: parsed.as_ref().and_then(extract_usage),
        },
        None => CapabilityProbeResult {
            state: CapabilityState::Ready,
            provider,
            mode: resolved_mode,
            status,
            message: "strict structured output is available".to_string(),
            usage: parsed.as_ref().and_then(extract_usage),
        },
    }
}

/// True only when a top-level `error` field is present and non-null.
/// Nullable `error` is documented for OpenAI Responses; `null` is also treated
/// defensively as non-error for compatible Chat/Anthropic-style payloads.
fn has_provider_error(value: &Value) -> bool {
    value.get("error").is_some_and(|err| !err.is_null())
}

/// Detect provider-envelope refusals only — never scan arbitrary response text.
///
/// OpenAI Chat: only a non-empty string at `choices[].message.refusal` counts.
/// OpenAI Responses: only `output[].content[]` parts with `type` exactly
/// `"refusal"` and a non-empty string `refusal` field count. Top-level,
/// output-item, untyped-part, and `text` fallbacks are not documented refusal
/// signals and are ignored (they can collide with structured application data).
/// Anthropic Messages: only the documented top-level `stop_reason` field counts,
/// and only when it is exactly the non-empty string `"refusal"`.
fn has_refusal(provider: ProviderKind, mode: ProviderMode, value: &Value) -> bool {
    match (provider, mode) {
        (ProviderKind::OpenAi, ProviderMode::Chat) => openai_chat_has_refusal(value),
        (ProviderKind::OpenAi, ProviderMode::Responses) => openai_responses_has_refusal(value),
        (ProviderKind::Anthropic, ProviderMode::AnthropicMessages) => {
            anthropic_messages_has_refusal(value)
        }
        // Auto is resolved before classification; treat unresolved as no refusal signal.
        _ => false,
    }
}

/// True only for a non-empty refusal *string* (null / empty / non-string → false).
fn is_nonempty_refusal_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty())
}

fn openai_chat_has_refusal(value: &Value) -> bool {
    value
        .get("choices")
        .and_then(Value::as_array)
        .map(|choices| {
            choices
                .iter()
                .any(|choice| is_nonempty_refusal_string(choice.pointer("/message/refusal")))
        })
        .unwrap_or(false)
}

/// Documented OpenAI Responses refusal location only:
/// `output[].content[]` part with `type == "refusal"` and non-empty `refusal` string.
fn openai_responses_has_refusal(value: &Value) -> bool {
    value
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts.iter().any(|part| {
                            part.get("type").and_then(Value::as_str) == Some("refusal")
                                && is_nonempty_refusal_string(part.get("refusal"))
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Anthropic Messages refusal signal is only documented top-level `stop_reason`.
/// Exact match on `"refusal"` — do not scan content text or OpenAI-style fields.
fn anthropic_messages_has_refusal(value: &Value) -> bool {
    value.get("stop_reason").and_then(Value::as_str) == Some("refusal")
}

fn has_structured_success(provider: ProviderKind, mode: ProviderMode, value: &Value) -> bool {
    extract_structured_object(provider, mode, value).is_some()
}

/// Classify an HTTP failure by status only.
///
/// `body` is intentionally never copied into user/debug messages: provider
/// responses may echo API keys, Authorization headers, or redirect URLs.
pub fn classify_http_failure(status: u16, body: &str) -> ProviderFailure {
    let _body = body; // retained for call-site stability; never echoed
    let kind = match status {
        300..=399 => ProviderFailureKind::Redirect,
        401 | 403 => ProviderFailureKind::Authentication,
        404 => ProviderFailureKind::Unsupported,
        408 | 504 => ProviderFailureKind::Timeout,
        429 => ProviderFailureKind::RateLimited,
        500..=599 => ProviderFailureKind::Server,
        _ => ProviderFailureKind::Malformed,
    };
    // Status/kind only — never include response body content (secrets/URLs).
    let message = match kind {
        ProviderFailureKind::Redirect => {
            format!("provider request was redirected (HTTP {status}); redirects are disabled")
        }
        ProviderFailureKind::Authentication => {
            format!("provider authentication failed (HTTP {status})")
        }
        ProviderFailureKind::Unsupported => {
            format!("provider endpoint is unsupported (HTTP {status})")
        }
        ProviderFailureKind::Timeout => {
            format!("provider request timed out (HTTP {status})")
        }
        ProviderFailureKind::RateLimited => {
            format!("provider rate limited the request (HTTP {status})")
        }
        ProviderFailureKind::Server => {
            format!("provider server error (HTTP {status})")
        }
        ProviderFailureKind::Malformed
        | ProviderFailureKind::Schema
        | ProviderFailureKind::Refusal => {
            format!("provider request failed with HTTP {status}")
        }
    };
    ProviderFailure {
        kind,
        status: Some(status),
        message,
    }
}

fn extract_usage(value: &Value) -> Option<ProviderUsage> {
    let usage = value.get("usage")?;
    Some(ProviderUsage {
        input_tokens: usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens"))
            .and_then(Value::as_u64),
        output_tokens: usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))
            .and_then(Value::as_u64),
        cached_tokens: usage
            .get("cached_tokens")
            .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
            .and_then(Value::as_u64),
        reasoning_tokens: usage
            .get("reasoning_tokens")
            .or_else(|| usage.pointer("/completion_tokens_details/reasoning_tokens"))
            .and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_responses_and_chat_have_distinct_strict_shapes() {
        let schema = json!({"type": "object"});
        let responses = build_probe_request(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            "https://example.test/v1",
            "model",
            &schema,
            AuthMode::Bearer,
        )
        .unwrap();
        let chat = build_probe_request(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            "https://example.test/v1",
            "model",
            &schema,
            AuthMode::Bearer,
        )
        .unwrap();
        assert!(responses.body.get("text").is_some());
        assert!(chat.body.get("response_format").is_some());
    }

    #[test]
    fn real_openai_chat_content_json_object_passes_strict_probe() {
        let with_parsed = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true}","parsed":{"ok":true}}}]}"#,
        );
        assert_eq!(with_parsed.state, CapabilityState::Ready);

        // Real OpenAI structured-output wire: JSON object string in message.content.
        let content_wire = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true}"}}]}"#,
        );
        assert_eq!(content_wire.state, CapabilityState::Ready);

        // Non-object free text / malformed JSON string remains unsupported.
        let free_text = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"not-json"}}]}"#,
        );
        assert_eq!(free_text.state, CapabilityState::Unsupported);

        let array_json = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"[{\"ok\":true}]"}}]}"#,
        );
        assert_eq!(array_json.state, CapabilityState::Unsupported);
    }

    #[test]
    fn formal_chat_extraction_accepts_content_json_object_string() {
        let content_body = r#"{"choices":[{"message":{"content":"{\"findings\":[]}"}}]}"#;
        let accepted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, content_body)
                .expect("Chat content JSON object string must pass formal extraction");
        assert!(accepted.get("findings").is_some());

        let strict_body =
            r#"{"choices":[{"message":{"parsed":{"findings":[]},"content":"{\"findings\":[]}"}}]}"#;
        let accepted_parsed =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, strict_body)
                .expect("strict parsed object must pass");
        assert!(accepted_parsed.get("findings").is_some());

        let free_text = r#"{"choices":[{"message":{"content":"hello findings"}}]}"#;
        let rejected = extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, free_text);
        assert!(
            rejected.is_err(),
            "unvalidated free text must not pass formal Chat extraction"
        );
        assert_eq!(rejected.unwrap_err().kind, ProviderFailureKind::Schema);
    }

    #[test]
    fn openai_chat_refusal_null_with_content_object_is_not_refusal() {
        // Real Chat structured-output wire often includes `"refusal": null` alongside content.
        // Substring scanners false-positive on the key name; envelope checks must not.
        let body = r#"{
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "{\"findings\":[],\"ok\":true}",
                    "refusal": null
                }
            }]
        }"#;
        let probe = classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, body);
        assert_eq!(
            probe.state,
            CapabilityState::Ready,
            "refusal:null must not reject valid Chat content"
        );
        let extracted = extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, body)
            .expect("Chat content with refusal:null must extract");
        assert!(extracted.get("findings").is_some());

        // Empty / non-string refusal values are also non-refusals.
        for neutral in [
            r#"{"choices":[{"message":{"content":"{\"findings\":[]}","refusal":""}}]}"#,
            r#"{"choices":[{"message":{"content":"{\"findings\":[]}","refusal":{}}}]}"#,
            r#"{"choices":[{"message":{"content":{"findings":[]},"refusal":null}}]}"#,
        ] {
            let accepted =
                extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, neutral)
                    .expect("null/empty/non-string refusal must not block extraction");
            assert!(accepted.get("findings").is_some());
        }
    }

    #[test]
    fn openai_responses_structured_output_without_refusal_is_accepted() {
        let body = r#"{
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Responses, 200, body);
        assert_eq!(probe.state, CapabilityState::Ready);
        let extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, body)
                .expect("Responses structured output without refusal must extract");
        assert!(extracted.get("findings").is_some());
    }

    #[test]
    fn openai_structured_payloads_with_error_null_remain_ready_and_extractable() {
        // Responses documents a nullable top-level `error`; null is not a hard failure.
        // Compatible Chat payloads with `error: null` are treated the same defensively.
        let chat_body = r#"{
            "error": null,
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "{\"findings\":[],\"ok\":true}",
                    "refusal": null
                }
            }]
        }"#;
        let chat_probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, chat_body);
        assert_eq!(
            chat_probe.state,
            CapabilityState::Ready,
            "error:null must not reject valid Chat structured content"
        );
        let chat_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, chat_body)
                .expect("Chat structured payload with error:null must extract");
        assert!(chat_extracted.get("findings").is_some());

        let responses_body = r#"{
            "error": null,
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let responses_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            responses_body,
        );
        assert_eq!(
            responses_probe.state,
            CapabilityState::Ready,
            "error:null must not reject valid Responses structured content"
        );
        let responses_extracted = extract_structured_json(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            responses_body,
        )
        .expect("Responses structured payload with error:null must extract");
        assert!(responses_extracted.get("findings").is_some());

        // A real top-level error object remains a hard schema failure.
        let real_error = r#"{
            "error": {
                "message": "Invalid request",
                "type": "invalid_request_error"
            }
        }"#;
        let error_probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, real_error);
        assert_eq!(error_probe.state, CapabilityState::Unsupported);
        let error_err =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, real_error)
                .expect_err("non-null error object must fail formal extraction");
        assert_eq!(error_err.kind, ProviderFailureKind::Schema);
        assert_eq!(error_err.message, "provider returned an error payload");
    }

    #[test]
    fn true_nonempty_provider_refusal_is_classified_as_refusal() {
        // Chat: non-empty message.refusal string.
        let chat_refusal = r#"{
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "refusal": "I cannot assist with that request."
                }
            }]
        }"#;
        let chat_probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, chat_refusal);
        assert_eq!(chat_probe.state, CapabilityState::Unsupported);
        let chat_err =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, chat_refusal)
                .expect_err("non-empty Chat refusal must fail formal extraction");
        assert_eq!(chat_err.kind, ProviderFailureKind::Refusal);

        // Responses: documented nested content part type=refusal with non-empty refusal.
        let responses_refusal = r#"{
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "refusal",
                    "refusal": "I cannot assist with that request."
                }]
            }]
        }"#;
        let responses_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            responses_refusal,
        );
        assert_eq!(responses_probe.state, CapabilityState::Unsupported);
        let responses_err = extract_structured_json(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            responses_refusal,
        )
        .expect_err("documented nested Responses refusal must fail formal extraction");
        assert_eq!(responses_err.kind, ProviderFailureKind::Refusal);
    }

    #[test]
    fn openai_responses_undocumented_refusal_shapes_are_not_refusal() {
        // Only output[].content[] type=="refusal" + non-empty refusal string is documented.
        // Top-level, output-item, untyped-part, and text-fallback shapes must not classify
        // as ProviderFailureKind::Refusal (they can collide with structured app data).

        // Top-level refusal string with valid structured output.
        let top_level = r#"{
            "refusal": "I cannot assist with that request.",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let top_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            top_level,
        );
        assert_eq!(
            top_probe.state,
            CapabilityState::Ready,
            "top-level refusal must not classify as Refusal"
        );
        let top_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, top_level)
                .expect("top-level refusal must not block extraction of structured output");
        assert!(top_extracted.get("findings").is_some());

        // Output item type=refusal (not nested under content[]) — not documented.
        let item_refusal = r#"{
            "output": [{
                "type": "refusal",
                "refusal": "Policy blocked this request."
            }, {
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let item_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            item_refusal,
        );
        assert_eq!(
            item_probe.state,
            CapabilityState::Ready,
            "output-item type=refusal must not classify as Refusal"
        );
        let item_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, item_refusal)
                .expect("output-item refusal must not block extraction of structured output");
        assert!(item_extracted.get("findings").is_some());

        // Untyped content part with a refusal string — not documented.
        let untyped_part = r#"{
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "refusal": "I cannot assist with that request.",
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let untyped_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            untyped_part,
        );
        assert_eq!(
            untyped_probe.state,
            CapabilityState::Ready,
            "untyped part refusal field must not classify as Refusal"
        );
        let untyped_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, untyped_part)
                .expect("untyped part refusal must not block extraction of structured output");
        assert!(untyped_extracted.get("findings").is_some());

        // type=refusal with only text (no refusal field) — text is not the documented signal.
        // Pair with a sibling output_text so structured extraction remains valid.
        let text_fallback = r#"{
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "refusal",
                    "text": "I cannot assist with that request."
                }, {
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let text_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            text_fallback,
        );
        assert_eq!(
            text_probe.state,
            CapabilityState::Ready,
            "type=refusal with only text must not classify as Refusal"
        );
        let text_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, text_fallback)
                .expect(
                    "text-fallback refusal shape must not block extraction of structured output",
                );
        assert!(text_extracted.get("findings").is_some());

        // Message-level item.refusal string (not under content[]) with structured output.
        let item_field = r#"{
            "output": [{
                "type": "message",
                "role": "assistant",
                "refusal": "I cannot assist with that request.",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let item_field_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            item_field,
        );
        assert_eq!(
            item_field_probe.state,
            CapabilityState::Ready,
            "output-item refusal field must not classify as Refusal"
        );
        extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, item_field)
            .expect("output-item refusal field must not block extraction");

        // Pure undocumented shapes without extractable content must not be Refusal either
        // (they may fail schema, but must not be ProviderFailureKind::Refusal).
        let bare_item = r#"{
            "output": [{
                "type": "refusal",
                "refusal": "Policy blocked this request."
            }]
        }"#;
        let bare_err =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, bare_item)
                .expect_err("bare output-item refusal without structured content may fail schema");
        assert_ne!(
            bare_err.kind,
            ProviderFailureKind::Refusal,
            "bare output-item refusal must not become ProviderFailureKind::Refusal"
        );
    }

    #[test]
    fn ordinary_audit_text_containing_word_refusal_is_not_provider_refusal() {
        // Application payload mentions "refusal" in ordinary audit prose — not an envelope signal.
        let chat_body = r#"{
            "choices": [{
                "message": {
                    "content": "{\"findings\":[{\"detail\":\"user refusal of terms noted\"}],\"summary\":\"no provider refusal\"}",
                    "refusal": null
                }
            }]
        }"#;
        let chat_probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, chat_body);
        assert_eq!(
            chat_probe.state,
            CapabilityState::Ready,
            "content text containing 'refusal' must not trigger refusal detection"
        );
        let chat_extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, chat_body)
                .expect("audit text with word refusal must still extract");
        assert!(chat_extracted.get("findings").is_some());

        let responses_body = r#"{
            "output_parsed": {
                "findings": [{"detail": "document discusses refusal clauses"}],
                "notes": "refusal language in source text"
            }
        }"#;
        let responses_probe = classify_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            200,
            responses_body,
        );
        assert_eq!(responses_probe.state, CapabilityState::Ready);
        let responses_extracted = extract_structured_json(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            responses_body,
        )
        .expect("Responses payload text mentioning refusal must extract");
        assert!(responses_extracted.get("findings").is_some());
    }

    #[test]
    fn anthropic_stop_reason_refusal_is_classified_as_refusal() {
        // Documented Anthropic Messages refusal signal: top-level stop_reason == "refusal".
        let body = r#"{
            "stop_reason": "refusal",
            "content": [{
                "type": "text",
                "text": "{\"findings\":[]}"
            }]
        }"#;
        let probe = classify_probe_response(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            200,
            body,
        );
        assert_eq!(
            probe.state,
            CapabilityState::Unsupported,
            "stop_reason=refusal probe must be Unsupported"
        );
        let err = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            body,
        )
        .expect_err("stop_reason=refusal must fail formal extraction");
        assert_eq!(err.kind, ProviderFailureKind::Refusal);
    }

    #[test]
    fn anthropic_end_turn_with_structured_json_is_ready_and_extractable() {
        let body = r#"{
            "stop_reason": "end_turn",
            "content": [{
                "type": "text",
                "text": "{\"findings\":[]}"
            }]
        }"#;
        let probe = classify_probe_response(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            200,
            body,
        );
        assert_eq!(
            probe.state,
            CapabilityState::Ready,
            "stop_reason=end_turn with structured JSON must probe Ready"
        );
        let extracted = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            body,
        )
        .expect("stop_reason=end_turn structured JSON must extract");
        assert!(extracted.get("findings").is_some());
    }

    #[test]
    fn anthropic_content_word_refusal_and_undocumented_fields_are_not_refusal() {
        // Ordinary content text mentioning "refusal" is not an envelope refusal.
        let content_word = r#"{
            "stop_reason": "end_turn",
            "content": [{
                "type": "text",
                "text": "{\"findings\":[{\"detail\":\"user refusal of terms noted\"}],\"summary\":\"no provider refusal\"}"
            }]
        }"#;
        let content_probe = classify_probe_response(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            200,
            content_word,
        );
        assert_eq!(
            content_probe.state,
            CapabilityState::Ready,
            "content text containing 'refusal' must not trigger Anthropic refusal"
        );
        let content_extracted = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            content_word,
        )
        .expect("audit text with word refusal must still extract");
        assert!(content_extracted.get("findings").is_some());

        // Undocumented OpenAI-style top-level/content refusal strings must be ignored
        // when stop_reason is not exactly "refusal".
        let undocumented = r#"{
            "stop_reason": "end_turn",
            "refusal": "I cannot assist with that request.",
            "content": [{
                "type": "text",
                "text": "{\"findings\":[]}",
                "refusal": "I cannot assist with that request."
            }]
        }"#;
        let undoc_probe = classify_probe_response(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            200,
            undocumented,
        );
        assert_eq!(
            undoc_probe.state,
            CapabilityState::Ready,
            "undocumented Anthropic refusal-like fields must not classify as Refusal"
        );
        let undoc_extracted = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            undocumented,
        )
        .expect("undocumented refusal-like fields must not block extraction");
        assert!(undoc_extracted.get("findings").is_some());

        // Undocumented content type=refusal is not an Anthropic envelope refusal.
        let type_refusal = r#"{
            "stop_reason": "end_turn",
            "content": [{
                "type": "refusal",
                "refusal": "I cannot assist with that request."
            }]
        }"#;
        let type_err = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            type_refusal,
        )
        .expect_err("type=refusal without extractable structured object may fail schema");
        assert_ne!(
            type_err.kind,
            ProviderFailureKind::Refusal,
            "undocumented content type=refusal must not become ProviderFailureKind::Refusal"
        );

        // Null / empty / non-string stop_reason is not a refusal.
        for body in [
            r#"{"stop_reason":null,"content":[{"type":"text","text":"{\"findings\":[]}"}]}"#,
            r#"{"stop_reason":"","content":[{"type":"text","text":"{\"findings\":[]}"}]}"#,
            r#"{"content":[{"type":"text","text":"{\"findings\":[]}"}]}"#,
        ] {
            let probe = classify_probe_response(
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                200,
                body,
            );
            assert_eq!(
                probe.state,
                CapabilityState::Ready,
                "null/empty/missing stop_reason must not be Refusal: {body}"
            );
            extract_structured_json(
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                body,
            )
            .expect("null/empty/missing stop_reason must not block extraction");
        }
    }

    #[test]
    fn formal_responses_extraction_accepts_output_text_json_object() {
        // Real Responses wire: output_text carrying a JSON object string.
        let output_text = r#"{
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let accepted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, output_text)
                .expect("Responses output_text JSON object must pass");
        assert!(accepted.get("findings").is_some());

        let top_level_text = r#"{"output_text":"{\"findings\":[]}"}"#;
        let accepted_top_text = extract_structured_json(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            top_level_text,
        )
        .expect("top-level output_text JSON object must pass");
        assert!(accepted_top_text.get("findings").is_some());

        // Typed json part with object text is accepted; free text remains rejected.
        let typed_text_object = r#"{
            "output": [{
                "type": "message",
                "content": [{
                    "type": "json",
                    "text": "{\"findings\":[]}"
                }]
            }]
        }"#;
        let accepted_typed = extract_structured_json(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            typed_text_object,
        )
        .expect("Responses type=json object text must pass");
        assert!(accepted_typed.get("findings").is_some());

        let free_text = r#"{
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "not a json object"
                }]
            }]
        }"#;
        let rejected =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, free_text);
        assert!(
            rejected.is_err(),
            "Responses unvalidated free text must be rejected"
        );
        assert_eq!(rejected.unwrap_err().kind, ProviderFailureKind::Schema);

        let strict = r#"{
            "output": [{
                "type": "message",
                "content": [{
                    "type": "json",
                    "parsed": {"findings": []}
                }]
            }]
        }"#;
        let accepted_parsed =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, strict)
                .expect("Responses native parsed object must pass");
        assert!(accepted_parsed.get("findings").is_some());

        let output_parsed = r#"{"output_parsed":{"findings":[]}}"#;
        let accepted_top =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, output_parsed)
                .expect("output_parsed object must pass");
        assert!(accepted_top.get("findings").is_some());
    }

    #[test]
    fn formal_anthropic_extraction_rejects_unvalidated_free_text() {
        // Anthropic plain free-text content blocks without object payload stay rejected.
        let free_text = r#"{
            "content": [{
                "type": "text",
                "text": "not-json findings"
            }]
        }"#;
        let rejected = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            free_text,
        );
        assert!(
            rejected.is_err(),
            "Anthropic unvalidated free text must be rejected"
        );
        assert_eq!(rejected.unwrap_err().kind, ProviderFailureKind::Schema);

        // type=json / text carrying a JSON object string is accepted (wire parity).
        let typed_text = r#"{
            "content": [{
                "type": "json",
                "text": "{\"findings\":[]}"
            }]
        }"#;
        let accepted_typed = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            typed_text,
        )
        .expect("Anthropic type=json object text must pass");
        assert!(accepted_typed.get("findings").is_some());

        let strict = r#"{
            "content": [{
                "type": "json",
                "json": {"findings": []}
            }]
        }"#;
        let accepted = extract_structured_json(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            strict,
        )
        .expect("Anthropic native json object must pass");
        assert!(accepted.get("findings").is_some());
    }

    #[test]
    fn auto_fallback_is_narrow_unsupported_endpoint_only() {
        assert_eq!(
            formal_attempt_modes(ProviderKind::OpenAi, ProviderMode::Auto),
            vec![ProviderMode::Responses, ProviderMode::Chat]
        );
        // Ready Auto→Chat must not reopen Responses for formal work.
        assert_eq!(
            formal_attempt_modes_for_ready_capability(
                ProviderKind::OpenAi,
                ProviderMode::Auto,
                Some(ProviderMode::Chat),
            ),
            vec![ProviderMode::Chat]
        );
        // Explicit Responses stays Responses; Auto without resolved still ladders.
        assert_eq!(
            formal_attempt_modes_for_ready_capability(
                ProviderKind::OpenAi,
                ProviderMode::Responses,
                None,
            ),
            vec![ProviderMode::Responses]
        );
        assert_eq!(
            formal_attempt_modes_for_ready_capability(
                ProviderKind::OpenAi,
                ProviderMode::Auto,
                None,
            ),
            vec![ProviderMode::Responses, ProviderMode::Chat]
        );
        let unsupported_404 = ProviderFailure {
            kind: ProviderFailureKind::Unsupported,
            status: Some(404),
            message: "missing".into(),
        };
        assert!(auto_fallback_allowed(
            ProviderKind::OpenAi,
            ProviderMode::Auto,
            ProviderMode::Responses,
            &unsupported_404
        ));
        for failure in [
            ProviderFailure {
                kind: ProviderFailureKind::Authentication,
                status: Some(401),
                message: "auth".into(),
            },
            ProviderFailure {
                kind: ProviderFailureKind::RateLimited,
                status: Some(429),
                message: "rate".into(),
            },
            ProviderFailure {
                kind: ProviderFailureKind::Schema,
                status: Some(200),
                message: "schema".into(),
            },
            ProviderFailure {
                kind: ProviderFailureKind::Unsupported,
                status: Some(400),
                message: "not endpoint".into(),
            },
            // Redirects are connection failures; Auto must not fall through on 3xx.
            ProviderFailure {
                kind: ProviderFailureKind::Redirect,
                status: Some(302),
                message: "redirect".into(),
            },
        ] {
            assert!(
                !auto_fallback_allowed(
                    ProviderKind::OpenAi,
                    ProviderMode::Auto,
                    ProviderMode::Responses,
                    &failure
                ),
                "must not fallback for {:?}",
                failure.kind
            );
        }
        // Explicit Chat mode never falls through to another mode.
        assert_eq!(
            formal_attempt_modes(ProviderKind::OpenAi, ProviderMode::Chat),
            vec![ProviderMode::Chat]
        );
    }

    #[test]
    fn status_classification_distinguishes_auth_rate_limit_and_unsupported() {
        assert_eq!(
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 401, "{}").state,
            CapabilityState::Failed
        );
        assert_eq!(
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 429, "{}").state,
            CapabilityState::Failed
        );
        assert_eq!(
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 404, "{}").state,
            CapabilityState::Unsupported
        );
    }

    #[test]
    fn http_3xx_is_explicit_redirect_failure_not_malformed() {
        for status in [301u16, 302, 303, 307, 308] {
            let failure = classify_http_failure(
                status,
                "Location: https://evil.example/steal?token=sk-secret\n",
            );
            assert_eq!(
                failure.kind,
                ProviderFailureKind::Redirect,
                "HTTP {status} must be Redirect"
            );
            assert_eq!(failure.status, Some(status));
            assert!(
                !failure.message.contains("evil"),
                "redirect error must not expose Location URL"
            );
            assert!(
                !failure.message.contains("sk-secret"),
                "redirect error must not expose secrets"
            );
            assert!(
                failure.message.contains("redirect"),
                "redirect error should name the failure kind"
            );
        }
        // 3xx is a connection failure for probes, not "unsupported mode".
        let probe = classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 302, "{}");
        assert_eq!(probe.state, CapabilityState::Failed);
        assert_eq!(
            classify_http_failure(400, "{}").kind,
            ProviderFailureKind::Malformed
        );
    }

    #[test]
    fn classify_http_failure_never_echoes_response_body_canaries() {
        // Canaries: API key, Authorization header material, and absolute URL.
        let canary = concat!(
            r#"{"error":"invalid_api_key","message":"sk-canary-secret-key","#,
            r#""hint":"Authorization: Bearer sk-canary-secret-key","#,
            r#""url":"https://evil.example/callback?token=sk-canary"}"#
        );
        for status in [301u16, 302, 400, 401, 403, 404, 408, 429, 500, 502, 504] {
            let failure = classify_http_failure(status, canary);
            assert_eq!(failure.status, Some(status));
            assert!(
                !failure.message.contains("sk-canary"),
                "HTTP {status} must not echo API key canary: {}",
                failure.message
            );
            assert!(
                !failure.message.contains("evil.example"),
                "HTTP {status} must not echo URL canary: {}",
                failure.message
            );
            assert!(
                !failure.message.contains("Bearer"),
                "HTTP {status} must not echo Authorization canary: {}",
                failure.message
            );
            assert!(
                !failure.message.contains(canary),
                "HTTP {status} must not echo full body"
            );
            // Status remains available for debug/classification.
            assert!(
                failure.message.contains(&status.to_string()),
                "HTTP {status} message should retain status"
            );
        }
    }

    #[test]
    fn custom_auth_header_is_revalidated_at_send_time() {
        assert!(
            resolve_custom_auth_header_name(None).is_err(),
            "missing custom header name must fail"
        );
        assert!(
            resolve_custom_auth_header_name(Some("")).is_err(),
            "empty custom header name must fail"
        );
        assert!(
            resolve_custom_auth_header_name(Some("Authorization")).is_err(),
            "managed Authorization header must be rejected at send time"
        );
        assert!(
            resolve_custom_auth_header_name(Some("Cookie")).is_err(),
            "managed Cookie header must be rejected at send time"
        );
        assert!(
            resolve_custom_auth_header_name(Some("Host")).is_err(),
            "transport Host header must be rejected at send time"
        );
        assert!(
            resolve_custom_auth_header_name(Some("X-Trace\nId")).is_err(),
            "control characters must be rejected at send time"
        );
        assert!(
            resolve_custom_auth_header_name(Some("X-Api-Key-Extra")).is_err(),
            "x-api-key* managed prefix must be rejected at send time"
        );
        assert_eq!(
            resolve_custom_auth_header_name(Some("  X-Request-Id  ")).unwrap(),
            "X-Request-Id"
        );
    }

    #[test]
    fn capability_identity_changes_when_secret_or_model_changes() {
        let first = CapabilityIdentity::from_connection(
            ProviderKind::OpenAi,
            "https://a/",
            "m",
            ProviderMode::Chat,
            AuthMode::Bearer,
            None,
            Some("one"),
        );
        let second = CapabilityIdentity::from_connection(
            ProviderKind::OpenAi,
            "https://a/",
            "m",
            ProviderMode::Chat,
            AuthMode::Bearer,
            None,
            Some("two"),
        );
        assert_ne!(first.digest, second.digest);
    }

    #[test]
    fn models_list_requests_use_get_and_no_body() {
        let openai = build_models_list_request(
            ProviderKind::OpenAi,
            "https://example.test/v1/",
            AuthMode::Bearer,
        )
        .unwrap();
        assert_eq!(openai.method, "GET");
        assert_eq!(openai.url, "https://example.test/v1/models");
        assert!(openai.body.is_null());
        assert_eq!(openai.managed_auth_header.as_deref(), Some("authorization"));

        let anthropic = build_models_list_request(
            ProviderKind::Anthropic,
            "https://api.anthropic.com/v1",
            AuthMode::AnthropicApiKey,
        )
        .unwrap();
        assert_eq!(anthropic.method, "GET");
        assert_eq!(anthropic.url, "https://api.anthropic.com/v1/models");
        assert_eq!(anthropic.managed_auth_header.as_deref(), Some("x-api-key"));
    }

    #[test]
    fn models_list_parsing_extracts_ids_and_never_echoes_body_on_error() {
        let openai = parse_models_list_response(
            ProviderKind::OpenAi,
            200,
            r#"{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"},{"id":"gpt-4o"}]}"#,
        )
        .unwrap();
        assert_eq!(
            openai,
            vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
        );

        let anthropic = parse_models_list_response(
            ProviderKind::Anthropic,
            200,
            r#"{"data":[{"id":"claude-3-5-sonnet"},{"id":"claude-3-haiku"}]}"#,
        )
        .unwrap();
        assert_eq!(
            anthropic,
            vec![
                "claude-3-5-sonnet".to_string(),
                "claude-3-haiku".to_string()
            ]
        );

        let canary = r#"{"error":"sk-canary-secret","url":"https://evil.example/x"}"#;
        let failure = parse_models_list_response(ProviderKind::OpenAi, 401, canary).unwrap_err();
        assert_eq!(failure.kind, ProviderFailureKind::Authentication);
        assert!(!failure.message.contains("sk-canary"));
        assert!(!failure.message.contains("evil.example"));
    }

    #[test]
    fn models_list_malformed_or_error_payload_is_classified_without_body() {
        let malformed =
            parse_models_list_response(ProviderKind::OpenAi, 200, "not-json").unwrap_err();
        assert_eq!(malformed.kind, ProviderFailureKind::Malformed);
        assert!(!malformed.message.contains("not-json"));

        let provider_error = parse_models_list_response(
            ProviderKind::OpenAi,
            200,
            r#"{"error":{"message":"sk-canary"}}"#,
        )
        .unwrap_err();
        assert_eq!(provider_error.kind, ProviderFailureKind::Schema);
        assert!(!provider_error.message.contains("sk-canary"));
    }

    #[test]
    fn probe_validation_requires_exact_ok_true_object() {
        assert!(validate_minimal_probe_object(&json!({"ok": true})));
        assert!(!validate_minimal_probe_object(&json!({"ok": false})));
        assert!(!validate_minimal_probe_object(
            &json!({"ok": true, "extra": 1})
        ));
        assert!(!validate_minimal_probe_object(&json!({"status": "ok"})));

        let ready = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"parsed":{"ok":true}}}]}"#,
        );
        assert_eq!(ready.state, CapabilityState::Ready);

        let content_ready = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true}"}}]}"#,
        );
        assert_eq!(content_ready.state, CapabilityState::Ready);

        let wrong_object = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"parsed":{"ok":false}}}]}"#,
        );
        assert_eq!(wrong_object.state, CapabilityState::Unsupported);

        // Content JSON that is not the exact probe shape stays Unsupported.
        let wrong_content_shape = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true,\"extra\":1}"}}]}"#,
        );
        assert_eq!(wrong_content_shape.state, CapabilityState::Unsupported);

        let free_text = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"ok"}}]}"#,
        );
        assert_eq!(free_text.state, CapabilityState::Unsupported);
    }

    #[test]
    fn capability_state_default_is_unknown_without_weakening_serde() {
        assert_eq!(CapabilityState::default(), CapabilityState::Unknown);
        let encoded = serde_json::to_string(&CapabilityState::Ready).unwrap();
        assert_eq!(encoded, "\"ready\"");
        let decoded: CapabilityState = serde_json::from_str("\"unsupported\"").unwrap();
        assert_eq!(decoded, CapabilityState::Unsupported);
        // PublicCapabilityStatus::default depends on CapabilityState::Default.
        let status = crate::ai::credentials::PublicCapabilityStatus::default();
        assert_eq!(status.state, CapabilityState::Unknown);
        assert!(!status.identity_matches);
    }

    #[test]
    fn minimal_probe_schema_is_strict_object() {
        let schema = minimal_probe_schema();
        assert_eq!(schema.get("type").and_then(Value::as_str), Some("object"));
        assert_eq!(
            schema.get("additionalProperties").and_then(Value::as_bool),
            Some(false)
        );
        assert!(schema
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|required| required.iter().any(|item| item.as_str() == Some("ok"))));
    }
}
