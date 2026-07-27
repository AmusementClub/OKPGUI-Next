use crate::ai::audit::{
    build_formal_audit_prompt, compute_decision, formal_audit_schema, formal_audit_system_prompt,
    redact_provider_error, sanitize_audit_input, try_parse_formal_audit_findings,
    validate_findings_against_projection, AuditDecision, AuditInput, Finding, FindingSeverity,
    ValidatedAudit,
};
use crate::ai::context::{
    context_error_to_public, project_context_from_binding, project_context_from_binding_with_media,
    ContextError, ContextProjection, DEFAULT_CONTEXT_CEILING,
};
use crate::ai::credentials::{
    apply_credential_journal_recovery, apply_public_credential_session_flag,
    apply_public_identity_matches, capability_identity, capability_identity_matches,
    cleanup_previous_secret_after_success, clear_credential_journal, credential_journal_path,
    credential_write_plan_needs_journal, decide_session_only_cold_start, load_credential_journal,
    may_read_credential_store_for_settings, plan_credential_secret_write,
    reconcile_existing_credential_journal_before_new, rollback_candidate_or_retain_journal,
    rollback_credential_candidate, validate_custom_header_name, write_credential_journal, AuthMode,
    CredentialJournalPhase, CredentialJournalSettingsMetadata, CredentialMutationGate,
    CredentialRef, CredentialRotationJournal, OsCredentialStore, PublicCapabilityStatus,
    PublicConnectionConfig, SecretStore, SecretValue, SessionOnlyColdStartAction,
    CREDENTIAL_JOURNAL_TTL_SECS,
};
use crate::ai::jobs::{
    formal_audit_may_bind_terminal_evidence, media_info_may_bind_plan_evidence,
    media_info_may_report_success, recognition_may_return_result, ActiveAiJobSummary, AiJob,
    AiJobManager, AiJobState, DebugExportMetadata, DebugRecord, JobKind, DEBUG_EXPORT_RELATIVE_DIR,
    DEBUG_STORE_RELATIVE_DIR,
};
use crate::ai::media::{
    build_plan_media_evidence, clamp_media_probe_timeout_ms, discover_media_files,
    probe_media_files_with_progress, resolve_all_torrent_media_entries_with_root,
    resolve_media_relative_entries, resolve_packaged_mediainfo, MediaCandidate, MediaProbeRequest,
    MediaProbeResult, MediaProbeState, MediaRelativeEntry, MAX_MEDIA_RELATIVE_ENTRIES,
};
use crate::ai::provider::{
    auto_fallback_allowed, build_models_list_request, build_no_redirect_client,
    build_probe_request, build_probe_request_for_capability,
    build_structured_request_with_system_and_reasoning, classify_and_validate_probe_response,
    classify_and_validate_probe_response_for_capability, classify_http_failure,
    extract_provider_json, formal_attempt_modes, formal_attempt_modes_for_ready_capability,
    minimal_probe_schema, parse_models_list_response, probe_output_capabilities,
    send_managed_provider_request, CapabilityIdentity, CapabilityProbeResult, CapabilityState,
    OutputCapability, ProviderFailure, ProviderKind, ProviderMode, ReasoningMode,
};
use crate::ai::recognition::{
    bind_recognition_result, build_recognition_context_snapshot, build_recognition_prompt,
    recognition_from_provider_outcome, recognition_schema, redact_recognition_output,
    RecognitionContextSnapshot, RecognitionResult, RECOGNITION_SCHEMA_VERSION,
    RECOGNITION_SYSTEM_PROMPT,
};
use crate::ai::redaction::RedactionPolicy;
use crate::ai::template_seed::{
    build_eligible_catalog, build_template_selection_prompt, catalog_snapshot_hash,
    parse_template_selection, template_selection_schema, ReviewTemplateRecommendationResult,
    TemplateRecommendation, TemplateRecommendationRegistry, TemplateSeed, TemplateSeedRegistry,
    TEMPLATE_SELECTION_SYSTEM_PROMPT,
};
use crate::domain::publish_plan::{
    get_or_create_registry, plan_token_digest, CancelPreflightSessionResult, PlanAuditEvidence,
    PlanRegistry, PreflightTokenState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(test)]
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

const FORMAL_PROVIDER_MAX_TOKENS: u32 = 4096;
const FORMAL_PROVIDER_ATTEMPTS: usize = 2;

fn validation_retry_prompt(original: &str) -> String {
    format!(
        "{original}\n\n上一次返回未通过 JSON 解析或结构校验。请重新生成完整的单一 JSON object，严格遵循既定 schema；不要输出 Markdown 代码围栏、解释文字或额外字段。"
    )
}

fn retryable_structured_failure(failure: &ProviderFailure) -> bool {
    matches!(
        failure.kind,
        crate::ai::provider::ProviderFailureKind::Schema
            | crate::ai::provider::ProviderFailureKind::Malformed
    )
}

fn formal_retry_remaining(request_attempt: usize) -> bool {
    request_attempt + 1 < FORMAL_PROVIDER_ATTEMPTS
}

struct FormalValidationError {
    message: String,
    code: &'static str,
    retryable: bool,
}

enum FormalProviderCallResult<T> {
    Success(T),
    Cancelled,
    Failed {
        failure: ProviderFailure,
        formal_ran: bool,
        error_code: &'static str,
    },
}

#[allow(clippy::too_many_arguments)]
async fn run_formal_provider_call<T, V, C>(
    client: &reqwest::Client,
    connection: &PublicConnectionConfig,
    secret: Option<&SecretValue>,
    schema: &Value,
    schema_name: &str,
    system_prompt: &str,
    prompt: &str,
    output_capability: OutputCapability,
    reasoning_mode: ReasoningMode,
    is_cancelled: C,
    mut validate: V,
) -> FormalProviderCallResult<T>
where
    V: FnMut(&Value) -> Result<T, FormalValidationError>,
    C: Fn() -> bool,
{
    let attempt_modes = formal_modes_for_connection(connection);
    'modes: for attempted_mode in attempt_modes {
        for request_attempt in 0..FORMAL_PROVIDER_ATTEMPTS {
            if is_cancelled() {
                return FormalProviderCallResult::Cancelled;
            }
            let retry_prompt;
            let request_prompt = if request_attempt == 0 {
                prompt
            } else {
                retry_prompt = validation_retry_prompt(prompt);
                retry_prompt.as_str()
            };
            let provider_request = match build_structured_request_with_system_and_reasoning(
                connection.provider,
                attempted_mode,
                &connection.endpoint,
                &connection.model,
                schema,
                connection.auth_mode,
                schema_name,
                system_prompt,
                request_prompt,
                output_capability,
                FORMAL_PROVIDER_MAX_TOKENS,
                reasoning_mode,
            ) {
                Ok(request) => request,
                Err(message) => {
                    return FormalProviderCallResult::Failed {
                        failure: ProviderFailure {
                            kind: crate::ai::provider::ProviderFailureKind::Unsupported,
                            status: None,
                            message,
                        },
                        formal_ran: false,
                        error_code: "PROVIDER_HTTP",
                    };
                }
            };

            let send_result = send_managed_provider_request(
                client,
                &provider_request,
                connection.auth_mode,
                connection.custom_header_name.as_deref(),
                secret.map(SecretValue::expose),
                connection.provider,
            )
            .await;
            let (status, body) = match send_result {
                Ok(response) => response,
                Err(message) => {
                    return FormalProviderCallResult::Failed {
                        failure: ProviderFailure {
                            kind: crate::ai::provider::ProviderFailureKind::Server,
                            status: None,
                            message,
                        },
                        formal_ran: true,
                        error_code: "PROVIDER_HTTP",
                    };
                }
            };
            if !(200..300).contains(&status) {
                let failure = classify_http_failure(status, &body);
                if auto_fallback_allowed(
                    connection.provider,
                    connection.mode,
                    attempted_mode,
                    &failure,
                ) {
                    continue 'modes;
                }
                return FormalProviderCallResult::Failed {
                    failure,
                    formal_ran: true,
                    error_code: "PROVIDER_HTTP",
                };
            }

            let structured = match extract_provider_json(
                connection.provider,
                attempted_mode,
                &body,
                output_capability,
            ) {
                Ok(value) => value,
                Err(failure)
                    if formal_retry_remaining(request_attempt)
                        && retryable_structured_failure(&failure) =>
                {
                    continue;
                }
                Err(failure) => {
                    return FormalProviderCallResult::Failed {
                        failure,
                        formal_ran: true,
                        error_code: "PROVIDER_HTTP",
                    };
                }
            };

            match validate(&structured) {
                Ok(value) => return FormalProviderCallResult::Success(value),
                Err(error) if error.retryable && formal_retry_remaining(request_attempt) => {}
                Err(error) => {
                    return FormalProviderCallResult::Failed {
                        failure: ProviderFailure {
                            kind: crate::ai::provider::ProviderFailureKind::Schema,
                            status: None,
                            message: error.message,
                        },
                        formal_ran: true,
                        error_code: error.code,
                    };
                }
            }
        }
    }

    FormalProviderCallResult::Failed {
        failure: ProviderFailure {
            kind: crate::ai::provider::ProviderFailureKind::Malformed,
            status: None,
            message: "provider formal request did not complete".to_string(),
        },
        formal_ran: false,
        error_code: "PROVIDER_HTTP",
    }
}

fn jobs() -> &'static Mutex<AiJobManager> {
    static JOBS: OnceLock<Mutex<AiJobManager>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(AiJobManager::default()))
}

/// Initialize the optional backend-owned durable AI debug store from
/// `{app_local_data_dir}/ai/debug`. Safe during setup with AI disabled; no network
/// and no job-lifecycle side effects beyond loading/pruning non-secret records.
pub fn init_ai_debug_store(app: &AppHandle) {
    let Ok(local_dir) = app.path().app_local_data_dir() else {
        // Optional store: missing path resolution leaves process-memory behavior.
        return;
    };
    let store_dir = local_dir.join(DEBUG_STORE_RELATIVE_DIR);
    let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
    manager.init_debug_store(store_dir);
}

#[cfg(test)]
fn command_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Process-global cancel flags keyed by job id.
type JobCancelFlagMap = HashMap<String, Arc<AtomicBool>>;
/// Process-global MediaInfo results keyed by job id.
type MediaInfoResultMap = HashMap<String, MediaInfoJobView>;
/// Process-global template-selection results keyed by job id.
type TemplateSelectionResultMap = HashMap<String, TemplateSelectionJobView>;
/// Process-global recognition results keyed by job id.
type RecognitionResultMap = HashMap<String, RecognitionJobView>;
/// Process-global recognition context snapshots keyed by job id (backend-owned identity).
type RecognitionSnapshotMap = HashMap<String, RecognitionContextSnapshot>;

/// Cooperative cancel flags for in-flight MediaInfo child probes (job_id → flag).
fn media_cancel_flags() -> &'static Mutex<JobCancelFlagMap> {
    static FLAGS: OnceLock<Mutex<JobCancelFlagMap>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight MediaInfo results keyed by job id (relative labels only; no absolute paths).
fn media_job_results() -> &'static Mutex<MediaInfoResultMap> {
    static RESULTS: OnceLock<Mutex<MediaInfoResultMap>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bound process-global MediaInfo result/cancel maps (active jobs are never pruned).
const MEDIA_STATE_MAX_RECORDS: usize = 200;

/// Hard cap on deferred MediaInfo probe work retained for `Queued` jobs.
///
/// When this bound is reached, a new Queued start is rejected and the job is
/// cancelled so no Queued AiJob can remain without corresponding pending work.
/// Active (Running) probe work is not counted here — only deferred map entries.
const MAX_PENDING_MEDIA_INFO_WORK: usize = 64;

/// Deferred MediaInfo probe work for jobs still `Queued` under AiJobManager concurrency.
struct PendingMediaInfoWork {
    job_id: String,
    /// Opaque plan token captured at start; bind uses backend plan identity only.
    plan_token: String,
    request_generation: u64,
    snapshot_hash: String,
    probe_requests: Vec<MediaProbeRequest>,
    pre_results: Vec<MediaProbeResult>,
    sidecar: PathBuf,
    timeout: Duration,
    cancel_flag: Arc<AtomicBool>,
}

fn media_pending_work() -> &'static Mutex<HashMap<String, PendingMediaInfoWork>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingMediaInfoWork>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn credential_store() -> &'static OsCredentialStore {
    static STORE: OnceLock<OsCredentialStore> = OnceLock::new();
    STORE.get_or_init(|| OsCredentialStore::new("com.okpgui.okpgui-next.ai"))
}

/// Serializes credential save / rotation / clear across concurrent settings mutations.
fn credential_mutation_gate() -> &'static CredentialMutationGate {
    static GATE: OnceLock<CredentialMutationGate> = OnceLock::new();
    GATE.get_or_init(CredentialMutationGate::new)
}

/// App-local path for the non-secret credential rotation journal.
fn ai_credential_journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| {
        format!("failed to resolve app data dir for credential journal: {error}")
    })?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!("failed to create app data dir for credential journal: {error}")
    })?;
    Ok(credential_journal_path(&data_dir))
}

fn journal_settings_metadata(
    connection: &PublicConnectionConfig,
) -> CredentialJournalSettingsMetadata {
    CredentialJournalSettingsMetadata {
        provider: match connection.provider {
            ProviderKind::OpenAi => "openai".to_string(),
            ProviderKind::Anthropic => "anthropic".to_string(),
        },
        endpoint: connection.endpoint.clone(),
        model: connection.model.clone(),
        auth_mode: match connection.auth_mode {
            AuthMode::Bearer => "bearer".to_string(),
            AuthMode::AnthropicApiKey => "anthropic_api_key".to_string(),
            AuthMode::CustomHeader => "custom_header".to_string(),
            AuthMode::None => "none".to_string(),
        },
        enabled: connection.enabled,
        mode: match connection.mode {
            ProviderMode::Auto => "auto".to_string(),
            ProviderMode::Responses => "responses".to_string(),
            ProviderMode::Chat => "chat".to_string(),
            ProviderMode::AnthropicMessages => "anthropic_messages".to_string(),
        },
    }
}

/// Startup hook: reconcile any in-flight credential rotation journal before normal AI use,
/// then clear stale session-only credential pointers that cannot survive process restart.
///
/// Idempotent and fail closed. Never exposes secrets over IPC. Host-only gap: Linux
/// session-only secrets do not survive process restart, so recovery can only clean
/// durable OS keyring entries + the journal file after a cold start on that path, and
/// must clear the non-secret config pointer (never claim restore, never write plaintext).
pub fn init_ai_credential_journal_recovery(app: AppHandle) {
    if let Err(error) = recover_ai_credential_journal(&app) {
        // Best-effort startup reconciliation; do not abort app launch.
        eprintln!("ai credential journal recovery: {error}");
    }
    if let Err(error) = recover_session_only_credentials_on_cold_start(&app) {
        eprintln!("ai session-only credential recovery: {error}");
    }
}

fn recover_ai_credential_journal(app: &AppHandle) -> Result<(), String> {
    let _mutation_guard = credential_mutation_gate().lock()?;
    let path = ai_credential_journal_path(app)?;
    let Some(journal) = load_credential_journal(&path)? else {
        return Ok(());
    };
    let config = crate::config::load_config(app);
    let active_ref = config
        .ai
        .credential_ref
        .as_ref()
        .and_then(|reference| reference.key_ref.clone());
    let _ = apply_credential_journal_recovery(
        credential_store(),
        &path,
        &journal,
        active_ref.as_deref(),
        now_unix(),
    )?;
    Ok(())
}

/// Cold-start: if the last credential generation was session-only and the secret is
/// gone from process memory, clear the stale non-secret pointer/journal and mark
/// the connection unconfigured. Never restores secrets and never writes plaintext.
fn recover_session_only_credentials_on_cold_start(app: &AppHandle) -> Result<(), String> {
    let _mutation_guard = credential_mutation_gate().lock()?;
    let config = crate::config::load_config(app);
    let active_ref = config
        .ai
        .credential_ref
        .as_ref()
        .and_then(|reference| reference.key_ref.clone());
    let secret_present = match active_ref.as_deref() {
        Some(id) => credential_store()
            .get(&CredentialRef { id: id.to_string() })?
            .is_some(),
        None => false,
    };
    let action = decide_session_only_cold_start(
        config.ai.credential_session_only,
        active_ref.as_deref(),
        secret_present,
    );
    if action != SessionOnlyColdStartAction::ClearStalePointer {
        return Ok(());
    }

    // Clear journal first (non-secret), then reconcile config pointer.
    if let Ok(path) = ai_credential_journal_path(app) {
        let _ = clear_credential_journal(&path);
    }

    let mut ai = config.ai;
    // Drop the non-secret pointer; require re-entry. Never invent a secret.
    ai.credential_ref = None;
    ai.credential_session_only = false;
    // Capability identity depended on the lost secret — invalidate without claiming restore.
    ai.capability = None;
    crate::config::save_ai_config(app.clone(), ai)?;
    Ok(())
}

fn template_seeds() -> &'static Mutex<TemplateSeedRegistry> {
    static SEEDS: OnceLock<Mutex<TemplateSeedRegistry>> = OnceLock::new();
    SEEDS.get_or_init(|| Mutex::new(TemplateSeedRegistry::default()))
}

/// Backend-owned validated recommendations (seed mint only on explicit Review).
fn template_recommendations() -> &'static Mutex<TemplateRecommendationRegistry> {
    static RECS: OnceLock<Mutex<TemplateRecommendationRegistry>> = OnceLock::new();
    RECS.get_or_init(|| Mutex::new(TemplateRecommendationRegistry::default()))
}

/// Cooperative cancel flags for in-flight TemplateSelection provider work (job_id → flag).
fn template_cancel_flags() -> &'static Mutex<JobCancelFlagMap> {
    static FLAGS: OnceLock<Mutex<JobCancelFlagMap>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight TemplateSelection views keyed by job id (seed only when Succeeded).
fn template_job_results() -> &'static Mutex<TemplateSelectionResultMap> {
    static RESULTS: OnceLock<Mutex<TemplateSelectionResultMap>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bound process-global TemplateSelection result/cancel maps (active jobs are never pruned).
const TEMPLATE_STATE_MAX_RECORDS: usize = 200;

/// Whether a TemplateSelection job may surface a validated recommendation (not a seed).
///
/// Only `Succeeded` qualifies. `Cancelled` / `Stale` / `Failed` (and non-terminal states)
/// must never return a recommendation, mint a handoff seed, or resurrect after late completion.
fn template_selection_may_return_recommendation(state: AiJobState) -> bool {
    matches!(state, AiJobState::Succeeded)
}

/// Cooperative cancel flags for in-flight Recognition provider work (job_id → flag).
fn recognition_cancel_flags() -> &'static Mutex<JobCancelFlagMap> {
    static FLAGS: OnceLock<Mutex<JobCancelFlagMap>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight Recognition views keyed by job id (result only when Succeeded).
fn recognition_job_results() -> &'static Mutex<RecognitionResultMap> {
    static RESULTS: OnceLock<Mutex<RecognitionResultMap>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Backend-owned recognition context snapshots keyed by job id.
fn recognition_snapshots() -> &'static Mutex<RecognitionSnapshotMap> {
    static SNAPSHOTS: OnceLock<Mutex<RecognitionSnapshotMap>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Monotonic backend generation for recognition jobs (never client-supplied).
fn next_recognition_generation() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Bound process-global Recognition result/cancel/snapshot maps (active jobs are never pruned).
const RECOGNITION_STATE_MAX_RECORDS: usize = 200;

#[tauri::command]
pub fn ai_validate_custom_header(name: String) -> Result<String, String> {
    validate_custom_header_name(&name)
}

#[tauri::command]
pub fn ai_get_settings(app: AppHandle) -> PublicConnectionConfig {
    let config = crate::config::load_config(&app);
    let mut connection = public_connection_from_ai_config(&config.ai);
    // Disabled AI is a compatibility path: never touch the credential store even if a
    // stale credential_ref remains. identity_matches stays false.
    let secret = if may_read_credential_store_for_settings(&connection) {
        resolve_stored_secret(&connection).ok().flatten()
    } else {
        None
    };
    apply_public_identity_matches(&mut connection, secret.as_ref());
    // Non-secret session-only indicator (never secret material or raw keyring errors).
    apply_public_credential_session_flag(&mut connection, credential_store());
    connection
}

/// Modes for formal provider work: prefer probe-resolved mode when Ready.
fn formal_modes_for_connection(connection: &PublicConnectionConfig) -> Vec<ProviderMode> {
    let resolved = connection
        .capability
        .as_ref()
        .filter(|capability| capability.state == CapabilityState::Ready)
        .and_then(|capability| capability.resolved_mode);
    formal_attempt_modes_for_ready_capability(connection.provider, connection.mode, resolved)
}

fn public_connection_from_ai_config(ai: &crate::config::AIConfig) -> PublicConnectionConfig {
    let provider = match ai.provider.to_ascii_lowercase().as_str() {
        "anthropic" => ProviderKind::Anthropic,
        _ => ProviderKind::OpenAi,
    };
    let mode = match ai.mode.to_ascii_lowercase().as_str() {
        "responses" => ProviderMode::Responses,
        "chat" => ProviderMode::Chat,
        "anthropic_messages" | "messages" => ProviderMode::AnthropicMessages,
        _ => ProviderMode::Auto,
    };
    let auth_mode = match ai.auth_mode.to_ascii_lowercase().as_str() {
        "anthropic_api_key" | "x_api_key" => AuthMode::AnthropicApiKey,
        "custom_header" => AuthMode::CustomHeader,
        "none" => AuthMode::None,
        _ => AuthMode::Bearer,
    };
    PublicConnectionConfig {
        provider,
        endpoint: ai.endpoint.clone(),
        model: ai.model.clone(),
        mode,
        auth_mode,
        custom_header_name: ai.custom_header_name.clone(),
        credential_ref: ai
            .credential_ref
            .as_ref()
            .and_then(|reference| reference.key_ref.clone())
            .map(|id| CredentialRef { id }),
        enabled: ai.enabled,
        capability: ai.capability.as_ref().map(public_capability_from_config),
        discovered_models: ai.discovered_models.clone(),
        models_fetched_at_unix: ai.models_fetched_at_unix,
        // Runtime-only; projected from the live store in ai_get_settings.
        credential_session_only: false,
    }
}

fn public_capability_from_config(
    capability: &crate::config::AiCapabilityConfig,
) -> PublicCapabilityStatus {
    PublicCapabilityStatus {
        state: parse_capability_state(&capability.state),
        identity_digest: capability.identity_digest.clone(),
        resolved_mode: parse_provider_mode_opt(&capability.resolved_mode),
        output_capability: parse_output_capability_opt(&capability.output_capability),
        message: capability.message.clone(),
        probed_at_unix: capability.probed_at_unix,
        identity_matches: false,
    }
}

fn parse_capability_state(value: &str) -> CapabilityState {
    match value.to_ascii_lowercase().as_str() {
        "probing" => CapabilityState::Probing,
        "ready" => CapabilityState::Ready,
        "unsupported" => CapabilityState::Unsupported,
        "failed" => CapabilityState::Failed,
        _ => CapabilityState::Unknown,
    }
}

fn capability_state_to_config(state: CapabilityState) -> String {
    match state {
        CapabilityState::Unknown => "unknown",
        CapabilityState::Probing => "probing",
        CapabilityState::Ready => "ready",
        CapabilityState::Unsupported => "unsupported",
        CapabilityState::Failed => "failed",
    }
    .to_string()
}

fn parse_output_capability_opt(value: &str) -> Option<OutputCapability> {
    match value.to_ascii_lowercase().as_str() {
        "strict_schema" => Some(OutputCapability::StrictSchema),
        "json_object" => Some(OutputCapability::JsonObject),
        _ => None,
    }
}

fn output_capability_to_config(capability: OutputCapability) -> String {
    match capability {
        OutputCapability::StrictSchema => "strict_schema",
        OutputCapability::JsonObject => "json_object",
    }
    .to_string()
}

fn parse_provider_mode_opt(value: &str) -> Option<ProviderMode> {
    match value.to_ascii_lowercase().as_str() {
        "responses" => Some(ProviderMode::Responses),
        "chat" => Some(ProviderMode::Chat),
        "anthropic_messages" | "messages" => Some(ProviderMode::AnthropicMessages),
        "auto" => Some(ProviderMode::Auto),
        _ => None,
    }
}

fn provider_mode_to_config(mode: ProviderMode) -> String {
    match mode {
        ProviderMode::Auto => "auto",
        ProviderMode::Responses => "responses",
        ProviderMode::Chat => "chat",
        ProviderMode::AnthropicMessages => "anthropic_messages",
    }
    .to_string()
}

fn resolve_stored_secret(
    connection: &PublicConnectionConfig,
) -> Result<Option<SecretValue>, String> {
    if connection.auth_mode == AuthMode::None {
        return Ok(None);
    }
    let Some(reference) = connection.credential_ref.clone() else {
        return Ok(None);
    };
    credential_store().get(&reference)
}

/// Actionable gate failure when formal tasks need a Ready capability identity.
fn capability_gate_error() -> String {
    "structured output capability probe is not Ready for the current connection; open AI settings, refresh models if needed, and run the capability probe".to_string()
}

#[tauri::command]
pub fn ai_save_settings(
    app: AppHandle,
    mut connection: PublicConnectionConfig,
    secret: Option<String>,
) -> Result<PublicConnectionConfig, String> {
    // Serialize save/rotation/clear so candidate create, config pointer switch, and cleanup
    // cannot interleave with concurrent settings mutations.
    let _mutation_guard = credential_mutation_gate().lock()?;

    if connection.auth_mode == AuthMode::CustomHeader {
        let header = connection
            .custom_header_name
            .as_deref()
            .ok_or_else(|| "custom auth mode requires a header name".to_string())?;
        connection.custom_header_name = Some(validate_custom_header_name(header)?);
    }

    let current = crate::config::load_config(&app);
    let old_ref = current
        .ai
        .credential_ref
        .as_ref()
        .and_then(|reference| reference.key_ref.clone());
    // New secrets always write to a unique candidate; never overwrite the active secret in place.
    // AuthMode::None never creates a candidate and schedules old-secret cleanup only after success.
    // Plan rejects candidate == old_ref so rollback cannot delete the live secret.
    let write_plan = plan_credential_secret_write(
        connection.auth_mode,
        old_ref.clone(),
        connection
            .credential_ref
            .as_ref()
            .map(|reference| reference.id.clone()),
        secret.is_some(),
        unique_connection_candidate_id(),
    )?;
    let next_ref = write_plan.next_ref_id.clone();

    // Durable non-secret journal around candidate write → config pointer → old cleanup.
    // Journal failures before the pointer switch abort without destroying the old active secret.
    let needs_journal = credential_write_plan_needs_journal(&write_plan);
    let journal_path = if needs_journal {
        Some(ai_credential_journal_path(&app)?)
    } else {
        None
    };

    // Under the mutation gate: finish or fail any prior journal before writing a new one so a
    // ConfigCommitted cleanup record cannot be overwritten by a later save (fail closed).
    if let Some(path) = journal_path.as_ref() {
        reconcile_existing_credential_journal_before_new(
            credential_store(),
            path,
            old_ref.as_deref(),
            now_unix(),
        )?;
    }

    let mut journal = if let Some(path) = journal_path.as_ref() {
        let prepared = CredentialRotationJournal::prepare(
            &write_plan,
            journal_settings_metadata(&connection),
            now_unix(),
            CREDENTIAL_JOURNAL_TTL_SECS,
        );
        write_credential_journal(path, &prepared)?;
        Some(prepared)
    } else {
        None
    };

    if let (Some(candidate_id), Some(value)) =
        (write_plan.rollback_candidate_id.as_ref(), secret.as_deref())
    {
        if let Err(error) = credential_store().set(
            &CredentialRef {
                id: candidate_id.clone(),
            },
            SecretValue::new(value),
        ) {
            // Candidate never stored; drop journal and keep old active secret.
            if let Some(path) = journal_path.as_ref() {
                let _ = clear_credential_journal(path);
            }
            return Err(error);
        }
        if let (Some(path), Some(current_journal)) = (journal_path.as_ref(), journal.as_mut()) {
            *current_journal = current_journal
                .clone()
                .with_phase(CredentialJournalPhase::CandidateStored);
            if let Err(error) = write_credential_journal(path, current_journal) {
                // Phase advance failed after candidate write: roll back candidate only.
                // Clear journal only after confirmed delete; otherwise retain for recovery.
                if let Err(rollback_error) = rollback_candidate_or_retain_journal(
                    credential_store(),
                    &write_plan,
                    path,
                    current_journal,
                ) {
                    return Err(format!("{error}; {rollback_error}"));
                }
                return Err(error);
            }
        }
    }

    // Non-secret session-only marker for cold-start recovery (never secret material).
    // Evaluated after candidate write so Linux fallback is reflected accurately.
    // Never trust the webview-supplied connection.credential_session_only flag.
    let persisted_session_only = match next_ref.as_ref() {
        Some(id) if connection.auth_mode != AuthMode::None => {
            let reference = CredentialRef { id: id.clone() };
            if credential_store().credential_is_session_only(&reference) {
                true
            } else if matches!(credential_store().get(&reference), Ok(Some(_))) {
                // Durable OS secret present.
                false
            } else {
                // Secret not readable: preserve prior marker so cold-start can still
                // clear a dead session-only generation; durable missing stays false.
                current.ai.credential_session_only
            }
        }
        _ => false,
    };

    let mut ai = crate::config::AIConfig {
        enabled: connection.enabled,
        provider: match connection.provider {
            ProviderKind::OpenAi => "openai".to_string(),
            ProviderKind::Anthropic => "anthropic".to_string(),
        },
        credential_ref: next_ref
            .clone()
            .map(|key_ref| crate::config::CredentialBundleRef {
                provider: match connection.provider {
                    ProviderKind::OpenAi => "openai".to_string(),
                    ProviderKind::Anthropic => "anthropic".to_string(),
                },
                key_ref: Some(key_ref),
            }),
        model: connection.model.clone(),
        endpoint: connection.endpoint.clone(),
        mode: match connection.mode {
            ProviderMode::Auto => "auto",
            ProviderMode::Responses => "responses",
            ProviderMode::Chat => "chat",
            ProviderMode::AnthropicMessages => "anthropic_messages",
        }
        .to_string(),
        auth_mode: match connection.auth_mode {
            AuthMode::Bearer => "bearer",
            AuthMode::AnthropicApiKey => "anthropic_api_key",
            AuthMode::CustomHeader => "custom_header",
            AuthMode::None => "none",
        }
        .to_string(),
        custom_header_name: connection.custom_header_name.clone(),
        // Preserve non-secret metadata unless identity-relevant fields change.
        capability: current.ai.capability.clone(),
        discovered_models: current.ai.discovered_models.clone(),
        models_fetched_at_unix: current.ai.models_fetched_at_unix,
        credential_session_only: persisted_session_only,
    };

    // Secret rotation or identity-field edits immediately invalidate Ready capability.
    // AuthMode::None never writes a secret, so ignore a stray secret payload for invalidation
    // only when a candidate was actually planned (secret_provided still invalidates identity).
    let secret_changed = write_plan.rollback_candidate_id.is_some();
    if secret_changed || crate::config::ai_connection_identity_fields_changed(&current.ai, &ai) {
        ai.capability = None;
    }
    // Provider/endpoint/auth drift also drops cached model lists (manual model still kept).
    if current.ai.provider != ai.provider
        || current.ai.endpoint.trim_end_matches('/') != ai.endpoint.trim_end_matches('/')
        || current.ai.auth_mode != ai.auth_mode
    {
        ai.discovered_models.clear();
        ai.models_fetched_at_unix = None;
    }

    if let Err(error) = crate::config::save_ai_config(app.clone(), ai) {
        // Pre-switch failure: delete only the candidate created by this call; keep old active secret.
        // Clear journal only after confirmed candidate rollback; otherwise retain for recovery.
        if let (Some(path), Some(current_journal)) = (journal_path.as_ref(), journal.as_ref()) {
            if let Err(rollback_error) = rollback_candidate_or_retain_journal(
                credential_store(),
                &write_plan,
                path,
                current_journal,
            ) {
                return Err(format!("{error}; {rollback_error}"));
            }
        } else {
            // No journal path (no rotation journal planned): still attempt candidate rollback.
            let _ = rollback_credential_candidate(credential_store(), &write_plan);
        }
        return Err(error);
    }

    // Pointer switched: mark committed so startup recovery finishes old cleanup if we crash.
    if let (Some(path), Some(current_journal)) = (journal_path.as_ref(), journal.as_mut()) {
        *current_journal = current_journal
            .clone()
            .with_phase(CredentialJournalPhase::ConfigCommitted);
        // Best-effort phase write; config pointer is authoritative if this fails.
        let _ = write_credential_journal(path, current_journal);
    }

    // Successful switch: delete previous active secret (None transition + rotation).
    // On failure keep ConfigCommitted journal so the next startup retries cleanup.
    match cleanup_previous_secret_after_success(credential_store(), &write_plan) {
        Ok(()) => {
            if let Some(path) = journal_path.as_ref() {
                let _ = clear_credential_journal(path);
            }
        }
        Err(_error) => {
            // Leave journal for init_ai_credential_journal_recovery on next launch.
        }
    }

    connection.credential_ref = next_ref.map(|id| CredentialRef { id });
    Ok(ai_get_settings(app))
}

#[tauri::command]
pub fn ai_has_secret(reference: CredentialRef) -> Result<bool, String> {
    Ok(credential_store().get(&reference)?.is_some())
}

#[tauri::command]
pub fn ai_clear_secret(reference: CredentialRef) -> Result<(), String> {
    let _mutation_guard = credential_mutation_gate().lock()?;
    credential_store().delete(&reference)
}

#[tauri::command]
pub fn ai_discover_media(
    app: AppHandle,
    torrent_path: String,
    manual_paths: Vec<String>,
) -> Result<Vec<MediaCandidate>, String> {
    let connection = ai_get_settings(app);
    if !connection.enabled {
        return Err("AI is disabled; media discovery is unavailable".to_string());
    }
    // Discovery returns relative labels + sizes only (no absolute paths).
    discover_media_files(&torrent_path, &manual_paths)
}

/// Start request for a backend-owned MediaInfo job bound to a prepared plan.
///
/// `plan_token` is the only plan identity. Backend resolves snapshot_hash,
/// request_generation, and torrent path from `PlanRegistry` / `LocalExecutionBinding`.
/// Client snapshot_hash, request_generation, torrent_path, relative paths, and
/// content_root are never plan identity (deprecated fields accepted for wire
/// compatibility and ignored for identity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfoStartRequest {
    /// Opaque prepared-plan token. Backend identity + binding are authoritative.
    pub plan_token: String,
    /// Deprecated: ignored for identity. Torrent path comes from plan binding only.
    #[serde(default)]
    pub torrent_path: Option<String>,
    /// Optional torrent-relative video entries under binding-derived roots.
    /// Empty means probe every media file declared by the bound torrent. Never plan identity.
    /// Explicit batches are capped at `MAX_MEDIA_RELATIVE_ENTRIES` (256).
    #[serde(default)]
    pub relative_entries: Vec<MediaRelativeEntry>,
    /// Deprecated: ignored for identity and root expansion. Binding torrent only.
    #[serde(default)]
    pub content_root: Option<String>,
    /// Deprecated: ignored. Plan request_generation is authoritative.
    #[serde(default)]
    pub request_generation: Option<u64>,
    /// Deprecated: ignored. Plan snapshot_hash is authoritative.
    #[serde(default)]
    pub snapshot_hash: Option<String>,
    /// Optional per-file timeout override (ms). Defaults to 30s; clamped to
    /// 100ms..=300_000 (`MAX_MEDIA_PROBE_TIMEOUT_MS`).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Public MediaInfo job view: relative labels/results only, no absolute paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfoJobView {
    pub job_id: String,
    /// Backend-issued plan token echoed for client correlation (not a client authority).
    pub plan_token: String,
    pub state: AiJobState,
    pub request_generation: u64,
    pub snapshot_hash: String,
    pub progress: u8,
    pub error_code: Option<String>,
    /// Per-file outcomes. Successful measured summaries only appear when `state` is Succeeded.
    pub results: Vec<MediaProbeResult>,
}

/// Backend-owned base directory for packaged MediaInfo resolution.
///
/// Prefer Tauri `resource_dir` when available. When that fails (common for
/// draft-release `--no-bundle` flat layouts), fall back to the directory that
/// contains `current_exe` so fixed-layout candidates beside the app binary
/// remain reachable. Never accepts caller/IPC-supplied paths.
fn media_info_packaged_resource_base(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        return Some(dir);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.to_path_buf()))
}

/// Start a backend-owned MediaInfo job (queued/running immediately with job id).
///
/// Requires an opaque `plan_token`. Backend resolves identity through `PlanRegistry`
/// and reuses the plan's private `LocalExecutionBinding` + current snapshot/generation.
/// Client snapshot_hash / request_generation / torrent_path / content_root are never
/// plan identity. MediaInfo remains a local capability: AI must be enabled, but
/// provider Ready is **not** required.
///
/// Disabled AI is a true zero-impact path: no sidecar spawn.
/// Cancellation is cooperative and reaches the child MediaInfo process.
#[tauri::command]
pub fn ai_start_media_info(
    app: AppHandle,
    request: MediaInfoStartRequest,
) -> Result<MediaInfoJobView, String> {
    let plan_token = request.plan_token.trim().to_string();
    if plan_token.is_empty() {
        return Err("prepared plan token is required for media info".to_string());
    }

    let connection = ai_get_settings(app.clone());
    // Disabled AI must not launch MediaInfo (zero behavioral impact).
    // Local MediaInfo does not require provider Ready — only that AI is enabled.
    if !connection.enabled {
        return Err("AI is disabled; MediaInfo is not launched".to_string());
    }

    // Backend plan identity is authoritative — never trust client snapshot/generation/paths.
    let (snapshot_hash, request_generation, binding) = {
        let mut guard = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        guard.resolve_for_media_info(&plan_token)?
    };
    // Private binding path only; never echo absolute paths on the public IPC path.
    let torrent_path = binding.request().torrent_path.clone();
    let content_root = binding.content_root().trim().to_string();
    if torrent_path.trim().is_empty() {
        return Err("prepared plan has no bound torrent path".to_string());
    }

    if request.relative_entries.len() > MAX_MEDIA_RELATIVE_ENTRIES {
        return Err(format!(
            "too many relative media entries (max {MAX_MEDIA_RELATIVE_ENTRIES})"
        ));
    }

    // Resolve only under the prepared binding. Start-request paths remain ignored so
    // they cannot expand probe authority after plan creation.
    let (probe_requests, mut pre_results) = if request.relative_entries.is_empty() {
        let batch = resolve_all_torrent_media_entries_with_root(
            torrent_path.as_str(),
            (!content_root.is_empty()).then_some(content_root.as_str()),
        )?;
        (batch.requests, batch.pre_results)
    } else {
        let batch = resolve_media_relative_entries(
            torrent_path.as_str(),
            &request.relative_entries,
            (!content_root.is_empty()).then_some(content_root.as_str()),
        )?;
        (batch.requests, batch.pre_results)
    };

    let timeout = Duration::from_millis(clamp_media_probe_timeout_ms(request.timeout_ms));

    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::MediaInfo,
            request_generation,
            snapshot_hash.clone(),
            None,
        )
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = media_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        flags.insert(job_id.clone(), Arc::clone(&cancel_flag));
        retain_media_global_state(Some(&mut flags), None);
    }

    // Seed a non-terminal view so poll can report progress before the worker finishes.
    // Snapshot is for the initial view only — never used later to choose spawn vs enqueue
    // (resource/sidecar resolution below is an unlocked window that can race promotion).
    let manager_state = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .get(&job_id)
            .map(|job| job.state)
            .unwrap_or(AiJobState::Running)
    };
    let initial = MediaInfoJobView {
        job_id: job_id.clone(),
        plan_token: plan_token.clone(),
        state: manager_state,
        request_generation,
        snapshot_hash: snapshot_hash.clone(),
        progress: 0,
        error_code: None,
        results: pre_results.clone(),
    };
    {
        let mut store = media_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job_id.clone(), initial.clone());
        retain_media_global_state(None, Some(&mut store));
    }

    // Prefer Tauri resource_dir; when unavailable (e.g. --no-bundle flat archives),
    // still search fixed current_exe / flat-layout candidates via the shared resolver.
    let resource_dir = match media_info_packaged_resource_base(app.path().resource_dir().ok()) {
        Some(dir) => dir,
        None => {
            let view = finish_media_info_job(
                &job_id,
                &plan_token,
                request_generation,
                &snapshot_hash,
                false,
                Some("MISSING_SIDECAR".to_string()),
                "MediaInfo sidecar is unavailable",
                merge_media_results(
                    pre_results,
                    Vec::new(),
                    MediaProbeState::MissingSidecar,
                    "MediaInfo sidecar is unavailable",
                ),
            );
            return Ok(view);
        }
    };
    let sidecar = match resolve_packaged_mediainfo(&resource_dir) {
        Ok(path) => path,
        Err(error) => {
            let view = finish_media_info_job(
                &job_id,
                &plan_token,
                request_generation,
                &snapshot_hash,
                false,
                Some("MISSING_SIDECAR".to_string()),
                error.clone(),
                merge_media_results(
                    pre_results,
                    Vec::new(),
                    MediaProbeState::MissingSidecar,
                    &error,
                ),
            );
            return Ok(view);
        }
    };

    // Nothing to probe: complete immediately with pre-results only (still a terminal job).
    // Empty discovery is a successful "nothing measured" outcome (not a crash).
    if probe_requests.is_empty() {
        let view = finish_media_info_job(
            &job_id,
            &plan_token,
            request_generation,
            &snapshot_hash,
            true,
            None,
            if pre_results.is_empty() {
                "no media files to probe"
            } else {
                "media mapping completed without probe"
            },
            pre_results,
        );
        return Ok(view);
    }

    let work = PendingMediaInfoWork {
        job_id: job_id.clone(),
        plan_token: plan_token.clone(),
        request_generation,
        snapshot_hash: snapshot_hash.clone(),
        probe_requests,
        pre_results: std::mem::take(&mut pre_results),
        sidecar,
        timeout,
        cancel_flag,
    };

    // Do not branch on the stale `manager_state` snapshot taken before the unlocked
    // resource/sidecar window. Always park work, then drain against live manager state
    // after the pending lock is released (Running spawns, Queued waits, terminal discards).
    park_pending_media_info_and_drain(work)?;

    media_job_results()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&job_id)
        .cloned()
        .ok_or_else(|| "media info job failed to register".to_string())
}

/// Register deferred MediaInfo work under the documented finite bound.
///
/// Returns `Err` without inserting when the pending map is full (and `job_id` is new).
/// Callers must cancel/cleanup the job so it cannot remain without pending work.
fn enqueue_pending_media_info_work(work: PendingMediaInfoWork) -> Result<(), String> {
    let job_id = work.job_id.clone();
    let mut pending = media_pending_work()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if pending.len() >= MAX_PENDING_MEDIA_INFO_WORK && !pending.contains_key(&job_id) {
        return Err(format!(
            "MediaInfo pending queue is full (max {MAX_PENDING_MEDIA_INFO_WORK})"
        ));
    }
    pending.insert(job_id, work);
    Ok(())
}

/// Park completed MediaInfo work, then drain against live `AiJobManager` state.
///
/// This is the start-path coordination used after the unlocked resource/sidecar window:
/// never choose spawn vs enqueue from a stale snapshot. After the pending lock is
/// released, `try_start_promoted_media_info_jobs` observes live state so a currently
/// Running job is spawned, a Queued job waits for promotion, and a terminal/cancelled
/// job's pending entry is discarded without resurrection. Does not spawn while holding
/// the jobs or pending locks (drain releases both before `spawn_media_info_worker`).
fn park_pending_media_info_and_drain(work: PendingMediaInfoWork) -> Result<(), String> {
    let job_id = work.job_id.clone();
    if let Err(error) = enqueue_pending_media_info_work(work) {
        // Overflow: cleanup even if the job was promoted to Running concurrently, then
        // drain so any other job promoted by that cancellation is not left without a worker.
        reject_media_info_start_after_queue_full(&job_id);
        return Err(error);
    }
    try_start_promoted_media_info_jobs();
    Ok(())
}

/// Coherent cleanup when a MediaInfo start cannot retain deferred work.
///
/// Cancels the job (Running or Queued), drops cancel flag and result view, and ensures
/// no pending entry remains. Cancel of a Running job may promote another Queued job;
/// drain after locks are released so that promoted work is not left without a worker.
/// Does not strip measured results of unrelated jobs; only touches this `job_id`.
fn reject_media_info_start_after_queue_full(job_id: &str) {
    {
        let mut pending = media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.remove(job_id);
    }
    let _ = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.cancel(job_id)
    };
    clear_media_cancel_flag(job_id);
    if let Ok(mut store) = media_job_results().lock() {
        store.remove(job_id);
    }
    // Cancel may free a concurrency slot and promote another job; drain after release.
    try_start_promoted_media_info_jobs();
}

/// Spawn MediaInfo child probes for a job already promoted to `Running`.
fn spawn_media_info_worker(work: PendingMediaInfoWork) {
    std::thread::spawn(move || {
        let PendingMediaInfoWork {
            job_id: bg_job_id,
            plan_token: bg_plan_token,
            request_generation: bg_generation,
            snapshot_hash: bg_snapshot,
            probe_requests,
            pre_results: bg_pre,
            sidecar,
            timeout,
            cancel_flag,
        } = work;

        // Re-check: do not probe if cancelled/stale while waiting for the thread to start.
        let still_running = {
            let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
            manager
                .get(&bg_job_id)
                .map(|job| job.state == AiJobState::Running)
                .unwrap_or(false)
        };
        if !still_running || cancel_flag.load(Ordering::Relaxed) {
            let cancelled = cancel_flag.load(Ordering::Relaxed)
                || jobs()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(&bg_job_id)
                    .map(|job| job.state == AiJobState::Cancelled)
                    .unwrap_or(true);
            if cancelled {
                let _ = {
                    let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
                    manager.cancel(&bg_job_id)
                };
                let sanitized = sanitize_media_results_for_non_success(bg_pre);
                // Cancel never mutates plan-owned media evidence.
                store_media_info_view(
                    &bg_job_id,
                    &bg_plan_token,
                    bg_generation,
                    &bg_snapshot,
                    AiJobState::Cancelled,
                    Some("CANCELLED".to_string()),
                    sanitized,
                );
            }
            clear_media_cancel_flag(&bg_job_id);
            try_start_promoted_media_info_jobs();
            return;
        }

        // Align stored view with Running before child spawn.
        if let Ok(mut store) = media_job_results().lock() {
            if let Some(view) = store.get_mut(&bg_job_id) {
                if !view.state.is_terminal() {
                    view.state = AiJobState::Running;
                }
            }
        }

        let probed = probe_media_files_with_progress(
            probe_requests,
            &sidecar,
            cancel_flag.as_ref(),
            timeout,
            |completed, all| {
                let progress = if all == 0 {
                    100
                } else {
                    completed
                        .saturating_mul(100)
                        .checked_div(all)
                        .unwrap_or(0)
                        .min(100) as u8
                };
                let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
                let _ = manager.update_progress(&bg_job_id, progress);
                drop(manager);
                if let Ok(mut store) = media_job_results().lock() {
                    if let Some(view) = store.get_mut(&bg_job_id) {
                        if !view.state.is_terminal() {
                            view.progress = progress;
                            view.state = AiJobState::Running;
                        }
                    }
                }
            },
        );

        let cancelled = cancel_flag.load(Ordering::Relaxed)
            || probed
                .iter()
                .any(|item| item.state == MediaProbeState::Cancelled);
        let mut results = bg_pre;
        results.extend(probed);

        if cancelled {
            // Ensure job is Cancelled (idempotent if ai_cancel_job already ran).
            let _ = {
                let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
                manager.cancel(&bg_job_id)
            };
            // Cancellation cannot report a successful media result: strip measured summaries.
            // Cancel never mutates plan-owned media evidence.
            let sanitized = sanitize_media_results_for_non_success(results);
            store_media_info_view(
                &bg_job_id,
                &bg_plan_token,
                bg_generation,
                &bg_snapshot,
                AiJobState::Cancelled,
                Some("CANCELLED".to_string()),
                sanitized,
            );
            clear_media_cancel_flag(&bg_job_id);
            try_start_promoted_media_info_jobs();
            return;
        }

        // Late completion after cancel/stale must not resurrect success (complete is terminal-idempotent).
        // The batch itself completed successfully even when an individual file could not
        // be measured. Preserve every per-file state (including timeout/malformed output)
        // in plan-owned evidence so formal audit sees the complete torrent inventory.
        let measured_count = results
            .iter()
            .filter(|item| item.state == MediaProbeState::Measured)
            .count();
        let failed_count = results.len().saturating_sub(measured_count);
        let summary = if failed_count == 0 {
            format!("MediaInfo probed {} file(s)", measured_count)
        } else {
            format!("MediaInfo completed: {measured_count} measured, {failed_count} unresolved")
        };
        let _ = finish_media_info_job(
            &bg_job_id,
            &bg_plan_token,
            bg_generation,
            &bg_snapshot,
            true,
            None,
            summary,
            results,
        );
        clear_media_cancel_flag(&bg_job_id);
        // finish_media_info_job already promotes and drains pending work.
    });
}

/// After capacity frees, start deferred MediaInfo jobs that were promoted to `Running`.
///
/// No permanent worker loop: only inspects the pending map when a job terminates.
fn try_start_promoted_media_info_jobs() {
    let ready: Vec<PendingMediaInfoWork> = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        let mut pending = media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut ready = Vec::new();
        let ids: Vec<String> = pending.keys().cloned().collect();
        for id in ids {
            let state = manager.get(&id).map(|job| job.state);
            match state {
                Some(AiJobState::Running) => {
                    if let Some(work) = pending.remove(&id) {
                        ready.push(work);
                    }
                }
                Some(state) if state.is_terminal() => {
                    pending.remove(&id);
                }
                // Still Queued, or job disappeared: leave pending until a later promote/cancel.
                _ => {}
            }
        }
        ready
    };
    for work in ready {
        // Keep stored progress/state consistent with the promoted Running job.
        if let Ok(mut store) = media_job_results().lock() {
            if let Some(view) = store.get_mut(&work.job_id) {
                if !view.state.is_terminal() {
                    view.state = AiJobState::Running;
                    view.progress = 0;
                }
            }
        }
        spawn_media_info_worker(work);
    }
}

/// Poll MediaInfo job status. Returns `None` while queued/running; `Some` when terminal.
/// Cancelled/Stale jobs never surface Measured summaries as a successful media result.
/// Progress while running is available via `ai_get_job`.
#[tauri::command]
pub fn ai_poll_media_info(job_id: String) -> Result<Option<MediaInfoJobView>, String> {
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err("job_id is required".to_string());
    }
    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&job_id).cloned()
    };
    let Some(job) = job else {
        return Err("media info job not found".to_string());
    };
    if job.kind != JobKind::MediaInfo {
        return Err("job is not a media info job".to_string());
    }
    if !job.state.is_terminal() {
        return Ok(None);
    }
    Ok(Some(media_info_terminal_view(&job)?))
}

/// Fetch terminal MediaInfo result. Errors if still running or missing.
/// Succeeded is the only state that may include Measured summaries.
#[tauri::command]
pub fn ai_get_media_info_result(job_id: String) -> Result<MediaInfoJobView, String> {
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err("job_id is required".to_string());
    }
    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&job_id).cloned()
    };
    let Some(job) = job else {
        return Err("media info job not found".to_string());
    };
    if job.kind != JobKind::MediaInfo {
        return Err("job is not a media info job".to_string());
    }
    if !job.state.is_terminal() {
        return Err("media info job is still running".to_string());
    }
    media_info_terminal_view(&job)
}

fn media_info_terminal_view(job: &AiJob) -> Result<MediaInfoJobView, String> {
    let stored = media_job_results()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&job.id)
        .cloned();
    let mut view = stored.unwrap_or(MediaInfoJobView {
        job_id: job.id.clone(),
        plan_token: String::new(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone(),
        results: Vec::new(),
    });
    view.state = job.state;
    view.progress = 100;
    view.error_code = job.error_code.clone();
    // Cancellation / stale / failed must not report a successful media result.
    if !media_info_may_report_success(job.state) {
        view.results = sanitize_media_results_for_non_success(view.results);
        if job.state == AiJobState::Cancelled {
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string()));
        } else if job.state == AiJobState::Stale {
            view.error_code = job.error_code.clone().or_else(|| Some("STALE".to_string()));
        }
    }
    // Drop absolute paths if any leaked into messages (defense in depth).
    for item in &mut view.results {
        if let Some(message) = item.message.take() {
            item.message = Some(redact_media_message(&message));
        }
    }
    Ok(view)
}

#[allow(clippy::too_many_arguments)]
fn finish_media_info_job(
    job_id: &str,
    plan_token: &str,
    request_generation: u64,
    snapshot_hash: &str,
    success: bool,
    error_code: Option<String>,
    summary: impl Into<String>,
    results: Vec<MediaProbeResult>,
) -> MediaInfoJobView {
    let summary = summary.into();
    let job =
        complete_job_backend(job_id, success, error_code.clone(), summary).unwrap_or_else(|_| {
            AiJob {
                id: job_id.to_string(),
                kind: JobKind::MediaInfo,
                state: if success {
                    AiJobState::Succeeded
                } else {
                    AiJobState::Failed
                },
                request_generation,
                snapshot_hash: snapshot_hash.to_string(),
                provider_identity: None,
                progress: 100,
                error_code: error_code.clone(),
                debug_record_id: None,
                created_at_unix: now_unix(),
            }
        });

    let mut results = results;
    // Only Succeeded may retain Measured summaries; cancel/stale/failed strip them.
    if !media_info_may_report_success(job.state) {
        results = sanitize_media_results_for_non_success(results);
    }

    // Bind plan-owned redacted media evidence only on Succeeded terminal jobs.
    // Cancel / timeout / nonzero / malformed / oversized / Failed never mutate the plan.
    // Identity mismatch or drift also leave plan media evidence unchanged.
    let bound_snapshot_hash = if media_info_may_bind_plan_evidence(job.state) {
        try_bind_media_evidence_to_plan(
            plan_token,
            job_id,
            &job.snapshot_hash,
            job.request_generation,
            &results,
        )
        .unwrap_or_else(|_| job.snapshot_hash.clone())
    } else {
        job.snapshot_hash.clone()
    };

    let view = store_media_info_view(
        job_id,
        plan_token,
        job.request_generation,
        &bound_snapshot_hash,
        job.state,
        job.error_code.clone(),
        results,
    );
    // Completing frees a concurrency slot; promote deferred MediaInfo work if any.
    try_start_promoted_media_info_jobs();
    view
}

/// Attempt to bind redacted MediaInfo summaries to the matching prepared plan.
///
/// Failures (token mismatch, identity drift, missing binding) return `Err` without
/// mutating plan state. Never trusts client snapshot_hash as identity — the job's
/// backend-assigned identity must match the live plan token.
fn try_bind_media_evidence_to_plan(
    plan_token: &str,
    job_id: &str,
    snapshot_hash: &str,
    request_generation: u64,
    results: &[MediaProbeResult],
) -> Result<String, String> {
    let plan_token = plan_token.trim();
    if plan_token.is_empty() {
        return Err("prepared plan token is required".to_string());
    }
    let evidence = build_plan_media_evidence(
        job_id,
        snapshot_hash,
        request_generation,
        results,
        &RedactionPolicy::default(),
    );
    let mut guard = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.bind_media_evidence(plan_token, evidence)
}

fn store_media_info_view(
    job_id: &str,
    plan_token: &str,
    request_generation: u64,
    snapshot_hash: &str,
    state: AiJobState,
    error_code: Option<String>,
    results: Vec<MediaProbeResult>,
) -> MediaInfoJobView {
    let view = MediaInfoJobView {
        job_id: job_id.to_string(),
        plan_token: plan_token.to_string(),
        state,
        request_generation,
        snapshot_hash: snapshot_hash.to_string(),
        progress: 100,
        error_code,
        results,
    };
    {
        let mut store = media_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job_id.to_string(), view.clone());
        retain_media_global_state(None, Some(&mut store));
    }
    view
}

/// Bound process-global MediaInfo result and cancel-flag maps.
///
/// Active (non-terminal) job entries are never deleted. Only surplus terminal
/// result rows and cancel flags for jobs that are no longer active are pruned.
fn retain_media_global_state(
    flags: Option<&mut JobCancelFlagMap>,
    results: Option<&mut MediaInfoResultMap>,
) {
    let active_ids: std::collections::HashSet<String> = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .list()
            .into_iter()
            .filter(|job| !job.state.is_terminal())
            .map(|job| job.id)
            .collect()
    };

    if let Some(store) = results {
        if store.len() > MEDIA_STATE_MAX_RECORDS {
            let mut terminal: Vec<String> = store
                .iter()
                .filter(|(id, view)| !active_ids.contains(*id) && view.state.is_terminal())
                .map(|(id, _)| id.clone())
                .collect();
            // Deterministic prune order for stable retention under pressure.
            terminal.sort();
            while store.len() > MEDIA_STATE_MAX_RECORDS {
                let Some(id) = terminal.pop() else {
                    break;
                };
                store.remove(&id);
            }
        }
    }

    if let Some(flags) = flags {
        if flags.len() > MEDIA_STATE_MAX_RECORDS {
            let mut inactive: Vec<String> = flags
                .keys()
                .filter(|id| !active_ids.contains(*id))
                .cloned()
                .collect();
            inactive.sort();
            while flags.len() > MEDIA_STATE_MAX_RECORDS {
                let Some(id) = inactive.pop() else {
                    break;
                };
                flags.remove(&id);
            }
        }
    }
}

fn sanitize_media_results_for_non_success(results: Vec<MediaProbeResult>) -> Vec<MediaProbeResult> {
    results
        .into_iter()
        .map(|mut item| {
            if item.state == MediaProbeState::Measured {
                item.state = MediaProbeState::Cancelled;
                item.summary = None;
                item.message =
                    Some("MediaInfo result discarded after cancel or failure".to_string());
            } else if item.summary.is_some() && item.state != MediaProbeState::Measured {
                item.summary = None;
            }
            item
        })
        .collect()
}

fn merge_media_results(
    mut pre: Vec<MediaProbeResult>,
    probed: Vec<MediaProbeResult>,
    fallback_state: MediaProbeState,
    message: &str,
) -> Vec<MediaProbeResult> {
    if pre.is_empty() && probed.is_empty() {
        pre.push(MediaProbeResult {
            relative_name: "[none]".to_string(),
            state: fallback_state,
            summary: None,
            message: Some(message.to_string()),
        });
        return pre;
    }
    pre.extend(probed);
    pre
}

fn clear_media_cancel_flag(job_id: &str) {
    if let Ok(mut flags) = media_cancel_flags().lock() {
        flags.remove(job_id);
    }
}

fn signal_media_cancel(job_id: &str) {
    if let Ok(flags) = media_cancel_flags().lock() {
        if let Some(flag) = flags.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn redact_media_message(message: &str) -> String {
    // Strip absolute-looking segments so diagnostics never echo host paths.
    let mut output = String::with_capacity(message.len());
    for part in message.split_whitespace() {
        let looks_absolute = part.starts_with('/')
            || (part.len() > 2
                && part.as_bytes()[0].is_ascii_alphabetic()
                && part.as_bytes().get(1) == Some(&b':')
                && (part.as_bytes().get(2) == Some(&b'\\')
                    || part.as_bytes().get(2) == Some(&b'/')));
        if looks_absolute {
            output.push_str("[path]");
        } else {
            output.push_str(part);
        }
        output.push(' ');
    }
    output.trim().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSeedPrepareRequest {
    pub template_id: String,
    pub template_revision: u64,
    pub template_digest: String,
    pub torrent_name: String,
    pub torrent_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSelectTemplateRequest {
    /// Absolute path to the torrent file. Never stored in browser handoff.
    pub torrent_path: String,
}

/// Public TemplateSelection job view: progress + redacted errors.
/// Recommendation only on Succeeded — never a pre-minted handoff seed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSelectionJobView {
    pub job_id: String,
    pub state: AiJobState,
    pub request_generation: u64,
    pub snapshot_hash: String,
    pub progress: u8,
    pub error_code: Option<String>,
    /// Redacted human-readable status/error (never secrets, raw paths, or provider bodies).
    pub message: Option<String>,
    /// Backend-owned validated recommendation when `state == Succeeded`.
    /// Explicit Review mints the one-shot handoff seed separately.
    #[serde(default)]
    pub recommendation: Option<TemplateRecommendation>,
    /// Deprecated: always `None` after recommendation handoff. Kept for wire compatibility.
    #[serde(default)]
    pub seed: Option<TemplateSeed>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConsumedTemplateSeed {
    pub template_id: String,
    pub template_revision: u64,
    pub template_digest: String,
    pub torrent_name: String,
    pub torrent_path: String,
}

fn load_eligible_catalog(
    app: &AppHandle,
) -> Vec<crate::ai::template_seed::EligibleTemplateCatalogEntry> {
    let config = crate::config::load_config(app);
    build_eligible_catalog(&config.quick_publish_templates)
}

/// Prepare a seed only when the requested id/revision/digest matches the live catalog
/// and the torrent file identity can be bound. Callers must not invent catalog entries.
#[tauri::command]
pub fn ai_prepare_template_seed(
    app: AppHandle,
    request: TemplateSeedPrepareRequest,
) -> Result<TemplateSeed, String> {
    let catalog = load_eligible_catalog(&app);
    let entry = crate::ai::template_seed::find_catalog_match(
        &catalog,
        &request.template_id,
        request.template_revision,
        &request.template_digest,
    )
    .ok_or_else(|| {
        "template selection does not match the current catalog (id/revision/digest)".to_string()
    })?;

    template_seeds()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .prepare(
            entry.id.clone(),
            entry.revision,
            entry.digest.clone(),
            request.torrent_name,
            request.torrent_path,
        )
}

/// Start a backend-owned TemplateSelection job (queued/running immediately with job id).
///
/// Provider work runs in the background. The client polls via `ai_poll_template_selection`
/// and cancels via `ai_cancel_job`. Never falls back to the first catalog entry.
/// Raw torrent_path stays Rust-owned and is never returned on the job view.
#[tauri::command]
pub async fn ai_start_template_selection(
    app: AppHandle,
    request: AiSelectTemplateRequest,
) -> Result<TemplateSelectionJobView, String> {
    let torrent_path = request.torrent_path.trim().to_string();
    if torrent_path.is_empty() {
        return Err("请先输入种子路径。".to_string());
    }

    let connection = ai_get_settings(app.clone());
    if !connection.enabled {
        return Err("请先在 AI 设置中启用并完成连接和模型配置。".to_string());
    }
    if !connection_is_configured(&connection) {
        return Err("请先在 AI 设置中完成连接和模型配置。".to_string());
    }

    let catalog = load_eligible_catalog(&app);
    if catalog.is_empty() {
        return Err("没有可用于自动选择的发布模板。".to_string());
    }
    let catalog_hash = catalog_snapshot_hash(&catalog);

    // Resolve torrent name without sending the raw path to the provider or browser.
    let torrent_info = crate::torrent::parse_torrent(torrent_path.clone())?;
    let torrent_name = torrent_info.name.clone();

    let secret = if connection.auth_mode == AuthMode::None {
        None
    } else {
        let reference = connection
            .credential_ref
            .clone()
            .ok_or_else(|| "AI credential is not configured".to_string())?;
        Some(
            credential_store()
                .get(&reference)?
                .ok_or_else(|| "AI credential is missing from the secure store".to_string())?,
        )
    };

    // Formal template selection requires an exact Ready capability identity match.
    let identity = require_ready_capability_identity(&connection, secret.as_ref())?;

    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::TemplateSelection,
            0,
            catalog_hash.clone(),
            Some(identity),
        )
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = template_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        flags.insert(job_id.clone(), Arc::clone(&cancel_flag));
        retain_template_global_state(Some(&mut flags), None);
    }

    let manager_state = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .get(&job_id)
            .map(|job| job.state)
            .unwrap_or(AiJobState::Running)
    };
    let initial = TemplateSelectionJobView {
        job_id: job_id.clone(),
        state: manager_state,
        request_generation: 0,
        snapshot_hash: catalog_hash.clone(),
        progress: 0,
        error_code: None,
        message: Some("template selection queued".to_string()),
        recommendation: None,
        seed: None,
    };
    {
        let mut store = template_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job_id.clone(), initial.clone());
        retain_template_global_state(None, Some(&mut store));
    }

    let bg_app = app.clone();
    let bg_job_id = job_id.clone();
    let bg_connection = connection;
    let bg_catalog_hash = catalog_hash;
    let bg_torrent_path = torrent_path;
    let bg_torrent_name = torrent_name;
    let bg_catalog = catalog;
    tauri::async_runtime::spawn(async move {
        run_template_selection_worker(
            bg_app,
            bg_connection,
            secret,
            bg_job_id,
            bg_catalog_hash,
            bg_torrent_path,
            bg_torrent_name,
            bg_catalog,
            cancel_flag,
        )
        .await;
    });

    Ok(initial)
}

/// Poll TemplateSelection job status.
///
/// - Still queued/running → `None` (keep polling; progress via `ai_get_job`).
/// - Terminal → `Some(view)`. Seed is present only when `state == Succeeded`.
/// - Cancelled/Stale/Failed never return a usable seed (fail closed).
#[tauri::command]
pub fn ai_poll_template_selection(
    job_id: String,
) -> Result<Option<TemplateSelectionJobView>, String> {
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err("job_id is required".to_string());
    }
    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&job_id).cloned()
    };
    let Some(job) = job else {
        return Err("template selection job not found".to_string());
    };
    if job.kind != JobKind::TemplateSelection {
        return Err("job is not a template selection job".to_string());
    }
    if !job.state.is_terminal() {
        return Ok(None);
    }
    Ok(Some(template_selection_terminal_view(&job)))
}

fn template_selection_terminal_view(job: &AiJob) -> TemplateSelectionJobView {
    let stored = template_job_results()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&job.id)
        .cloned();
    let mut view = stored.unwrap_or(TemplateSelectionJobView {
        job_id: job.id.clone(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone(),
        message: None,
        recommendation: None,
        seed: None,
    });
    view.state = job.state;
    view.progress = 100;
    view.error_code = job.error_code.clone();
    // Fail closed: only Succeeded may surface a recommendation; never auto-mint seeds.
    view.seed = None;
    if !template_selection_may_return_recommendation(job.state) {
        view.recommendation = None;
        if job.state == AiJobState::Cancelled {
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string()));
            if view.message.is_none() {
                view.message = Some("template selection cancelled".to_string());
            }
        } else if job.state == AiJobState::Stale {
            view.error_code = job.error_code.clone().or_else(|| Some("STALE".to_string()));
            if view.message.is_none() {
                view.message = Some("template selection is stale".to_string());
            }
        }
    }
    // Persist the sanitized terminal view.
    {
        let mut store = template_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job.id.clone(), view.clone());
        retain_template_global_state(None, Some(&mut store));
    }
    view
}

fn signal_template_cancel(job_id: &str) {
    if let Ok(flags) = template_cancel_flags().lock() {
        if let Some(flag) = flags.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn template_selection_is_cancelled(job_id: &str, flag: &AtomicBool) -> bool {
    if flag.load(Ordering::Relaxed) {
        return true;
    }
    let state = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(job_id)
        .map(|job| job.state);
    matches!(state, Some(state) if state.is_terminal())
}

fn update_template_job_progress(job_id: &str, progress: u8, message: impl Into<String>) {
    let message = message.into();
    {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        let _ = manager.update_progress(job_id, progress);
    }
    if let Ok(mut store) = template_job_results().lock() {
        if let Some(view) = store.get_mut(job_id) {
            if !view.state.is_terminal() {
                view.progress = progress.min(100);
                view.message = Some(message);
                if let Ok(manager) = jobs().lock() {
                    if let Some(job) = manager.get(job_id) {
                        view.state = job.state;
                    }
                }
            }
        }
    }
}

fn store_template_selection_view(view: TemplateSelectionJobView) -> TemplateSelectionJobView {
    {
        let mut store = template_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(view.job_id.clone(), view.clone());
        retain_template_global_state(None, Some(&mut store));
    }
    view
}

fn finish_template_selection_failure(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    error_code: Option<String>,
    message: impl Into<String>,
) -> TemplateSelectionJobView {
    let message = message.into();
    let job = complete_job_backend(job_id, false, error_code.clone(), message.clone())
        .unwrap_or_else(|_| AiJob {
            id: job_id.to_string(),
            kind: JobKind::TemplateSelection,
            state: AiJobState::Failed,
            request_generation,
            snapshot_hash: snapshot_hash.to_string(),
            provider_identity: None,
            progress: 100,
            error_code: error_code.clone(),
            debug_record_id: None,
            created_at_unix: now_unix(),
        });
    // If cancel/stale won the race, honor that terminal state without a recommendation.
    store_template_selection_view(TemplateSelectionJobView {
        job_id: job_id.to_string(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone().or(error_code),
        message: Some(message),
        recommendation: None,
        seed: None,
    })
}

/// Store a validated recommendation when the job is still non-terminal; complete as Succeeded.
/// Does **not** mint a handoff seed — explicit Review does that. Late cancel drops the rec.
#[allow(clippy::too_many_arguments)]
fn finish_template_selection_success(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    selected_id: &str,
    selected_revision: u64,
    selected_digest: &str,
    selected_name: &str,
    selected_summary: &str,
    catalog: &[crate::ai::template_seed::EligibleTemplateCatalogEntry],
    torrent_name: String,
    torrent_path: String,
    cancel_flag: &AtomicBool,
) -> TemplateSelectionJobView {
    if template_selection_is_cancelled(job_id, cancel_flag) {
        return finish_template_selection_cancelled(
            job_id,
            request_generation,
            snapshot_hash,
            "template selection cancelled before recommendation store",
        );
    }

    let selected_entry = crate::ai::template_seed::EligibleTemplateCatalogEntry {
        id: selected_id.to_string(),
        name: selected_name.to_string(),
        revision: selected_revision,
        digest: selected_digest.to_string(),
        summary: selected_summary.to_string(),
    };
    let summary_text = format!(
        "推荐模板「{}」(revision {})",
        selected_name, selected_revision
    );
    let recommendation = match template_recommendations()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .store(
            &selected_entry,
            catalog,
            snapshot_hash.to_string(),
            torrent_name,
            torrent_path,
            summary_text.clone(),
        ) {
        Ok(rec) => rec,
        Err(error) => {
            return finish_template_selection_failure(
                job_id,
                request_generation,
                snapshot_hash,
                Some("RECOMMENDATION_STORE".to_string()),
                error,
            );
        }
    };

    let job =
        complete_job_backend(job_id, true, None, summary_text.clone()).unwrap_or_else(|_| AiJob {
            id: job_id.to_string(),
            kind: JobKind::TemplateSelection,
            state: AiJobState::Succeeded,
            request_generation,
            snapshot_hash: snapshot_hash.to_string(),
            provider_identity: None,
            progress: 100,
            error_code: None,
            debug_record_id: None,
            created_at_unix: now_unix(),
        });

    if !template_selection_may_return_recommendation(job.state) {
        // Cancel/stale won the race after store: do not surface the recommendation.
        return store_template_selection_view(TemplateSelectionJobView {
            job_id: job_id.to_string(),
            state: job.state,
            request_generation: job.request_generation,
            snapshot_hash: job.snapshot_hash.clone(),
            progress: 100,
            error_code: job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string())),
            message: Some("template selection cancelled; recommendation discarded".to_string()),
            recommendation: None,
            seed: None,
        });
    }

    store_template_selection_view(TemplateSelectionJobView {
        job_id: job_id.to_string(),
        state: AiJobState::Succeeded,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: None,
        message: Some(format!(
            "selected template {selected_id} revision {selected_revision}"
        )),
        recommendation: Some(recommendation),
        seed: None,
    })
}

fn finish_template_selection_cancelled(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    message: impl Into<String>,
) -> TemplateSelectionJobView {
    let message = message.into();
    // Ensure Cancelled (idempotent if ai_cancel_job already ran).
    let job = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.cancel(job_id).unwrap_or_else(|_| AiJob {
            id: job_id.to_string(),
            kind: JobKind::TemplateSelection,
            state: AiJobState::Cancelled,
            request_generation,
            snapshot_hash: snapshot_hash.to_string(),
            provider_identity: None,
            progress: 100,
            error_code: Some("CANCELLED".to_string()),
            debug_record_id: None,
            created_at_unix: now_unix(),
        })
    };
    store_template_selection_view(TemplateSelectionJobView {
        job_id: job_id.to_string(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job
            .error_code
            .clone()
            .or_else(|| Some("CANCELLED".to_string())),
        message: Some(message),
        recommendation: None,
        seed: None,
    })
}

fn retain_template_global_state(
    flags: Option<&mut JobCancelFlagMap>,
    results: Option<&mut TemplateSelectionResultMap>,
) {
    let active_ids: std::collections::HashSet<String> = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .list()
            .into_iter()
            .filter(|job| job.kind == JobKind::TemplateSelection && !job.state.is_terminal())
            .map(|job| job.id)
            .collect()
    };
    if let Some(flags) = flags {
        if flags.len() > TEMPLATE_STATE_MAX_RECORDS {
            flags.retain(|id, _| active_ids.contains(id));
        }
    }
    if let Some(results) = results {
        if results.len() > TEMPLATE_STATE_MAX_RECORDS {
            let surplus = results.len().saturating_sub(TEMPLATE_STATE_MAX_RECORDS);
            if surplus > 0 {
                let mut terminal_ids = results
                    .iter()
                    .filter(|(id, view)| view.state.is_terminal() && !active_ids.contains(*id))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                terminal_ids.sort();
                for id in terminal_ids.into_iter().take(surplus) {
                    results.remove(&id);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_template_selection_worker(
    app: AppHandle,
    connection: PublicConnectionConfig,
    secret: Option<SecretValue>,
    job_id: String,
    catalog_hash: String,
    torrent_path: String,
    torrent_name: String,
    catalog: Vec<crate::ai::template_seed::EligibleTemplateCatalogEntry>,
    cancel_flag: Arc<AtomicBool>,
) {
    if template_selection_is_cancelled(&job_id, &cancel_flag) {
        finish_template_selection_cancelled(
            &job_id,
            0,
            &catalog_hash,
            "template selection cancelled",
        );
        return;
    }

    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);
    // Provider sees redacted torrent name only — never the filesystem path.
    let safe_torrent_name = policy.redact_text(&torrent_name);

    update_template_job_progress(&job_id, 10, "preparing template selection");

    let prompt = build_template_selection_prompt(&safe_torrent_name, &catalog);
    let schema = template_selection_schema();
    let output_capability = ready_output_capability(&connection)
        .expect("formal capability gate must provide an output tier");

    if template_selection_is_cancelled(&job_id, &cancel_flag) {
        finish_template_selection_cancelled(
            &job_id,
            0,
            &catalog_hash,
            "template selection cancelled",
        );
        return;
    }

    let client = match build_no_redirect_client() {
        Ok(client) => client,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            finish_template_selection_failure(
                &job_id,
                0,
                &catalog_hash,
                Some("PROVIDER_CLIENT".to_string()),
                message,
            );
            return;
        }
    };

    update_template_job_progress(&job_id, 35, "requesting provider selection");

    let outcome = run_formal_provider_call(
        &client,
        &connection,
        secret.as_ref(),
        &schema,
        "okpgui_template_selection",
        TEMPLATE_SELECTION_SYSTEM_PROMPT,
        &prompt,
        output_capability,
        ReasoningMode::Disabled,
        || template_selection_is_cancelled(&job_id, &cancel_flag),
        |structured| {
            let live_catalog = load_eligible_catalog(&app);
            if live_catalog.is_empty() {
                return Err(FormalValidationError {
                    message: "没有可用于自动选择的发布模板。".to_string(),
                    code: "CATALOG_EMPTY",
                    retryable: false,
                });
            }
            match parse_template_selection(structured, &live_catalog) {
                Ok(selected) => Ok((selected, live_catalog)),
                Err(message) => Err(FormalValidationError {
                    retryable: message.contains("schema validation"),
                    message,
                    code: "SELECTION_INVALID",
                }),
            }
        },
    )
    .await;

    update_template_job_progress(&job_id, 75, "validating catalog selection");
    let (selected, final_catalog) = match outcome {
        FormalProviderCallResult::Success(value) => value,
        FormalProviderCallResult::Cancelled => {
            finish_template_selection_cancelled(
                &job_id,
                0,
                &catalog_hash,
                "template selection cancelled",
            );
            return;
        }
        FormalProviderCallResult::Failed {
            failure,
            error_code,
            ..
        } => {
            let message = redact_provider_error(&failure.message, &policy);
            finish_template_selection_failure(
                &job_id,
                0,
                &catalog_hash,
                Some(error_code.to_string()),
                message,
            );
            return;
        }
    };

    update_template_job_progress(&job_id, 90, "storing template recommendation");

    finish_template_selection_success(
        &job_id,
        0,
        &catalog_hash,
        &selected.id,
        selected.revision,
        &selected.digest,
        &selected.name,
        &selected.summary,
        &final_catalog,
        torrent_name,
        torrent_path,
        &cancel_flag,
    );
}

/// One-shot / start release recognition request: safe torrent name + template pattern content only.
///
/// Never accepts absolute torrent paths, publish-plan tokens, model-owned final titles, or
/// client identity (`snapshot_hash` / `request_generation`). Context hash and generation are
/// allocated by Rust when the job is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRecognizeRequest {
    /// Display torrent name only (never a filesystem path).
    pub torrent_name: String,
    /// Optional episode regex/context from the active template.
    #[serde(default)]
    pub ep_pattern: String,
    /// Optional resolution regex/context from the active template.
    #[serde(default)]
    pub resolution_pattern: String,
    /// Optional title pattern context (deterministic final title still uses this locally).
    #[serde(default)]
    pub title_pattern: String,
}

/// Public Recognition job view: progress + redacted errors; result only on Succeeded.
///
/// Validated redacted `RecognitionResult` is stored by job id and surfaced only when
/// `state == Succeeded`. Cancelled / Stale / Failed / late completion never return a result.
/// `request_generation` and `snapshot_hash` are backend-owned context identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognitionJobView {
    pub job_id: String,
    pub state: AiJobState,
    /// Backend-allocated monotonic recognition generation.
    pub request_generation: u64,
    /// Backend-computed cryptographic context hash of the stored recognition snapshot.
    pub snapshot_hash: String,
    pub progress: u8,
    pub error_code: Option<String>,
    /// Redacted human-readable status/error (never secrets, raw paths, or provider bodies).
    pub message: Option<String>,
    /// Present only when `state == Succeeded` and result return was allowed.
    pub result: Option<RecognitionResult>,
}

/// Start a backend-owned Recognition job (queued/running immediately with job id).
///
/// Rust sanitizes content, builds a versioned context snapshot, computes the context hash,
/// and allocates a monotonic generation before any provider work. The client polls via
/// `ai_poll_recognition` and cancels via `ai_cancel_job`. Disabled/unconfigured AI is
/// rejected with zero provider work.
#[tauri::command]
pub async fn ai_start_recognition(
    app: AppHandle,
    request: AiRecognizeRequest,
) -> Result<RecognitionJobView, String> {
    let connection = ai_get_settings(app.clone());
    if !connection.enabled {
        return Err("请先在 AI 设置中启用并完成连接和模型配置。".to_string());
    }
    if !connection_is_configured(&connection) {
        return Err("请先在 AI 设置中完成连接和模型配置。".to_string());
    }

    let secret = if connection.auth_mode == AuthMode::None {
        None
    } else {
        let reference = connection
            .credential_ref
            .clone()
            .ok_or_else(|| "AI credential is not configured".to_string())?;
        Some(
            credential_store()
                .get(&reference)?
                .ok_or_else(|| "AI credential is missing from the secure store".to_string())?,
        )
    };

    // Formal recognition requires an exact Ready capability identity match.
    let identity = require_ready_capability_identity(&connection, secret.as_ref())?;

    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);

    // Backend-owned identity: sanitize → snapshot → hash → monotonic generation.
    let (snapshot, context_hash) = build_recognition_context_snapshot(
        &request.torrent_name,
        &request.ep_pattern,
        &request.resolution_pattern,
        &request.title_pattern,
        &policy,
    )?;
    let request_generation = next_recognition_generation();

    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::Recognition,
            request_generation,
            context_hash.clone(),
            Some(identity),
        )
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = recognition_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        flags.insert(job_id.clone(), Arc::clone(&cancel_flag));
        retain_recognition_global_state(Some(&mut flags), None, None);
    }
    {
        let mut store = recognition_snapshots()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job_id.clone(), snapshot.clone());
        retain_recognition_global_state(None, None, Some(&mut store));
    }

    let manager_state = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .get(&job_id)
            .map(|job| job.state)
            .unwrap_or(AiJobState::Running)
    };
    let initial = RecognitionJobView {
        job_id: job_id.clone(),
        state: manager_state,
        request_generation,
        snapshot_hash: context_hash.clone(),
        progress: 0,
        error_code: None,
        message: Some("recognition queued".to_string()),
        result: None,
    };
    {
        let mut store = recognition_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job_id.clone(), initial.clone());
        retain_recognition_global_state(None, Some(&mut store), None);
    }

    let bg_job_id = job_id.clone();
    let bg_connection = connection;
    let bg_generation = request_generation;
    let bg_snapshot_hash = context_hash;
    let bg_torrent = snapshot.torrent_name.clone();
    let bg_ep = snapshot.ep_pattern.clone();
    let bg_res = snapshot.resolution_pattern.clone();
    let bg_title = snapshot.title_pattern.clone();
    tauri::async_runtime::spawn(async move {
        run_recognition_worker(
            bg_connection,
            secret,
            bg_job_id,
            bg_generation,
            bg_snapshot_hash,
            bg_torrent,
            bg_ep,
            bg_res,
            bg_title,
            cancel_flag,
        )
        .await;
    });

    Ok(initial)
}

/// Poll Recognition job status.
///
/// - Still queued/running → `None` (keep polling; progress via `ai_get_job`).
/// - Terminal → `Some(view)`. Result is present only when `state == Succeeded`.
/// - Cancelled/Stale/Failed never return a usable recognition result (fail closed).
#[tauri::command]
pub fn ai_poll_recognition(job_id: String) -> Result<Option<RecognitionJobView>, String> {
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err("job_id is required".to_string());
    }
    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&job_id).cloned()
    };
    let Some(job) = job else {
        return Err("recognition job not found".to_string());
    };
    if job.kind != JobKind::Recognition {
        return Err("job is not a recognition job".to_string());
    }
    if !job.state.is_terminal() {
        return Ok(None);
    }
    Ok(Some(recognition_terminal_view(&job)))
}

fn recognition_terminal_view(job: &AiJob) -> RecognitionJobView {
    let stored = recognition_job_results()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&job.id)
        .cloned();
    let mut view = stored.unwrap_or(RecognitionJobView {
        job_id: job.id.clone(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone(),
        message: None,
        result: None,
    });
    view.state = job.state;
    view.progress = 100;
    view.error_code = job.error_code.clone();
    // Fail closed: only Succeeded may surface a validated recognition result.
    if !recognition_may_return_result(job.state) {
        view.result = None;
        if job.state == AiJobState::Cancelled {
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string()));
            if view.message.is_none() {
                view.message = Some("recognition cancelled".to_string());
            }
        } else if job.state == AiJobState::Stale {
            view.error_code = job.error_code.clone().or_else(|| Some("STALE".to_string()));
            if view.message.is_none() {
                view.message = Some("recognition is stale".to_string());
            }
        }
    }
    {
        let mut store = recognition_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(job.id.clone(), view.clone());
        retain_recognition_global_state(None, Some(&mut store), None);
    }
    view
}

fn signal_recognition_cancel(job_id: &str) {
    if let Ok(flags) = recognition_cancel_flags().lock() {
        if let Some(flag) = flags.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn recognition_is_cancelled(job_id: &str, flag: &AtomicBool) -> bool {
    if flag.load(Ordering::Relaxed) {
        return true;
    }
    let state = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(job_id)
        .map(|job| job.state);
    matches!(state, Some(state) if state.is_terminal())
}

fn update_recognition_job_progress(job_id: &str, progress: u8, message: impl Into<String>) {
    let message = message.into();
    {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        let _ = manager.update_progress(job_id, progress);
    }
    if let Ok(mut store) = recognition_job_results().lock() {
        if let Some(view) = store.get_mut(job_id) {
            if !view.state.is_terminal() {
                view.progress = progress.min(100);
                view.message = Some(message);
                if let Ok(manager) = jobs().lock() {
                    if let Some(job) = manager.get(job_id) {
                        view.state = job.state;
                    }
                }
            }
        }
    }
}

fn store_recognition_view(view: RecognitionJobView) -> RecognitionJobView {
    {
        let mut store = recognition_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        store.insert(view.job_id.clone(), view.clone());
        retain_recognition_global_state(None, Some(&mut store), None);
    }
    view
}

fn finish_recognition_failure(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    error_code: Option<String>,
    message: impl Into<String>,
) -> RecognitionJobView {
    let message = message.into();
    let job = complete_job_backend(job_id, false, error_code.clone(), message.clone())
        .unwrap_or_else(|_| AiJob {
            id: job_id.to_string(),
            kind: JobKind::Recognition,
            state: AiJobState::Failed,
            request_generation,
            snapshot_hash: snapshot_hash.to_string(),
            provider_identity: None,
            progress: 100,
            error_code: error_code.clone(),
            debug_record_id: None,
            created_at_unix: now_unix(),
        });
    // If cancel/stale won the race, honor that terminal state without a result.
    store_recognition_view(RecognitionJobView {
        job_id: job_id.to_string(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone().or(error_code),
        message: Some(message),
        result: None,
    })
}

/// Store a validated redacted result only when the job is still non-terminal; complete as
/// Succeeded only then. Late cancel between validation and complete drops the result.
fn finish_recognition_success(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    result: RecognitionResult,
    cancel_flag: &AtomicBool,
) -> RecognitionJobView {
    if recognition_is_cancelled(job_id, cancel_flag) {
        return finish_recognition_cancelled(
            job_id,
            request_generation,
            snapshot_hash,
            "recognition cancelled before result store",
        );
    }

    let summary = format!(
        "recognition schema={} episode={} resolution={} suggested_title={}",
        RECOGNITION_SCHEMA_VERSION,
        result.episode.is_some(),
        result.resolution.is_some(),
        result.suggested_title.is_some()
    );
    let job = complete_job_backend(job_id, true, None, summary).unwrap_or_else(|_| AiJob {
        id: job_id.to_string(),
        kind: JobKind::Recognition,
        state: AiJobState::Succeeded,
        request_generation,
        snapshot_hash: snapshot_hash.to_string(),
        provider_identity: None,
        progress: 100,
        error_code: None,
        debug_record_id: None,
        created_at_unix: now_unix(),
    });

    if !recognition_may_return_result(job.state) {
        // Cancel/stale won the race after validation: never surface the result.
        return store_recognition_view(RecognitionJobView {
            job_id: job_id.to_string(),
            state: job.state,
            request_generation: job.request_generation,
            snapshot_hash: job.snapshot_hash.clone(),
            progress: 100,
            error_code: job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string())),
            message: Some("recognition cancelled; result discarded".to_string()),
            result: None,
        });
    }

    store_recognition_view(RecognitionJobView {
        job_id: job_id.to_string(),
        state: AiJobState::Succeeded,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: None,
        message: Some("recognition completed".to_string()),
        result: Some(result),
    })
}

fn finish_recognition_cancelled(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    message: impl Into<String>,
) -> RecognitionJobView {
    let message = message.into();
    // Ensure Cancelled (idempotent if ai_cancel_job already ran).
    let job = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.cancel(job_id).unwrap_or_else(|_| AiJob {
            id: job_id.to_string(),
            kind: JobKind::Recognition,
            state: AiJobState::Cancelled,
            request_generation,
            snapshot_hash: snapshot_hash.to_string(),
            provider_identity: None,
            progress: 100,
            error_code: Some("CANCELLED".to_string()),
            debug_record_id: None,
            created_at_unix: now_unix(),
        })
    };
    store_recognition_view(RecognitionJobView {
        job_id: job_id.to_string(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job
            .error_code
            .clone()
            .or_else(|| Some("CANCELLED".to_string())),
        message: Some(message),
        result: None,
    })
}

fn retain_recognition_global_state(
    flags: Option<&mut JobCancelFlagMap>,
    results: Option<&mut RecognitionResultMap>,
    snapshots: Option<&mut RecognitionSnapshotMap>,
) {
    let active_ids: std::collections::HashSet<String> = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .list()
            .into_iter()
            .filter(|job| job.kind == JobKind::Recognition && !job.state.is_terminal())
            .map(|job| job.id)
            .collect()
    };
    if let Some(flags) = flags {
        if flags.len() > RECOGNITION_STATE_MAX_RECORDS {
            flags.retain(|id, _| active_ids.contains(id));
        }
    }
    if let Some(results) = results {
        if results.len() > RECOGNITION_STATE_MAX_RECORDS {
            let surplus = results.len().saturating_sub(RECOGNITION_STATE_MAX_RECORDS);
            if surplus > 0 {
                let mut terminal_ids = results
                    .iter()
                    .filter(|(id, view)| view.state.is_terminal() && !active_ids.contains(*id))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                terminal_ids.sort();
                for id in terminal_ids.into_iter().take(surplus) {
                    results.remove(&id);
                }
            }
        }
    }
    if let Some(snapshots) = snapshots {
        if snapshots.len() > RECOGNITION_STATE_MAX_RECORDS {
            snapshots.retain(|id, _| active_ids.contains(id));
            // If still over cap, drop arbitrary surplus of non-active (terminal) entries.
            if snapshots.len() > RECOGNITION_STATE_MAX_RECORDS {
                let surplus = snapshots
                    .len()
                    .saturating_sub(RECOGNITION_STATE_MAX_RECORDS);
                let mut drop_ids = snapshots
                    .keys()
                    .filter(|id| !active_ids.contains(*id))
                    .cloned()
                    .collect::<Vec<_>>();
                drop_ids.sort();
                for id in drop_ids.into_iter().take(surplus) {
                    snapshots.remove(&id);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_recognition_worker(
    connection: PublicConnectionConfig,
    secret: Option<SecretValue>,
    job_id: String,
    request_generation: u64,
    snapshot_hash: String,
    torrent_name: String,
    ep_pattern: String,
    resolution_pattern: String,
    title_pattern: String,
    cancel_flag: Arc<AtomicBool>,
) {
    if recognition_is_cancelled(&job_id, &cancel_flag) {
        finish_recognition_cancelled(
            &job_id,
            request_generation,
            &snapshot_hash,
            "recognition cancelled",
        );
        return;
    }

    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);

    update_recognition_job_progress(&job_id, 10, "preparing recognition");

    let prompt = build_recognition_prompt(
        &torrent_name,
        &ep_pattern,
        &resolution_pattern,
        &title_pattern,
    );
    let schema = recognition_schema();
    let output_capability = ready_output_capability(&connection)
        .expect("formal capability gate must provide an output tier");

    if recognition_is_cancelled(&job_id, &cancel_flag) {
        finish_recognition_cancelled(
            &job_id,
            request_generation,
            &snapshot_hash,
            "recognition cancelled",
        );
        return;
    }

    let client = match build_no_redirect_client() {
        Ok(client) => client,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            finish_recognition_failure(
                &job_id,
                request_generation,
                &snapshot_hash,
                Some("PROVIDER_CLIENT".to_string()),
                message,
            );
            return;
        }
    };

    update_recognition_job_progress(&job_id, 35, "requesting provider recognition");

    let outcome = run_formal_provider_call(
        &client,
        &connection,
        secret.as_ref(),
        &schema,
        "okpgui_recognition",
        RECOGNITION_SYSTEM_PROMPT,
        &prompt,
        output_capability,
        ReasoningMode::Default,
        || recognition_is_cancelled(&job_id, &cancel_flag),
        |structured| {
            recognition_from_provider_outcome(Some(structured), None).map_err(|message| {
                FormalValidationError {
                    message,
                    code: "RECOGNITION_INVALID",
                    retryable: true,
                }
            })
        },
    )
    .await;

    update_recognition_job_progress(&job_id, 75, "validating recognition output");
    let output = match outcome {
        FormalProviderCallResult::Success(value) => value,
        FormalProviderCallResult::Cancelled => {
            finish_recognition_cancelled(
                &job_id,
                request_generation,
                &snapshot_hash,
                "recognition cancelled",
            );
            return;
        }
        FormalProviderCallResult::Failed {
            failure,
            error_code,
            ..
        } => {
            let message = redact_provider_error(&failure.message, &policy);
            finish_recognition_failure(
                &job_id,
                request_generation,
                &snapshot_hash,
                Some(error_code.to_string()),
                message,
            );
            return;
        }
    };

    if recognition_is_cancelled(&job_id, &cancel_flag) {
        finish_recognition_cancelled(
            &job_id,
            request_generation,
            &snapshot_hash,
            "recognition cancelled after validation",
        );
        return;
    }

    update_recognition_job_progress(&job_id, 90, "binding recognition result");

    let redacted = redact_recognition_output(output, &policy);
    let result = bind_recognition_result(
        redacted,
        request_generation,
        snapshot_hash.clone(),
        job_id.clone(),
    );

    finish_recognition_success(
        &job_id,
        request_generation,
        &snapshot_hash,
        result,
        &cancel_flag,
    );
}

/// Provider-backed one-shot release recognition (backward-compatible).
///
/// Capability-gated (Ready identity + output tier), JobKind::Recognition lifecycle, structured
/// schema validation. Provider failures and missing structured JSON never become a
/// successful empty result. Valid all-null candidates are a successful empty result.
/// Prefer `ai_start_recognition` + `ai_poll_recognition` for cancellable UI flows.
#[tauri::command]
pub async fn ai_recognize(
    app: AppHandle,
    request: AiRecognizeRequest,
) -> Result<RecognitionResult, String> {
    // Backward-compatible one-shot: start + poll until terminal, then map to RecognitionResult.
    let started = ai_start_recognition(app, request).await?;
    let job_id = started.job_id.clone();
    // Bounded wait: poll until terminal (provider work is background; this holds the IPC).
    loop {
        match ai_poll_recognition(job_id.clone())? {
            None => {
                // Cooperative yield so the background worker can progress.
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Some(view) => {
                if recognition_may_return_result(view.state) {
                    return view
                        .result
                        .ok_or_else(|| "recognition succeeded without a result".to_string());
                }
                let message = view
                    .message
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| view.error_code.clone())
                    .unwrap_or_else(|| "recognition failed".to_string());
                return Err(message);
            }
        }
    }
}

#[tauri::command]
pub fn ai_inspect_template_seed(app: AppHandle, token: String) -> Option<TemplateSeed> {
    let catalog = load_eligible_catalog(&app);
    template_seeds()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .inspect_validated(&token, &catalog)
}

/// Consume once with live catalog + torrent identity gates (not remove-only).
#[tauri::command]
pub fn ai_consume_template_seed(
    app: AppHandle,
    token: String,
) -> Result<ConsumedTemplateSeed, String> {
    let catalog = load_eligible_catalog(&app);
    let (public, binding) = template_seeds()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .consume_validated(&token, &catalog)?;
    // Mark the parent recommendation as consumed so repeated Review cannot remint.
    template_recommendations()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .mark_seed_consumed(&public.token);
    Ok(ConsumedTemplateSeed {
        template_id: public.template_id,
        template_revision: public.template_revision,
        template_digest: public.template_digest,
        torrent_name: public.torrent_name,
        torrent_path: binding.torrent_path,
    })
}

/// Explicit Review: revalidate a stored recommendation and mint exactly one handoff seed.
///
/// Repeated Review:
/// - minted but unconsumed → same seed (`already_minted`)
/// - consumed by Quick Publish → `already_consumed` (no second live seed)
/// - expired / catalog or torrent drift → terminal error
#[tauri::command]
pub fn ai_review_template_recommendation(
    app: AppHandle,
    recommendation_id: String,
) -> Result<ReviewTemplateRecommendationResult, String> {
    let catalog = load_eligible_catalog(&app);
    let mut seeds = template_seeds()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut recommendations = template_recommendations()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    recommendations.review_and_mint(&recommendation_id, &catalog, &mut seeds)
}

#[tauri::command]
pub fn ai_redact_value(value: Value, secret_values: Vec<String>) -> Value {
    RedactionPolicy::new(secret_values).redact_value(&value)
}

/// Request for plan-owned AI context projection. Opaque token only — never client
/// torrent names, trees, templates, files, or absolute paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProjectContextRequest {
    pub plan_token: String,
}

/// Project AI context from a prepared plan token only.
///
/// Backend resolves `LocalExecutionBinding` fail-closed, parses the bound torrent in
/// Rust, allowlists relative tree/file metadata + template content, revalidates
/// torrent identity after parse, and never truncates on `PAYLOAD_TOO_LARGE`.
/// Absolute paths, raw bencode, trackers, credentials, generic PublishPlan
/// serialization, and client-supplied names/files never enter the projection.
#[tauri::command]
pub fn ai_project_context(request: AiProjectContextRequest) -> Result<ContextProjection, String> {
    let plan_token = request.plan_token.trim();
    if plan_token.is_empty() {
        return Err("prepared plan token is required".to_string());
    }

    let binding = {
        let mut guard = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        guard.resolve_binding_for_context(plan_token)?
    };

    // Credentials never enter ContextProjection; default policy still path-redacts scalars.
    project_context_from_binding(
        &binding,
        &RedactionPolicy::default(),
        DEFAULT_CONTEXT_CEILING,
    )
    .map_err(context_error_to_public)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFormalAuditRequest {
    /// Opaque prepared-plan token. Backend snapshot identity + binding are authoritative.
    pub plan_token: String,
    /// Deprecated: ignored. Prompt uses plan-token ContextProjection only.
    #[serde(default)]
    pub title: Option<String>,
    /// Deprecated: ignored. Prompt uses plan-token ContextProjection only.
    #[serde(default)]
    pub torrent_name: Option<String>,
    /// Deprecated: ignored. Prompt uses plan-token ContextProjection only.
    #[serde(default)]
    pub sites: Vec<String>,
    /// Deprecated client fields: accepted for wire compatibility but ignored for binding.
    #[serde(default)]
    pub request_generation: Option<u64>,
    #[serde(default)]
    pub snapshot_hash: Option<String>,
    /// Deprecated: ignored. Plan-token local_blockers are authoritative.
    #[serde(default)]
    pub local_blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFormalAuditResult {
    pub decision: AuditDecision,
    pub findings: Vec<Finding>,
    pub unknown_codes: Vec<String>,
    pub local_blockers: Vec<String>,
    /// True only when a real provider HTTP call was attempted/completed.
    pub formal_ran: bool,
    pub job_id: Option<String>,
    /// Backend plan identity echoed so the client never invents binding keys.
    pub plan_token: String,
    pub snapshot_hash: String,
    pub request_generation: u64,
}

fn connection_is_configured(connection: &PublicConnectionConfig) -> bool {
    if !connection.enabled {
        return false;
    }
    if connection.endpoint.trim().is_empty() || connection.model.trim().is_empty() {
        return false;
    }
    match connection.auth_mode {
        AuthMode::None => true,
        AuthMode::CustomHeader => {
            connection
                .custom_header_name
                .as_deref()
                .map(str::trim)
                .is_some_and(|name| !name.is_empty())
                && connection.credential_ref.is_some()
        }
        AuthMode::Bearer | AuthMode::AnthropicApiKey => connection.credential_ref.is_some(),
    }
}

/// Shared by `prepare_plan`: AI enabled **and** fully configured ⇒ bind PENDING evidence.
/// Disabled or incomplete config ⇒ local-only GO/LOCAL_BLOCKED path (zero network).
pub fn ai_connection_is_configured_for_app(app: &AppHandle) -> bool {
    let connection = ai_get_settings(app.clone());
    connection_is_configured(&connection)
}

/// Build a formal-audit result after sanitizing findings with the active policy.
/// Callers pass the secret-aware policy when a credential is in scope; otherwise default.
/// Sanitization runs before decision calculation so bind + IPC never see raw canaries.
///
/// Plan-owned MediaInfo state contributes `MEDIA_NOT_TESTED` / `MEDIA_CHECK_FAILED`
/// via [`media_findings_from_plan_evidence`] — never client probe values.
#[allow(clippy::too_many_arguments)]
fn local_audit_result(
    plan_token: String,
    snapshot_hash: String,
    request_generation: u64,
    local_blockers: Vec<String>,
    findings: Vec<Finding>,
    formal_ran: bool,
    job_id: Option<String>,
    policy: &RedactionPolicy,
) -> AiFormalAuditResult {
    // Secret-aware substring redaction on evidence_path preserves relative path shape
    // (full redact_text would path-mangle "torrent/file.mkv"); messages use full policy.
    let mut findings = findings
        .into_iter()
        .map(|mut finding| {
            if let Some(path) = finding.evidence_path.as_ref() {
                finding.evidence_path = Some(policy.redact_secret_substrings(path));
            }
            finding
        })
        .collect::<Vec<_>>();
    // An AI-disabled plan is a local-only path: do not turn the optional, unrun
    // MediaInfo check into a new WARNING. Once an AI/media path actually ran (or
    // already produced a local finding), plan-owned media evidence is advisory.
    // This preserves the zero-impact disabled contract without trusting client data.
    if formal_ran || job_id.is_some() || !findings.is_empty() {
        findings.extend(load_plan_media_findings(&plan_token));
    }
    let input = sanitize_audit_input(
        AuditInput {
            local_blockers: local_blockers.clone(),
            findings,
            checking: false,
        },
        policy,
    );
    let validated = compute_decision(&input);
    AiFormalAuditResult {
        decision: validated.decision,
        findings: validated.findings,
        unknown_codes: validated.unknown_codes,
        local_blockers: input.local_blockers,
        formal_ran,
        job_id,
        plan_token,
        snapshot_hash,
        request_generation,
    }
}

/// Load plan-owned MediaInfo findings for formal/local audit derivation.
///
/// Missing / expired tokens yield no media findings (caller already failed closed on
/// plan identity). Live plans derive `MEDIA_NOT_TESTED` / `MEDIA_CHECK_FAILED` from
/// identity-matched plan-owned media evidence only.
fn load_plan_media_findings(plan_token: &str) -> Vec<Finding> {
    let plan_token = plan_token.trim();
    if plan_token.is_empty() {
        return Vec::new();
    }
    let mut guard = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(plan) = guard.inspect_plan(plan_token) else {
        return Vec::new();
    };
    plan.media_audit_findings()
}

fn bind_audit_to_plan(result: &AiFormalAuditResult) -> Result<(), String> {
    let mut guard = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.bind_audit_evidence(
        &result.plan_token,
        PlanAuditEvidence {
            decision: result.decision,
            findings: result.findings.clone(),
            unknown_codes: result.unknown_codes.clone(),
            formal_ran: result.formal_ran,
            job_id: result.job_id.clone(),
            snapshot_hash: result.snapshot_hash.clone(),
            request_generation: result.request_generation,
        },
    )?;
    // Index live plan → audit job so token-only cancel and strip cancel can resolve.
    if let Some(job_id) = result.job_id.as_deref() {
        guard.note_plan_audit_job(&result.plan_token, job_id);
    }
    Ok(())
}

/// Prepare-time / in-flight PENDING evidence with a backend job id (not a client decision).
fn pending_audit_result(
    plan_token: String,
    snapshot_hash: String,
    request_generation: u64,
    local_blockers: Vec<String>,
    job_id: String,
    policy: &RedactionPolicy,
) -> AiFormalAuditResult {
    if !local_blockers.is_empty() {
        return local_audit_result(
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            Vec::new(),
            false,
            Some(job_id),
            policy,
        );
    }
    AiFormalAuditResult {
        decision: AuditDecision::Pending,
        findings: Vec::new(),
        unknown_codes: Vec::new(),
        local_blockers,
        formal_ran: false,
        job_id: Some(job_id),
        plan_token,
        snapshot_hash,
        request_generation,
    }
}

fn formal_result_from_plan_evidence(
    plan_token: String,
    evidence: &PlanAuditEvidence,
    local_blockers: Vec<String>,
) -> AiFormalAuditResult {
    AiFormalAuditResult {
        decision: evidence.decision,
        findings: evidence.findings.clone(),
        unknown_codes: evidence.unknown_codes.clone(),
        local_blockers,
        formal_ran: evidence.formal_ran,
        job_id: evidence.job_id.clone(),
        plan_token,
        snapshot_hash: evidence.snapshot_hash.clone(),
        request_generation: evidence.request_generation,
    }
}

/// Error when a formal-audit job finished as Cancelled/Stale (or complete failed).
/// Frontend treats this as a failed prepare (non-publishable); prepare-time PENDING stays bound.
fn non_bindable_formal_audit_error(job: &AiJob) -> String {
    match job.state {
        AiJobState::Cancelled => {
            "formal audit was cancelled; prepare-time PENDING evidence was preserved".to_string()
        }
        AiJobState::Stale => {
            "formal audit became stale; prepare-time PENDING evidence was preserved".to_string()
        }
        other => format!(
            "formal audit job is not bindable (state={other:?}); prepare-time PENDING evidence was preserved"
        ),
    }
}

/// Complete the backend job, then bind formal evidence only when the job is Succeeded/Failed.
/// Cancelled/Stale (cancel, app-exit, late completion) never overwrite prepare-time PENDING.
fn complete_and_bind_formal_audit(
    job_id: &str,
    success: bool,
    error_code: Option<String>,
    summary: impl Into<String>,
    result: AiFormalAuditResult,
) -> Result<AiFormalAuditResult, String> {
    let completed = complete_job_backend(job_id, success, error_code, summary)?;
    if !formal_audit_may_bind_terminal_evidence(completed.state) {
        // Leave prepare-time PENDING evidence authoritative on the plan.
        return Err(non_bindable_formal_audit_error(&completed));
    }
    bind_audit_to_plan(&result)?;
    Ok(result)
}

fn plan_identity(token: &str) -> Result<(String, u64, Vec<String>), String> {
    let mut guard = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let plan = guard
        .inspect_plan(token)
        .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
    Ok((
        plan.snapshot_hash.clone(),
        plan.request_generation,
        plan.local_blockers.clone(),
    ))
}

/// Resolve plan identity + local/sync formal-audit short-circuits (disabled AI, incomplete
/// config, missing credential, or local blockers). Returns `Ok(Some(result))` when the audit
/// finished without a provider job; `Ok(None)` means a configured formal job should start.
#[allow(clippy::type_complexity)]
fn resolve_local_formal_audit(
    app: &AppHandle,
    plan_token: &str,
) -> Result<
    (
        String,
        String,
        u64,
        Vec<String>,
        PublicConnectionConfig,
        Option<SecretValue>,
        Option<AiFormalAuditResult>,
    ),
    String,
> {
    let plan_token = plan_token.trim().to_string();
    if plan_token.is_empty() {
        return Err("prepared plan token is required for formal audit".to_string());
    }

    // Backend plan identity is authoritative — never trust caller snapshot/generation/blockers.
    let (snapshot_hash, request_generation, plan_blockers) = plan_identity(&plan_token)?;
    let policy = RedactionPolicy::default();
    let local_blockers = plan_blockers
        .into_iter()
        .map(|blocker| policy.redact_text(&blocker))
        .collect::<Vec<_>>();
    let snapshot_hash = policy.redact_text(&snapshot_hash);

    let connection = ai_get_settings(app.clone());
    if !connection.enabled {
        // Preserve AI-disabled behavior: no provider calls, bind local decision only.
        let result = local_audit_result(
            plan_token.clone(),
            snapshot_hash.clone(),
            request_generation,
            local_blockers.clone(),
            Vec::new(),
            false,
            None,
            &policy,
        );
        bind_audit_to_plan(&result)?;
        return Ok((
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            connection,
            None,
            Some(result),
        ));
    }
    if !connection_is_configured(&connection) {
        let result = local_audit_result(
            plan_token.clone(),
            snapshot_hash.clone(),
            request_generation,
            local_blockers.clone(),
            vec![Finding {
                code: "PROVIDER_WARNING".to_string(),
                severity: FindingSeverity::Warning,
                message: "AI is enabled but not fully configured for formal audit".to_string(),
                evidence_path: None,
            }],
            false,
            None,
            &policy,
        );
        bind_audit_to_plan(&result)?;
        return Ok((
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            connection,
            None,
            Some(result),
        ));
    }

    // Local blockers always win: no provider job for a plan that cannot publish.
    if !local_blockers.is_empty() {
        let result = local_audit_result(
            plan_token.clone(),
            snapshot_hash.clone(),
            request_generation,
            local_blockers.clone(),
            Vec::new(),
            false,
            None,
            &policy,
        );
        bind_audit_to_plan(&result)?;
        return Ok((
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            connection,
            None,
            Some(result),
        ));
    }

    // Resolve secret only after prerequisites pass; never return it to the client.
    let secret = if connection.auth_mode == AuthMode::None {
        None
    } else {
        let reference = connection
            .credential_ref
            .clone()
            .ok_or_else(|| "AI credential is not configured".to_string())?;
        match credential_store().get(&reference)? {
            Some(value) => Some(value),
            None => {
                let result = local_audit_result(
                    plan_token.clone(),
                    snapshot_hash.clone(),
                    request_generation,
                    local_blockers.clone(),
                    vec![Finding {
                        code: "PROVIDER_WARNING".to_string(),
                        severity: FindingSeverity::Warning,
                        message: "AI credential is missing from the secure store".to_string(),
                        evidence_path: None,
                    }],
                    false,
                    None,
                    &policy,
                );
                bind_audit_to_plan(&result)?;
                return Ok((
                    plan_token,
                    snapshot_hash,
                    request_generation,
                    local_blockers,
                    connection,
                    None,
                    Some(result),
                ));
            }
        }
    };

    // Formal provider audit requires an exact Ready capability identity match (stored secret).
    if require_ready_capability_identity(&connection, secret.as_ref()).is_err() {
        let result = local_audit_result(
            plan_token.clone(),
            snapshot_hash.clone(),
            request_generation,
            local_blockers.clone(),
            vec![Finding {
                code: "PROVIDER_WARNING".to_string(),
                severity: FindingSeverity::Warning,
                message: capability_gate_error(),
                evidence_path: None,
            }],
            false,
            None,
            &policy,
        );
        bind_audit_to_plan(&result)?;
        return Ok((
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            connection,
            None,
            Some(result),
        ));
    }

    Ok((
        plan_token,
        snapshot_hash,
        request_generation,
        local_blockers,
        connection,
        secret,
        None,
    ))
}

/// Gate formal provider tasks: stored capability must be Ready and match current stored identity.
fn require_ready_capability_identity(
    connection: &PublicConnectionConfig,
    secret: Option<&SecretValue>,
) -> Result<CapabilityIdentity, String> {
    let identity = capability_identity(connection, secret);
    let Some(capability) = connection.capability.as_ref() else {
        return Err(capability_gate_error());
    };
    if capability.state != CapabilityState::Ready
        || capability.output_capability.is_none()
        || !capability_identity_matches(&capability.identity_digest, connection, secret)
    {
        return Err(capability_gate_error());
    }
    Ok(identity)
}

fn ready_output_capability(connection: &PublicConnectionConfig) -> Option<OutputCapability> {
    connection
        .capability
        .as_ref()
        .filter(|capability| capability.state == CapabilityState::Ready)
        .and_then(|capability| capability.output_capability)
}

/// Map a context projection failure to a public finding code (no truncation, no HTTP).
fn context_failure_finding(error: ContextError) -> Finding {
    let public = context_error_to_public(error);
    let code = if public.starts_with("PAYLOAD_TOO_LARGE") {
        "PAYLOAD_TOO_LARGE"
    } else {
        "PROVIDER_WARNING"
    };
    Finding {
        code: code.to_string(),
        severity: FindingSeverity::Warning,
        message: public,
        evidence_path: None,
    }
}

/// Provider-backed formal audit for an already-started backend job.
/// Completes the job and binds terminal evidence only when Succeeded/Failed.
///
/// Prompt identity comes only from the plan token's `LocalExecutionBinding` via
/// `project_context_from_binding`. Client title/torrent_name/sites/local_blockers are ignored.
async fn run_provider_formal_audit(
    connection: PublicConnectionConfig,
    secret: Option<SecretValue>,
    plan_token: String,
    snapshot_hash: String,
    request_generation: u64,
    local_blockers: Vec<String>,
    job_id: String,
) -> Result<AiFormalAuditResult, String> {
    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);

    // Project plan-owned context before any provider HTTP. Fail closed (no truncation).
    let projection = {
        let (binding, media_info) = {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match guard.resolve_context_for_audit(&plan_token) {
                Ok(context) => context,
                Err(error) => {
                    let message = policy.redact_text(&error);
                    let result = local_audit_result(
                        plan_token,
                        snapshot_hash,
                        request_generation,
                        local_blockers,
                        vec![Finding {
                            code: "PROVIDER_WARNING".to_string(),
                            severity: FindingSeverity::Warning,
                            message: message.clone(),
                            evidence_path: None,
                        }],
                        false,
                        Some(job_id.clone()),
                        &policy,
                    );
                    return complete_and_bind_formal_audit(
                        &job_id,
                        false,
                        Some("CONTEXT".to_string()),
                        message,
                        result,
                    );
                }
            }
        };
        match project_context_from_binding_with_media(
            &binding,
            &media_info,
            &policy,
            DEFAULT_CONTEXT_CEILING,
        ) {
            Ok(projection) => projection,
            Err(error) => {
                let finding = context_failure_finding(error);
                let message = finding.message.clone();
                let error_code = if finding.code == "PAYLOAD_TOO_LARGE" {
                    "PAYLOAD_TOO_LARGE"
                } else {
                    "CONTEXT"
                };
                let result = local_audit_result(
                    plan_token,
                    snapshot_hash,
                    request_generation,
                    local_blockers,
                    vec![finding],
                    false,
                    Some(job_id.clone()),
                    &policy,
                );
                return complete_and_bind_formal_audit(
                    &job_id,
                    false,
                    Some(error_code.to_string()),
                    message,
                    result,
                );
            }
        }
    };

    let prompt = match build_formal_audit_prompt(&snapshot_hash, &projection) {
        Ok(prompt) => prompt,
        Err(error) => {
            let message = policy.redact_text(&error);
            let result = local_audit_result(
                plan_token,
                snapshot_hash,
                request_generation,
                local_blockers,
                vec![Finding {
                    code: "PROVIDER_WARNING".to_string(),
                    severity: FindingSeverity::Warning,
                    message: message.clone(),
                    evidence_path: None,
                }],
                false,
                Some(job_id.clone()),
                &policy,
            );
            return complete_and_bind_formal_audit(
                &job_id,
                false,
                Some("CONTEXT".to_string()),
                message,
                result,
            );
        }
    };
    let schema = formal_audit_schema();
    let output_capability = ready_output_capability(&connection)
        .expect("formal capability gate must provide an output tier");

    let client = match build_no_redirect_client() {
        Ok(client) => client,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            let result = local_audit_result(
                plan_token,
                snapshot_hash,
                request_generation,
                local_blockers,
                vec![Finding {
                    code: "PROVIDER_WARNING".to_string(),
                    severity: FindingSeverity::Warning,
                    message: message.clone(),
                    evidence_path: None,
                }],
                false,
                Some(job_id.clone()),
                &policy,
            );
            return complete_and_bind_formal_audit(
                &job_id,
                false,
                Some("PROVIDER_CLIENT".to_string()),
                message,
                result,
            );
        }
    };

    let system_prompt = formal_audit_system_prompt();
    let outcome = run_formal_provider_call(
        &client,
        &connection,
        secret.as_ref(),
        &schema,
        "okpgui_audit",
        &system_prompt,
        &prompt,
        output_capability,
        ReasoningMode::Default,
        || false,
        |structured| {
            try_parse_formal_audit_findings(structured).map_err(|message| FormalValidationError {
                message,
                code: "PROVIDER_SCHEMA",
                retryable: true,
            })
        },
    )
    .await;

    match outcome {
        FormalProviderCallResult::Success(findings) => {
            let findings = validate_findings_against_projection(findings, &projection);
            let result = local_audit_result(
                plan_token,
                snapshot_hash,
                request_generation,
                local_blockers,
                findings,
                true,
                Some(job_id.clone()),
                &policy,
            );
            let summary = format!(
                "formal audit decision={} findings={}",
                match result.decision {
                    AuditDecision::Go => "GO",
                    AuditDecision::Warning => "WARNING",
                    AuditDecision::NoGo => "NO_GO",
                    AuditDecision::Pending => "PENDING",
                    AuditDecision::LocalBlocked => "LOCAL_BLOCKED",
                },
                result.findings.len()
            );
            complete_and_bind_formal_audit(&job_id, true, None, summary, result)
        }
        FormalProviderCallResult::Failed {
            failure,
            formal_ran,
            error_code,
        } => {
            let message = redact_provider_error(&failure.message, &policy);
            let result = local_audit_result(
                plan_token,
                snapshot_hash,
                request_generation,
                local_blockers,
                vec![Finding {
                    code: "PROVIDER_WARNING".to_string(),
                    severity: FindingSeverity::Warning,
                    message: message.clone(),
                    evidence_path: None,
                }],
                formal_ran,
                Some(job_id.clone()),
                &policy,
            );
            complete_and_bind_formal_audit(
                &job_id,
                false,
                Some(error_code.to_string()),
                message,
                result,
            )
        }
        FormalProviderCallResult::Cancelled => unreachable!("formal audit has no cancel hook"),
    }
}

/// Start formal audit for a prepared plan.
///
/// - Disabled / unconfigured / local-blockers / missing credential: binds a terminal local
///   decision synchronously (zero provider HTTP) and returns it.
/// - Configured AI: starts a backend `AiJob`, binds PENDING+job_id on the plan, returns that
///   PENDING result immediately, and runs the provider work in the background. Terminal
///   evidence is bound only via job Succeeded/Failed (cancel/stale/late cannot forge bind).
#[tauri::command]
pub async fn ai_start_formal_audit(
    app: AppHandle,
    request: AiFormalAuditRequest,
) -> Result<AiFormalAuditResult, String> {
    let (
        plan_token,
        snapshot_hash,
        request_generation,
        local_blockers,
        connection,
        secret,
        local_done,
    ) = resolve_local_formal_audit(&app, &request.plan_token)?;
    if let Some(result) = local_done {
        return Ok(result);
    }

    // Client title/torrent_name/sites/local_blockers are intentionally ignored: prompt
    // context is projected from the plan token binding inside run_provider_formal_audit.
    let _ = (
        &request.title,
        &request.torrent_name,
        &request.sites,
        &request.local_blockers,
        &request.snapshot_hash,
        &request.request_generation,
    );

    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);
    let identity = capability_identity(&connection, secret.as_ref());
    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::Audit,
            request_generation,
            snapshot_hash.clone(),
            Some(identity),
        )
    };

    let pending = pending_audit_result(
        plan_token.clone(),
        snapshot_hash.clone(),
        request_generation,
        local_blockers.clone(),
        job_id.clone(),
        &policy,
    );
    // Attach job id to prepare-time PENDING so cancel/publish can target the live job.
    bind_audit_to_plan(&pending)?;

    let bg_connection = connection.clone();
    let bg_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_provider_formal_audit(
            bg_connection,
            secret,
            plan_token,
            snapshot_hash,
            request_generation,
            local_blockers,
            bg_job_id,
        )
        .await;
    });

    Ok(pending)
}

/// Poll formal-audit result for a plan-bound job.
///
/// - Still queued/running → `None` (keep polling).
/// - Succeeded/Failed with plan-bound terminal evidence for this job → `Some(result)`.
/// - Cancelled/Stale (or plan consumed/missing) → error so the client stops polling without
///   treating client snapshots as authority. Prepare-time PENDING is preserved on cancel.
#[tauri::command]
pub fn ai_poll_formal_audit(
    plan_token: String,
    job_id: String,
) -> Result<Option<AiFormalAuditResult>, String> {
    let plan_token = plan_token.trim().to_string();
    let job_id = job_id.trim().to_string();
    if plan_token.is_empty() || job_id.is_empty() {
        return Err("plan_token and job_id are required".to_string());
    }

    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&job_id).cloned()
    };
    let Some(job) = job else {
        return Err("formal audit job not found".to_string());
    };
    if !job.state.is_terminal() {
        return Ok(None);
    }
    if !formal_audit_may_bind_terminal_evidence(job.state) {
        return Err(non_bindable_formal_audit_error(&job));
    }

    let mut guard = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let plan = guard
        .inspect_plan(&plan_token)
        .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
    let evidence = plan
        .audit_evidence
        .as_ref()
        .ok_or_else(|| "plan has no audit evidence".to_string())?;
    if evidence.job_id.as_deref() != Some(job_id.as_str()) {
        // Job finished but plan evidence is not this job's bind (consumed/superseded/cancelled).
        return Err("formal audit evidence is not bound for this job on the plan".to_string());
    }
    if matches!(evidence.decision, AuditDecision::Pending) {
        // Terminal job without terminal evidence yet (rare race) — keep polling.
        return Ok(None);
    }
    let blockers = plan.local_blockers.clone();
    Ok(Some(formal_result_from_plan_evidence(
        plan_token, evidence, blockers,
    )))
}

/// Rust-owned formal audit bound to a prepared plan token (synchronous wait).
/// When AI is off/unconfigured, returns and binds a local decision only (zero provider HTTP).
/// When prerequisites pass, starts a backend AiJob, awaits the provider, completes the job,
/// binds evidence, and returns the terminal result. Prefer `ai_start_formal_audit` + poll for
/// UI that must open while formal audit is still PENDING.
#[tauri::command]
pub async fn ai_compute_audit(
    app: AppHandle,
    request: AiFormalAuditRequest,
) -> Result<AiFormalAuditResult, String> {
    let (
        plan_token,
        snapshot_hash,
        request_generation,
        local_blockers,
        connection,
        secret,
        local_done,
    ) = resolve_local_formal_audit(&app, &request.plan_token)?;
    if let Some(result) = local_done {
        return Ok(result);
    }

    // Client title/torrent_name/sites/local_blockers are intentionally ignored.
    let _ = (
        &request.title,
        &request.torrent_name,
        &request.sites,
        &request.local_blockers,
        &request.snapshot_hash,
        &request.request_generation,
    );

    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);
    let identity = capability_identity(&connection, secret.as_ref());
    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::Audit,
            request_generation,
            snapshot_hash.clone(),
            Some(identity),
        )
    };

    // Bind PENDING+job_id before the provider call so cancel mid-flight is cooperative.
    let pending = pending_audit_result(
        plan_token.clone(),
        snapshot_hash.clone(),
        request_generation,
        local_blockers.clone(),
        job_id.clone(),
        &policy,
    );
    bind_audit_to_plan(&pending)?;

    run_provider_formal_audit(
        connection,
        secret,
        plan_token,
        snapshot_hash,
        request_generation,
        local_blockers,
        job_id,
    )
    .await
}

/// Local decision helper retained for unit-style / compatibility callers.
/// Not a public IPC surface for publish (decision authority stays on prepared plans).
///
/// Narrow allow: kept for in-crate compatibility with audit unit tests and future
/// local-only callers; intentionally unregistered so webview cannot forge decisions.
#[allow(dead_code)] // compatibility API: not referenced by production IPC path
pub fn ai_compute_audit_local(input: AuditInput) -> Result<ValidatedAudit, String> {
    let policy = RedactionPolicy::default();
    let sanitized = sanitize_audit_input(input, &policy);
    Ok(compute_decision(&sanitized))
}

/// Crate-private job lifecycle: only backend workers may start jobs.
///
/// Narrow allow on the lib target: heavily used by `#[cfg(test)]` suites under
/// `--all-targets`, but not by the production webview IPC surface (webview may
/// only start formal tasks through dedicated command entry points).
#[allow(dead_code)] // test + worker helper; not an IPC export
pub(crate) fn start_job_backend(
    kind: JobKind,
    request_generation: u64,
    snapshot_hash: impl Into<String>,
    provider_identity: Option<CapabilityIdentity>,
) -> String {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .start(kind, request_generation, snapshot_hash, provider_identity)
}

/// Crate-private job completion for backend workers only (not registered IPC).
///
/// Any completion may free a concurrency slot and promote a Queued MediaInfo job.
/// After the manager lock is released, deferred PendingMediaInfoWork is drained so
/// promoted MediaInfo jobs start without callers having to know the job kind.
pub(crate) fn complete_job_backend(
    id: &str,
    success: bool,
    error_code: Option<String>,
    summary: impl Into<String>,
) -> Result<AiJob, String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .complete(id, success, error_code, summary, None)?;
    // Do not hold the jobs lock across try_start (it reacquires jobs + pending).
    try_start_promoted_media_info_jobs();
    Ok(job)
}

/// Crate-private stale marker for backend workers only (not registered IPC).
///
/// Stale transitions free capacity via `promote_next`; drain deferred MediaInfo work
/// after releasing the manager lock so promoted jobs are not left without a worker.
///
/// Narrow allow on the lib target: exercised by unit tests and exit cleanup paths
/// that mark unfinished jobs stale; webview cannot call this directly.
#[allow(dead_code)] // test + exit-cleanup helper; not an IPC export
pub(crate) fn mark_job_stale_backend(id: &str, reason: impl Into<String>) -> Result<AiJob, String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .mark_stale(id, reason)?;
    try_start_promoted_media_info_jobs();
    Ok(job)
}

/// Sanitized cross-surface lifecycle event after preflight cancel/reconcile.
/// Never includes frozen request, paths, secrets, or provider bodies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreflightSessionChangedPayload {
    /// Opaque plan token when still known to the caller path (optional if unsafe).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_token: Option<String>,
    /// SHA-256 digest of the opaque plan token (always present; never the raw secret material).
    pub token_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Authoritative UI lifecycle after reconciliation (`cancelled` / `unavailable` / …).
    pub lifecycle: String,
    /// `invalidated` | `already_missing`
    pub token_state: PreflightTokenState,
    pub reconciled: bool,
}

fn ai_job_state_label(state: AiJobState) -> String {
    match state {
        AiJobState::Queued => "queued".to_string(),
        AiJobState::Running => "running".to_string(),
        AiJobState::Succeeded => "succeeded".to_string(),
        AiJobState::Failed => "failed".to_string(),
        AiJobState::Cancelled => "cancelled".to_string(),
        AiJobState::Stale => "stale".to_string(),
    }
}

fn emit_preflight_session_changed(
    app: &AppHandle,
    plan_token: &str,
    job_id: Option<String>,
    result: &CancelPreflightSessionResult,
    lifecycle: &str,
) {
    let payload = PreflightSessionChangedPayload {
        plan_token: Some(plan_token.to_string()),
        token_digest: plan_token_digest(plan_token),
        job_id,
        lifecycle: lifecycle.to_string(),
        token_state: result.token_state,
        reconciled: result.reconciled,
    };
    let _ = app.emit("preflight-session-changed", payload);
}

/// Atomic preflight cancellation/reconciliation (core logic; unit-testable without emit).
///
/// Accepts the plan token and optional job id. When job id is omitted, resolves the
/// related audit job from plan-bound evidence or the plan→job index. When supplied,
/// validates the relationship and rejects mismatches without acting on unrelated jobs.
///
/// On success: terminally cancels a non-terminal job, invalidates the plan token,
/// writes a bounded cancellation tombstone keyed by token digest, and returns
/// `{ job_state, token_state, reconciled }`. Repeated calls replay the tombstone.
pub fn cancel_preflight_session_core(
    plan_token: &str,
    job_id: Option<&str>,
) -> Result<(CancelPreflightSessionResult, Option<String>), String> {
    let plan_token = plan_token.trim();
    if plan_token.is_empty() {
        return Err("prepared plan token is required".to_string());
    }
    let supplied_job = job_id.map(str::trim).filter(|id| !id.is_empty());

    // 1) Tombstone hit → idempotent replay (still reject mismatched job ids).
    {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(tombstone) = registry.get_cancellation_tombstone(plan_token).cloned() {
            if let (Some(supplied), Some(recorded)) = (supplied_job, tombstone.job_id.as_deref()) {
                if supplied != recorded {
                    return Err(
                        "job id does not match the preflight session cancellation record"
                            .to_string(),
                    );
                }
            }
            let result = PlanRegistry::cancel_result_from_tombstone(&tombstone);
            return Ok((result, tombstone.job_id));
        }
    }

    // 2) Resolve related audit job from live plan evidence / plan→job index.
    let resolved_job_id = {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.resolve_related_audit_job_id(plan_token)
    };

    // Validate supplied job id against the session relationship before any mutation.
    let target_job_id: Option<String> = match (supplied_job, resolved_job_id.as_deref()) {
        (Some(supplied), Some(resolved)) if supplied == resolved => Some(supplied.to_string()),
        (Some(_), Some(_)) => {
            return Err("job id does not match the prepared plan audit session".to_string());
        }
        (Some(_), None) => {
            // Never cancel an unproven job id (plan missing or session has no audit job).
            return Err(
                "job id cannot be validated against the prepared plan audit session".to_string(),
            );
        }
        (None, Some(resolved)) => Some(resolved.to_string()),
        (None, None) => None,
    };

    // 3) Cancel / read terminal state of related job (never act when target is None).
    let mut final_job_state: Option<String> = None;
    let mut final_job_id: Option<String> = None;
    if let Some(ref id) = target_job_id {
        final_job_id = Some(id.clone());
        // Cooperative signals before flipping job state (same as ai_cancel_job).
        signal_media_cancel(id);
        signal_template_cancel(id);
        signal_recognition_cancel(id);
        {
            let mut pending = media_pending_work()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending.remove(id);
        }
        match jobs()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancel(id)
        {
            Ok(job) => {
                final_job_state = Some(ai_job_state_label(job.state));
            }
            Err(_) => {
                // Job already absent: treat as no live work for this session.
                final_job_state = None;
                // Keep job_id for tombstone correlation when client/plan knew it.
            }
        }
    }

    // 4) Invalidate plan token and write tombstone.
    let token_state = {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let removed = registry.invalidate_plan(plan_token);
        if removed {
            PreflightTokenState::Invalidated
        } else {
            PreflightTokenState::AlreadyMissing
        }
    };

    let result = {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.record_preflight_cancellation(
            plan_token,
            final_job_id.clone(),
            final_job_state,
            token_state,
            true,
        )
    };

    Ok((result, final_job_id))
}

/// Result of publish-time pending-audit suppression.
/// Keeps the frozen plan token live so PENDING + pending-ack can still publish.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CancelPendingAuditForPublishResult {
    /// Final related job state (snake_case), or null when no job was bound.
    pub job_state: Option<String>,
    /// True when the prepared plan token remains inspectable after cancel.
    pub plan_token_live: bool,
    /// Authoritative audit decision still bound on the plan (typically PENDING).
    pub decision: String,
}

/// Publish-time pending-audit cancel: cooperatively cancel the formal-audit job so late
/// completion cannot bind terminal evidence, **without** invalidating the frozen plan token.
///
/// Distinct from [`ai_cancel_preflight_session`] / plan-bound [`ai_cancel_job`] escalation,
/// which invalidate the token (return-to-edit, strip cancel, poll failure).
///
/// Callers must already have bound `pending` acknowledgement when decision is PENDING.
#[tauri::command]
pub fn ai_cancel_pending_audit_for_publish(
    plan_token: String,
    job_id: Option<String>,
) -> Result<CancelPendingAuditForPublishResult, String> {
    cancel_pending_audit_for_publish_core(&plan_token, job_id.as_deref())
}

pub(crate) fn cancel_pending_audit_for_publish_core(
    plan_token: &str,
    job_id: Option<&str>,
) -> Result<CancelPendingAuditForPublishResult, String> {
    let plan_token = plan_token.trim();
    if plan_token.is_empty() {
        return Err("prepared plan token is required".to_string());
    }

    // Plan must still be live — this path never creates or resurrects tokens.
    let (bound_job_id, decision_label, pending_ack) = {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let plan = registry
            .inspect_plan(plan_token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        let decision = match plan.publish_decision() {
            crate::ai::audit::AuditDecision::Go => "GO",
            crate::ai::audit::AuditDecision::Warning => "WARNING",
            crate::ai::audit::AuditDecision::NoGo => "NO_GO",
            crate::ai::audit::AuditDecision::Pending => "PENDING",
            crate::ai::audit::AuditDecision::LocalBlocked => "LOCAL_BLOCKED",
        }
        .to_string();
        let pending_ack = plan.acknowledgements.pending;
        let from_related = registry.resolve_related_audit_job_id(plan_token);
        (from_related, decision, pending_ack)
    };

    // Publish-time cancel is only for PENDING formal audit with bound pending ack.
    if decision_label != "PENDING" {
        return Err(format!(
            "publish-time audit cancel requires PENDING decision (got {decision_label})"
        ));
    }
    if !pending_ack {
        return Err("publish-time audit cancel requires bound pending acknowledgement".to_string());
    }

    let requested = job_id.map(str::trim).filter(|id| !id.is_empty());
    let resolved_job_id = match (requested, bound_job_id) {
        (Some(req), Some(bound)) if req != bound => {
            // Client job id must match plan-bound audit; never cancel an unrelated job.
            return Err(format!(
                "job id {req} is not bound to the prepared plan audit (expected {bound})"
            ));
        }
        (Some(req), Some(bound)) => {
            // Bound path already validated equality above.
            let _ = bound;
            Some(req.to_string())
        }
        (Some(req), None) => {
            // Reject caller-supplied IDs with no registry mapping — never cancel unbound jobs.
            let mut registry = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match registry.resolve_plan_token_for_job(req) {
                Some(resolved_token) if resolved_token == plan_token => Some(req.to_string()),
                Some(_) => {
                    return Err("job id is bound to a different prepared plan".to_string());
                }
                None => {
                    return Err(format!(
                        "job id {req} is not bound to the prepared plan audit"
                    ));
                }
            }
        }
        (None, Some(bound)) => Some(bound),
        (None, None) => None,
    };

    let job_state = if let Some(id) = resolved_job_id.as_deref() {
        match cancel_job_ordinary(id) {
            Ok(job) => Some(ai_job_state_label(job.state)),
            Err(_) => {
                // Job already terminal or missing — still publishable with plan PENDING + ack.
                jobs()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(id)
                    .map(|job| ai_job_state_label(job.state))
            }
        }
    } else {
        None
    };

    // Critical: plan token must remain live for publish_prepared_plan.
    let plan_token_live = {
        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.inspect_plan(plan_token).is_some()
    };
    if !plan_token_live {
        return Err("prepared plan token was lost during publish-time audit cancel".to_string());
    }

    Ok(CancelPendingAuditForPublishResult {
        job_state,
        plan_token_live: true,
        decision: decision_label,
    })
}

#[cfg(test)]
pub(crate) fn ai_cancel_pending_audit_for_publish_for_test(
    plan_token: String,
    job_id: Option<String>,
) -> Result<CancelPendingAuditForPublishResult, String> {
    cancel_pending_audit_for_publish_core(&plan_token, job_id.as_deref())
}

/// Atomic preflight session cancel: cancel related audit job, invalidate plan token,
/// write bounded cancellation tombstone, emit `preflight-session-changed`.
#[tauri::command]
pub fn ai_cancel_preflight_session(
    app: AppHandle,
    plan_token: String,
    job_id: Option<String>,
) -> Result<CancelPreflightSessionResult, String> {
    let (result, resolved_job_id) = cancel_preflight_session_core(&plan_token, job_id.as_deref())?;
    let lifecycle = if result.reconciled {
        "cancelled"
    } else {
        "reconciling"
    };
    emit_preflight_session_changed(
        &app,
        plan_token.trim(),
        resolved_job_id.or(job_id),
        &result,
        lifecycle,
    );
    Ok(result)
}

/// Test/helper path without AppHandle (no event emission).
#[cfg(test)]
pub(crate) fn ai_cancel_preflight_session_for_test(
    plan_token: String,
    job_id: Option<String>,
) -> Result<CancelPreflightSessionResult, String> {
    cancel_preflight_session_core(&plan_token, job_id.as_deref()).map(|(result, _)| result)
}

#[tauri::command]
pub fn ai_get_job(id: String) -> Option<AiJob> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&id)
        .cloned()
}

#[tauri::command]
pub fn ai_list_jobs() -> Vec<AiJob> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .list()
}

/// Sanitized active-job list for the global status strip (never full AiJob).
/// Ordered by start time then job id; completed jobs are omitted.
#[tauri::command]
pub fn ai_list_active_jobs() -> Vec<ActiveAiJobSummary> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .list_active_summaries()
}

/// Kind-dispatching cancel for the status strip.
///
/// - Audit / plan-bound → atomic preflight session cancel + `preflight-session-changed`
/// - Other kinds → ordinary cooperative job cancel
///
/// React never chooses the authority path; Rust resolves association here.
#[tauri::command]
pub fn ai_cancel_active_job(
    app: AppHandle,
    job_id: String,
) -> Result<ActiveAiJobCancelResult, String> {
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err("job_id is required".to_string());
    }
    let job = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .get(&job_id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())?
    };

    if job.kind == JobKind::Audit || is_plan_bound_audit_job(&job_id) {
        let plan_token = {
            let mut registry = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            registry.resolve_plan_token_for_job(&job_id)
        };
        let Some(plan_token) = plan_token else {
            // Orphan audit with no resolvable plan: ordinary cancel only (no live token).
            let cancelled = cancel_job_ordinary(&job_id)?;
            return Ok(ActiveAiJobCancelResult {
                job_id: cancelled.id,
                kind: cancelled.kind,
                job_state: ai_job_state_label(cancelled.state),
                used_preflight_session: false,
                reconciled: true,
            });
        };
        let (result, resolved_job) = cancel_preflight_session_core(&plan_token, Some(&job_id))?;
        let lifecycle = if result.reconciled {
            "cancelled"
        } else {
            "reconciling"
        };
        emit_preflight_session_changed(
            &app,
            plan_token.trim(),
            resolved_job.or(Some(job_id.clone())),
            &result,
            lifecycle,
        );
        return Ok(ActiveAiJobCancelResult {
            job_id,
            kind: JobKind::Audit,
            job_state: result
                .job_state
                .clone()
                .unwrap_or_else(|| "cancelled".to_string()),
            used_preflight_session: true,
            reconciled: result.reconciled,
        });
    }

    let cancelled = cancel_job_ordinary(&job_id)?;
    Ok(ActiveAiJobCancelResult {
        job_id: cancelled.id,
        kind: cancelled.kind,
        job_state: ai_job_state_label(cancelled.state),
        used_preflight_session: false,
        reconciled: true,
    })
}

/// Public result of strip cancel (no secrets/paths/provider bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveAiJobCancelResult {
    pub job_id: String,
    pub kind: JobKind,
    pub job_state: String,
    /// True when atomic preflight session path was used.
    pub used_preflight_session: bool,
    pub reconciled: bool,
}

fn is_plan_bound_audit_job(job_id: &str) -> bool {
    let mut registry = get_or_create_registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    registry.resolve_plan_token_for_job(job_id).is_some()
}

/// Ordinary cooperative cancel (non-audit path shared by strip and legacy cancel).
fn cancel_job_ordinary(id: &str) -> Result<AiJob, String> {
    // Signal MediaInfo child probes before flipping job state so waiters observe cancel.
    signal_media_cancel(id);
    // Signal TemplateSelection provider work so late completion cannot mint a seed.
    signal_template_cancel(id);
    // Signal Recognition provider work so late completion cannot surface a result.
    signal_recognition_cancel(id);
    // Drop any deferred probe work for this id (Queued cancel must not later spawn).
    {
        let mut pending = media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.remove(id);
    }
    let job = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .cancel(id)?;
    apply_job_kind_cancel_side_effects(id, &job);
    // Cancelling any Running job frees capacity and may promote Queued MediaInfo work.
    try_start_promoted_media_info_jobs();
    Ok(job)
}

fn apply_job_kind_cancel_side_effects(id: &str, job: &AiJob) {
    let id = id.to_string();
    if job.kind == JobKind::MediaInfo {
        if media_info_may_report_success(job.state) {
            if let Ok(mut store) = media_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                }
                retain_media_global_state(None, Some(&mut store));
            }
        } else if let Ok(mut store) = media_job_results().lock() {
            if let Some(view) = store.get_mut(&id) {
                view.state = job.state;
                view.progress = 100;
                view.error_code = job.error_code.clone();
                view.results =
                    sanitize_media_results_for_non_success(std::mem::take(&mut view.results));
            } else {
                store.insert(
                    id.clone(),
                    MediaInfoJobView {
                        job_id: id.clone(),
                        plan_token: String::new(),
                        state: job.state,
                        request_generation: job.request_generation,
                        snapshot_hash: job.snapshot_hash.clone(),
                        progress: 100,
                        error_code: job.error_code.clone(),
                        results: Vec::new(),
                    },
                );
            }
            retain_media_global_state(None, Some(&mut store));
        }
    }
    if job.kind == JobKind::TemplateSelection {
        if template_selection_may_return_recommendation(job.state) {
            if let Ok(mut store) = template_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                    view.seed = None;
                }
                retain_template_global_state(None, Some(&mut store));
            }
        } else if let Ok(mut store) = template_job_results().lock() {
            if let Some(view) = store.get_mut(&id) {
                view.recommendation = None;
                view.seed = None;
                view.state = job.state;
                view.progress = 100;
                view.error_code = job
                    .error_code
                    .clone()
                    .or_else(|| Some("CANCELLED".to_string()));
                if view.message.is_none() {
                    view.message = Some("template selection cancelled".to_string());
                }
            } else {
                store.insert(
                    id.clone(),
                    TemplateSelectionJobView {
                        job_id: id.clone(),
                        state: job.state,
                        request_generation: job.request_generation,
                        snapshot_hash: job.snapshot_hash.clone(),
                        progress: 100,
                        error_code: job
                            .error_code
                            .clone()
                            .or_else(|| Some("CANCELLED".to_string())),
                        message: Some("template selection cancelled".to_string()),
                        recommendation: None,
                        seed: None,
                    },
                );
            }
            retain_template_global_state(None, Some(&mut store));
        }
    }
    if job.kind == JobKind::Recognition {
        if recognition_may_return_result(job.state) {
            if let Ok(mut store) = recognition_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                }
                retain_recognition_global_state(None, Some(&mut store), None);
            }
        } else if let Ok(mut store) = recognition_job_results().lock() {
            if let Some(view) = store.get_mut(&id) {
                view.result = None;
                view.state = job.state;
                view.progress = 100;
                view.error_code = job
                    .error_code
                    .clone()
                    .or_else(|| Some("CANCELLED".to_string()));
                if view.message.is_none() {
                    view.message = Some("recognition cancelled".to_string());
                }
            }
            retain_recognition_global_state(None, Some(&mut store), None);
        }
    }
}

#[tauri::command]
pub fn ai_cancel_job(id: String) -> Result<AiJob, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("job id is required".to_string());
    }

    // Harden: plan-bound Audit must escalate to atomic session reconciliation so a
    // job-only cancel never leaves a live plan token with cancelled audit evidence.
    // Orphan Audit (no resolvable plan) may use ordinary cancel.
    let kind = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.get(&id).map(|job| job.kind)
    };
    if matches!(kind, Some(JobKind::Audit)) || is_plan_bound_audit_job(&id) {
        let plan_token = {
            let mut registry = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            registry.resolve_plan_token_for_job(&id)
        };
        if let Some(plan_token) = plan_token {
            // Escalate to atomic session reconciliation (no AppHandle → no event; callers
            // that need PreflightSessionChanged should use ai_cancel_active_job / session).
            let _ = cancel_preflight_session_core(&plan_token, Some(&id))?;
            return jobs()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&id)
                .cloned()
                .ok_or_else(|| {
                    "audit job reconciled via preflight session but is no longer listed".to_string()
                });
        }
    }

    cancel_job_ordinary(&id)
}

/// Read-only list of bounded, non-secret AI job debug records (no raw provider bodies/secrets).
#[tauri::command]
pub fn ai_list_debug_records() -> Vec<DebugRecord> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .list_debug_records()
}

/// Clear retained non-secret AI job debug records (also empties the durable store when configured).
///
/// Fail-closed: durable persist failure restores in-memory records and returns `Err`
/// so the webview does not report success when `records.json` still holds data.
#[tauri::command]
pub fn ai_clear_debug_records() -> Result<(), String> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear_debug_records()
}

/// Read-only export of redacted debug records to an app-local file.
///
/// Returns safe basename metadata only — never raw bundle content or absolute paths.
/// Works with AI disabled (no network / no credential access). Storage or canary
/// failures surface as `Err` without mutating job lifecycle state.
#[tauri::command]
pub fn ai_export_debug_records(app: AppHandle) -> Result<DebugExportMetadata, String> {
    let local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("debug export unavailable: {error}"))?;
    let export_dir = local_dir
        .join(DEBUG_STORE_RELATIVE_DIR)
        .join(DEBUG_EXPORT_RELATIVE_DIR);
    let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
    manager.export_debug_bundle(export_dir)
}

/// Reveal the backend-owned debug directory in the system file manager.
///
/// The directory is derived from the app-local data root; callers cannot supply
/// an arbitrary path to the opener.
#[tauri::command]
pub fn ai_open_debug_directory(app: AppHandle) -> Result<(), String> {
    let local_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "debug directory unavailable".to_string())?;
    let debug_dir = local_dir.join(DEBUG_STORE_RELATIVE_DIR);
    std::fs::create_dir_all(&debug_dir).map_err(|_| "debug directory unavailable".to_string())?;
    app.opener()
        .reveal_item_in_dir(&debug_dir)
        .map_err(|_| "debug directory could not be opened".to_string())
}

/// App-exit hook: cancel queued/running AI jobs so late completions cannot bind.
pub fn cancel_unfinished_ai_jobs_on_exit() {
    // Flip all MediaInfo cancel flags so child probes are killed.
    if let Ok(flags) = media_cancel_flags().lock() {
        for flag in flags.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Flip TemplateSelection flags so late provider completion cannot mint seeds.
    if let Ok(flags) = template_cancel_flags().lock() {
        for flag in flags.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Flip Recognition flags so late provider completion cannot surface a result.
    if let Ok(flags) = recognition_cancel_flags().lock() {
        for flag in flags.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
    // Drop deferred MediaInfo work so Queued jobs cannot spawn after exit cancel.
    media_pending_work()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
    let unfinished: Vec<String> = {
        let manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager
            .list()
            .into_iter()
            .filter(|job| !job.state.is_terminal())
            .map(|job| job.id)
            .collect()
    };
    for id in unfinished {
        signal_media_cancel(&id);
        signal_template_cancel(&id);
        signal_recognition_cancel(&id);
    }
    // Strip non-success TemplateSelection recommendations before/after cancel_unfinished.
    {
        let mut store = template_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for view in store.values_mut() {
            if !view.state.is_terminal() {
                view.recommendation = None;
                view.seed = None;
                view.state = AiJobState::Cancelled;
                view.progress = 100;
                view.error_code = Some("CANCELLED".to_string());
                view.message = Some("template selection cancelled on exit".to_string());
            }
        }
    }
    // Strip non-success Recognition results before/after cancel_unfinished.
    {
        let mut store = recognition_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for view in store.values_mut() {
            if !view.state.is_terminal() {
                view.result = None;
                view.state = AiJobState::Cancelled;
                view.progress = 100;
                view.error_code = Some("CANCELLED".to_string());
                view.message = Some("recognition cancelled on exit".to_string());
            }
        }
    }
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .cancel_unfinished();
}

#[tauri::command]
pub fn ai_build_capability_probe(
    provider: ProviderKind,
    mode: ProviderMode,
    endpoint: String,
    model: String,
    schema: Value,
    auth_mode: AuthMode,
) -> Result<crate::ai::provider::ProviderRequest, String> {
    build_probe_request(provider, mode, &endpoint, &model, &schema, auth_mode)
}

#[tauri::command]
pub fn ai_classify_capability_probe(
    provider: ProviderKind,
    mode: ProviderMode,
    status: u16,
    body: String,
) -> CapabilityProbeResult {
    classify_and_validate_probe_response(provider, mode, status, &body)
}

/// Non-secret model discovery result for the settings UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModelDiscoveryResult {
    pub models: Vec<String>,
    pub fetched_at_unix: u64,
    /// True when discovery failed and the UI should keep/allow a manual model entry.
    pub manual_fallback: bool,
    pub message: String,
}

#[cfg(debug_assertions)]
fn debug_safe_provider_url(raw: &str) -> String {
    let raw = raw.trim();
    let without_query = raw.split(['?', '#']).next().unwrap_or(raw);
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return "<invalid-url>".to_string();
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = remainder[..authority_end]
        .rsplit('@')
        .next()
        .unwrap_or("<invalid-host>");
    let path = &remainder[authority_end..];
    format!("{scheme}://{authority}{path}")
}

#[cfg(debug_assertions)]
fn debug_model_response_shape(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(Value::Object(object)) => {
            let data_items = object
                .get("data")
                .and_then(Value::as_array)
                .map_or("missing".to_string(), |items| items.len().to_string());
            format!("json-object data-items={data_items}")
        }
        Ok(Value::Array(items)) => format!("json-array items={}", items.len()),
        Ok(_) => "json-scalar".to_string(),
        Err(_) => "non-json".to_string(),
    }
}

#[cfg(test)]
mod model_discovery_debug_tests {
    use super::{
        debug_model_response_shape, debug_safe_provider_url, model_discovery_may_use_stored_secret,
        PublicConnectionConfig,
    };

    #[test]
    fn diagnostics_strip_url_secrets_and_summarize_response_without_values() {
        let safe_url = debug_safe_provider_url(
            "https://user:password@example.test/v1/models?api_key=secret#fragment",
        );
        assert_eq!(safe_url, "https://example.test/v1/models");

        let shape = debug_model_response_shape(r#"{"data":[{"id":"secret-model"}]}"#);
        assert_eq!(shape, "json-object data-items=1");
        assert!(!shape.contains("secret-model"));
    }

    #[test]
    fn stored_model_discovery_secret_requires_exact_draft_auth_identity() {
        let saved = PublicConnectionConfig::default();
        let mut draft = saved.clone();
        assert!(model_discovery_may_use_stored_secret(&draft, &saved));

        draft.endpoint = "https://gateway.example/v1".to_string();
        assert!(!model_discovery_may_use_stored_secret(&draft, &saved));

        draft.endpoint = format!("  {}/  ", saved.endpoint);
        assert!(model_discovery_may_use_stored_secret(&draft, &saved));
    }
}

fn model_discovery_may_use_stored_secret(
    draft: &PublicConnectionConfig,
    saved: &PublicConnectionConfig,
) -> bool {
    draft.provider == saved.provider
        && draft.endpoint.trim().trim_end_matches('/')
            == saved.endpoint.trim().trim_end_matches('/')
        && draft.auth_mode == saved.auth_mode
        && draft.custom_header_name.as_deref().map(str::trim)
            == saved.custom_header_name.as_deref().map(str::trim)
        && draft.credential_ref == saved.credential_ref
}

/// Discover models for a settings draft without persisting the connection or credential.
/// This explicit setup request does not require `enabled` or a selected model. When the draft
/// secret is empty, an existing stored secret is reusable only for the exact saved auth identity.
/// Failures never return secrets or response bodies; callers may keep a manual model.
#[tauri::command]
pub async fn ai_list_models(
    app: AppHandle,
    connection: PublicConnectionConfig,
    secret: Option<String>,
) -> Result<AiModelDiscoveryResult, String> {
    let saved = ai_get_settings(app);
    let draft_secret = secret
        .filter(|value| !value.is_empty())
        .map(SecretValue::new);
    #[cfg(debug_assertions)]
    let credential_source = if draft_secret.is_some() {
        "draft"
    } else if model_discovery_may_use_stored_secret(&connection, &saved) {
        "stored"
    } else {
        "missing"
    };
    #[cfg(debug_assertions)]
    eprintln!(
        "[BYOK:model-list] start provider={:?} endpoint={} auth={:?} credential_source={} cached_models={}",
        connection.provider,
        debug_safe_provider_url(&connection.endpoint),
        connection.auth_mode,
        credential_source,
        connection.discovered_models.len(),
    );
    if connection.endpoint.trim().is_empty() {
        return Err("configure a provider endpoint before refreshing models".to_string());
    }

    let secret = match draft_secret {
        Some(value) => Some(value),
        None if model_discovery_may_use_stored_secret(&connection, &saved) => {
            resolve_stored_secret(&saved)?
        }
        None if connection.auth_mode == AuthMode::None => None,
        None => {
            return Err(
                "enter a credential for this draft connection before refreshing models".to_string(),
            );
        }
    };
    if connection.auth_mode != AuthMode::None && secret.is_none() {
        return Err("AI credential is missing from the secure store".to_string());
    }

    let client = build_no_redirect_client()?;
    let request = build_models_list_request(
        connection.provider,
        &connection.endpoint,
        connection.auth_mode,
    )?;
    #[cfg(debug_assertions)]
    eprintln!(
        "[BYOK:model-list] request method={} url={}",
        request.method,
        debug_safe_provider_url(&request.url),
    );

    let send_result = send_managed_provider_request(
        &client,
        &request,
        connection.auth_mode,
        connection.custom_header_name.as_deref(),
        secret.as_ref().map(SecretValue::expose),
        connection.provider,
    )
    .await;

    let fetched_at_unix = now_unix();
    match send_result {
        Ok((status, body)) => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[BYOK:model-list] response status={} bytes={} shape={}",
                status,
                body.len(),
                debug_model_response_shape(&body),
            );
            match parse_models_list_response(connection.provider, status, &body) {
                Ok(models) if !models.is_empty() => {
                    #[cfg(debug_assertions)]
                    eprintln!("[BYOK:model-list] parsed models={}", models.len());
                    Ok(AiModelDiscoveryResult {
                        models,
                        fetched_at_unix,
                        manual_fallback: false,
                        message: "models refreshed".to_string(),
                    })
                }
                Ok(_) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[BYOK:model-list] fallback reason=no-model-ids cached_models={}",
                        connection.discovered_models.len(),
                    );
                    Ok(AiModelDiscoveryResult {
                        models: connection.discovered_models,
                        fetched_at_unix,
                        manual_fallback: true,
                        message: "provider returned no model IDs; verify the base endpoint and model-list permissions".to_string(),
                    })
                }
                Err(failure) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[BYOK:model-list] fallback kind={:?} status={:?} message={}",
                        failure.kind, failure.status, failure.message,
                    );
                    // Keep any previous cached list; UI keeps manual model entry.
                    Ok(AiModelDiscoveryResult {
                        models: connection.discovered_models,
                        fetched_at_unix,
                        manual_fallback: true,
                        message: failure.message,
                    })
                }
            }
        }
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!("[BYOK:model-list] transport fallback message={error}");
            Ok(AiModelDiscoveryResult {
                models: connection.discovered_models,
                fetched_at_unix,
                manual_fallback: true,
                message: error.chars().take(240).collect(),
            })
        }
    }
}

/// Live backend-owned structured-output capability probe using stored credentials.
/// Persists non-secret capability state/identity metadata on completion.
#[tauri::command]
pub async fn ai_run_capability_probe(app: AppHandle) -> Result<PublicCapabilityStatus, String> {
    let connection = ai_get_settings(app.clone());
    if !connection.enabled {
        return Err("AI is disabled; capability probe makes no network calls".to_string());
    }
    if !connection_is_configured(&connection) {
        return Err("complete connection and model configuration before probing".to_string());
    }

    let secret = match resolve_stored_secret(&connection)? {
        Some(value) => Some(value),
        None if connection.auth_mode == AuthMode::None => None,
        None => {
            return Err("AI credential is missing from the secure store".to_string());
        }
    };

    // Secret-aware policy for every terminal probe summary (request/build/transport/classify).
    let mut redaction_secrets = Vec::new();
    if let Some(secret) = secret.as_ref() {
        redaction_secrets.push(secret.expose().to_string());
    }
    let policy = RedactionPolicy::new(redaction_secrets);

    let identity = capability_identity(&connection, secret.as_ref());
    let schema = minimal_probe_schema();
    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::CapabilityProbe,
            0,
            identity.digest.clone(),
            Some(identity.clone()),
        )
    };

    // Mark probing in config so UI can show status even if the process is interrupted.
    let _ = crate::config::save_ai_capability(
        &app,
        Some(crate::config::AiCapabilityConfig {
            state: capability_state_to_config(CapabilityState::Probing),
            identity_digest: identity.digest.clone(),
            resolved_mode: provider_mode_to_config(connection.mode),
            output_capability: String::new(),
            message: "capability probe in progress".to_string(),
            probed_at_unix: Some(now_unix()),
        }),
    );

    let client = match build_no_redirect_client() {
        Ok(client) => client,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            let status = persist_probe_outcome(
                &app,
                &identity,
                CapabilityState::Failed,
                connection.mode,
                None,
                message.clone(),
            );
            let _ =
                complete_job_backend(&job_id, false, Some("PROVIDER_CLIENT".to_string()), message);
            return Ok(status);
        }
    };

    let attempt_modes = formal_attempt_modes(connection.provider, connection.mode);
    let mut last_result: Option<CapabilityProbeResult> = None;

    'modes: for attempted_mode in attempt_modes {
        for output_capability in probe_output_capabilities(connection.provider)
            .iter()
            .copied()
        {
            let provider_request = match build_probe_request_for_capability(
                connection.provider,
                attempted_mode,
                &connection.endpoint,
                &connection.model,
                &schema,
                connection.auth_mode,
                output_capability,
            ) {
                Ok(value) => value,
                Err(error) => {
                    last_result = Some(CapabilityProbeResult {
                        state: CapabilityState::Failed,
                        provider: connection.provider,
                        mode: attempted_mode,
                        status: 0,
                        message: redact_provider_error(&error, &policy),
                        usage: None,
                        output_capability: None,
                    });
                    break 'modes;
                }
            };

            let send_result = send_managed_provider_request(
                &client,
                &provider_request,
                connection.auth_mode,
                connection.custom_header_name.as_deref(),
                secret.as_ref().map(SecretValue::expose),
                connection.provider,
            )
            .await;

            let probe = match send_result {
                Ok((status, body)) => {
                    let mut classified = classify_and_validate_probe_response_for_capability(
                        connection.provider,
                        attempted_mode,
                        status,
                        &body,
                        output_capability,
                    );
                    classified.message = redact_provider_error(&classified.message, &policy);
                    classified
                }
                Err(error) => CapabilityProbeResult {
                    state: CapabilityState::Failed,
                    provider: connection.provider,
                    mode: attempted_mode,
                    status: 0,
                    message: redact_provider_error(&error, &policy),
                    usage: None,
                    output_capability: None,
                },
            };

            if probe.state == CapabilityState::Ready {
                last_result = Some(probe);
                break 'modes;
            }

            let failure = ProviderFailure {
                kind: match probe.state {
                    CapabilityState::Unsupported => {
                        crate::ai::provider::ProviderFailureKind::Unsupported
                    }
                    _ => crate::ai::provider::ProviderFailureKind::Server,
                },
                status: (probe.status != 0).then_some(probe.status),
                message: probe.message.clone(),
            };
            let endpoint_fallback = auto_fallback_allowed(
                connection.provider,
                connection.mode,
                attempted_mode,
                &failure,
            );
            let failed = probe.state != CapabilityState::Unsupported;
            last_result = Some(probe);
            if endpoint_fallback {
                continue 'modes;
            }
            if failed {
                break 'modes;
            }
        }

        break;
    }

    let result = last_result.unwrap_or(CapabilityProbeResult {
        state: CapabilityState::Failed,
        provider: connection.provider,
        mode: connection.mode,
        status: 0,
        message: "capability probe did not complete".to_string(),
        usage: None,
        output_capability: None,
    });

    // Final secret-aware pass before config + job terminal summary retention.
    let terminal_message = redact_provider_error(&result.message, &policy);

    let public = persist_probe_outcome(
        &app,
        &identity,
        result.state,
        result.mode,
        result.output_capability,
        terminal_message.clone(),
    );

    let success = result.state == CapabilityState::Ready;
    let _ = complete_job_backend(
        &job_id,
        success,
        if success {
            None
        } else {
            Some(match result.state {
                CapabilityState::Unsupported => "UNSUPPORTED".to_string(),
                _ => "PROBE_FAILED".to_string(),
            })
        },
        terminal_message,
    );

    Ok(public)
}

fn persist_probe_outcome(
    app: &AppHandle,
    identity: &CapabilityIdentity,
    state: CapabilityState,
    resolved_mode: ProviderMode,
    output_capability: Option<OutputCapability>,
    message: String,
) -> PublicCapabilityStatus {
    let probed_at_unix = Some(now_unix());
    let config = crate::config::AiCapabilityConfig {
        state: capability_state_to_config(state),
        identity_digest: if state == CapabilityState::Ready {
            identity.digest.clone()
        } else {
            // Keep the attempted identity so UI can explain mismatch after edits.
            identity.digest.clone()
        },
        resolved_mode: provider_mode_to_config(resolved_mode),
        output_capability: output_capability
            .map(output_capability_to_config)
            .unwrap_or_default(),
        message: message.clone(),
        probed_at_unix,
    };
    let _ = crate::config::save_ai_capability(app, Some(config));
    PublicCapabilityStatus {
        state,
        identity_digest: identity.digest.clone(),
        resolved_mode: Some(resolved_mode),
        output_capability,
        message,
        probed_at_unix,
        identity_matches: state == CapabilityState::Ready,
    }
}

/// Read current non-secret capability status; identity_matches uses stored credentials only.
#[tauri::command]
pub fn ai_get_capability_status(app: AppHandle) -> PublicCapabilityStatus {
    let connection = ai_get_settings(app);
    connection.capability.unwrap_or(PublicCapabilityStatus {
        state: CapabilityState::Unknown,
        identity_digest: String::new(),
        resolved_mode: None,
        output_capability: None,
        message: "no capability probe has been run".to_string(),
        probed_at_unix: None,
        identity_matches: false,
    })
}

#[cfg(test)]
mod debug_record_and_exit_tests {
    use super::*;

    #[test]
    fn debug_record_ipc_lists_and_clears_non_secret_metadata() {
        let _guard = command_test_guard();
        // Isolate global manager records so this IPC contract test stays deterministic.
        ai_clear_debug_records().expect("clear");
        let job_id = start_job_backend(JobKind::Audit, 9, "sha256:debug-ipc", None);
        complete_job_backend(&job_id, true, None, "debug summary only").unwrap();

        let listed = ai_list_debug_records();
        assert!(
            listed.iter().any(|record| record.job_id == job_id),
            "completed job must produce a listable debug record"
        );
        let record = listed
            .iter()
            .find(|record| record.job_id == job_id)
            .unwrap();
        assert_eq!(record.summary, "debug summary only");
        // Shape is non-secret: summary + usage counters only (no body/secret fields).
        assert!(record.usage.is_none());

        ai_clear_debug_records().expect("clear");
        assert!(ai_list_debug_records().is_empty());
    }

    #[test]
    fn debug_record_ipc_redacts_absolute_paths_in_summary() {
        let _guard = command_test_guard();
        ai_clear_debug_records().expect("clear");
        let job_id = start_job_backend(JobKind::Audit, 10, "sha256:debug-path", None);
        complete_job_backend(
            &job_id,
            false,
            Some("X".into()),
            "failed reading /Users/owen/secret/file",
        )
        .unwrap();
        let listed = ai_list_debug_records();
        let record = listed
            .iter()
            .find(|record| record.job_id == job_id)
            .expect("record");
        assert!(
            !record.summary.contains("/Users/owen"),
            "list IPC must not surface absolute paths: {}",
            record.summary
        );
        assert!(record.summary.contains("[PATH_REDACTED]"));
        ai_clear_debug_records().expect("clear");
    }

    #[test]
    fn app_exit_hook_cancels_unfinished_jobs() {
        let _guard = command_test_guard();
        let running = start_job_backend(JobKind::Audit, 1, "sha256:exit-run", None);
        let queued = start_job_backend(JobKind::Audit, 1, "sha256:exit-queue", None);
        cancel_unfinished_ai_jobs_on_exit();
        assert_eq!(ai_get_job(running).unwrap().state, AiJobState::Cancelled);
        assert_eq!(ai_get_job(queued).unwrap().state, AiJobState::Cancelled);
    }
}

#[cfg(test)]
mod formal_audit_lifecycle_tests {
    use super::*;

    fn sample_formal_result(job_id: &str, decision_findings: Vec<Finding>) -> AiFormalAuditResult {
        local_audit_result(
            "plan-token-test".to_string(),
            "sha256:test".to_string(),
            1,
            Vec::new(),
            decision_findings,
            true,
            Some(job_id.to_string()),
            &RedactionPolicy::default(),
        )
    }

    fn prepare_pending_audit_session(snapshot: &str, generation: u64) -> (String, String) {
        let job_id = start_job_backend(JobKind::Audit, generation, snapshot, None);
        let token = {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .prepare_plan(snapshot.to_string(), generation)
                .expect("prepare")
        };
        let pending = pending_audit_result(
            token.clone(),
            snapshot.to_string(),
            generation,
            Vec::new(),
            job_id.clone(),
            &RedactionPolicy::default(),
        );
        bind_audit_to_plan(&pending).expect("bind pending");
        (token, job_id)
    }

    #[test]
    fn cancel_pending_audit_for_publish_keeps_token_and_pending_publishable() {
        use crate::ai::audit::Acknowledgements;

        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:publish-pending-ack", 21);
        {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .set_acknowledgements(
                    &token,
                    Acknowledgements {
                        warning: false,
                        critical: false,
                        pending: true,
                    },
                )
                .expect("pending ack");
            let plan = guard.inspect_plan(&token).expect("plan live");
            assert_eq!(
                plan.publish_decision(),
                crate::ai::audit::AuditDecision::Pending
            );
            assert!(plan.can_publish_now());
        }

        let result =
            ai_cancel_pending_audit_for_publish_for_test(token.clone(), Some(job_id.clone()))
                .expect("publish-time cancel");
        assert!(result.plan_token_live);
        assert_eq!(result.decision, "PENDING");
        assert_eq!(result.job_state.as_deref(), Some("cancelled"));
        assert_eq!(
            ai_get_job(job_id.clone()).map(|job| job.state),
            Some(AiJobState::Cancelled)
        );

        // Frozen token remains inspectable and PENDING+ack remains publishable.
        {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let plan = guard.inspect_plan(&token).expect("token must survive");
            assert_eq!(
                plan.publish_decision(),
                crate::ai::audit::AuditDecision::Pending
            );
            assert!(plan.can_publish_now());
            // Session cancel would tombstone; publish-time path must not.
            assert!(guard.get_cancellation_tombstone(&token).is_none());
        }

        // Unbound caller-supplied job id must be rejected (no registry mapping).
        let (token_unbound, _) = prepare_pending_audit_session("sha256:publish-unbound-job", 23);
        {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .set_acknowledgements(
                    &token_unbound,
                    Acknowledgements {
                        warning: false,
                        critical: false,
                        pending: true,
                    },
                )
                .expect("pending ack");
            let snap = guard
                .inspect_plan(&token_unbound)
                .expect("plan")
                .snapshot_hash
                .clone();
            guard
                .bind_audit_evidence(
                    &token_unbound,
                    PlanAuditEvidence {
                        decision: crate::ai::audit::AuditDecision::Pending,
                        findings: vec![],
                        unknown_codes: vec![],
                        formal_ran: false,
                        job_id: None,
                        snapshot_hash: snap,
                        request_generation: 23,
                    },
                )
                .expect("rebind without job");
            // bind_audit_evidence clears acks — re-bind pending for publish-time cancel gate.
            guard
                .set_acknowledgements(
                    &token_unbound,
                    Acknowledgements {
                        warning: false,
                        critical: false,
                        pending: true,
                    },
                )
                .expect("re-ack pending");
        }
        let err = ai_cancel_pending_audit_for_publish_for_test(
            token_unbound,
            Some("job-unrelated-forged".into()),
        )
        .expect_err("unbound job id must fail");
        assert!(err.contains("not bound"), "unexpected error: {err}");

        // Missing pending ack must fail closed.
        let (token_no_ack, job_no_ack) =
            prepare_pending_audit_session("sha256:publish-no-pending-ack", 24);
        let err_ack = ai_cancel_pending_audit_for_publish_for_test(token_no_ack, Some(job_no_ack))
            .expect_err("missing pending ack");
        assert!(
            err_ack.contains("pending acknowledgement"),
            "unexpected error: {err_ack}"
        );

        // Contrasting regression: generic ai_cancel_job escalates and invalidates.
        let (token2, job2) = prepare_pending_audit_session("sha256:cancel-job-escalates", 22);
        let _ = ai_cancel_job(job2).expect("escalating cancel");
        assert!(get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .inspect_plan(&token2)
            .is_none());
    }

    #[test]
    fn cancel_preflight_session_running_job_invalidates_and_tombstones() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-run", 11);
        let result = ai_cancel_preflight_session_for_test(token.clone(), Some(job_id.clone()))
            .expect("cancel running");
        assert!(result.reconciled);
        assert_eq!(result.token_state, PreflightTokenState::Invalidated);
        assert_eq!(result.job_state.as_deref(), Some("cancelled"));
        assert_eq!(
            ai_get_job(job_id.clone()).map(|job| job.state),
            Some(AiJobState::Cancelled)
        );
        {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(guard.inspect_plan(&token).is_none());
            assert!(guard.get_cancellation_tombstone(&token).is_some());
        }
    }

    #[test]
    fn cancel_preflight_session_terminal_job_still_invalidates_token() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-term", 12);
        complete_job_backend(&job_id, true, None, "already done").unwrap();
        let result = ai_cancel_preflight_session_for_test(token.clone(), Some(job_id.clone()))
            .expect("cancel terminal");
        assert!(result.reconciled);
        assert_eq!(result.token_state, PreflightTokenState::Invalidated);
        assert_eq!(result.job_state.as_deref(), Some("succeeded"));
        assert!(get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .inspect_plan(&token)
            .is_none());
    }

    #[test]
    fn cancel_preflight_session_token_only_after_client_job_id_loss() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-token-only", 13);
        let result =
            ai_cancel_preflight_session_for_test(token.clone(), None).expect("token-only cancel");
        assert!(result.reconciled);
        assert_eq!(result.token_state, PreflightTokenState::Invalidated);
        assert_eq!(result.job_state.as_deref(), Some("cancelled"));
        assert_eq!(
            ai_get_job(job_id).map(|job| job.state),
            Some(AiJobState::Cancelled)
        );
    }

    #[test]
    fn cancel_preflight_session_already_missing_and_tombstone_replay() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-replay", 14);
        let first = ai_cancel_preflight_session_for_test(token.clone(), Some(job_id.clone()))
            .expect("first cancel");
        assert_eq!(first.token_state, PreflightTokenState::Invalidated);

        let second = ai_cancel_preflight_session_for_test(token.clone(), Some(job_id.clone()))
            .expect("replay");
        assert_eq!(second, first);
        assert!(second.reconciled);

        // Token already gone without prior cancel-session (plain invalidate) → already_missing.
        let (token2, job_id2) = prepare_pending_audit_session("sha256:cancel-missing", 15);
        {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            assert!(guard.invalidate_plan(&token2));
        }
        // Index still resolves job after plain invalidate.
        let missing = ai_cancel_preflight_session_for_test(token2.clone(), Some(job_id2.clone()))
            .expect("already missing path");
        assert_eq!(missing.token_state, PreflightTokenState::AlreadyMissing);
        assert!(missing.reconciled);
        assert_eq!(missing.job_state.as_deref(), Some("cancelled"));

        let replay_missing =
            ai_cancel_preflight_session_for_test(token2, Some(job_id2)).expect("tombstone replay");
        assert_eq!(replay_missing, missing);
    }

    #[test]
    fn cancel_preflight_session_mismatched_job_is_error() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-mismatch", 16);
        let other = start_job_backend(JobKind::Audit, 16, "sha256:other", None);
        let err = ai_cancel_preflight_session_for_test(token.clone(), Some(other.clone()))
            .expect_err("mismatched job");
        assert!(
            err.contains("does not match") || err.contains("validated"),
            "{err}"
        );
        // Session must remain live after rejected mismatch.
        assert!(get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .inspect_plan(&token)
            .is_some());
        let session_state = ai_get_job(job_id.clone()).expect("session job").state;
        assert!(
            !session_state.is_terminal(),
            "mismatched cancel must not terminate session job: {session_state:?}"
        );
        // Unrelated job must not be cancelled.
        let other_state = ai_get_job(other).expect("other job").state;
        assert!(
            !other_state.is_terminal(),
            "mismatched cancel must not act on unrelated job: {other_state:?}"
        );

        // After successful cancel, mismatched job on tombstone also errors.
        ai_cancel_preflight_session_for_test(token.clone(), Some(job_id)).expect("cancel session");
        let err_after = ai_cancel_preflight_session_for_test(token, Some("job-unrelated".into()))
            .expect_err("tombstone mismatch");
        assert!(
            err_after.contains("does not match") || err_after.contains("cancellation record"),
            "{err_after}"
        );
    }

    #[test]
    fn cancel_preflight_session_repeated_returns_recorded_result() {
        let _guard = command_test_guard();
        let (token, job_id) = prepare_pending_audit_session("sha256:cancel-idempotent", 17);
        let first = ai_cancel_preflight_session_for_test(token.clone(), None).expect("first");
        let second =
            ai_cancel_preflight_session_for_test(token.clone(), Some(job_id)).expect("second");
        let third = ai_cancel_preflight_session_for_test(token, None).expect("third");
        assert_eq!(first, second);
        assert_eq!(second, third);
        assert!(first.reconciled);
    }

    #[test]
    fn late_success_after_cancel_does_not_bind_terminal_evidence() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Audit, 1, "sha256:test", None);
        ai_cancel_job(job_id.clone()).unwrap();

        // Would-be formal GO must not bind when the job is already Cancelled.
        let err = complete_and_bind_formal_audit(
            &job_id,
            true,
            None,
            "late success",
            sample_formal_result(&job_id, Vec::new()),
        )
        .expect_err("cancelled job must reject terminal bind");
        assert!(err.contains("cancelled"), "{err}");
        assert!(!formal_audit_may_bind_terminal_evidence(
            ai_get_job(job_id).unwrap().state
        ));
    }

    #[test]
    fn poll_rejects_cancelled_job_without_forging_terminal_evidence() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Audit, 3, "sha256:poll", None);
        let token = {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .prepare_plan("sha256:poll".to_string(), 3)
                .expect("prepare")
        };
        let pending = pending_audit_result(
            token.clone(),
            "sha256:poll".to_string(),
            3,
            Vec::new(),
            job_id.clone(),
            &RedactionPolicy::default(),
        );
        bind_audit_to_plan(&pending).expect("bind pending");

        ai_cancel_job(job_id.clone()).unwrap();
        let err =
            ai_poll_formal_audit(token, job_id).expect_err("cancelled must not poll as success");
        assert!(
            err.contains("cancelled") || err.contains("PENDING") || err.contains("preserved"),
            "{err}"
        );
    }

    #[test]
    fn poll_returns_none_while_job_still_running() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Audit, 4, "sha256:running", None);
        let token = {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            guard
                .prepare_plan("sha256:running".to_string(), 4)
                .expect("prepare")
        };
        let pending = pending_audit_result(
            token.clone(),
            "sha256:running".to_string(),
            4,
            Vec::new(),
            job_id.clone(),
            &RedactionPolicy::default(),
        );
        bind_audit_to_plan(&pending).expect("bind pending");

        let polled = ai_poll_formal_audit(token, job_id.clone()).expect("running poll");
        assert!(
            polled.is_none(),
            "running job must not surface terminal evidence"
        );
        let _ = ai_cancel_job(job_id);
    }

    #[test]
    fn late_provider_failure_after_stale_does_not_bind_terminal_evidence() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Audit, 2, "sha256:stale", None);
        mark_job_stale_backend(&job_id, "app exit").unwrap();

        let err = complete_and_bind_formal_audit(
            &job_id,
            false,
            Some("PROVIDER_HTTP".to_string()),
            "late provider failure",
            sample_formal_result(
                &job_id,
                vec![Finding {
                    code: "PROVIDER_WARNING".to_string(),
                    severity: FindingSeverity::Warning,
                    message: "provider down".to_string(),
                    evidence_path: None,
                }],
            ),
        )
        .expect_err("stale job must reject terminal bind");
        assert!(err.contains("stale"), "{err}");
        assert!(!formal_audit_may_bind_terminal_evidence(
            ai_get_job(job_id).unwrap().state
        ));
    }

    #[test]
    fn formal_success_findings_redact_canary_api_key_before_bind_result() {
        // Simulates structured provider findings that echo a live credential into
        // message and evidence_path; the active secret-aware policy must strip it
        // before decision calculation and the returned/bound IPC payload.
        const CANARY: &str = "sk-live-canary-formal-audit-key-9f3c2a1b";
        let policy = RedactionPolicy::new([CANARY]);
        let findings = vec![Finding {
            code: "PROVIDER_WARNING".to_string(),
            severity: FindingSeverity::Warning,
            message: format!("provider echoed credential {CANARY} in audit note"),
            evidence_path: Some(format!("notes/contains-{CANARY}-fragment")),
        }];
        let result = local_audit_result(
            "plan-token-canary".to_string(),
            "sha256:canary".to_string(),
            7,
            Vec::new(),
            findings,
            true,
            Some("job-canary".to_string()),
            &policy,
        );

        assert_eq!(result.decision, AuditDecision::Warning);
        assert_eq!(result.findings.len(), 1);
        assert!(
            !result.findings[0].message.contains(CANARY),
            "canary must not appear in finding message after secret-aware sanitize: {}",
            result.findings[0].message
        );
        assert!(
            result.findings[0].message.contains("[REDACTED]"),
            "message should carry redaction marker"
        );
        let evidence = result.findings[0]
            .evidence_path
            .as_deref()
            .unwrap_or_default();
        assert!(
            !evidence.contains(CANARY),
            "canary must not appear in evidence_path of bound result: {evidence}"
        );
        assert!(
            evidence.contains("[REDACTED]"),
            "evidence_path should retain relative shape with secret replaced: {evidence}"
        );

        // Serialize as Tauri IPC would: no raw canary in the wire payload.
        let wire = serde_json::to_string(&result).expect("result serializes");
        assert!(
            !wire.contains(CANARY),
            "canary must not reach IPC serialization: {wire}"
        );
    }

    #[test]
    fn formal_local_path_keeps_default_policy_when_no_secret() {
        // Paths without an active credential keep default-policy behavior.
        let result = local_audit_result(
            "plan-token-default".to_string(),
            "sha256:default".to_string(),
            1,
            vec!["blocker at /Users/owen/secret".to_string()],
            vec![Finding {
                code: "MISSING_TITLE".to_string(),
                severity: FindingSeverity::Warning,
                message: "missing title near /private/tmp/video.mkv".to_string(),
                evidence_path: Some("torrent/video.mkv".to_string()),
            }],
            false,
            None,
            &RedactionPolicy::default(),
        );
        assert_eq!(result.decision, AuditDecision::LocalBlocked);
        assert!(
            !result.local_blockers[0].contains("/Users/owen"),
            "default policy still path-redacts blockers"
        );
        assert!(
            !result.findings[0].message.contains("/private"),
            "default policy still path-redacts finding messages"
        );
        assert_eq!(
            result.findings[0].evidence_path.as_deref(),
            Some("torrent/video.mkv"),
            "safe relative evidence paths survive default policy"
        );
    }

    #[test]
    fn ai_disabled_local_only_result_does_not_invent_media_warning() {
        let _guard = command_test_guard();
        let token = {
            let mut registry = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            registry
                .prepare_plan("sha256:disabled-media".to_string(), 1)
                .expect("prepare local-only plan")
        };

        let result = local_audit_result(
            token.clone(),
            "sha256:disabled-media".to_string(),
            1,
            Vec::new(),
            Vec::new(),
            false,
            None,
            &RedactionPolicy::default(),
        );

        assert_eq!(result.decision, AuditDecision::Go);
        assert!(result.findings.is_empty());

        let mut registry = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.invalidate_plan(&token);
    }

    #[test]
    fn context_failure_binds_warning_without_formal_ran() {
        // PAYLOAD_TOO_LARGE / identity drift / other context errors must complete as a
        // non-provider warning (formal_ran=false) — never truncate into a prompt.
        let too_large = context_failure_finding(ContextError::PayloadTooLarge {
            bytes: 999_999,
            ceiling: 64,
        });
        assert_eq!(too_large.code, "PAYLOAD_TOO_LARGE");
        assert_eq!(too_large.severity, FindingSeverity::Warning);
        assert!(too_large.message.starts_with("PAYLOAD_TOO_LARGE:"));

        let drift = context_failure_finding(ContextError::IdentityDrift(
            "torrent digest mismatch".into(),
        ));
        assert_eq!(drift.code, "PROVIDER_WARNING");
        assert!(drift.message.contains("torrent digest mismatch"));

        let result = local_audit_result(
            "plan-token-context".to_string(),
            "sha256:context".to_string(),
            3,
            Vec::new(),
            vec![too_large],
            false,
            Some("job-context".to_string()),
            &RedactionPolicy::default(),
        );
        assert!(
            !result.formal_ran,
            "context failure must not claim provider ran"
        );
        assert_eq!(result.decision, AuditDecision::Warning);
        assert_eq!(result.findings[0].code, "PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn formal_audit_request_ignores_deprecated_client_fields_on_deserialize() {
        // Wire compatibility: old clients may still send title/torrent_name/sites/blockers.
        let raw = serde_json::json!({
            "plan_token": "plan_only",
            "title": "client-title-must-not-drive-prompt",
            "torrent_name": "client.torrent",
            "sites": ["nyaa"],
            "local_blockers": ["client-blocker"],
            "snapshot_hash": "sha256:client-forged",
            "request_generation": 99
        });
        let request: AiFormalAuditRequest =
            serde_json::from_value(raw).expect("deserialize with deprecated fields");
        assert_eq!(request.plan_token, "plan_only");
        // Fields remain parseable for serde compatibility but must not be treated as authority
        // by resolve_local_formal_audit / run_provider_formal_audit (covered by call sites).
        assert_eq!(
            request.title.as_deref(),
            Some("client-title-must-not-drive-prompt")
        );
        assert_eq!(request.local_blockers, vec!["client-blocker".to_string()]);
        assert_eq!(
            request.snapshot_hash.as_deref(),
            Some("sha256:client-forged")
        );
    }
}

#[tauri::command]
pub fn ai_connection_identity(
    config: PublicConnectionConfig,
    secret: Option<String>,
) -> CapabilityIdentity {
    CapabilityIdentity::from_connection(
        config.provider,
        &config.endpoint,
        &config.model,
        config.mode,
        config.auth_mode,
        config.custom_header_name.as_deref(),
        secret.as_deref(),
    )
}

/// Compile-time / type-privacy canary: ensures `SecretValue` stays private to this
/// module and Debug formatting never becomes a public IPC export path.
///
/// Narrow allow: intentionally unreferenced at runtime; retained so refactors that
/// accidentally make `SecretValue` public or loggable fail review of this sentinel.
#[allow(dead_code)] // type-privacy sentinel; not a runtime path
fn _secret_type_is_private(secret: SecretValue) -> String {
    format!("{secret:?}")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Restart-safe credential candidate id.
///
/// Combines process identity, high-resolution wall time, and a process-local monotonic counter
/// so IDs remain distinct across concurrent saves and process restarts (unix-second + reset
/// counter alone could reuse an active ref after restart). Keeps the `connection-` prefix.
fn unique_connection_candidate_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    format!("connection-{pid}-{nanos}-{seq}")
}

#[cfg(test)]
mod candidate_id_tests {
    use super::unique_connection_candidate_id;

    #[test]
    fn candidate_ids_are_unique_and_restart_resistant_by_construction() {
        let first = unique_connection_candidate_id();
        let second = unique_connection_candidate_id();
        assert_ne!(first, second, "concurrent saves must not share an id");
        assert!(
            first.starts_with("connection-") && second.starts_with("connection-"),
            "ids must keep the connection- prefix without embedding secrets"
        );

        // Format: connection-{pid}-{nanos}-{seq} — process identity + high-res time + counter.
        let pid = std::process::id().to_string();
        for id in [&first, &second] {
            let rest = id.strip_prefix("connection-").expect("connection- prefix");
            let mut parts = rest.splitn(3, '-');
            let id_pid = parts.next().expect("pid component");
            let id_nanos = parts.next().expect("nanos component");
            let id_seq = parts.next().expect("seq component");
            assert_eq!(id_pid, pid, "candidate must embed process identity");
            assert!(
                !id_nanos.is_empty() && id_nanos.chars().all(|c| c.is_ascii_digit()),
                "high-resolution time component must be numeric nanos: {id}"
            );
            assert!(
                !id_seq.is_empty() && id_seq.chars().all(|c| c.is_ascii_digit()),
                "counter component must be numeric: {id}"
            );
            // Nanos alone is restart-resistant vs second-granularity ids; pid further
            // separates concurrent processes that might share a counter restart epoch.
            assert!(
                id_nanos.len() >= 10,
                "nanos component should be high-resolution (not unix seconds only): {id}"
            );
        }

        let first_seq = first.rsplit('-').next().unwrap_or_default();
        let second_seq = second.rsplit('-').next().unwrap_or_default();
        assert_ne!(
            first_seq, second_seq,
            "monotonic counter must differ even if nanos matched"
        );
    }
}

#[cfg(test)]
mod capability_gate_tests {
    use super::*;
    use crate::ai::credentials::PublicCapabilityStatus;
    use crate::ai::provider::CapabilityState;

    fn configured_connection() -> PublicConnectionConfig {
        PublicConnectionConfig {
            provider: ProviderKind::OpenAi,
            endpoint: "https://example.test/v1".into(),
            model: "gpt-test".into(),
            mode: ProviderMode::Auto,
            auth_mode: AuthMode::Bearer,
            custom_header_name: None,
            credential_ref: Some(CredentialRef {
                id: "cred-1".into(),
            }),
            enabled: true,
            capability: None,
            discovered_models: Vec::new(),
            models_fetched_at_unix: None,
            credential_session_only: false,
        }
    }

    #[test]
    fn formal_validation_retry_is_exactly_one_additional_attempt() {
        assert_eq!(FORMAL_PROVIDER_MAX_TOKENS, 4096);
        assert_eq!(FORMAL_PROVIDER_ATTEMPTS, 2);
        assert!(formal_retry_remaining(0));
        assert!(!formal_retry_remaining(1));
        let prompt = validation_retry_prompt("可信原始输入");
        assert!(prompt.contains("可信原始输入"));
        assert!(prompt.contains("上一次返回未通过"));
    }

    #[test]
    fn formal_gate_rejects_missing_or_mismatched_capability() {
        let secret = SecretValue::new("sk-test");
        let mut connection = configured_connection();
        let err = require_ready_capability_identity(&connection, Some(&secret)).unwrap_err();
        assert!(err.contains("AI settings"), "{err}");

        let identity = capability_identity(&connection, Some(&secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Failed,
            identity_digest: identity.digest.clone(),
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: None,
            message: "failed".into(),
            probed_at_unix: Some(1),
            identity_matches: false,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_err());

        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: "sha256:other".into(),
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: Some(OutputCapability::StrictSchema),
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: false,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_err());

        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: Some(OutputCapability::StrictSchema),
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_ok());
    }

    #[test]
    fn formal_gate_rejects_when_secret_changes_without_reprobe() {
        let mut connection = configured_connection();
        let old_secret = SecretValue::new("old-secret");
        let identity = capability_identity(&connection, Some(&old_secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Responses),
            output_capability: Some(OutputCapability::StrictSchema),
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        let new_secret = SecretValue::new("new-secret");
        let err = require_ready_capability_identity(&connection, Some(&new_secret)).unwrap_err();
        assert!(err.contains("capability probe"), "{err}");
    }

    #[test]
    fn formal_gate_rejects_legacy_ready_record_without_output_tier() {
        let secret = SecretValue::new("sk-test");
        let mut connection = configured_connection();
        let identity = capability_identity(&connection, Some(&secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: None,
            message: "legacy ready".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_err());
        apply_public_identity_matches(&mut connection, Some(&secret));
        assert!(!connection.capability.unwrap().identity_matches);
    }

    #[test]
    fn disabled_connection_is_not_configured_for_formal_provider_paths() {
        let mut connection = configured_connection();
        connection.enabled = false;
        assert!(!connection_is_configured(&connection));
    }

    #[test]
    fn public_capability_from_config_maps_ready_state() {
        let status = public_capability_from_config(&crate::config::AiCapabilityConfig {
            state: "ready".into(),
            identity_digest: "sha256:abc".into(),
            resolved_mode: "chat".into(),
            output_capability: "json_object".into(),
            message: "ok".into(),
            probed_at_unix: Some(42),
        });
        assert_eq!(status.state, CapabilityState::Ready);
        assert_eq!(status.resolved_mode, Some(ProviderMode::Chat));
        assert_eq!(status.output_capability, Some(OutputCapability::JsonObject));
        assert_eq!(status.identity_digest, "sha256:abc");
        assert!(!status.identity_matches);
    }

    #[test]
    fn formal_modes_prefer_ready_resolved_chat_over_auto_ladder() {
        let mut connection = configured_connection();
        connection.mode = ProviderMode::Auto;
        let secret = SecretValue::new("sk-test");
        let identity = capability_identity(&connection, Some(&secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: Some(OutputCapability::JsonObject),
            message: "ready via chat".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        assert_eq!(
            formal_modes_for_connection(&connection),
            vec![ProviderMode::Chat],
            "Auto that resolved to Chat must not reopen Responses for formal work"
        );

        // Explicit Responses remains Responses regardless of a stale resolved mode field
        // only when capability is not Ready — missing Ready falls back to configured Auto ladder.
        connection.capability = None;
        assert_eq!(
            formal_modes_for_connection(&connection),
            vec![ProviderMode::Responses, ProviderMode::Chat]
        );

        connection.mode = ProviderMode::Responses;
        assert_eq!(
            formal_modes_for_connection(&connection),
            vec![ProviderMode::Responses]
        );
    }

    #[test]
    fn disabled_public_connection_projection_skips_secret_gate() {
        let mut connection = configured_connection();
        connection.enabled = false;
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: "sha256:stale".into(),
            resolved_mode: Some(ProviderMode::Chat),
            output_capability: Some(OutputCapability::StrictSchema),
            message: "stale".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        assert!(!may_read_credential_store_for_settings(&connection));
        apply_public_identity_matches(&mut connection, None);
        assert!(!connection.capability.unwrap().identity_matches);
    }
}

#[cfg(test)]
mod recognition_command_tests {
    use super::*;
    use crate::ai::credentials::PublicCapabilityStatus;
    use crate::ai::provider::CapabilityState;
    use crate::ai::recognition::{
        bind_recognition_result, recognition_from_provider_outcome, sanitize_recognition_context,
        RECOGNITION_SCHEMA_VERSION,
    };
    use serde_json::json;

    fn configured_connection() -> PublicConnectionConfig {
        PublicConnectionConfig {
            provider: ProviderKind::OpenAi,
            endpoint: "https://example.test/v1".into(),
            model: "gpt-test".into(),
            mode: ProviderMode::Auto,
            auth_mode: AuthMode::Bearer,
            custom_header_name: None,
            credential_ref: Some(CredentialRef {
                id: "cred-recog".into(),
            }),
            enabled: true,
            capability: None,
            discovered_models: Vec::new(),
            models_fetched_at_unix: None,
            credential_session_only: false,
        }
    }

    #[test]
    fn recognition_capability_gate_requires_ready_identity() {
        let secret = SecretValue::new("sk-recog-test");
        let mut connection = configured_connection();
        let err = require_ready_capability_identity(&connection, Some(&secret)).unwrap_err();
        assert!(
            err.contains("capability probe") || err.contains("AI settings"),
            "{err}"
        );

        let identity = capability_identity(&connection, Some(&secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Responses),
            output_capability: Some(OutputCapability::JsonObject),
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_ok());

        // Disabled / unconfigured connections are not formal-provider ready paths.
        connection.enabled = false;
        assert!(!connection_is_configured(&connection));
    }

    #[test]
    fn recognition_provider_failure_is_not_empty_success() {
        let err = recognition_from_provider_outcome(None, Some("provider 429 rate limited"))
            .expect_err("missing structured must fail");
        assert!(err.contains("429") || err.contains("rate"), "{err}");

        let empty_ok = recognition_from_provider_outcome(
            Some(&json!({
                "episode": null,
                "resolution": null,
                "suggested_title": null
            })),
            Some("should be ignored"),
        )
        .expect("schema-valid null candidates are empty success");
        assert!(empty_ok.episode.is_none());
        assert!(empty_ok.resolution.is_none());
        assert!(empty_ok.suggested_title.is_none());
    }

    #[test]
    fn recognition_job_kind_and_schema_version_are_stable() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Recognition, 11, "sha256:recog", None);
        let job = ai_get_job(job_id.clone()).expect("job");
        assert_eq!(job.kind, JobKind::Recognition);
        assert_eq!(job.request_generation, 11);
        assert_eq!(job.snapshot_hash, "sha256:recog");
        assert_eq!(RECOGNITION_SCHEMA_VERSION, "recognition_v1");
        let _ = complete_job_backend(&job_id, false, Some("TEST".into()), "cleanup");
    }

    #[test]
    fn recognition_request_context_rejects_path_like_torrent_name() {
        let policy = RedactionPolicy::default();
        let err = sanitize_recognition_context(
            "/Users/secret/show.torrent",
            r"(?P<ep>\d+)",
            r"(?P<res>1080p)",
            "<ep> <res>",
            &policy,
        )
        .expect_err("absolute torrent name must fail");
        assert!(
            err.contains("torrent_name") || err.contains("path"),
            "{err}"
        );
    }

    fn sample_recognition_result(job_id: &str) -> RecognitionResult {
        bind_recognition_result(
            crate::ai::recognition::RecognitionOutput {
                episode: Some(crate::ai::recognition::RecognitionCandidate {
                    value: "01".into(),
                    confidence: 0.9,
                    evidence: "E01 token".into(),
                }),
                resolution: None,
                suggested_title: None,
            },
            3,
            "sha256:recog-poll".into(),
            job_id.to_string(),
        )
    }

    #[test]
    fn poll_recognition_returns_none_until_terminal() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Recognition, 3, "sha256:recog-poll", None);
        store_recognition_view(RecognitionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Running,
            request_generation: 3,
            snapshot_hash: "sha256:recog-poll".into(),
            progress: 35,
            error_code: None,
            message: Some("requesting provider recognition".into()),
            result: None,
        });
        assert!(ai_poll_recognition(job_id.clone()).unwrap().is_none());

        complete_job_backend(&job_id, true, None, "ok").unwrap();
        store_recognition_view(RecognitionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Succeeded,
            request_generation: 3,
            snapshot_hash: "sha256:recog-poll".into(),
            progress: 100,
            error_code: None,
            message: Some("recognition completed".into()),
            result: Some(sample_recognition_result(&job_id)),
        });
        let terminal = ai_poll_recognition(job_id).unwrap().expect("terminal");
        assert_eq!(terminal.state, AiJobState::Succeeded);
        assert!(terminal.result.is_some());
        assert_eq!(
            terminal
                .result
                .as_ref()
                .and_then(|item| item.episode.as_ref())
                .map(|item| item.value.as_str()),
            Some("01")
        );
    }

    #[test]
    fn cancel_recognition_strips_result_and_blocks_late_success() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Recognition, 5, "sha256:recog-cancel", None);
        let flag = Arc::new(AtomicBool::new(false));
        recognition_cancel_flags()
            .lock()
            .unwrap()
            .insert(job_id.clone(), Arc::clone(&flag));
        store_recognition_view(RecognitionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Running,
            request_generation: 5,
            snapshot_hash: "sha256:recog-cancel".into(),
            progress: 50,
            error_code: None,
            message: Some("in flight".into()),
            // Race result that must be discarded on cancel-before-success.
            result: Some(sample_recognition_result(&job_id)),
        });

        let cancelled = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        assert!(flag.load(Ordering::Relaxed), "cancel must signal flag");

        // Late complete cannot resurrect Succeeded or keep a recognition result.
        let late = complete_job_backend(&job_id, true, None, "late success").unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);

        let terminal = ai_poll_recognition(job_id).unwrap().expect("terminal");
        assert_eq!(terminal.state, AiJobState::Cancelled);
        assert!(
            terminal.result.is_none(),
            "cancelled must not surface recognition result"
        );
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("CANCELLED"),
            "{:?}",
            terminal.error_code
        );
    }

    #[test]
    fn failed_recognition_never_returns_result() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::Recognition, 2, "sha256:recog-fail", None);
        let view = finish_recognition_failure(
            &job_id,
            2,
            "sha256:recog-fail",
            Some("RECOGNITION_INVALID".into()),
            "provider recognition failed schema validation",
        );
        assert_eq!(view.state, AiJobState::Failed);
        assert!(view.result.is_none());
        assert_eq!(view.error_code.as_deref(), Some("RECOGNITION_INVALID"));

        let polled = ai_poll_recognition(job_id).unwrap().expect("terminal");
        assert_eq!(polled.state, AiJobState::Failed);
        assert!(polled.result.is_none());
    }

    #[test]
    fn recognition_result_gate_allows_only_succeeded() {
        assert!(recognition_may_return_result(AiJobState::Succeeded));
        assert!(!recognition_may_return_result(AiJobState::Failed));
        assert!(!recognition_may_return_result(AiJobState::Cancelled));
        assert!(!recognition_may_return_result(AiJobState::Stale));
        assert!(!recognition_may_return_result(AiJobState::Running));
        assert!(!recognition_may_return_result(AiJobState::Queued));
    }

    #[test]
    fn ai_recognize_request_has_no_client_identity_fields() {
        // Wire inventory: start request accepts content only. Caller-supplied
        // snapshot_hash / request_generation are not struct fields (serde ignores extras).
        let value = serde_json::json!({
            "torrent_name": "Show.S01E01.1080p",
            "ep_pattern": r"(?P<ep>\d+)",
            "resolution_pattern": r"(?P<res>1080p)",
            "title_pattern": "<ep>",
            "snapshot_hash": "sha256:forged-client-identity",
            "request_generation": 999_u64
        });
        let request: AiRecognizeRequest =
            serde_json::from_value(value).expect("content-only request deserializes");
        assert_eq!(request.torrent_name, "Show.S01E01.1080p");
        assert_eq!(request.ep_pattern, r"(?P<ep>\d+)");
        // Round-trip must not re-emit forbidden identity fields.
        let encoded = serde_json::to_value(&request).expect("serialize");
        let object = encoded.as_object().expect("object");
        assert!(
            !object.contains_key("snapshot_hash"),
            "start request must not serialize snapshot_hash"
        );
        assert!(
            !object.contains_key("request_generation"),
            "start request must not serialize request_generation"
        );
        assert!(object.contains_key("torrent_name"));
        assert!(object.contains_key("ep_pattern"));
        assert!(object.contains_key("resolution_pattern"));
        assert!(object.contains_key("title_pattern"));
    }

    #[test]
    fn recognition_context_identity_is_backend_owned_and_deterministic() {
        let policy = RedactionPolicy::default();
        let (snap_a, hash_a) = build_recognition_context_snapshot(
            "Show.S01E01.1080p",
            r"(?P<ep>\d+)",
            r"(?P<res>1080p)",
            "[Group] <title> - <ep>",
            &policy,
        )
        .expect("safe");
        let (snap_b, hash_b) = build_recognition_context_snapshot(
            "Show.S01E01.1080p",
            r"(?P<ep>\d+)",
            r"(?P<res>1080p)",
            "[Group] <title> - <ep>",
            &policy,
        )
        .expect("safe");
        assert_eq!(hash_a, hash_b);
        assert_eq!(snap_a, snap_b);
        assert!(hash_a.starts_with("sha256:"));
        assert_eq!(hash_a.len(), "sha256:".len() + 64);

        let (_, hash_changed) = build_recognition_context_snapshot(
            "Show.S01E02.1080p",
            r"(?P<ep>\d+)",
            r"(?P<res>1080p)",
            "[Group] <title> - <ep>",
            &policy,
        )
        .expect("safe");
        assert_ne!(hash_a, hash_changed);

        // Monotonic backend generation (independent of content).
        let g1 = next_recognition_generation();
        let g2 = next_recognition_generation();
        assert!(g2 > g1);

        // Stored snapshot is the source of prompt fields and identity binding.
        let job_id = "job-recog-identity-test".to_string();
        {
            let mut store = recognition_snapshots().lock().unwrap();
            store.insert(job_id.clone(), snap_a.clone());
        }
        let stored = recognition_snapshots()
            .lock()
            .unwrap()
            .get(&job_id)
            .cloned()
            .expect("stored");
        assert_eq!(stored.context_hash(), hash_a);
        assert_eq!(stored.torrent_name, "Show.S01E01.1080p");
        let bound = bind_recognition_result(
            crate::ai::recognition::RecognitionOutput {
                episode: None,
                resolution: None,
                suggested_title: None,
            },
            g1,
            stored.context_hash(),
            job_id.clone(),
        );
        assert_eq!(bound.snapshot_hash, hash_a);
        assert_eq!(bound.request_generation, g1);
        assert_eq!(bound.job_id, job_id);
    }
}

#[cfg(test)]
mod media_info_job_tests {
    use super::*;
    use crate::ai::media::MediaInfoSummary;

    #[test]
    fn sanitize_media_results_strips_measured_summaries() {
        let _guard = command_test_guard();
        let results = vec![MediaProbeResult {
            relative_name: "video.mkv".into(),
            state: MediaProbeState::Measured,
            summary: Some(MediaInfoSummary {
                duration_ms: Some(1000),
                width: Some(1920),
                height: Some(1080),
                video_codec: Some("AV1".into()),
                audio_codecs: vec!["AAC".into()],
                subtitle_languages: vec![],
                scan_type: None,
            }),
            message: None,
        }];
        let sanitized = sanitize_media_results_for_non_success(results);
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].state, MediaProbeState::Cancelled);
        assert!(sanitized[0].summary.is_none());
        assert_eq!(sanitized[0].relative_name, "video.mkv");
        let serialized = serde_json::to_string(&sanitized).unwrap();
        assert!(!serialized.contains("/private"));
        assert!(!serialized.contains("1920"));
    }

    #[test]
    fn cancel_media_info_job_signals_flag_and_discards_success() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let job_id = start_job_backend(JobKind::MediaInfo, 7, "sha256:media", None);
        let flag = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(job_id.clone(), Arc::clone(&flag));
        media_job_results().lock().unwrap().insert(
            job_id.clone(),
            MediaInfoJobView {
                job_id: job_id.clone(),
                plan_token: "plan_test_media".into(),
                state: AiJobState::Running,
                request_generation: 7,
                snapshot_hash: "sha256:media".into(),
                progress: 40,
                error_code: None,
                results: vec![MediaProbeResult {
                    relative_name: "ep.mkv".into(),
                    state: MediaProbeState::Measured,
                    summary: Some(MediaInfoSummary {
                        duration_ms: Some(500),
                        ..MediaInfoSummary::default()
                    }),
                    message: None,
                }],
            },
        );

        let cancelled = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        assert!(flag.load(Ordering::Relaxed), "cancel must reach child flag");

        // Second cancel is idempotent.
        let again = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(again.state, AiJobState::Cancelled);

        // Late complete cannot resurrect success.
        let late = complete_job_backend(&job_id, true, None, "late success").unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);

        let view = ai_get_media_info_result(job_id).unwrap();
        assert_eq!(view.state, AiJobState::Cancelled);
        assert!(
            view.results
                .iter()
                .all(|item| item.state != MediaProbeState::Measured && item.summary.is_none()),
            "cancelled media result must not report measured success: {:?}",
            view.results
        );
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("/Users"));
        assert!(!serialized.contains("/private"));
    }

    #[test]
    fn cancel_after_media_info_success_preserves_measured_results() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let job_id = start_job_backend(JobKind::MediaInfo, 11, "sha256:media-ok", None);
        complete_job_backend(&job_id, true, None, "measured ok").unwrap();
        media_job_results().lock().unwrap().insert(
            job_id.clone(),
            MediaInfoJobView {
                job_id: job_id.clone(),
                plan_token: "plan_test_media_ok".into(),
                state: AiJobState::Succeeded,
                request_generation: 11,
                snapshot_hash: "sha256:media-ok".into(),
                progress: 100,
                error_code: None,
                results: vec![MediaProbeResult {
                    relative_name: "show/ep01.mkv".into(),
                    state: MediaProbeState::Measured,
                    summary: Some(MediaInfoSummary {
                        duration_ms: Some(1_234),
                        width: Some(1920),
                        height: Some(1080),
                        video_codec: Some("AV1".into()),
                        ..MediaInfoSummary::default()
                    }),
                    message: None,
                }],
            },
        );

        let after = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(after.state, AiJobState::Succeeded);
        assert!(media_info_may_report_success(after.state));

        // Second cancel remains idempotent and still does not strip results.
        let again = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(again.state, AiJobState::Succeeded);

        let view = ai_get_media_info_result(job_id).unwrap();
        assert_eq!(view.state, AiJobState::Succeeded);
        assert_eq!(view.results.len(), 1);
        assert_eq!(view.results[0].state, MediaProbeState::Measured);
        assert_eq!(view.results[0].relative_name, "show/ep01.mkv");
        assert_eq!(
            view.results[0]
                .summary
                .as_ref()
                .and_then(|summary| summary.duration_ms),
            Some(1_234)
        );
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("/private"));
        assert!(!serialized.contains("/Users"));
    }

    /// Install Queued MediaInfo job + deferred work under full concurrency (no spawn yet).
    fn install_queued_media_info_pending(
        snapshot_hash: &str,
        generation: u64,
    ) -> (String, String, String, Arc<AtomicBool>) {
        // Default max_running is 2 — fill both slots so MediaInfo starts Queued.
        let blocker = start_job_backend(JobKind::Audit, 1, "sha256:blocker", None);
        let blocker2 = start_job_backend(JobKind::Audit, 1, "sha256:blocker2", None);
        assert_eq!(
            ai_get_job(blocker.clone()).map(|job| job.state),
            Some(AiJobState::Running)
        );
        assert_eq!(
            ai_get_job(blocker2.clone()).map(|job| job.state),
            Some(AiJobState::Running)
        );

        let media_id = start_job_backend(JobKind::MediaInfo, generation, snapshot_hash, None);
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Queued)
        );

        let flag = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_id.clone(), Arc::clone(&flag));
        media_job_results().lock().unwrap().insert(
            media_id.clone(),
            MediaInfoJobView {
                job_id: media_id.clone(),
                plan_token: "plan_queued_media".into(),
                state: AiJobState::Queued,
                request_generation: generation,
                snapshot_hash: snapshot_hash.to_string(),
                progress: 0,
                error_code: None,
                results: Vec::new(),
            },
        );

        // Deferred work is registered but must not run while Queued.
        enqueue_pending_media_info_work(PendingMediaInfoWork {
            job_id: media_id.clone(),
            plan_token: "plan_queued_media".into(),
            request_generation: generation,
            snapshot_hash: snapshot_hash.to_string(),
            // Empty probes: worker finishes quickly without spawning a real sidecar.
            probe_requests: Vec::new(),
            pre_results: Vec::new(),
            sidecar: PathBuf::from("/missing/MediaInfo"),
            timeout: Duration::from_millis(100),
            cancel_flag: Arc::clone(&flag),
        })
        .expect("pending insert under test budget");

        (blocker, blocker2, media_id, flag)
    }

    /// Bounded poll until deferred work is drained and the job left Queued.
    fn wait_for_media_pending_drain(media_id: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let still_pending = media_pending_work()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(media_id);
            let state = ai_get_job(media_id.to_string()).map(|job| job.state);
            if !still_pending
                && matches!(
                    state,
                    Some(AiJobState::Running)
                        | Some(AiJobState::Succeeded)
                        | Some(AiJobState::Failed)
                        | Some(AiJobState::Cancelled)
                )
            {
                return;
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out waiting for MediaInfo pending drain; pending={still_pending} state={state:?}"
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn reset_media_job_globals() {
        // Signal any child probe before cancelling jobs so a worker cannot keep probing
        // while the process-global test state is being reset.
        if let Ok(flags) = media_cancel_flags().lock() {
            for flag in flags.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
        {
            let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
            manager.cancel_unfinished();
        }
        media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        media_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        media_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    #[test]
    fn queued_media_info_work_does_not_spawn_until_promoted() {
        let _guard = command_test_guard();
        // Best-effort isolation against process-global leftover jobs from other tests.
        reset_media_job_globals();

        let (blocker, blocker2, media_id, _flag) =
            install_queued_media_info_pending("sha256:queued-media", 2);

        // While still Queued, pending work stays and no progress is written.
        assert!(media_pending_work().lock().unwrap().contains_key(&media_id));
        assert_eq!(
            media_job_results()
                .lock()
                .unwrap()
                .get(&media_id)
                .map(|view| view.state),
            Some(AiJobState::Queued)
        );
        assert_eq!(
            media_job_results()
                .lock()
                .unwrap()
                .get(&media_id)
                .map(|view| view.progress),
            Some(0)
        );

        // Free one slot via production complete path (cross-kind). Must drain deferred
        // MediaInfo work without a manual try_start_promoted_media_info_jobs call.
        complete_job_backend(&blocker, true, None, "blocker done").unwrap();

        wait_for_media_pending_drain(&media_id, Duration::from_secs(2));
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "promoted job must leave the pending map via production complete path"
        );
        let state = ai_get_job(media_id.clone()).unwrap().state;
        assert!(
            matches!(
                state,
                AiJobState::Running | AiJobState::Succeeded | AiJobState::Failed
            ),
            "promoted MediaInfo must leave Queued; got {state:?}"
        );

        // Cleanup remaining jobs so other tests see a clean manager.
        let _ = ai_cancel_job(blocker2);
        let _ = ai_cancel_job(media_id);
    }

    #[test]
    fn non_media_cancel_promotes_and_starts_deferred_media_info() {
        let _guard = command_test_guard();
        reset_media_job_globals();

        let (blocker, blocker2, media_id, _flag) =
            install_queued_media_info_pending("sha256:queued-media-cancel", 3);

        // Cancelling a Running non-MediaInfo job frees capacity; production cancel must
        // drain deferred MediaInfo work (not only MediaInfo-kind cancels).
        let cancelled = ai_cancel_job(blocker).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        assert_eq!(cancelled.kind, JobKind::Audit);

        wait_for_media_pending_drain(&media_id, Duration::from_secs(2));
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "cancel-promoted MediaInfo must leave the pending map via production path"
        );
        let state = ai_get_job(media_id.clone()).unwrap().state;
        assert!(
            matches!(
                state,
                AiJobState::Running | AiJobState::Succeeded | AiJobState::Failed
            ),
            "cancel-promoted MediaInfo must leave Queued; got {state:?}"
        );

        let _ = ai_cancel_job(blocker2);
        let _ = ai_cancel_job(media_id);
    }

    #[test]
    fn pending_media_info_work_is_bounded_and_rejects_without_zombie() {
        let _guard = command_test_guard();
        reset_media_job_globals();

        // Fill deferred map to the documented finite bound with placeholder entries.
        {
            let mut pending = media_pending_work()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for index in 0..MAX_PENDING_MEDIA_INFO_WORK {
                let id = format!("pad-pending-{index}");
                pending.insert(
                    id.clone(),
                    PendingMediaInfoWork {
                        job_id: id,
                        plan_token: format!("plan_pad_{index}"),
                        request_generation: index as u64,
                        snapshot_hash: format!("sha256:pad-{index}"),
                        probe_requests: Vec::new(),
                        pre_results: Vec::new(),
                        sidecar: PathBuf::from("/missing/MediaInfo"),
                        timeout: Duration::from_millis(50),
                        cancel_flag: Arc::new(AtomicBool::new(false)),
                    },
                );
            }
            assert_eq!(pending.len(), MAX_PENDING_MEDIA_INFO_WORK);
        }

        // Force a real Queued MediaInfo job under full concurrency.
        let blocker = start_job_backend(JobKind::Audit, 1, "sha256:bound-blocker", None);
        let blocker2 = start_job_backend(JobKind::Audit, 1, "sha256:bound-blocker2", None);
        let media_id = start_job_backend(JobKind::MediaInfo, 9, "sha256:bound-media", None);
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Queued)
        );

        let flag = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_id.clone(), Arc::clone(&flag));
        media_job_results().lock().unwrap().insert(
            media_id.clone(),
            MediaInfoJobView {
                job_id: media_id.clone(),
                plan_token: "plan_bound_media".into(),
                state: AiJobState::Queued,
                request_generation: 9,
                snapshot_hash: "sha256:bound-media".into(),
                progress: 0,
                error_code: None,
                results: Vec::new(),
            },
        );

        let err = enqueue_pending_media_info_work(PendingMediaInfoWork {
            job_id: media_id.clone(),
            plan_token: "plan_bound_media".into(),
            request_generation: 9,
            snapshot_hash: "sha256:bound-media".into(),
            probe_requests: Vec::new(),
            pre_results: Vec::new(),
            sidecar: PathBuf::from("/missing/MediaInfo"),
            timeout: Duration::from_millis(50),
            cancel_flag: Arc::clone(&flag),
        })
        .expect_err("full pending map must reject new Queued work");
        assert!(
            err.contains("full") || err.contains(&MAX_PENDING_MEDIA_INFO_WORK.to_string()),
            "{err}"
        );

        // Coherent cleanup: no Queued job may remain without pending work.
        reject_media_info_start_after_queue_full(&media_id);
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Cancelled),
            "rejected start must cancel the Queued job"
        );
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "rejected start must not leave pending work"
        );
        assert!(
            !media_job_results().lock().unwrap().contains_key(&media_id),
            "rejected start must drop the result view"
        );
        assert!(
            !media_cancel_flags().lock().unwrap().contains_key(&media_id),
            "rejected start must drop the cancel flag"
        );

        // Active/padding pending entries are preserved (bound is not a wipe).
        assert_eq!(
            media_pending_work().lock().unwrap().len(),
            MAX_PENDING_MEDIA_INFO_WORK
        );

        media_pending_work().lock().unwrap().clear();
        let _ = ai_cancel_job(blocker);
        let _ = ai_cancel_job(blocker2);
    }

    /// Live-state handoff: job promoted to Running after a stale Queued snapshot must still
    /// spawn when work is parked via the production start-path coordinator (no manual drain).
    #[test]
    fn park_and_drain_starts_running_job_after_stale_queued_snapshot() {
        let _guard = command_test_guard();
        reset_media_job_globals();

        // Fill concurrency so MediaInfo starts Queued (stale snapshot would say Queued).
        let blocker = start_job_backend(JobKind::Audit, 1, "sha256:toctou-b1", None);
        let blocker2 = start_job_backend(JobKind::Audit, 1, "sha256:toctou-b2", None);
        let media_id = start_job_backend(JobKind::MediaInfo, 7, "sha256:toctou-live-handoff", None);
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Queued)
        );

        // Unlocked-window equivalent: promote to Running before deferred work exists.
        // Stale branch would have enqueued-only without a follow-up drain → zombie Running.
        complete_job_backend(&blocker, true, None, "free slot").unwrap();
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Running),
            "media job must be Running before park (live state != stale Queued)"
        );
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "no pending work yet — classic TOCTOU gap after promotion"
        );

        let flag = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_id.clone(), Arc::clone(&flag));
        media_job_results().lock().unwrap().insert(
            media_id.clone(),
            MediaInfoJobView {
                job_id: media_id.clone(),
                plan_token: "plan_toctou".into(),
                // Stale view still shows Queued; coordination must not trust it.
                state: AiJobState::Queued,
                request_generation: 7,
                snapshot_hash: "sha256:toctou-live-handoff".into(),
                progress: 0,
                error_code: None,
                results: Vec::new(),
            },
        );

        park_pending_media_info_and_drain(PendingMediaInfoWork {
            job_id: media_id.clone(),
            plan_token: "plan_toctou".into(),
            request_generation: 7,
            snapshot_hash: "sha256:toctou-live-handoff".into(),
            probe_requests: Vec::new(),
            pre_results: Vec::new(),
            sidecar: PathBuf::from("/missing/MediaInfo"),
            timeout: Duration::from_millis(100),
            cancel_flag: Arc::clone(&flag),
        })
        .expect("park under budget must succeed");

        wait_for_media_pending_drain(&media_id, Duration::from_secs(2));
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "Running live-state handoff must drain pending via production path"
        );
        let state = ai_get_job(media_id.clone()).unwrap().state;
        assert!(
            matches!(
                state,
                AiJobState::Running | AiJobState::Succeeded | AiJobState::Failed
            ),
            "park+drain must start the Running job; got {state:?}"
        );

        let _ = ai_cancel_job(blocker2);
        let _ = ai_cancel_job(media_id);
    }

    /// Terminal/cancel before enqueue must not leave pending work consuming capacity or
    /// resurrect a cancelled job when the start path parks then drains.
    #[test]
    fn park_and_drain_discards_terminal_pending_without_resurrection() {
        let _guard = command_test_guard();
        reset_media_job_globals();

        let media_id =
            start_job_backend(JobKind::MediaInfo, 8, "sha256:toctou-terminal-before", None);
        assert!(matches!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Running) | Some(AiJobState::Queued)
        ));

        // Cancel before deferred work is parked (terminal-before-enqueue race).
        let cancelled = ai_cancel_job(media_id.clone()).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);

        let flag = Arc::new(AtomicBool::new(true));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_id.clone(), Arc::clone(&flag));
        media_job_results().lock().unwrap().insert(
            media_id.clone(),
            MediaInfoJobView {
                job_id: media_id.clone(),
                plan_token: "plan_toctou_terminal".into(),
                state: AiJobState::Cancelled,
                request_generation: 8,
                snapshot_hash: "sha256:toctou-terminal-before".into(),
                progress: 100,
                error_code: Some("CANCELLED".into()),
                results: Vec::new(),
            },
        );

        park_pending_media_info_and_drain(PendingMediaInfoWork {
            job_id: media_id.clone(),
            plan_token: "plan_toctou_terminal".into(),
            request_generation: 8,
            snapshot_hash: "sha256:toctou-terminal-before".into(),
            probe_requests: Vec::new(),
            pre_results: Vec::new(),
            sidecar: PathBuf::from("/missing/MediaInfo"),
            timeout: Duration::from_millis(100),
            cancel_flag: Arc::clone(&flag),
        })
        .expect("park of terminal job under budget must insert then discard");

        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_id),
            "terminal pending entry must be discarded so it cannot consume capacity"
        );
        assert_eq!(
            ai_get_job(media_id.clone()).map(|job| job.state),
            Some(AiJobState::Cancelled),
            "drain must not resurrect a cancelled MediaInfo job"
        );
        // No worker should flip the view out of Cancelled.
        assert_eq!(
            media_job_results()
                .lock()
                .unwrap()
                .get(&media_id)
                .map(|view| view.state),
            Some(AiJobState::Cancelled)
        );
    }

    /// Overflow reject for a live Running start must cancel/cleanup zombies and drain any
    /// Queued MediaInfo promoted by that cancel (capacity freed by rejecting the Running job).
    #[test]
    fn park_overflow_rejects_running_and_drains_promoted_queued() {
        let _guard = command_test_guard();
        reset_media_job_globals();

        // Running target that will fail to park + second Running filler so media_q is Queued.
        let media_reject = start_job_backend(JobKind::MediaInfo, 1, "sha256:overflow-reject", None);
        let filler = start_job_backend(JobKind::Audit, 1, "sha256:overflow-filler", None);
        let media_q = start_job_backend(JobKind::MediaInfo, 2, "sha256:overflow-queued", None);
        assert_eq!(
            ai_get_job(media_reject.clone()).map(|job| job.state),
            Some(AiJobState::Running)
        );
        assert_eq!(
            ai_get_job(media_q.clone()).map(|job| job.state),
            Some(AiJobState::Queued)
        );

        let flag_q = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_q.clone(), Arc::clone(&flag_q));
        media_job_results().lock().unwrap().insert(
            media_q.clone(),
            MediaInfoJobView {
                job_id: media_q.clone(),
                plan_token: "plan_overflow_q".into(),
                state: AiJobState::Queued,
                request_generation: 2,
                snapshot_hash: "sha256:overflow-queued".into(),
                progress: 0,
                error_code: None,
                results: Vec::new(),
            },
        );

        let flag_r = Arc::new(AtomicBool::new(false));
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(media_reject.clone(), Arc::clone(&flag_r));
        media_job_results().lock().unwrap().insert(
            media_reject.clone(),
            MediaInfoJobView {
                job_id: media_reject.clone(),
                plan_token: "plan_overflow_r".into(),
                state: AiJobState::Running,
                request_generation: 1,
                snapshot_hash: "sha256:overflow-reject".into(),
                progress: 0,
                error_code: None,
                results: Vec::new(),
            },
        );

        // Bound full with media_q deferred work + pads (media_reject not present).
        {
            let mut pending = media_pending_work()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending.insert(
                media_q.clone(),
                PendingMediaInfoWork {
                    job_id: media_q.clone(),
                    plan_token: "plan_overflow_q".into(),
                    request_generation: 2,
                    snapshot_hash: "sha256:overflow-queued".into(),
                    probe_requests: Vec::new(),
                    pre_results: Vec::new(),
                    sidecar: PathBuf::from("/missing/MediaInfo"),
                    timeout: Duration::from_millis(50),
                    cancel_flag: Arc::clone(&flag_q),
                },
            );
            for index in 1..MAX_PENDING_MEDIA_INFO_WORK {
                let id = format!("pad-overflow-{index}");
                pending.insert(
                    id.clone(),
                    PendingMediaInfoWork {
                        job_id: id,
                        plan_token: format!("plan_pad_overflow_{index}"),
                        request_generation: index as u64,
                        snapshot_hash: format!("sha256:pad-overflow-{index}"),
                        probe_requests: Vec::new(),
                        pre_results: Vec::new(),
                        sidecar: PathBuf::from("/missing/MediaInfo"),
                        timeout: Duration::from_millis(50),
                        cancel_flag: Arc::new(AtomicBool::new(false)),
                    },
                );
            }
            assert_eq!(pending.len(), MAX_PENDING_MEDIA_INFO_WORK);
            assert!(!pending.contains_key(&media_reject));
        }

        let err = park_pending_media_info_and_drain(PendingMediaInfoWork {
            job_id: media_reject.clone(),
            plan_token: "plan_overflow_r".into(),
            request_generation: 1,
            snapshot_hash: "sha256:overflow-reject".into(),
            probe_requests: Vec::new(),
            pre_results: Vec::new(),
            sidecar: PathBuf::from("/missing/MediaInfo"),
            timeout: Duration::from_millis(50),
            cancel_flag: Arc::clone(&flag_r),
        })
        .expect_err("full pending map must reject a live Running start");
        assert!(
            err.contains("full") || err.contains(&MAX_PENDING_MEDIA_INFO_WORK.to_string()),
            "{err}"
        );

        // Rejected Running job is cleaned up (no zombie job/flag/view/pending).
        assert_eq!(
            ai_get_job(media_reject.clone()).map(|job| job.state),
            Some(AiJobState::Cancelled)
        );
        assert!(!media_pending_work()
            .lock()
            .unwrap()
            .contains_key(&media_reject));
        assert!(!media_job_results()
            .lock()
            .unwrap()
            .contains_key(&media_reject));
        assert!(!media_cancel_flags()
            .lock()
            .unwrap()
            .contains_key(&media_reject));

        // Cancel of Running media_reject promotes media_q; reject's drain must start it
        // without a manual try_start in the test.
        wait_for_media_pending_drain(&media_q, Duration::from_secs(2));
        assert!(
            !media_pending_work().lock().unwrap().contains_key(&media_q),
            "overflow reject must drain the Queued job promoted by cancel"
        );
        let q_state = ai_get_job(media_q.clone()).unwrap().state;
        assert!(
            matches!(
                q_state,
                AiJobState::Running | AiJobState::Succeeded | AiJobState::Failed
            ),
            "promoted Queued MediaInfo must leave Queued after reject drain; got {q_state:?}"
        );

        media_pending_work().lock().unwrap().clear();
        let _ = ai_cancel_job(filler);
        let _ = ai_cancel_job(media_q);
        let _ = ai_cancel_job(media_reject);
    }

    #[test]
    fn media_global_state_retention_keeps_active_jobs() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let active = start_job_backend(JobKind::MediaInfo, 1, "sha256:active-retain", None);
        media_job_results().lock().unwrap().insert(
            active.clone(),
            MediaInfoJobView {
                job_id: active.clone(),
                plan_token: "plan_active_retain".into(),
                state: AiJobState::Running,
                request_generation: 1,
                snapshot_hash: "sha256:active-retain".into(),
                progress: 5,
                error_code: None,
                results: Vec::new(),
            },
        );
        media_cancel_flags()
            .lock()
            .unwrap()
            .insert(active.clone(), Arc::new(AtomicBool::new(false)));

        // Flood terminal result rows past the retention cap.
        {
            let mut store = media_job_results().lock().unwrap();
            for index in 0..(MEDIA_STATE_MAX_RECORDS + 40) {
                let id = format!("terminal-media-{index}");
                store.insert(
                    id.clone(),
                    MediaInfoJobView {
                        job_id: id,
                        plan_token: format!("plan_terminal_{index}"),
                        state: AiJobState::Succeeded,
                        request_generation: index as u64,
                        snapshot_hash: format!("sha256:t-{index}"),
                        progress: 100,
                        error_code: None,
                        results: Vec::new(),
                    },
                );
            }
            retain_media_global_state(None, Some(&mut store));
            assert!(
                store.contains_key(&active),
                "active MediaInfo job must not be pruned"
            );
            assert!(
                store.len() <= MEDIA_STATE_MAX_RECORDS
                    || store
                        .values()
                        .filter(|view| !view.state.is_terminal())
                        .count()
                        > 0,
                "terminal retention must be bounded"
            );
            // Bound overall map: active + at most MEDIA_STATE_MAX_RECORDS is not required
            // when active pushes over, but terminal-only surplus must shrink toward the cap.
            let terminal_count = store
                .values()
                .filter(|view| view.state.is_terminal())
                .count();
            assert!(
                terminal_count <= MEDIA_STATE_MAX_RECORDS,
                "terminal MediaInfo results unbounded: {terminal_count}"
            );
        }

        let _ = ai_cancel_job(active);
    }

    #[test]
    fn poll_media_info_returns_none_until_terminal() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let job_id = start_job_backend(JobKind::MediaInfo, 1, "sha256:poll-media", None);
        media_job_results().lock().unwrap().insert(
            job_id.clone(),
            MediaInfoJobView {
                job_id: job_id.clone(),
                plan_token: "plan_poll_media".into(),
                state: AiJobState::Running,
                request_generation: 1,
                snapshot_hash: "sha256:poll-media".into(),
                progress: 10,
                error_code: None,
                results: Vec::new(),
            },
        );
        assert!(ai_poll_media_info(job_id.clone()).unwrap().is_none());

        store_media_info_view(
            &job_id,
            "plan_poll_media",
            1,
            "sha256:poll-media",
            AiJobState::Succeeded,
            None,
            vec![MediaProbeResult {
                relative_name: "a.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(MediaInfoSummary::default()),
                message: None,
            }],
        );
        complete_job_backend(&job_id, true, None, "ok").unwrap();
        let terminal = ai_poll_media_info(job_id).unwrap().expect("terminal");
        assert_eq!(terminal.state, AiJobState::Succeeded);
        assert_eq!(terminal.results[0].relative_name, "a.mkv");
        assert_eq!(terminal.results[0].state, MediaProbeState::Measured);
    }

    #[test]
    fn media_info_packaged_resource_base_falls_back_to_current_exe_parent() {
        // When Tauri resource_dir is available, it is preferred as-is.
        let explicit = PathBuf::from("/tmp/okpgui_tauri_resource_dir_probe");
        assert_eq!(
            media_info_packaged_resource_base(Some(explicit.clone())),
            Some(explicit)
        );

        // When resource_dir fails, fall back to current_exe parent so flat
        // --no-bundle archives still reach fixed-layout sidecar candidates.
        let fallback =
            media_info_packaged_resource_base(None).expect("current_exe parent fallback");
        let exe_parent = std::env::current_exe()
            .expect("current_exe")
            .parent()
            .expect("exe parent")
            .to_path_buf();
        assert_eq!(fallback, exe_parent);

        // Fallback base must still resolve through the shared fixed-layout
        // resolver (current_exe-adjacent candidates), not arbitrary paths.
        let candidates = crate::ai::media::packaged_mediainfo_candidates(&fallback);
        let exe_dir = exe_parent.to_string_lossy().replace('\\', "/");
        assert!(
            candidates
                .iter()
                .any(|c| { c.to_string_lossy().replace('\\', "/").starts_with(&exe_dir) }),
            "fallback resource base must include current_exe parent candidates"
        );
    }
}

#[cfg(test)]
mod media_info_plan_bind_tests {
    use super::*;
    use crate::config::Template;
    use crate::domain::publish_plan::PlanMediaStatus;
    use crate::publish::PublishRequest;

    fn reset_media_job_globals() {
        if let Ok(flags) = media_cancel_flags().lock() {
            for flag in flags.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
        {
            let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
            manager.cancel_unfinished();
        }
        media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        media_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        media_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn write_temp_torrent(contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "okpgui-media-bind-{}-{}.torrent",
            std::process::id(),
            now_unix()
        ));
        std::fs::write(&path, contents).expect("write temp torrent");
        path
    }

    fn prepare_bound_plan(generation: u64) -> (String, String, PathBuf) {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = PublishRequest {
            publish_id: "pub".into(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "profile".into(),
            template: Template::default(),
        };
        let mut guard = get_or_create_registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let prepared = guard
            .prepare_plan_with_request_and_blockers(generation, request, Vec::new(), false, None)
            .expect("prepare");
        (prepared.token, prepared.snapshot_hash, torrent_path)
    }

    #[test]
    fn success_finish_binds_redacted_media_evidence_to_plan() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let (token, snapshot_hash, torrent_path) = prepare_bound_plan(4);
        let job_id = start_job_backend(JobKind::MediaInfo, 4, &snapshot_hash, None);

        let view = finish_media_info_job(
            &job_id,
            &token,
            4,
            &snapshot_hash,
            true,
            None,
            "measured",
            vec![MediaProbeResult {
                relative_name: "show/ep01.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(crate::ai::media::MediaInfoSummary {
                    duration_ms: Some(9_000),
                    width: Some(1920),
                    height: Some(1080),
                    video_codec: Some("AV1".into()),
                    audio_codecs: vec!["AAC".into()],
                    subtitle_languages: vec![],
                    scan_type: None,
                }),
                message: None,
            }],
        );
        assert_eq!(view.state, AiJobState::Succeeded);
        assert_eq!(view.plan_token, token);
        let view_json = serde_json::to_string(&view).unwrap();
        assert!(!view_json.contains(torrent_path.to_string_lossy().as_ref()));
        assert!(!view_json.contains("/Users/"));

        {
            let mut reg = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let plan = reg.inspect_plan(&token).expect("plan");
            let media = plan.media_evidence.as_ref().expect("media bound");
            assert_eq!(media.status, PlanMediaStatus::Tested);
            assert_eq!(media.job_id, job_id);
            assert_eq!(media.summaries[0].relative_name, "show/ep01.mkv");
            let findings = plan.media_audit_findings();
            assert!(
                findings.is_empty(),
                "tested media must not yield media findings: {findings:?}"
            );
            let public = serde_json::to_string(plan).unwrap();
            assert!(!public.contains(torrent_path.to_string_lossy().as_ref()));
            assert!(!public.contains("/Users/"));
        }
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn cancel_and_failure_finish_do_not_bind_media_evidence() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let (token, snapshot_hash, torrent_path) = prepare_bound_plan(5);

        // Failed finish (timeout / nonzero class) must not mutate the plan.
        let fail_id = start_job_backend(JobKind::MediaInfo, 5, &snapshot_hash, None);
        let failed = finish_media_info_job(
            &fail_id,
            &token,
            5,
            &snapshot_hash,
            false,
            Some("PROBE_FAILED".into()),
            "timeout",
            vec![MediaProbeResult {
                relative_name: "ep.mkv".into(),
                state: MediaProbeState::TimedOut,
                summary: None,
                message: Some("timed out".into()),
            }],
        );
        assert_eq!(failed.state, AiJobState::Failed);
        assert!(
            get_or_create_registry()
                .lock()
                .unwrap()
                .inspect_plan(&token)
                .and_then(|plan| plan.media_evidence.clone())
                .is_none(),
            "failed MediaInfo must not bind plan media evidence"
        );

        // Cancelled store path must not bind either.
        let cancel_id = start_job_backend(JobKind::MediaInfo, 5, &snapshot_hash, None);
        ai_cancel_job(cancel_id.clone()).unwrap();
        store_media_info_view(
            &cancel_id,
            &token,
            5,
            &snapshot_hash,
            AiJobState::Cancelled,
            Some("CANCELLED".into()),
            sanitize_media_results_for_non_success(vec![MediaProbeResult {
                relative_name: "ep.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(crate::ai::media::MediaInfoSummary {
                    duration_ms: Some(1),
                    ..crate::ai::media::MediaInfoSummary::default()
                }),
                message: None,
            }]),
        );
        assert!(
            !media_info_may_bind_plan_evidence(AiJobState::Cancelled)
                && !media_info_may_bind_plan_evidence(AiJobState::Failed)
        );
        assert!(
            get_or_create_registry()
                .lock()
                .unwrap()
                .inspect_plan(&token)
                .and_then(|plan| plan.media_evidence.clone())
                .is_none(),
            "cancel/failure must leave plan media evidence unset"
        );
        // Formal/local audit can still derive MEDIA_NOT_TESTED from unbound plan state.
        let findings = get_or_create_registry()
            .lock()
            .unwrap()
            .inspect_plan(&token)
            .map(|plan| plan.media_audit_findings())
            .expect("plan");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "MEDIA_NOT_TESTED");
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn token_mismatch_and_identity_drift_reject_bind_without_mutating() {
        let _guard = command_test_guard();
        reset_media_job_globals();
        let (token, snapshot_hash, torrent_path) = prepare_bound_plan(6);
        let job_id = start_job_backend(JobKind::MediaInfo, 6, &snapshot_hash, None);

        // Wrong plan token: bind rejected, plan unchanged.
        let err = try_bind_media_evidence_to_plan(
            "plan_not_this_token",
            &job_id,
            &snapshot_hash,
            6,
            &[MediaProbeResult {
                relative_name: "ep.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(crate::ai::media::MediaInfoSummary {
                    duration_ms: Some(1),
                    ..crate::ai::media::MediaInfoSummary::default()
                }),
                message: None,
            }],
        )
        .expect_err("unknown token");
        assert!(
            err.contains("missing") || err.contains("expired") || err.contains("required"),
            "{err}"
        );

        // Forged client snapshot as bind identity: rejected.
        let err = try_bind_media_evidence_to_plan(
            &token,
            &job_id,
            "sha256:forged-client-hash",
            6,
            &[MediaProbeResult {
                relative_name: "ep.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(crate::ai::media::MediaInfoSummary {
                    duration_ms: Some(1),
                    ..crate::ai::media::MediaInfoSummary::default()
                }),
                message: None,
            }],
        )
        .expect_err("forged snapshot");
        assert!(
            err.contains("identity") || err.contains("snapshot"),
            "{err}"
        );

        // Identity drift: mutate torrent after start, bind must fail closed.
        std::fs::write(&torrent_path, b"d4:infod4:name7:changedee").expect("mutate");
        let err = try_bind_media_evidence_to_plan(
            &token,
            &job_id,
            &snapshot_hash,
            6,
            &[MediaProbeResult {
                relative_name: "ep.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(crate::ai::media::MediaInfoSummary {
                    duration_ms: Some(1),
                    ..crate::ai::media::MediaInfoSummary::default()
                }),
                message: None,
            }],
        )
        .expect_err("drift");
        assert!(!err.is_empty());

        {
            let mut reg = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let plan = reg.inspect_plan(&token).expect("plan still live");
            assert!(plan.media_evidence.is_none());
            assert!(plan.has_authoritative_audit_evidence());
            assert_eq!(plan.media_audit_findings()[0].code, "MEDIA_NOT_TESTED");
        }
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn media_info_start_request_ignores_client_identity_fields_on_deserialize() {
        let raw = serde_json::json!({
            "plan_token": "plan_only_authority",
            "torrent_path": "/Users/forged/secret.torrent",
            "content_root": "/Users/forged/media",
            "snapshot_hash": "sha256:client-forged",
            "request_generation": 999,
            "relative_entries": [],
            "timeout_ms": 1000
        });
        let request: MediaInfoStartRequest =
            serde_json::from_value(raw).expect("deserialize start request");
        assert_eq!(request.plan_token, "plan_only_authority");
        // Deprecated client identity fields may deserialize for wire compat but must not
        // become plan identity (start path uses PlanRegistry only).
        assert_eq!(
            request.snapshot_hash.as_deref(),
            Some("sha256:client-forged")
        );
        assert_eq!(request.request_generation, Some(999));
        assert_eq!(
            request.torrent_path.as_deref(),
            Some("/Users/forged/secret.torrent")
        );
    }
}

#[cfg(test)]
mod template_selection_job_tests {
    use super::*;
    use crate::ai::template_seed::{
        EligibleTemplateCatalogEntry, ReviewTemplateRecommendationStatus,
    };
    use crate::config::Template;
    use crate::publish::PublishRequest;
    use std::io::Write;
    use std::path::PathBuf;

    fn sample_recommendation(id: &str) -> TemplateRecommendation {
        TemplateRecommendation {
            recommendation_id: id.to_string(),
            template_id: "zzz-last".into(),
            template_revision: 2,
            template_digest: "sha256:zzz".into(),
            template_name: "Last".into(),
            summary: "推荐模板".into(),
            alternatives: vec![],
            torrent_digest: "sha256:torrent".into(),
            torrent_name: "show.mkv".into(),
            catalog_hash: "sha256:catalog".into(),
            generation: 1,
            expires_at_unix: now_unix() + 600,
        }
    }

    fn write_temp_torrent(file_name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "okpgui_rec_{}_{}_{}",
            std::process::id(),
            now_unix(),
            file_name
        ));
        let mut file = std::fs::File::create(&path).expect("create temp torrent");
        file.write_all(contents).expect("write torrent");
        path
    }

    #[test]
    fn template_selection_recommendation_gate_allows_only_succeeded() {
        assert!(template_selection_may_return_recommendation(
            AiJobState::Succeeded
        ));
        assert!(!template_selection_may_return_recommendation(
            AiJobState::Failed
        ));
        assert!(!template_selection_may_return_recommendation(
            AiJobState::Cancelled
        ));
        assert!(!template_selection_may_return_recommendation(
            AiJobState::Stale
        ));
        assert!(!template_selection_may_return_recommendation(
            AiJobState::Running
        ));
        assert!(!template_selection_may_return_recommendation(
            AiJobState::Queued
        ));
    }

    #[test]
    fn poll_template_selection_returns_recommendation_not_seed() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::TemplateSelection, 0, "sha256:catalog", None);
        store_template_selection_view(TemplateSelectionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Running,
            request_generation: 0,
            snapshot_hash: "sha256:catalog".into(),
            progress: 35,
            error_code: None,
            message: Some("requesting provider selection".into()),
            recommendation: None,
            seed: None,
        });
        assert!(ai_poll_template_selection(job_id.clone())
            .unwrap()
            .is_none());

        complete_job_backend(&job_id, true, None, "matched").unwrap();
        store_template_selection_view(TemplateSelectionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Succeeded,
            request_generation: 0,
            snapshot_hash: "sha256:catalog".into(),
            progress: 100,
            error_code: None,
            message: Some("selected".into()),
            recommendation: Some(sample_recommendation("rec_ok")),
            // Legacy seed field must be stripped by terminal view sanitization.
            seed: Some(TemplateSeed {
                token: "seed_must_not_surface".into(),
                template_id: "zzz-last".into(),
                template_revision: 2,
                template_digest: "sha256:zzz".into(),
                torrent_name: "show.mkv".into(),
            }),
        });
        let terminal = ai_poll_template_selection(job_id)
            .unwrap()
            .expect("terminal");
        assert_eq!(terminal.state, AiJobState::Succeeded);
        assert!(terminal.seed.is_none(), "success must not auto-mint seed");
        assert_eq!(
            terminal
                .recommendation
                .as_ref()
                .map(|rec| rec.recommendation_id.as_str()),
            Some("rec_ok")
        );
        let serialized = serde_json::to_string(&terminal).unwrap();
        assert!(!serialized.contains("torrent_path"));
    }

    #[test]
    fn cancel_template_selection_strips_recommendation_and_blocks_late_success() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::TemplateSelection, 0, "sha256:cancel", None);
        let flag = Arc::new(AtomicBool::new(false));
        template_cancel_flags()
            .lock()
            .unwrap()
            .insert(job_id.clone(), Arc::clone(&flag));
        store_template_selection_view(TemplateSelectionJobView {
            job_id: job_id.clone(),
            state: AiJobState::Running,
            request_generation: 0,
            snapshot_hash: "sha256:cancel".into(),
            progress: 50,
            error_code: None,
            message: Some("in flight".into()),
            recommendation: Some(sample_recommendation("rec_race")),
            seed: None,
        });

        let cancelled = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        assert!(flag.load(Ordering::Relaxed), "cancel must signal flag");

        let late = complete_job_backend(&job_id, true, None, "late success").unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);

        let terminal = ai_poll_template_selection(job_id)
            .unwrap()
            .expect("terminal");
        assert_eq!(terminal.state, AiJobState::Cancelled);
        assert!(terminal.seed.is_none());
        assert!(
            terminal.recommendation.is_none(),
            "cancelled must not hand off recommendation"
        );
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("CANCELLED"),
            "{:?}",
            terminal.error_code
        );
    }

    #[test]
    fn failed_selection_never_returns_recommendation() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::TemplateSelection, 0, "sha256:fail", None);
        let view = finish_template_selection_failure(
            &job_id,
            0,
            "sha256:fail",
            Some("SELECTION_INVALID".into()),
            "provider selected an invalid or stale template id/revision/digest",
        );
        assert_eq!(view.state, AiJobState::Failed);
        assert!(view.seed.is_none());
        assert!(view.recommendation.is_none());
        assert_eq!(view.error_code.as_deref(), Some("SELECTION_INVALID"));

        let polled = ai_poll_template_selection(job_id)
            .unwrap()
            .expect("terminal");
        assert_eq!(polled.state, AiJobState::Failed);
        assert!(polled.seed.is_none());
        assert!(polled.recommendation.is_none());
        assert!(
            polled
                .message
                .as_deref()
                .unwrap_or("")
                .contains("invalid or stale"),
            "{:?}",
            polled.message
        );
    }

    #[test]
    fn stale_or_cancelled_finish_success_discards_recommendation() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::TemplateSelection, 0, "sha256:stale", None);
        ai_cancel_job(job_id.clone()).unwrap();

        let catalog = vec![EligibleTemplateCatalogEntry {
            id: "zzz-last".into(),
            name: "Last".into(),
            revision: 2,
            digest: "sha256:zzz".into(),
            summary: String::new(),
        }];
        let view = finish_template_selection_success(
            &job_id,
            0,
            "sha256:stale",
            "zzz-last",
            2,
            "sha256:zzz",
            "Last",
            "",
            &catalog,
            "show.mkv".into(),
            "/tmp/does-not-matter.torrent".into(),
            &AtomicBool::new(true),
        );
        assert_ne!(view.state, AiJobState::Succeeded);
        assert!(view.seed.is_none());
        assert!(view.recommendation.is_none());
        assert!(!template_selection_may_return_recommendation(view.state));
    }

    #[test]
    fn review_mints_once_replays_unconsumed_and_refuses_consumed() {
        let _guard = command_test_guard();
        let torrent_path = write_temp_torrent("review.torrent", b"d4:infod4:name4:testee");
        let catalog = vec![EligibleTemplateCatalogEntry {
            id: "tpl-a".into(),
            name: "Alpha".into(),
            revision: 1,
            digest: "sha256:alpha".into(),
            summary: "summary".into(),
        }];
        let catalog_hash = catalog_snapshot_hash(&catalog);
        let rec = template_recommendations()
            .lock()
            .unwrap()
            .store(
                &catalog[0],
                &catalog,
                catalog_hash,
                "test".into(),
                torrent_path.to_string_lossy().into_owned(),
                "推荐模板「Alpha」".into(),
            )
            .expect("store recommendation");

        // First review mints exactly one seed.
        let first = {
            let mut seeds = template_seeds().lock().unwrap();
            let mut recs = template_recommendations().lock().unwrap();
            recs.review_and_mint(&rec.recommendation_id, &catalog, &mut seeds)
                .expect("first mint")
        };
        assert_eq!(first.status, ReviewTemplateRecommendationStatus::Minted);
        let seed_token = first.seed.as_ref().unwrap().token.clone();

        // Repeated review while unconsumed returns the same seed.
        let second = {
            let mut seeds = template_seeds().lock().unwrap();
            let mut recs = template_recommendations().lock().unwrap();
            recs.review_and_mint(&rec.recommendation_id, &catalog, &mut seeds)
                .expect("replay")
        };
        assert_eq!(
            second.status,
            ReviewTemplateRecommendationStatus::AlreadyMinted
        );
        assert_eq!(
            second.seed.as_ref().map(|s| s.token.as_str()),
            Some(seed_token.as_str())
        );

        // Consume via seed registry + mark recommendation.
        {
            let mut seeds = template_seeds().lock().unwrap();
            let _ = seeds
                .consume_validated(&seed_token, &catalog)
                .expect("consume");
            template_recommendations()
                .lock()
                .unwrap()
                .mark_seed_consumed(&seed_token);
        }
        let third = {
            let mut seeds = template_seeds().lock().unwrap();
            let mut recs = template_recommendations().lock().unwrap();
            recs.review_and_mint(&rec.recommendation_id, &catalog, &mut seeds)
                .expect("consumed")
        };
        assert_eq!(
            third.status,
            ReviewTemplateRecommendationStatus::AlreadyConsumed
        );
        assert!(third.seed.is_none());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn review_expired_recommendation_is_terminal_error() {
        let _guard = command_test_guard();
        let mut recs = crate::ai::template_seed::TemplateRecommendationRegistry::with_ttl(
            std::time::Duration::from_millis(20),
        );
        let torrent_path = write_temp_torrent("expire.torrent", b"d4:infod4:name4:testee");
        let catalog = vec![EligibleTemplateCatalogEntry {
            id: "tpl-b".into(),
            name: "Beta".into(),
            revision: 1,
            digest: "sha256:beta".into(),
            summary: String::new(),
        }];
        let rec = recs
            .store(
                &catalog[0],
                &catalog,
                catalog_snapshot_hash(&catalog),
                "test".into(),
                torrent_path.to_string_lossy().into_owned(),
                "rec".into(),
            )
            .expect("store");
        std::thread::sleep(std::time::Duration::from_millis(40));
        let mut seeds = TemplateSeedRegistry::default();
        let err = recs
            .review_and_mint(&rec.recommendation_id, &catalog, &mut seeds)
            .expect_err("expired");
        assert!(
            err.contains("missing") || err.contains("expired") || err.contains("discarded"),
            "{err}"
        );
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn review_catalog_drift_is_terminal_error() {
        let _guard = command_test_guard();
        let torrent_path = write_temp_torrent("drift.torrent", b"d4:infod4:name4:testee");
        let catalog = vec![EligibleTemplateCatalogEntry {
            id: "tpl-c".into(),
            name: "Gamma".into(),
            revision: 1,
            digest: "sha256:gamma".into(),
            summary: String::new(),
        }];
        let rec = template_recommendations()
            .lock()
            .unwrap()
            .store(
                &catalog[0],
                &catalog,
                catalog_snapshot_hash(&catalog),
                "test".into(),
                torrent_path.to_string_lossy().into_owned(),
                "rec".into(),
            )
            .expect("store");
        // Drift: revision change changes catalog hash + identity.
        let drifted = vec![EligibleTemplateCatalogEntry {
            id: "tpl-c".into(),
            name: "Gamma".into(),
            revision: 2,
            digest: "sha256:gamma-v2".into(),
            summary: String::new(),
        }];
        let mut seeds = template_seeds().lock().unwrap();
        let mut recs = template_recommendations().lock().unwrap();
        let err = recs
            .review_and_mint(&rec.recommendation_id, &drifted, &mut seeds)
            .expect_err("drift");
        assert!(
            err.contains("stale") || err.contains("drift") || err.contains("mismatch"),
            "{err}"
        );
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn active_job_summaries_order_and_exclude_terminal() {
        let _guard = command_test_guard();
        let early = start_job_backend(JobKind::Recognition, 0, "sha256:a", None);
        let late = start_job_backend(JobKind::TemplateSelection, 0, "sha256:b", None);
        complete_job_backend(&early, true, None, "done").unwrap();
        let summaries = ai_list_active_jobs();
        assert!(
            summaries.iter().all(|s| s.job_id != early),
            "terminal jobs must not appear"
        );
        assert!(summaries.iter().any(|s| s.job_id == late));
        // Ordering: started_at then id
        let mut sorted = summaries.clone();
        sorted.sort_by(|a, b| {
            a.started_at_unix
                .cmp(&b.started_at_unix)
                .then_with(|| a.job_id.cmp(&b.job_id))
        });
        assert_eq!(summaries, sorted);
        for summary in &summaries {
            assert!(!summary.job_id.is_empty());
            assert!(summary.progress <= 100);
            // Never leak snapshot hash into strip projection fields.
            let json = serde_json::to_string(summary).unwrap();
            assert!(!json.contains("snapshot_hash"));
            assert!(!json.contains("provider_identity"));
        }
    }

    #[test]
    fn cancel_active_audit_uses_preflight_session_not_job_only() {
        let _guard = command_test_guard();
        let torrent_path = write_temp_torrent("audit-cancel.torrent", b"d4:infod4:name4:testee");
        let request = PublishRequest {
            publish_id: "pub-audit-cancel".into(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "profile".into(),
            template: Template::default(),
        };
        let prepared = {
            let mut registry = get_or_create_registry().lock().unwrap();
            registry
                .prepare_plan_with_request_and_blockers(1, request, vec![], true, None)
                .expect("prepare")
        };
        let job_id = start_job_backend(JobKind::Audit, 1, prepared.snapshot_hash.clone(), None);
        {
            let mut registry = get_or_create_registry().lock().unwrap();
            registry.note_plan_audit_job(&prepared.token, &job_id);
        }

        // Job-only path for plan-bound audit must escalate (token invalidated).
        let cancelled = ai_cancel_job(job_id.clone()).expect("escalate cancel");
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        {
            let mut registry = get_or_create_registry().lock().unwrap();
            assert!(
                registry.inspect_plan(&prepared.token).is_none(),
                "plan token must not remain live after plan-bound audit cancel"
            );
        }
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn plan_bound_audit_cancel_path_reconciles_session() {
        let _guard = command_test_guard();
        let torrent_path = write_temp_torrent("audit-session.torrent", b"d4:infod4:name4:testee");
        let request = PublishRequest {
            publish_id: "pub-audit-session".into(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "profile".into(),
            template: Template::default(),
        };
        let prepared = {
            let mut registry = get_or_create_registry().lock().unwrap();
            registry
                .prepare_plan_with_request_and_blockers(2, request, vec![], true, None)
                .expect("prepare")
        };
        let job_id = start_job_backend(JobKind::Audit, 2, prepared.snapshot_hash.clone(), None);
        {
            let mut registry = get_or_create_registry().lock().unwrap();
            registry.note_plan_audit_job(&prepared.token, &job_id);
        }
        // Strip kind-dispatch uses the same core path as session cancel.
        let (result, resolved) =
            cancel_preflight_session_core(&prepared.token, Some(&job_id)).expect("session");
        assert!(result.reconciled);
        assert_eq!(resolved.as_deref(), Some(job_id.as_str()));
        assert!(matches!(
            result.token_state,
            PreflightTokenState::Invalidated | PreflightTokenState::AlreadyMissing
        ));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn invalid_catalog_selection_parse_never_picks_first_entry() {
        // parse_template_selection is the only selection authority — empty/mismatched
        // provider payloads must fail closed (no first-catalog fallback).
        let catalog = vec![crate::ai::template_seed::EligibleTemplateCatalogEntry {
            id: "aaa-first".into(),
            name: "First".into(),
            revision: 1,
            digest: "sha256:aaa".into(),
            summary: String::new(),
        }];
        let unmatched = serde_json::json!({
            "matched": false,
            "template_id": "",
            "template_revision": 0,
            "template_digest": ""
        });
        let err = parse_template_selection(&unmatched, &catalog).expect_err("unmatched");
        assert!(
            err.contains("no matching") || err.contains("catalog"),
            "{err}"
        );

        let stale = serde_json::json!({
            "matched": true,
            "template_id": "aaa-first",
            "template_revision": 99,
            "template_digest": "sha256:wrong"
        });
        let err = parse_template_selection(&stale, &catalog).expect_err("stale");
        assert!(
            err.contains("invalid or stale") || err.contains("stale"),
            "{err}"
        );
    }
}
