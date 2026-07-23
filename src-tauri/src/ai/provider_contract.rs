//! Offline provider/mock contract surface for BYOK AI Preflight V2.
//!
//! These helpers and tests never call live or paid providers. They validate the
//! strict Models / Responses / Chat / Anthropic Messages request shapes, refusal
//! envelope rules, malformed/schema classification, usage extraction, timeout and
//! redirect errors, and Vision request assembly against localhost mock fixtures
//! or pure in-memory bodies. No credentials or binary image fixtures are stored.
//!
//! Run focused: `cargo test --manifest-path src-tauri/Cargo.toml provider_contract`

use super::credentials::AuthMode;
use super::provider::{
    build_models_list_request, build_probe_request, build_structured_request,
    build_structured_request_with_vision, classify_http_failure, classify_probe_response,
    extract_structured_json, parse_models_list_response, CapabilityState, ProviderFailureKind,
    ProviderKind, ProviderMode, ProviderRequest, ProviderUsage, VisionRequestImage,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Deterministic fixture IDs used by the offline mock matrix (never secrets).
pub const FIXTURE_MODEL_OPENAI: &str = "mock-gpt-contract";
pub const FIXTURE_MODEL_ANTHROPIC: &str = "mock-claude-contract";
/// Canary secret used only inside mock HTTP bodies to prove redaction of errors.
pub const CANARY_SECRET: &str = "sk-canary-offline-secret-never-log";

/// One offline mock scenario covering a provider wire shape or failure mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockScenario {
    ModelsListOpenAi,
    ModelsListAnthropic,
    ResponsesStrictOk,
    ChatStrictOk,
    AnthropicMessagesStrictOk,
    ChatRefusal,
    ResponsesRefusal,
    AnthropicRefusal,
    MalformedJson,
    SchemaIncompatible,
    UsageNormalized,
    TimeoutHttp,
    AuthFailure,
    Redirect,
    VisionResponses,
    VisionChat,
    VisionAnthropic,
}

/// Build the strict structured request body for a formal scenario without network I/O.
pub fn build_contract_request(
    scenario: MockScenario,
    endpoint: &str,
) -> Result<(ProviderKind, ProviderMode, ProviderRequest), String> {
    let schema = json!({
        "type": "object",
        "properties": {
            "findings": { "type": "array" }
        },
        "required": ["findings"],
        "additionalProperties": false
    });
    match scenario {
        MockScenario::ModelsListOpenAi => {
            let request =
                build_models_list_request(ProviderKind::OpenAi, endpoint, AuthMode::Bearer)?;
            Ok((ProviderKind::OpenAi, ProviderMode::Chat, request))
        }
        MockScenario::ModelsListAnthropic => {
            let request = build_models_list_request(
                ProviderKind::Anthropic,
                endpoint,
                AuthMode::AnthropicApiKey,
            )?;
            Ok((
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                request,
            ))
        }
        MockScenario::ResponsesStrictOk
        | MockScenario::ResponsesRefusal
        | MockScenario::UsageNormalized
        | MockScenario::MalformedJson
        | MockScenario::SchemaIncompatible
        | MockScenario::TimeoutHttp
        | MockScenario::AuthFailure
        | MockScenario::Redirect => {
            let request = build_structured_request(
                ProviderKind::OpenAi,
                ProviderMode::Responses,
                endpoint,
                FIXTURE_MODEL_OPENAI,
                &schema,
                AuthMode::Bearer,
                "okpgui_audit",
                "contract-audit-prompt",
                256,
            )?;
            Ok((ProviderKind::OpenAi, ProviderMode::Responses, request))
        }
        MockScenario::ChatStrictOk | MockScenario::ChatRefusal => {
            let request = build_structured_request(
                ProviderKind::OpenAi,
                ProviderMode::Chat,
                endpoint,
                FIXTURE_MODEL_OPENAI,
                &schema,
                AuthMode::Bearer,
                "okpgui_audit",
                "contract-audit-prompt",
                256,
            )?;
            Ok((ProviderKind::OpenAi, ProviderMode::Chat, request))
        }
        MockScenario::AnthropicMessagesStrictOk | MockScenario::AnthropicRefusal => {
            let request = build_structured_request(
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                endpoint,
                FIXTURE_MODEL_ANTHROPIC,
                &schema,
                AuthMode::AnthropicApiKey,
                "okpgui_audit",
                "contract-audit-prompt",
                256,
            )?;
            Ok((
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                request,
            ))
        }
        MockScenario::VisionResponses => {
            let images = [VisionRequestImage {
                mime_type: "image/jpeg".into(),
                bytes: b"mock-jpeg".to_vec(),
            }];
            let request = build_structured_request_with_vision(
                ProviderKind::OpenAi,
                ProviderMode::Responses,
                endpoint,
                FIXTURE_MODEL_OPENAI,
                &schema,
                AuthMode::Bearer,
                "okpgui_audit",
                "vision-audit-prompt",
                256,
                &images,
            )?;
            Ok((ProviderKind::OpenAi, ProviderMode::Responses, request))
        }
        MockScenario::VisionChat => {
            let images = [VisionRequestImage {
                mime_type: "image/png".into(),
                bytes: b"mock-png".to_vec(),
            }];
            let request = build_structured_request_with_vision(
                ProviderKind::OpenAi,
                ProviderMode::Chat,
                endpoint,
                FIXTURE_MODEL_OPENAI,
                &schema,
                AuthMode::Bearer,
                "okpgui_audit",
                "vision-audit-prompt",
                256,
                &images,
            )?;
            Ok((ProviderKind::OpenAi, ProviderMode::Chat, request))
        }
        MockScenario::VisionAnthropic => {
            let images = [VisionRequestImage {
                mime_type: "image/webp".into(),
                bytes: b"mock-webp".to_vec(),
            }];
            let request = build_structured_request_with_vision(
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                endpoint,
                FIXTURE_MODEL_ANTHROPIC,
                &schema,
                AuthMode::AnthropicApiKey,
                "okpgui_audit",
                "vision-audit-prompt",
                256,
                &images,
            )?;
            Ok((
                ProviderKind::Anthropic,
                ProviderMode::AnthropicMessages,
                request,
            ))
        }
    }
}

/// Fixture HTTP body for a scenario (never contains real credentials beyond canaries).
pub fn fixture_body(scenario: MockScenario) -> &'static str {
    match scenario {
        MockScenario::ModelsListOpenAi => {
            r#"{"data":[{"id":"mock-gpt-contract"},{"id":"mock-gpt-mini"}]}"#
        }
        MockScenario::ModelsListAnthropic => {
            r#"{"data":[{"id":"mock-claude-contract"},{"id":"mock-claude-haiku"}]}"#
        }
        MockScenario::ResponsesStrictOk => {
            r#"{
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "{\"findings\":[]}"
                    }]
                }],
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 7,
                    "cached_tokens": 2,
                    "reasoning_tokens": 1
                }
            }"#
        }
        MockScenario::ChatStrictOk => {
            r#"{
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "{\"findings\":[]}",
                        "refusal": null
                    }
                }],
                "usage": {
                    "prompt_tokens": 9,
                    "completion_tokens": 4
                }
            }"#
        }
        MockScenario::AnthropicMessagesStrictOk => {
            r#"{
                "stop_reason": "end_turn",
                "content": [{
                    "type": "text",
                    "text": "{\"findings\":[]}"
                }],
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 3
                }
            }"#
        }
        MockScenario::ChatRefusal => {
            r#"{
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "refusal": "I cannot assist with that request."
                    }
                }]
            }"#
        }
        MockScenario::ResponsesRefusal => {
            r#"{
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "refusal",
                        "refusal": "I cannot assist with that request."
                    }]
                }]
            }"#
        }
        MockScenario::AnthropicRefusal => {
            r#"{
                "stop_reason": "refusal",
                "content": [{
                    "type": "text",
                    "text": "{\"findings\":[]}"
                }]
            }"#
        }
        MockScenario::MalformedJson => "not-json{",
        MockScenario::SchemaIncompatible => {
            r#"{
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "plain free text not a json object"
                    }
                }]
            }"#
        }
        MockScenario::UsageNormalized => {
            r#"{
                "output_parsed": { "findings": [] },
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "prompt_tokens_details": { "cached_tokens": 8 },
                    "completion_tokens_details": { "reasoning_tokens": 3 }
                }
            }"#
        }
        MockScenario::TimeoutHttp => {
            r#"{"error":{"message":"sk-canary-offline-secret-never-log","url":"https://evil.example/x"}}"#
        }
        MockScenario::AuthFailure => {
            r#"{"error":{"message":"sk-canary-offline-secret-never-log"}}"#
        }
        MockScenario::Redirect => {
            r#"Location: https://evil.example/steal?token=sk-canary-offline-secret-never-log"#
        }
        MockScenario::VisionResponses => r#"{"output_parsed":{"findings":[]}}"#,
        MockScenario::VisionChat => r#"{"choices":[{"message":{"content":"{\"findings\":[]}"}}]}"#,
        MockScenario::VisionAnthropic => {
            r#"{"stop_reason":"end_turn","content":[{"type":"text","text":"{\"findings\":[]}"}]}"#
        }
    }
}

/// HTTP status for a scenario fixture.
pub fn fixture_status(scenario: MockScenario) -> u16 {
    match scenario {
        MockScenario::TimeoutHttp => 408,
        MockScenario::AuthFailure => 401,
        MockScenario::Redirect => 302,
        _ => 200,
    }
}

/// Assert a request body never embeds secret material or absolute local paths.
pub fn assert_request_body_sanitary(body: &Value) {
    let serialized = body.to_string();
    assert!(
        !serialized.contains(CANARY_SECRET),
        "request body must not contain canary secret"
    );
    assert!(
        !serialized.contains("/Users/") && !serialized.contains("C:\\\\Users"),
        "request body must not embed absolute user paths"
    );
}

/// Spawn a one-shot localhost HTTP mock that replies with the fixture for `scenario`.
/// Returns the base URL (`http://127.0.0.1:port`) and a join handle.
pub fn spawn_oneshot_mock(scenario: MockScenario) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind localhost mock");
    let addr = listener.local_addr().expect("local addr");
    let status = fixture_status(scenario);
    let body = fixture_body(scenario);
    let (ready_tx, ready_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        ready_tx.send(()).ok();
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            let reason = match status {
                200 => "OK",
                302 => "Found",
                401 => "Unauthorized",
                408 => "Request Timeout",
                _ => "Error",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("mock server ready");
    (format!("http://{addr}"), handle)
}

/// Classify a fixture body with the production parsers (no network).
pub fn classify_fixture(
    scenario: MockScenario,
) -> (
    CapabilityState,
    Option<ProviderFailureKind>,
    Option<ProviderUsage>,
) {
    match scenario {
        MockScenario::ModelsListOpenAi | MockScenario::ModelsListAnthropic => {
            // Models list is not a capability probe; report Ready only when parse succeeds.
            let provider = if matches!(scenario, MockScenario::ModelsListOpenAi) {
                ProviderKind::OpenAi
            } else {
                ProviderKind::Anthropic
            };
            match parse_models_list_response(provider, 200, fixture_body(scenario)) {
                Ok(_) => (CapabilityState::Ready, None, None),
                Err(failure) => (CapabilityState::Failed, Some(failure.kind), None),
            }
        }
        MockScenario::TimeoutHttp | MockScenario::AuthFailure | MockScenario::Redirect => {
            let failure = classify_http_failure(fixture_status(scenario), fixture_body(scenario));
            let probe = classify_probe_response(
                ProviderKind::OpenAi,
                ProviderMode::Chat,
                fixture_status(scenario),
                fixture_body(scenario),
            );
            (probe.state, Some(failure.kind), probe.usage)
        }
        MockScenario::ChatStrictOk
        | MockScenario::ChatRefusal
        | MockScenario::SchemaIncompatible => {
            let mode = ProviderMode::Chat;
            let probe = classify_probe_response(
                ProviderKind::OpenAi,
                mode,
                fixture_status(scenario),
                fixture_body(scenario),
            );
            let failure =
                extract_structured_json(ProviderKind::OpenAi, mode, fixture_body(scenario))
                    .err()
                    .map(|f| f.kind);
            (probe.state, failure, probe.usage)
        }
        MockScenario::ResponsesStrictOk
        | MockScenario::ResponsesRefusal
        | MockScenario::UsageNormalized
        | MockScenario::MalformedJson
        | MockScenario::VisionResponses => {
            let mode = ProviderMode::Responses;
            let probe = classify_probe_response(
                ProviderKind::OpenAi,
                mode,
                fixture_status(scenario),
                fixture_body(scenario),
            );
            let failure =
                extract_structured_json(ProviderKind::OpenAi, mode, fixture_body(scenario))
                    .err()
                    .map(|f| f.kind);
            (probe.state, failure, probe.usage)
        }
        MockScenario::AnthropicMessagesStrictOk
        | MockScenario::AnthropicRefusal
        | MockScenario::VisionAnthropic => {
            let mode = ProviderMode::AnthropicMessages;
            let probe = classify_probe_response(
                ProviderKind::Anthropic,
                mode,
                fixture_status(scenario),
                fixture_body(scenario),
            );
            let failure =
                extract_structured_json(ProviderKind::Anthropic, mode, fixture_body(scenario))
                    .err()
                    .map(|f| f.kind);
            (probe.state, failure, probe.usage)
        }
        MockScenario::VisionChat => {
            let mode = ProviderMode::Chat;
            let probe = classify_probe_response(
                ProviderKind::OpenAi,
                mode,
                200,
                r#"{"choices":[{"message":{"content":"{\"findings\":[]}"}}]}"#,
            );
            (probe.state, None, probe.usage)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{
        build_no_redirect_client, classify_and_validate_probe_response, encode_base64,
        formal_attempt_modes, minimal_probe_schema, send_managed_provider_request,
    };

    #[test]
    fn contract_matrix_covers_required_scenarios() {
        let scenarios = [
            MockScenario::ModelsListOpenAi,
            MockScenario::ModelsListAnthropic,
            MockScenario::ResponsesStrictOk,
            MockScenario::ChatStrictOk,
            MockScenario::AnthropicMessagesStrictOk,
            MockScenario::ChatRefusal,
            MockScenario::ResponsesRefusal,
            MockScenario::AnthropicRefusal,
            MockScenario::MalformedJson,
            MockScenario::SchemaIncompatible,
            MockScenario::UsageNormalized,
            MockScenario::TimeoutHttp,
            MockScenario::AuthFailure,
            MockScenario::Redirect,
            MockScenario::VisionResponses,
            MockScenario::VisionChat,
            MockScenario::VisionAnthropic,
        ];
        for scenario in scenarios {
            let (state, failure, usage) = classify_fixture(scenario);
            match scenario {
                MockScenario::ModelsListOpenAi
                | MockScenario::ModelsListAnthropic
                | MockScenario::ResponsesStrictOk
                | MockScenario::ChatStrictOk
                | MockScenario::AnthropicMessagesStrictOk
                | MockScenario::UsageNormalized
                | MockScenario::VisionResponses
                | MockScenario::VisionChat
                | MockScenario::VisionAnthropic => {
                    assert_eq!(
                        state,
                        CapabilityState::Ready,
                        "{scenario:?} must classify Ready"
                    );
                    assert!(
                        failure.is_none(),
                        "{scenario:?} must extract without failure"
                    );
                }
                MockScenario::ChatRefusal
                | MockScenario::ResponsesRefusal
                | MockScenario::AnthropicRefusal => {
                    assert_eq!(state, CapabilityState::Unsupported);
                    assert_eq!(failure, Some(ProviderFailureKind::Refusal));
                }
                MockScenario::MalformedJson => {
                    assert_eq!(state, CapabilityState::Unsupported);
                    assert_eq!(failure, Some(ProviderFailureKind::Malformed));
                }
                MockScenario::SchemaIncompatible => {
                    assert_eq!(state, CapabilityState::Unsupported);
                    assert_eq!(failure, Some(ProviderFailureKind::Schema));
                }
                MockScenario::TimeoutHttp => {
                    assert_eq!(state, CapabilityState::Failed);
                    assert_eq!(failure, Some(ProviderFailureKind::Timeout));
                }
                MockScenario::AuthFailure => {
                    assert_eq!(state, CapabilityState::Failed);
                    assert_eq!(failure, Some(ProviderFailureKind::Authentication));
                }
                MockScenario::Redirect => {
                    assert_eq!(state, CapabilityState::Failed);
                    assert_eq!(failure, Some(ProviderFailureKind::Redirect));
                }
            }
            if matches!(
                scenario,
                MockScenario::ResponsesStrictOk
                    | MockScenario::ChatStrictOk
                    | MockScenario::AnthropicMessagesStrictOk
                    | MockScenario::UsageNormalized
            ) {
                assert!(usage.is_some(), "{scenario:?} must surface usage");
            }
            // Canaries in error fixtures must never appear in classified messages.
            let probe = classify_probe_response(
                ProviderKind::OpenAi,
                ProviderMode::Chat,
                fixture_status(scenario),
                fixture_body(scenario),
            );
            assert!(
                !probe.message.contains(CANARY_SECRET),
                "classified message must not echo canary for {scenario:?}"
            );
            assert!(
                !probe.message.contains("evil.example"),
                "classified message must not echo URL canary for {scenario:?}"
            );
        }
    }

    #[test]
    fn request_shapes_match_strict_provider_contracts() {
        let endpoint = "https://example.test/v1";
        let schema = minimal_probe_schema();

        let responses = build_probe_request(
            ProviderKind::OpenAi,
            ProviderMode::Responses,
            endpoint,
            FIXTURE_MODEL_OPENAI,
            &schema,
            AuthMode::Bearer,
        )
        .unwrap();
        assert_eq!(responses.method, "POST");
        assert!(responses.url.ends_with("/responses"));
        assert!(responses.body.pointer("/text/format/type").is_some());
        assert_eq!(
            responses
                .body
                .pointer("/text/format/type")
                .and_then(Value::as_str),
            Some("json_schema")
        );
        assert_request_body_sanitary(&responses.body);

        let chat = build_probe_request(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            endpoint,
            FIXTURE_MODEL_OPENAI,
            &schema,
            AuthMode::Bearer,
        )
        .unwrap();
        assert!(chat.url.ends_with("/chat/completions"));
        assert_eq!(
            chat.body
                .pointer("/response_format/type")
                .and_then(Value::as_str),
            Some("json_schema")
        );
        assert_request_body_sanitary(&chat.body);

        let anthropic = build_probe_request(
            ProviderKind::Anthropic,
            ProviderMode::AnthropicMessages,
            endpoint,
            FIXTURE_MODEL_ANTHROPIC,
            &schema,
            AuthMode::AnthropicApiKey,
        )
        .unwrap();
        assert!(anthropic.url.ends_with("/messages"));
        assert_eq!(
            anthropic
                .body
                .pointer("/output_config/format/type")
                .and_then(Value::as_str),
            Some("json_schema")
        );
        assert_request_body_sanitary(&anthropic.body);

        let models =
            build_models_list_request(ProviderKind::OpenAi, endpoint, AuthMode::Bearer).unwrap();
        assert_eq!(models.method, "GET");
        assert!(models.body.is_null());
    }

    #[test]
    fn vision_request_shapes_are_provider_specific_without_persisting_bytes() {
        for scenario in [
            MockScenario::VisionResponses,
            MockScenario::VisionChat,
            MockScenario::VisionAnthropic,
        ] {
            let (_provider, mode, request) =
                build_contract_request(scenario, "https://example.test/v1").unwrap();
            let body = request.body.to_string();
            // Ephemeral base64 may exist in the request body, but not as a canary secret.
            assert!(!body.contains(CANARY_SECRET));
            match mode {
                ProviderMode::Responses => {
                    assert!(body.contains("input_image") || body.contains("input_text"));
                }
                ProviderMode::Chat => {
                    assert!(body.contains("image_url") || body.contains("\"type\":\"text\""));
                }
                ProviderMode::AnthropicMessages => {
                    assert!(body.contains("\"type\":\"image\"") || body.contains("base64"));
                }
                ProviderMode::Auto => panic!("vision contract must resolve a concrete mode"),
            }
        }
        // encode_base64 is for ephemeral request assembly only.
        assert_eq!(encode_base64(b"mock"), "bW9jaw==");
    }

    #[test]
    fn usage_normalization_accepts_openai_and_chat_aliases() {
        let (state, failure, usage) = classify_fixture(MockScenario::UsageNormalized);
        assert_eq!(state, CapabilityState::Ready);
        assert!(failure.is_none());
        let usage = usage.expect("usage");
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cached_tokens, Some(8));
        assert_eq!(usage.reasoning_tokens, Some(3));

        let chat = classify_fixture(MockScenario::ChatStrictOk).2.unwrap();
        assert_eq!(chat.input_tokens, Some(9));
        assert_eq!(chat.output_tokens, Some(4));
    }

    #[test]
    fn auto_mode_attempt_list_is_narrow() {
        assert_eq!(
            formal_attempt_modes(ProviderKind::OpenAi, ProviderMode::Auto),
            vec![ProviderMode::Responses, ProviderMode::Chat]
        );
        assert_eq!(
            formal_attempt_modes(ProviderKind::Anthropic, ProviderMode::Auto),
            vec![ProviderMode::AnthropicMessages]
        );
    }

    #[test]
    fn probe_validation_rejects_wrong_shape_even_when_provider_claims_ok() {
        let wrong = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true,\"extra\":1}"}}]}"#,
        );
        assert_eq!(wrong.state, CapabilityState::Unsupported);
        let ready = classify_and_validate_probe_response(
            ProviderKind::OpenAi,
            ProviderMode::Chat,
            200,
            r#"{"choices":[{"message":{"content":"{\"ok\":true}"}}]}"#,
        );
        assert_eq!(ready.state, CapabilityState::Ready);
    }

    #[test]
    fn ordinary_audit_text_with_word_refusal_is_not_envelope_refusal() {
        let body = r#"{
            "choices": [{
                "message": {
                    "content": "{\"findings\":[{\"detail\":\"user refusal of terms noted\"}]}",
                    "refusal": null
                }
            }]
        }"#;
        let extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Chat, body).unwrap();
        assert!(extracted.get("findings").is_some());
        let probe = classify_probe_response(ProviderKind::OpenAi, ProviderMode::Chat, 200, body);
        assert_eq!(probe.state, CapabilityState::Ready);
    }

    #[tokio::test]
    async fn localhost_mock_models_list_never_leaves_loopback() {
        let (base, handle) = spawn_oneshot_mock(MockScenario::ModelsListOpenAi);
        let client = build_no_redirect_client().unwrap();
        let request =
            build_models_list_request(ProviderKind::OpenAi, &base, AuthMode::Bearer).unwrap();
        let (status, body) = send_managed_provider_request(
            &client,
            &request,
            AuthMode::Bearer,
            None,
            Some("offline-test-token"),
            ProviderKind::OpenAi,
        )
        .await
        .expect("localhost models list");
        handle.join().ok();
        assert_eq!(status, 200);
        let models = parse_models_list_response(ProviderKind::OpenAi, status, &body).unwrap();
        assert!(models.iter().any(|id| id == FIXTURE_MODEL_OPENAI));
        assert!(!body.contains(CANARY_SECRET));
    }

    #[tokio::test]
    async fn localhost_mock_responses_strict_extracts_findings() {
        let (base, handle) = spawn_oneshot_mock(MockScenario::ResponsesStrictOk);
        let client = build_no_redirect_client().unwrap();
        let (_provider, _mode, request) =
            build_contract_request(MockScenario::ResponsesStrictOk, &base).unwrap();
        let (status, body) = send_managed_provider_request(
            &client,
            &request,
            AuthMode::Bearer,
            None,
            Some("offline-test-token"),
            ProviderKind::OpenAi,
        )
        .await
        .expect("localhost responses");
        handle.join().ok();
        assert_eq!(status, 200);
        let extracted =
            extract_structured_json(ProviderKind::OpenAi, ProviderMode::Responses, &body).unwrap();
        assert!(extracted.get("findings").is_some());
        let probe =
            classify_probe_response(ProviderKind::OpenAi, ProviderMode::Responses, status, &body);
        assert_eq!(probe.state, CapabilityState::Ready);
        assert!(!probe.message.contains("offline-test-token"));
    }

    #[tokio::test]
    async fn localhost_mock_auth_failure_never_echoes_canary() {
        let (base, handle) = spawn_oneshot_mock(MockScenario::AuthFailure);
        let client = build_no_redirect_client().unwrap();
        let request =
            build_models_list_request(ProviderKind::OpenAi, &base, AuthMode::Bearer).unwrap();
        let (status, body) = send_managed_provider_request(
            &client,
            &request,
            AuthMode::Bearer,
            None,
            Some("offline-test-token"),
            ProviderKind::OpenAi,
        )
        .await
        .expect("localhost auth failure");
        handle.join().ok();
        assert_eq!(status, 401);
        let failure = parse_models_list_response(ProviderKind::OpenAi, status, &body).unwrap_err();
        assert_eq!(failure.kind, ProviderFailureKind::Authentication);
        assert!(!failure.message.contains(CANARY_SECRET));
        assert!(!failure.message.contains("offline-test-token"));
    }

    #[tokio::test]
    async fn localhost_mock_redirect_is_classified_without_following() {
        let (base, handle) = spawn_oneshot_mock(MockScenario::Redirect);
        let client = build_no_redirect_client().unwrap();
        let request =
            build_models_list_request(ProviderKind::OpenAi, &base, AuthMode::Bearer).unwrap();
        let (status, body) = send_managed_provider_request(
            &client,
            &request,
            AuthMode::Bearer,
            None,
            Some("offline-test-token"),
            ProviderKind::OpenAi,
        )
        .await
        .expect("localhost redirect");
        handle.join().ok();
        assert_eq!(status, 302);
        let failure = classify_http_failure(status, &body);
        assert_eq!(failure.kind, ProviderFailureKind::Redirect);
        assert!(!failure.message.contains("evil.example"));
        assert!(!failure.message.contains(CANARY_SECRET));
    }
}
