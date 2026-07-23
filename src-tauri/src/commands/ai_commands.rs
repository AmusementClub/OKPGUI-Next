use crate::ai::audit::{
    build_formal_audit_prompt, compute_decision, formal_audit_schema, parse_formal_audit_findings,
    redact_provider_error, sanitize_audit_input, validate_findings_against_projection,
    AuditDecision, AuditInput, Finding, FindingSeverity, ValidatedAudit,
};
use crate::ai::context::{
    context_error_to_public, project_context_from_binding, ContextError, ContextProjection,
    DEFAULT_CONTEXT_CEILING,
};
use crate::ai::credentials::{
    apply_public_credential_session_flag, apply_public_identity_matches, capability_identity,
    capability_identity_matches, cleanup_previous_secret_after_success,
    may_read_credential_store_for_settings, plan_credential_secret_write,
    rollback_credential_candidate, validate_custom_header_name, AuthMode, CredentialMutationGate,
    CredentialRef, OsCredentialStore, PublicCapabilityStatus, PublicConnectionConfig, SecretStore,
    SecretValue,
};
use crate::ai::jobs::{
    formal_audit_may_bind_terminal_evidence, media_info_may_report_success,
    recognition_may_return_result, AiJob, AiJobManager, AiJobState, DebugRecord, JobKind,
};
use crate::ai::media::{
    clamp_media_probe_timeout_ms, discover_media_files, discover_media_probe_requests,
    probe_media_files_with_progress, resolve_media_relative_entries, resolve_packaged_mediainfo,
    MediaCandidate, MediaProbeRequest, MediaProbeResult, MediaProbeState, MediaRelativeEntry,
    MAX_MEDIA_RELATIVE_ENTRIES,
};
use crate::ai::provider::{
    auto_fallback_allowed, build_models_list_request, build_no_redirect_client, build_probe_request,
    build_structured_request, classify_and_validate_probe_response, classify_http_failure,
    extract_structured_json, formal_attempt_modes, formal_attempt_modes_for_ready_capability,
    minimal_probe_schema, parse_models_list_response, send_managed_provider_request,
    CapabilityIdentity, CapabilityProbeResult, CapabilityState, ProviderFailure, ProviderKind,
    ProviderMode,
};
use crate::ai::recognition::{
    bind_recognition_result, build_recognition_prompt, recognition_from_provider_outcome,
    recognition_schema, redact_recognition_output, sanitize_recognition_context, RecognitionResult,
    RECOGNITION_SCHEMA_VERSION,
};
use crate::ai::redaction::RedactionPolicy;
use crate::ai::template_seed::{
    build_eligible_catalog, build_template_selection_prompt, catalog_snapshot_hash,
    parse_template_selection, template_selection_schema, TemplateSeed, TemplateSeedRegistry,
};
use crate::ai::vision::{
    extract_final_image_urls, normalize_image, VisionImageInput, VisionImageResult,
    MAX_DOWNLOAD_BYTES,
};
use crate::domain::publish_plan::{get_or_create_registry, PlanAuditEvidence};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn jobs() -> &'static Mutex<AiJobManager> {
    static JOBS: OnceLock<Mutex<AiJobManager>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(AiJobManager::default()))
}

#[cfg(test)]
fn command_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Cooperative cancel flags for in-flight MediaInfo child probes (job_id → flag).
fn media_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight MediaInfo results keyed by job id (relative labels only; no absolute paths).
fn media_job_results() -> &'static Mutex<HashMap<String, MediaInfoJobView>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, MediaInfoJobView>>> = OnceLock::new();
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

fn template_seeds() -> &'static Mutex<TemplateSeedRegistry> {
    static SEEDS: OnceLock<Mutex<TemplateSeedRegistry>> = OnceLock::new();
    SEEDS.get_or_init(|| Mutex::new(TemplateSeedRegistry::default()))
}

/// Cooperative cancel flags for in-flight TemplateSelection provider work (job_id → flag).
fn template_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight TemplateSelection views keyed by job id (seed only when Succeeded).
fn template_job_results() -> &'static Mutex<HashMap<String, TemplateSelectionJobView>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, TemplateSelectionJobView>>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bound process-global TemplateSelection result/cancel maps (active jobs are never pruned).
const TEMPLATE_STATE_MAX_RECORDS: usize = 200;

/// Whether a TemplateSelection job may mint or return a usable seed.
///
/// Only `Succeeded` qualifies. `Cancelled` / `Stale` / `Failed` (and non-terminal states)
/// must never mint a seed, return a handoff token, or resurrect after late completion.
fn template_selection_may_return_seed(state: AiJobState) -> bool {
    matches!(state, AiJobState::Succeeded)
}

/// Cooperative cancel flags for in-flight Recognition provider work (job_id → flag).
fn recognition_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Terminal / in-flight Recognition views keyed by job id (result only when Succeeded).
fn recognition_job_results() -> &'static Mutex<HashMap<String, RecognitionJobView>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, RecognitionJobView>>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Bound process-global Recognition result/cancel maps (active jobs are never pruned).
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
    "strict capability probe is not Ready for the current connection; open AI settings, refresh models if needed, and run the capability probe".to_string()
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
    let write_plan = plan_credential_secret_write(
        connection.auth_mode,
        old_ref.clone(),
        connection
            .credential_ref
            .as_ref()
            .map(|reference| reference.id.clone()),
        secret.is_some(),
        unique_connection_candidate_id(),
    );
    let next_ref = write_plan.next_ref_id.clone();

    if let (Some(candidate_id), Some(value)) =
        (write_plan.rollback_candidate_id.as_ref(), secret.as_deref())
    {
        credential_store().set(
            &CredentialRef {
                id: candidate_id.clone(),
            },
            SecretValue::new(value),
        )?;
    }

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
        let _ = rollback_credential_candidate(credential_store(), &write_plan);
        return Err(error);
    }

    // Successful switch: best-effort delete previous active secret (None transition + rotation).
    // Never runs on pre-switch failure, so rollback still preserves the old active secret.
    let _ = cleanup_previous_secret_after_success(credential_store(), &write_plan);

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
    torrent_path: String,
    manual_paths: Vec<String>,
) -> Result<Vec<MediaCandidate>, String> {
    // Discovery returns relative labels + sizes only (no absolute paths).
    discover_media_files(&torrent_path, &manual_paths)
}

/// Start request for a backend-owned MediaInfo job.
///
/// Absolute per-file probe paths are never accepted as authority. Callers supply
/// torrent-relative video entries (and optional content root directory); Rust maps
/// them under allowed torrent/content roots and exposes only relative results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfoStartRequest {
    /// Local torrent path used solely for content-root resolution (never sent to AI).
    pub torrent_path: String,
    /// Torrent-relative video entries. Empty means discover videos under allowed roots.
    /// Explicit batches are capped at `MAX_MEDIA_RELATIVE_ENTRIES` (256).
    #[serde(default)]
    pub relative_entries: Vec<MediaRelativeEntry>,
    /// Optional user-selected content root directory (directory only, not a probe file).
    /// Filesystem / drive roots are rejected.
    #[serde(default)]
    pub content_root: Option<String>,
    pub request_generation: u64,
    pub snapshot_hash: String,
    /// Optional per-file timeout override (ms). Defaults to 30s; clamped to
    /// 100ms..=300_000 (`MAX_MEDIA_PROBE_TIMEOUT_MS`).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Public MediaInfo job view: relative labels/results only, no absolute paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfoJobView {
    pub job_id: String,
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
/// Disabled AI is a true zero-impact path: no sidecar spawn.
/// Cancellation is cooperative and reaches the child MediaInfo process.
#[tauri::command]
pub fn ai_start_media_info(
    app: AppHandle,
    request: MediaInfoStartRequest,
) -> Result<MediaInfoJobView, String> {
    let snapshot_hash = request.snapshot_hash.trim().to_string();
    if snapshot_hash.is_empty() {
        return Err("media info requires a non-empty snapshot_hash".to_string());
    }
    let torrent_path = request.torrent_path.trim().to_string();
    if torrent_path.is_empty() {
        return Err("media info requires a torrent path for content-root resolution".to_string());
    }

    let connection = ai_get_settings(app.clone());
    // Disabled AI must not launch MediaInfo (zero behavioral impact).
    if !connection.enabled {
        return Err("AI is disabled; MediaInfo is not launched".to_string());
    }

    let content_root = request
        .content_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if request.relative_entries.len() > MAX_MEDIA_RELATIVE_ENTRIES {
        return Err(format!(
            "too many relative media entries (max {MAX_MEDIA_RELATIVE_ENTRIES})"
        ));
    }

    // Resolve relative entries under allowed roots before starting the job so
    // absolute caller paths never become probe authority.
    let (probe_requests, mut pre_results) = if request.relative_entries.is_empty() {
        (
            discover_media_probe_requests(torrent_path.as_str(), content_root.as_deref())?,
            Vec::new(),
        )
    } else {
        let batch = resolve_media_relative_entries(
            torrent_path.as_str(),
            &request.relative_entries,
            content_root.as_deref(),
        )?;
        (batch.requests, batch.pre_results)
    };

    let timeout = Duration::from_millis(clamp_media_probe_timeout_ms(request.timeout_ms));

    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::MediaInfo,
            request.request_generation,
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
        state: manager_state,
        request_generation: request.request_generation,
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
                request.request_generation,
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
                request.request_generation,
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
            request.request_generation,
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
        request_generation: request.request_generation,
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
    if let Err(error) = park_pending_media_info_and_drain(work) {
        return Err(error);
    }

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
                store_media_info_view(
                    &bg_job_id,
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
                    ((completed.saturating_mul(100)) / all).min(100) as u8
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
            let sanitized = sanitize_media_results_for_non_success(results);
            store_media_info_view(
                &bg_job_id,
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
        let any_hard_failure = results.iter().any(|item| {
            matches!(
                item.state,
                MediaProbeState::MissingSidecar
                    | MediaProbeState::StartFailed
                    | MediaProbeState::NonZeroExit
                    | MediaProbeState::MalformedJson
                    | MediaProbeState::OversizedOutput
                    | MediaProbeState::TimedOut
            )
        });
        let success = !any_hard_failure;
        let summary = if success {
            format!(
                "MediaInfo probed {} file(s)",
                results
                    .iter()
                    .filter(|item| item.state == MediaProbeState::Measured)
                    .count()
            )
        } else {
            "MediaInfo completed with probe failures".to_string()
        };
        let _ = finish_media_info_job(
            &bg_job_id,
            bg_generation,
            &bg_snapshot,
            success,
            if success {
                None
            } else {
                Some("PROBE_FAILED".to_string())
            },
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
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("STALE".to_string()));
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

fn finish_media_info_job(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    success: bool,
    error_code: Option<String>,
    summary: impl Into<String>,
    results: Vec<MediaProbeResult>,
) -> MediaInfoJobView {
    let summary = summary.into();
    let job = complete_job_backend(job_id, success, error_code.clone(), summary)
        .unwrap_or_else(|_| AiJob {
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
        });

    let mut results = results;
    // Only Succeeded may retain Measured summaries; cancel/stale/failed strip them.
    if !media_info_may_report_success(job.state) {
        results = sanitize_media_results_for_non_success(results);
    }
    let view = store_media_info_view(
        job_id,
        job.request_generation,
        &job.snapshot_hash,
        job.state,
        job.error_code.clone(),
        results,
    );
    // Completing frees a concurrency slot; promote deferred MediaInfo work if any.
    try_start_promoted_media_info_jobs();
    view
}

fn store_media_info_view(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    state: AiJobState,
    error_code: Option<String>,
    results: Vec<MediaProbeResult>,
) -> MediaInfoJobView {
    let view = MediaInfoJobView {
        job_id: job_id.to_string(),
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
    flags: Option<&mut HashMap<String, Arc<AtomicBool>>>,
    results: Option<&mut HashMap<String, MediaInfoJobView>>,
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
                .filter(|(id, view)| {
                    !active_ids.contains(*id) && view.state.is_terminal()
                })
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
                item.message = Some("MediaInfo result discarded after cancel or failure".to_string());
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

#[tauri::command]
pub fn ai_extract_vision_images(
    poster: String,
    markdown: String,
    html: String,
) -> Vec<VisionImageInput> {
    extract_final_image_urls(&poster, &markdown, &html)
}

#[tauri::command]
pub fn ai_normalize_vision_image(
    content_type: String,
    bytes: Vec<u8>,
) -> Result<VisionImageResult, String> {
    // Mirror fetch streaming ceiling so local/command paths cannot force giant decodes.
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err("image too large: download exceeds streaming ceiling".to_string());
    }
    let (normalized, width, height) =
        normalize_image(&content_type, &bytes).map_err(|error| error.to_string())?;
    Ok(VisionImageResult {
        url: String::new(),
        source: "local".to_string(),
        normalized_bytes: normalized.len(),
        width,
        height,
    })
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

/// Public TemplateSelection job view: progress + redacted errors; seed only on Succeeded.
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
    /// Present only when `state == Succeeded` and seed mint was allowed.
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
        seed: None,
    });
    view.state = job.state;
    view.progress = 100;
    view.error_code = job.error_code.clone();
    // Fail closed: only Succeeded may surface a seed token.
    if !template_selection_may_return_seed(job.state) {
        if let Some(seed) = view.seed.take() {
            // Drop any race-minted seed so it cannot be consumed later.
            let _ = template_seeds()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .consume(&seed.token);
        }
        if job.state == AiJobState::Cancelled {
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("CANCELLED".to_string()));
            if view.message.is_none() {
                view.message = Some("template selection cancelled".to_string());
            }
        } else if job.state == AiJobState::Stale {
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("STALE".to_string()));
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
    let job = complete_job_backend(
        job_id,
        false,
        error_code.clone(),
        message.clone(),
    )
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
    // If cancel/stale won the race, honor that terminal state without a seed.
    store_template_selection_view(TemplateSelectionJobView {
        job_id: job_id.to_string(),
        state: job.state,
        request_generation: job.request_generation,
        snapshot_hash: job.snapshot_hash.clone(),
        progress: 100,
        error_code: job.error_code.clone().or(error_code),
        message: Some(message),
        seed: None,
    })
}

/// Mint a seed only when the job is still non-terminal; complete as Succeeded only then.
/// Late cancel between mint and complete drops the seed (fail closed).
fn finish_template_selection_success(
    job_id: &str,
    request_generation: u64,
    snapshot_hash: &str,
    selected_id: &str,
    selected_revision: u64,
    selected_digest: &str,
    torrent_name: String,
    torrent_path: String,
    cancel_flag: &AtomicBool,
) -> TemplateSelectionJobView {
    if template_selection_is_cancelled(job_id, cancel_flag) {
        return finish_template_selection_cancelled(
            job_id,
            request_generation,
            snapshot_hash,
            "template selection cancelled before seed mint",
        );
    }

    let seed = match template_seeds()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .prepare(
            selected_id.to_string(),
            selected_revision,
            selected_digest.to_string(),
            torrent_name,
            torrent_path,
        ) {
        Ok(seed) => seed,
        Err(error) => {
            return finish_template_selection_failure(
                job_id,
                request_generation,
                snapshot_hash,
                Some("SEED_PREPARE".to_string()),
                error,
            );
        }
    };

    let summary = format!(
        "template selection matched id={selected_id} revision={selected_revision}"
    );
    let job = complete_job_backend(job_id, true, None, summary).unwrap_or_else(|_| AiJob {
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

    if !template_selection_may_return_seed(job.state) {
        // Cancel/stale won the race after mint: drop the seed so it is unusable.
        let _ = template_seeds()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .consume(&seed.token);
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
            message: Some("template selection cancelled; seed discarded".to_string()),
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
        seed: Some(seed),
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
        manager
            .cancel(job_id)
            .unwrap_or_else(|_| AiJob {
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
        seed: None,
    })
}

fn retain_template_global_state(
    flags: Option<&mut HashMap<String, Arc<AtomicBool>>>,
    results: Option<&mut HashMap<String, TemplateSelectionJobView>>,
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

    let attempt_modes = formal_modes_for_connection(&connection);
    let mut last_failure: Option<ProviderFailure> = None;
    let mut structured: Option<Value> = None;

    for attempted_mode in attempt_modes {
        if template_selection_is_cancelled(&job_id, &cancel_flag) {
            finish_template_selection_cancelled(
                &job_id,
                0,
                &catalog_hash,
                "template selection cancelled",
            );
            return;
        }

        let provider_request = match build_structured_request(
            connection.provider,
            attempted_mode,
            &connection.endpoint,
            &connection.model,
            &schema,
            connection.auth_mode,
            "okpgui_template_selection",
            &prompt,
            512,
        ) {
            Ok(value) => value,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Unsupported,
                    status: None,
                    message: error,
                });
                break;
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

        let (status, body) = match send_result {
            Ok(pair) => pair,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Server,
                    status: None,
                    message: error,
                });
                break;
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
                last_failure = Some(failure);
                continue;
            }
            last_failure = Some(failure);
            break;
        }

        match extract_structured_json(connection.provider, attempted_mode, &body) {
            Ok(value) => {
                structured = Some(value);
                last_failure = None;
                break;
            }
            Err(failure) => {
                last_failure = Some(failure);
                break;
            }
        }
    }

    if template_selection_is_cancelled(&job_id, &cancel_flag) {
        finish_template_selection_cancelled(
            &job_id,
            0,
            &catalog_hash,
            "template selection cancelled",
        );
        return;
    }

    update_template_job_progress(&job_id, 75, "validating catalog selection");

    // Re-load catalog after the provider round-trip so revision drift fails closed.
    let catalog = load_eligible_catalog(&app);
    if catalog.is_empty() {
        finish_template_selection_failure(
            &job_id,
            0,
            &catalog_hash,
            Some("CATALOG_EMPTY".to_string()),
            "没有可用于自动选择的发布模板。",
        );
        return;
    }

    let structured = match structured {
        Some(value) => value,
        None => {
            let failure = last_failure.unwrap_or(ProviderFailure {
                kind: crate::ai::provider::ProviderFailureKind::Malformed,
                status: None,
                message: "provider template selection failed".to_string(),
            });
            let message = redact_provider_error(&failure.message, &policy);
            finish_template_selection_failure(
                &job_id,
                0,
                &catalog_hash,
                Some("PROVIDER_HTTP".to_string()),
                message,
            );
            return;
        }
    };

    let selected = match parse_template_selection(&structured, &catalog) {
        Ok(entry) => entry,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            finish_template_selection_failure(
                &job_id,
                0,
                &catalog_hash,
                Some("SELECTION_INVALID".to_string()),
                message,
            );
            return;
        }
    };

    update_template_job_progress(&job_id, 90, "minting template seed");

    finish_template_selection_success(
        &job_id,
        0,
        &catalog_hash,
        &selected.id,
        selected.revision,
        &selected.digest,
        torrent_name,
        torrent_path,
        &cancel_flag,
    );
}

/// One-shot / start release recognition request: safe torrent name + template pattern context only.
/// Never accepts absolute torrent paths, publish-plan tokens, or model-owned final titles.
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
    /// Client request generation for stale-result binding.
    pub request_generation: u64,
    /// Snapshot hash for identity binding (caller-supplied; not a publish plan authority).
    pub snapshot_hash: String,
}

/// Public Recognition job view: progress + redacted errors; result only on Succeeded.
///
/// Validated redacted `RecognitionResult` is stored by job id and surfaced only when
/// `state == Succeeded`. Cancelled / Stale / Failed / late completion never return a result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognitionJobView {
    pub job_id: String,
    pub state: AiJobState,
    pub request_generation: u64,
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
/// Provider work runs in the background. The client polls via `ai_poll_recognition`
/// and cancels via `ai_cancel_job`. Reuses recognition schema/prompt/strict validation
/// and redaction utilities. Disabled/unconfigured AI is rejected with zero provider work.
#[tauri::command]
pub async fn ai_start_recognition(
    app: AppHandle,
    request: AiRecognizeRequest,
) -> Result<RecognitionJobView, String> {
    let snapshot_hash = request.snapshot_hash.trim().to_string();
    if snapshot_hash.is_empty() {
        return Err("recognition requires a non-empty snapshot_hash".to_string());
    }

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

    let (safe_torrent_name, safe_ep, safe_res, safe_title) = sanitize_recognition_context(
        &request.torrent_name,
        &request.ep_pattern,
        &request.resolution_pattern,
        &request.title_pattern,
        &policy,
    )?;
    let safe_snapshot_hash = policy.redact_text(&snapshot_hash);

    let job_id = {
        let mut manager = jobs().lock().unwrap_or_else(|error| error.into_inner());
        manager.start(
            JobKind::Recognition,
            request.request_generation,
            safe_snapshot_hash.clone(),
            Some(identity),
        )
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = recognition_cancel_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        flags.insert(job_id.clone(), Arc::clone(&cancel_flag));
        retain_recognition_global_state(Some(&mut flags), None);
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
        request_generation: request.request_generation,
        snapshot_hash: safe_snapshot_hash.clone(),
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
        retain_recognition_global_state(None, Some(&mut store));
    }

    let bg_job_id = job_id.clone();
    let bg_connection = connection;
    let bg_generation = request.request_generation;
    let bg_snapshot = safe_snapshot_hash;
    let bg_torrent = safe_torrent_name;
    let bg_ep = safe_ep;
    let bg_res = safe_res;
    let bg_title = safe_title;
    tauri::async_runtime::spawn(async move {
        run_recognition_worker(
            bg_connection,
            secret,
            bg_job_id,
            bg_generation,
            bg_snapshot,
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
            view.error_code = job
                .error_code
                .clone()
                .or_else(|| Some("STALE".to_string()));
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
        retain_recognition_global_state(None, Some(&mut store));
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
        retain_recognition_global_state(None, Some(&mut store));
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
    let job = complete_job_backend(
        job_id,
        false,
        error_code.clone(),
        message.clone(),
    )
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
    flags: Option<&mut HashMap<String, Arc<AtomicBool>>>,
    results: Option<&mut HashMap<String, RecognitionJobView>>,
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
}

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

    let prompt = build_recognition_prompt(&torrent_name, &ep_pattern, &resolution_pattern, &title_pattern);
    let schema = recognition_schema();

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

    let attempt_modes = formal_modes_for_connection(&connection);
    let mut last_failure: Option<ProviderFailure> = None;
    let mut structured: Option<Value> = None;

    for attempted_mode in attempt_modes {
        if recognition_is_cancelled(&job_id, &cancel_flag) {
            finish_recognition_cancelled(
                &job_id,
                request_generation,
                &snapshot_hash,
                "recognition cancelled",
            );
            return;
        }

        let provider_request = match build_structured_request(
            connection.provider,
            attempted_mode,
            &connection.endpoint,
            &connection.model,
            &schema,
            connection.auth_mode,
            "okpgui_recognition",
            &prompt,
            512,
        ) {
            Ok(value) => value,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Unsupported,
                    status: None,
                    message: error,
                });
                break;
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

        let (status, body) = match send_result {
            Ok(pair) => pair,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Server,
                    status: None,
                    message: error,
                });
                break;
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
                last_failure = Some(failure);
                continue;
            }
            last_failure = Some(failure);
            break;
        }

        match extract_structured_json(connection.provider, attempted_mode, &body) {
            Ok(value) => {
                structured = Some(value);
                last_failure = None;
                break;
            }
            Err(failure) => {
                last_failure = Some(failure);
                break;
            }
        }
    }

    if recognition_is_cancelled(&job_id, &cancel_flag) {
        finish_recognition_cancelled(
            &job_id,
            request_generation,
            &snapshot_hash,
            "recognition cancelled",
        );
        return;
    }

    update_recognition_job_progress(&job_id, 75, "validating recognition output");

    let structured = match structured {
        Some(value) => value,
        None => {
            let failure = last_failure.unwrap_or(ProviderFailure {
                kind: crate::ai::provider::ProviderFailureKind::Malformed,
                status: None,
                message: "provider recognition failed".to_string(),
            });
            let message = redact_provider_error(&failure.message, &policy);
            finish_recognition_failure(
                &job_id,
                request_generation,
                &snapshot_hash,
                Some("PROVIDER_HTTP".to_string()),
                message,
            );
            return;
        }
    };

    let output = match recognition_from_provider_outcome(Some(&structured), None) {
        Ok(output) => output,
        Err(error) => {
            let message = redact_provider_error(&error, &policy);
            finish_recognition_failure(
                &job_id,
                request_generation,
                &snapshot_hash,
                Some("RECOGNITION_INVALID".to_string()),
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
/// Capability-gated (Ready identity), JobKind::Recognition lifecycle, strict structured
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
    Ok(ConsumedTemplateSeed {
        template_id: public.template_id,
        template_revision: public.template_revision,
        template_digest: public.template_digest,
        torrent_name: public.torrent_name,
        torrent_path: binding.torrent_path,
    })
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
pub fn ai_project_context(
    request: AiProjectContextRequest,
) -> Result<ContextProjection, String> {
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
    project_context_from_binding(&binding, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING)
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
    let findings = findings
        .into_iter()
        .map(|mut finding| {
            if let Some(path) = finding.evidence_path.as_ref() {
                finding.evidence_path = Some(policy.redact_secret_substrings(path));
            }
            finding
        })
        .collect();
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
        || !capability_identity_matches(&capability.identity_digest, connection, secret)
    {
        return Err(capability_gate_error());
    }
    Ok(identity)
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
        let binding = {
            let mut guard = get_or_create_registry()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match guard.resolve_binding_for_context(&plan_token) {
                Ok(binding) => binding,
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
        match project_context_from_binding(&binding, &policy, DEFAULT_CONTEXT_CEILING) {
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

    let attempt_modes = formal_modes_for_connection(&connection);
    let mut last_failure: Option<ProviderFailure> = None;
    let mut formal_ran = false;
    let mut structured: Option<Value> = None;

    for attempted_mode in attempt_modes {
        let provider_request = match build_structured_request(
            connection.provider,
            attempted_mode,
            &connection.endpoint,
            &connection.model,
            &schema,
            connection.auth_mode,
            "okpgui_audit",
            &prompt,
            1024,
        ) {
            Ok(value) => value,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Unsupported,
                    status: None,
                    message: error,
                });
                break;
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
        formal_ran = true;

        let (status, body) = match send_result {
            Ok(pair) => pair,
            Err(error) => {
                last_failure = Some(ProviderFailure {
                    kind: crate::ai::provider::ProviderFailureKind::Server,
                    status: None,
                    message: error,
                });
                break;
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
                last_failure = Some(failure);
                continue;
            }
            last_failure = Some(failure);
            break;
        }

        match extract_structured_json(connection.provider, attempted_mode, &body) {
            Ok(value) => {
                structured = Some(value);
                last_failure = None;
                break;
            }
            Err(failure) => {
                last_failure = Some(failure);
                break;
            }
        }
    }

    if let Some(structured) = structured {
        // Keep parse_formal_audit_findings pure for unit callers; bind evidence to projection here.
        let findings = parse_formal_audit_findings(&structured);
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
        return complete_and_bind_formal_audit(&job_id, true, None, summary, result);
    }

    let failure = last_failure.unwrap_or(ProviderFailure {
        kind: crate::ai::provider::ProviderFailureKind::Malformed,
        status: None,
        message: "provider formal audit failed".to_string(),
    });
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
        Some("PROVIDER_HTTP".to_string()),
        message,
        result,
    )
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

/// Local decision helper retained for unit-style callers; not a public IPC surface for publish.
#[allow(dead_code)]
pub fn ai_compute_audit_local(input: AuditInput) -> Result<ValidatedAudit, String> {
    let policy = RedactionPolicy::default();
    let sanitized = sanitize_audit_input(input, &policy);
    Ok(compute_decision(&sanitized))
}

/// Crate-private job lifecycle: only backend workers may start jobs.
#[allow(dead_code)]
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
#[allow(dead_code)]
pub(crate) fn mark_job_stale_backend(id: &str, reason: impl Into<String>) -> Result<AiJob, String> {
    let job = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .mark_stale(id, reason)?;
    try_start_promoted_media_info_jobs();
    Ok(job)
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

#[tauri::command]
pub fn ai_cancel_job(id: String) -> Result<AiJob, String> {
    // Signal MediaInfo child probes before flipping job state so waiters observe cancel.
    signal_media_cancel(&id);
    // Signal TemplateSelection provider work so late completion cannot mint a seed.
    signal_template_cancel(&id);
    // Signal Recognition provider work so late completion cannot surface a result.
    signal_recognition_cancel(&id);
    // Drop any deferred probe work for this id (Queued cancel must not later spawn).
    {
        let mut pending = media_pending_work()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.remove(&id);
    }
    let job = jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .cancel(&id)?;
    if job.kind == JobKind::MediaInfo {
        if media_info_may_report_success(job.state) {
            // Cancel-after-success is idempotent: never mutate or strip measured results.
            if let Ok(mut store) = media_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                }
                retain_media_global_state(None, Some(&mut store));
            }
        } else if let Ok(mut store) = media_job_results().lock() {
            // Cancel-before-complete (or re-cancel of Cancelled/Failed/Stale): sanitize.
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
        if template_selection_may_return_seed(job.state) {
            // Cancel-after-success is idempotent: keep the already-minted seed.
            if let Ok(mut store) = template_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                }
                retain_template_global_state(None, Some(&mut store));
            }
        } else if let Ok(mut store) = template_job_results().lock() {
            // Cancel-before-success: drop any race-minted seed and never hand it off.
            if let Some(view) = store.get_mut(&id) {
                if let Some(seed) = view.seed.take() {
                    let _ = template_seeds()
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .consume(&seed.token);
                }
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
                        seed: None,
                    },
                );
            }
            retain_template_global_state(None, Some(&mut store));
        }
    }
    if job.kind == JobKind::Recognition {
        if recognition_may_return_result(job.state) {
            // Cancel-after-success is idempotent: keep the already-stored result.
            if let Ok(mut store) = recognition_job_results().lock() {
                if let Some(view) = store.get_mut(&id) {
                    view.state = job.state;
                    view.progress = job.progress;
                    view.error_code = job.error_code.clone();
                }
                retain_recognition_global_state(None, Some(&mut store));
            }
        } else if let Ok(mut store) = recognition_job_results().lock() {
            // Cancel-before-success: drop any race-stored result and never surface it.
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
            } else {
                store.insert(
                    id.clone(),
                    RecognitionJobView {
                        job_id: id.clone(),
                        state: job.state,
                        request_generation: job.request_generation,
                        snapshot_hash: job.snapshot_hash.clone(),
                        progress: 100,
                        error_code: job
                            .error_code
                            .clone()
                            .or_else(|| Some("CANCELLED".to_string())),
                        message: Some("recognition cancelled".to_string()),
                        result: None,
                    },
                );
            }
            retain_recognition_global_state(None, Some(&mut store));
        }
    }
    // Cancelling any Running job (MediaInfo or cross-kind) frees capacity and may
    // promote Queued MediaInfo work. Drain after releasing the jobs lock above.
    try_start_promoted_media_info_jobs();
    Ok(job)
}

/// Read-only list of bounded, non-secret AI job debug records (no raw provider bodies/secrets).
#[tauri::command]
pub fn ai_list_debug_records() -> Vec<DebugRecord> {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .list_debug_records()
}

/// Clear retained non-secret AI job debug records.
#[tauri::command]
pub fn ai_clear_debug_records() {
    jobs()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear_debug_records();
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
    // Strip non-success TemplateSelection seeds before/after cancel_unfinished.
    {
        let mut store = template_job_results()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for view in store.values_mut() {
            if !view.state.is_terminal() {
                if let Some(seed) = view.seed.take() {
                    let _ = template_seeds()
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .consume(&seed.token);
                }
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

/// Discover models for the saved connection. Disabled/unconfigured AI makes zero network calls.
/// Failures never return secrets or response bodies; callers may keep a manual model.
#[tauri::command]
pub async fn ai_list_models(app: AppHandle) -> Result<AiModelDiscoveryResult, String> {
    let connection = ai_get_settings(app.clone());
    if !connection.enabled {
        return Err("AI is disabled; model discovery makes no network calls".to_string());
    }
    if connection.endpoint.trim().is_empty() {
        return Err("configure a provider endpoint before refreshing models".to_string());
    }
    if connection.auth_mode != AuthMode::None && connection.credential_ref.is_none() {
        return Err("configure a credential before refreshing models".to_string());
    }

    let secret = match resolve_stored_secret(&connection)? {
        Some(value) => Some(value),
        None if connection.auth_mode == AuthMode::None => None,
        None => {
            return Err("AI credential is missing from the secure store".to_string());
        }
    };

    let client = build_no_redirect_client()?;
    let request = build_models_list_request(
        connection.provider,
        &connection.endpoint,
        connection.auth_mode,
    )?;

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
        Ok((status, body)) => match parse_models_list_response(connection.provider, status, &body)
        {
            Ok(models) => {
                let _ = crate::config::save_ai_discovered_models(
                    &app,
                    models.clone(),
                    Some(fetched_at_unix),
                );
                Ok(AiModelDiscoveryResult {
                    models,
                    fetched_at_unix,
                    manual_fallback: false,
                    message: "models refreshed".to_string(),
                })
            }
            Err(failure) => {
                // Keep any previous cached list; UI keeps manual model entry.
                Ok(AiModelDiscoveryResult {
                    models: connection.discovered_models,
                    fetched_at_unix,
                    manual_fallback: true,
                    message: failure.message,
                })
            }
        },
        Err(error) => Ok(AiModelDiscoveryResult {
            models: connection.discovered_models,
            fetched_at_unix,
            manual_fallback: true,
            message: error.chars().take(240).collect(),
        }),
    }
}

/// Live backend-owned strict capability probe using stored credentials (never webview secrets).
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
            message: "capability probe in progress".to_string(),
            probed_at_unix: Some(now_unix()),
        }),
    );

    let client = match build_no_redirect_client() {
        Ok(client) => client,
        Err(error) => {
            let status = persist_probe_outcome(
                &app,
                &identity,
                CapabilityState::Failed,
                connection.mode,
                error.clone(),
            );
            let _ = complete_job_backend(
                &job_id,
                false,
                Some("PROVIDER_CLIENT".to_string()),
                error,
            );
            return Ok(status);
        }
    };

    let attempt_modes = formal_attempt_modes(connection.provider, connection.mode);
    let mut last_result: Option<CapabilityProbeResult> = None;

    for attempted_mode in attempt_modes {
        let provider_request = match build_probe_request(
            connection.provider,
            attempted_mode,
            &connection.endpoint,
            &connection.model,
            &schema,
            connection.auth_mode,
        ) {
            Ok(value) => value,
            Err(error) => {
                last_result = Some(CapabilityProbeResult {
                    state: CapabilityState::Failed,
                    provider: connection.provider,
                    mode: attempted_mode,
                    status: 0,
                    message: error,
                    usage: None,
                });
                break;
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
            Ok((status, body)) => classify_and_validate_probe_response(
                connection.provider,
                attempted_mode,
                status,
                &body,
            ),
            Err(error) => CapabilityProbeResult {
                state: CapabilityState::Failed,
                provider: connection.provider,
                mode: attempted_mode,
                status: 0,
                message: error.chars().take(240).collect(),
                usage: None,
            },
        };

        if probe.state == CapabilityState::Ready {
            last_result = Some(probe);
            break;
        }

        let failure = ProviderFailure {
            kind: match probe.state {
                CapabilityState::Unsupported => {
                    crate::ai::provider::ProviderFailureKind::Unsupported
                }
                _ => crate::ai::provider::ProviderFailureKind::Server,
            },
            status: if probe.status == 0 {
                None
            } else {
                Some(probe.status)
            },
            message: probe.message.clone(),
        };

        // Narrow Auto fallback: only OpenAI Auto Responses→Chat on explicit 404 unsupported.
        if auto_fallback_allowed(
            connection.provider,
            connection.mode,
            attempted_mode,
            &failure,
        ) {
            last_result = Some(probe);
            continue;
        }

        last_result = Some(probe);
        break;
    }

    let result = last_result.unwrap_or(CapabilityProbeResult {
        state: CapabilityState::Failed,
        provider: connection.provider,
        mode: connection.mode,
        status: 0,
        message: "capability probe did not complete".to_string(),
        usage: None,
    });

    let public = persist_probe_outcome(
        &app,
        &identity,
        result.state,
        result.mode,
        result.message.clone(),
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
        result.message,
    );

    Ok(public)
}

fn persist_probe_outcome(
    app: &AppHandle,
    identity: &CapabilityIdentity,
    state: CapabilityState,
    resolved_mode: ProviderMode,
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
        message: message.clone(),
        probed_at_unix,
    };
    let _ = crate::config::save_ai_capability(app, Some(config));
    PublicCapabilityStatus {
        state,
        identity_digest: identity.digest.clone(),
        resolved_mode: Some(resolved_mode),
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

        ai_clear_debug_records();
        assert!(ai_list_debug_records().is_empty());
    }

    #[test]
    fn app_exit_hook_cancels_unfinished_jobs() {
        let _guard = command_test_guard();
        let running = start_job_backend(JobKind::Vision, 1, "sha256:exit-run", None);
        let queued = start_job_backend(JobKind::Vision, 1, "sha256:exit-queue", None);
        cancel_unfinished_ai_jobs_on_exit();
        assert_eq!(
            ai_get_job(running).unwrap().state,
            AiJobState::Cancelled
        );
        assert_eq!(
            ai_get_job(queued).unwrap().state,
            AiJobState::Cancelled
        );
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
        assert!(!result.formal_ran, "context failure must not claim provider ran");
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
        assert_eq!(request.snapshot_hash.as_deref(), Some("sha256:client-forged"));
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

#[allow(dead_code)]
fn _secret_type_is_private(secret: SecretValue) -> String {
    format!("{secret:?}")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Process-unique credential candidate id: wall-clock seconds plus a monotonic counter.
/// Concurrent saves within the same second must not collide on the keyring entry name.
fn unique_connection_candidate_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("connection-{}-{}", now_unix(), seq)
}

#[cfg(test)]
mod candidate_id_tests {
    use super::unique_connection_candidate_id;

    #[test]
    fn candidate_ids_are_unique_within_the_same_second() {
        let first = unique_connection_candidate_id();
        let second = unique_connection_candidate_id();
        assert_ne!(
            first, second,
            "same-second concurrent saves must not share an id"
        );
        assert!(
            first.starts_with("connection-") && second.starts_with("connection-"),
            "ids must keep the connection- prefix without embedding secrets"
        );
        // Counter suffix differs even when the unix-second prefix matches.
        let first_seq = first.rsplit('-').next().unwrap_or_default();
        let second_seq = second.rsplit('-').next().unwrap_or_default();
        assert_ne!(first_seq, second_seq);
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
            message: "failed".into(),
            probed_at_unix: Some(1),
            identity_matches: false,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_err());

        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: "sha256:other".into(),
            resolved_mode: Some(ProviderMode::Chat),
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: false,
        });
        assert!(require_ready_capability_identity(&connection, Some(&secret)).is_err());

        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Chat),
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
            message: "ready".into(),
            probed_at_unix: Some(1),
            identity_matches: true,
        });
        let new_secret = SecretValue::new("new-secret");
        let err = require_ready_capability_identity(&connection, Some(&new_secret)).unwrap_err();
        assert!(err.contains("capability probe"), "{err}");
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
            message: "ok".into(),
            probed_at_unix: Some(42),
        });
        assert_eq!(status.state, CapabilityState::Ready);
        assert_eq!(status.resolved_mode, Some(ProviderMode::Chat));
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
    use crate::ai::recognition::{
        bind_recognition_result, recognition_from_provider_outcome, sanitize_recognition_context,
        RECOGNITION_SCHEMA_VERSION,
    };
    use crate::ai::credentials::PublicCapabilityStatus;
    use crate::ai::provider::CapabilityState;
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
        assert!(err.contains("capability probe") || err.contains("AI settings"), "{err}");

        let identity = capability_identity(&connection, Some(&secret));
        connection.capability = Some(PublicCapabilityStatus {
            state: CapabilityState::Ready,
            identity_digest: identity.digest,
            resolved_mode: Some(ProviderMode::Responses),
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
        assert!(err.contains("torrent_name") || err.contains("path"), "{err}");
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
        let media_id =
            start_job_backend(JobKind::MediaInfo, 9, "sha256:bound-media", None);
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
        let media_id =
            start_job_backend(JobKind::MediaInfo, 7, "sha256:toctou-live-handoff", None);
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
        let media_reject =
            start_job_backend(JobKind::MediaInfo, 1, "sha256:overflow-reject", None);
        let filler = start_job_backend(JobKind::Audit, 1, "sha256:overflow-filler", None);
        let media_q =
            start_job_backend(JobKind::MediaInfo, 2, "sha256:overflow-queued", None);
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
        assert!(!media_pending_work().lock().unwrap().contains_key(&media_reject));
        assert!(!media_job_results().lock().unwrap().contains_key(&media_reject));
        assert!(!media_cancel_flags().lock().unwrap().contains_key(&media_reject));

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
            let terminal_count = store.values().filter(|view| view.state.is_terminal()).count();
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
            candidates.iter().any(|c| {
                c.to_string_lossy()
                    .replace('\\', "/")
                    .starts_with(&exe_dir)
            }),
            "fallback resource base must include current_exe parent candidates"
        );
    }
}

#[cfg(test)]
mod template_selection_job_tests {
    use super::*;

    fn sample_seed(token: &str) -> TemplateSeed {
        TemplateSeed {
            token: token.to_string(),
            template_id: "zzz-last".into(),
            template_revision: 2,
            template_digest: "sha256:zzz".into(),
            torrent_name: "show.mkv".into(),
        }
    }

    #[test]
    fn template_selection_seed_gate_allows_only_succeeded() {
        assert!(template_selection_may_return_seed(AiJobState::Succeeded));
        assert!(!template_selection_may_return_seed(AiJobState::Failed));
        assert!(!template_selection_may_return_seed(AiJobState::Cancelled));
        assert!(!template_selection_may_return_seed(AiJobState::Stale));
        assert!(!template_selection_may_return_seed(AiJobState::Running));
        assert!(!template_selection_may_return_seed(AiJobState::Queued));
    }

    #[test]
    fn poll_template_selection_returns_none_until_terminal() {
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
            seed: Some(sample_seed("seed_ok")),
        });
        let terminal = ai_poll_template_selection(job_id)
            .unwrap()
            .expect("terminal");
        assert_eq!(terminal.state, AiJobState::Succeeded);
        assert_eq!(
            terminal.seed.as_ref().map(|seed| seed.token.as_str()),
            Some("seed_ok")
        );
        assert_eq!(
            terminal.seed.as_ref().map(|seed| seed.template_id.as_str()),
            Some("zzz-last")
        );
        // Opaque seed must never include a torrent path field in the public view shape.
        let serialized = serde_json::to_string(&terminal).unwrap();
        assert!(!serialized.contains("torrent_path"));
    }

    #[test]
    fn cancel_template_selection_strips_seed_and_blocks_late_success() {
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
            // Race seed that must be discarded on cancel-before-success.
            seed: Some(sample_seed("seed_race")),
        });

        let cancelled = ai_cancel_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.state, AiJobState::Cancelled);
        assert!(flag.load(Ordering::Relaxed), "cancel must signal flag");

        // Late complete cannot resurrect Succeeded or keep a handoff seed.
        let late = complete_job_backend(&job_id, true, None, "late success").unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);

        let terminal = ai_poll_template_selection(job_id).unwrap().expect("terminal");
        assert_eq!(terminal.state, AiJobState::Cancelled);
        assert!(terminal.seed.is_none(), "cancelled must not hand off seed");
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("CANCELLED"),
            "{:?}",
            terminal.error_code
        );
    }

    #[test]
    fn failed_selection_never_returns_seed() {
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
        assert_eq!(view.error_code.as_deref(), Some("SELECTION_INVALID"));

        let polled = ai_poll_template_selection(job_id).unwrap().expect("terminal");
        assert_eq!(polled.state, AiJobState::Failed);
        assert!(polled.seed.is_none());
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
    fn stale_or_cancelled_finish_success_discards_seed() {
        let _guard = command_test_guard();
        let job_id = start_job_backend(JobKind::TemplateSelection, 0, "sha256:stale", None);
        ai_cancel_job(job_id.clone()).unwrap();

        // finish_success after cancel must not return a seed even if prepare would work
        // with a real torrent — the job is already terminal Cancelled.
        let view = finish_template_selection_success(
            &job_id,
            0,
            "sha256:stale",
            "zzz-last",
            2,
            "sha256:zzz",
            "show.mkv".into(),
            "/tmp/does-not-matter.torrent".into(),
            &AtomicBool::new(true),
        );
        assert_ne!(view.state, AiJobState::Succeeded);
        assert!(view.seed.is_none());
        assert!(!template_selection_may_return_seed(view.state));
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
