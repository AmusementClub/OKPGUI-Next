//! Backend-owned AI job registry.
//!
//! Lifecycle mutations (`start` / `complete` / `mark_stale`) are for crate-private
//! workers only. Webview IPC must not expose forgeable job creation or completion;
//! registered commands are limited to read status and cancel.
//!
//! Terminal debug records may optionally persist under an app-local durable store
//! (wired by Tauri setup). Persistence failures never affect job lifecycle results;
//! when a durable store is configured they fail closed by restoring in-memory debug
//! state so memory and disk stay consistent.

use crate::ai::provider::CapabilityIdentity;
use crate::ai::redaction::RedactionPolicy;
use crate::atomic_file;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    CapabilityProbe,
    Recognition,
    TemplateSelection,
    MediaInfo,
    Vision,
    Audit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiJobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Stale,
}

impl AiJobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Stale
        )
    }
}

/// Whether formal-audit terminal evidence may replace prepare-time PENDING on a plan.
///
/// Only `Succeeded` / `Failed` are bindable. `Cancelled` / `Stale` (user cancel, app exit,
/// or late completion after those) must leave the prepare-time PENDING evidence intact and
/// never bind formal GO/WARNING/NO_GO or provider-failure WARNING evidence.
pub fn formal_audit_may_bind_terminal_evidence(state: AiJobState) -> bool {
    matches!(state, AiJobState::Succeeded | AiJobState::Failed)
}

/// Whether a MediaInfo job may report a successful measured media result.
///
/// Only `Succeeded` qualifies. `Cancelled` / `Stale` / `Failed` (and non-terminal states)
/// must never publish measured summaries as a successful media outcome, mutate a plan,
/// or resurrect after late completion.
pub fn media_info_may_report_success(state: AiJobState) -> bool {
    matches!(state, AiJobState::Succeeded)
}

/// Whether a terminal MediaInfo job may bind redacted summaries onto a PublishPlan.
///
/// Same gate as [`media_info_may_report_success`]: only `Succeeded` may bind.
/// Cancel / timeout / nonzero / malformed / oversized / Failed / Stale must leave
/// plan-owned media evidence unchanged.
pub fn media_info_may_bind_plan_evidence(state: AiJobState) -> bool {
    media_info_may_report_success(state)
}

/// Whether a Recognition job may surface a validated redacted `RecognitionResult`.
///
/// Only `Succeeded` qualifies. `Cancelled` / `Stale` / `Failed` (and non-terminal states)
/// must never return advisory candidates, and late completion after cancel/stale must not
/// resurrect a result.
pub fn recognition_may_return_result(state: AiJobState) -> bool {
    matches!(state, AiJobState::Succeeded)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiJob {
    pub id: String,
    pub kind: JobKind,
    pub state: AiJobState,
    pub request_generation: u64,
    pub snapshot_hash: String,
    pub provider_identity: Option<CapabilityIdentity>,
    pub progress: u8,
    pub error_code: Option<String>,
    pub debug_record_id: Option<String>,
    pub created_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugRecord {
    pub id: String,
    pub job_id: String,
    pub kind: JobKind,
    pub state: AiJobState,
    pub created_at_unix: u64,
    pub completed_at_unix: Option<u64>,
    /// Non-secret human summary only — never raw provider bodies or credentials.
    pub summary: String,
    /// Token usage counters only (non-secret).
    pub usage: Option<crate::ai::provider::ProviderUsage>,
}

/// Default retention for debug records (bounded by the V2 privacy contract).
pub const DEBUG_RECORD_MAX_AGE_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const DEBUG_RECORD_MAX_RECORDS: usize = 200;

/// Fixed relative directory under app-local data for durable AI debug records.
pub const DEBUG_STORE_RELATIVE_DIR: &str = "ai/debug";
/// Durable store filename (JSON array wrapper; never raw provider bodies).
pub const DEBUG_STORE_FILE_NAME: &str = "records.json";
/// Export subdirectory under the debug store directory.
pub const DEBUG_EXPORT_RELATIVE_DIR: &str = "exports";

const DEBUG_STORE_VERSION: u32 = 1;

/// On-disk envelope for durable debug records (versioned; non-secret fields only).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DebugRecordStoreFile {
    version: u32,
    records: Vec<DebugRecord>,
}

/// Result of loading the durable debug store on init.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DebugStoreLoadOutcome {
    /// No `records.json` present; memory starts empty.
    Absent,
    /// Valid envelope loaded into memory.
    Loaded,
    /// Corrupt file quarantined; active path left absent until a later write.
    IsolatedCorrupt,
}

/// Safe metadata returned by debug export IPC (no raw content / absolute paths).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DebugExportMetadata {
    /// Basename only (e.g. `ai-debug-export-1710000000.json`).
    pub file_name: String,
    pub record_count: usize,
    pub exported_at_unix: u64,
}

#[derive(Debug, Clone)]
pub struct AiJobManager {
    jobs: HashMap<String, AiJob>,
    queue: VecDeque<String>,
    debug_records: Vec<DebugRecord>,
    /// Full path to `records.json` when durable store is configured; `None` = memory only.
    debug_store_path: Option<PathBuf>,
    running: usize,
    max_running: usize,
    next_id: u64,
}

impl Default for AiJobManager {
    fn default() -> Self {
        Self::new(2)
    }
}

impl AiJobManager {
    pub fn new(max_running: usize) -> Self {
        Self {
            jobs: HashMap::new(),
            queue: VecDeque::new(),
            debug_records: Vec::new(),
            debug_store_path: None,
            running: 0,
            max_running: max_running.max(1),
            next_id: 1,
        }
    }

    /// Configure the optional durable store under `store_dir` (typically
    /// `{app_local_data_dir}/ai/debug`). Loads valid records, isolates a corrupt
    /// store file, applies retention, and persists the cleaned set when a valid
    /// store was loaded or the path was already empty. After quarantine, leaves
    /// the active `records.json` absent until a later terminal write recreates
    /// it. When retention/sanitization mutates the loaded set but the cleanup
    /// persist fails, restores the post-load in-memory snapshot so memory stays
    /// consistent with the unchanged on-disk store. Never panics.
    pub fn init_debug_store(&mut self, store_dir: impl Into<PathBuf>) {
        let store_dir = store_dir.into();
        if let Err(_error) = std::fs::create_dir_all(&store_dir) {
            // Non-fatal: remain memory-only if the directory cannot be created.
            return;
        }
        let store_path = store_dir.join(DEBUG_STORE_FILE_NAME);
        self.debug_store_path = Some(store_path);
        let load_outcome = self.load_debug_store();
        // Snapshot post-load state before retention / re-sanitization so a failed
        // cleanup write can restore memory to match the still-unchanged disk file.
        let previous_after_load = self.debug_records.clone();
        let now = now_unix();
        self.retain_debug_records_in_memory(
            now,
            DEBUG_RECORD_MAX_AGE_SECONDS,
            DEBUG_RECORD_MAX_RECORDS,
        );
        self.sanitize_loaded_summaries();
        // Do not immediately rewrite an empty envelope over a just-quarantined
        // corrupt file; a later complete/cancel path recreates a valid store.
        if !matches!(load_outcome, DebugStoreLoadOutcome::IsolatedCorrupt)
            && self.persist_debug_store().is_err()
        {
            self.debug_records = previous_after_load;
        }
    }

    /// Whether a durable store path is configured (tests / diagnostics).
    #[allow(dead_code)]
    pub fn debug_store_configured(&self) -> bool {
        self.debug_store_path.is_some()
    }

    pub fn start(
        &mut self,
        kind: JobKind,
        request_generation: u64,
        snapshot_hash: impl Into<String>,
        provider_identity: Option<CapabilityIdentity>,
    ) -> String {
        let id = self.new_id("job");
        let state = if self.running < self.max_running {
            self.running += 1;
            AiJobState::Running
        } else {
            self.queue.push_back(id.clone());
            AiJobState::Queued
        };
        self.jobs.insert(
            id.clone(),
            AiJob {
                id: id.clone(),
                kind,
                state,
                request_generation,
                snapshot_hash: snapshot_hash.into(),
                provider_identity,
                progress: 0,
                error_code: None,
                debug_record_id: None,
                created_at_unix: now_unix(),
            },
        );
        id
    }

    pub fn get(&self, id: &str) -> Option<&AiJob> {
        self.jobs.get(id)
    }

    pub fn list(&self) -> Vec<AiJob> {
        self.jobs.values().cloned().collect()
    }

    pub fn update_progress(&mut self, id: &str, progress: u8) -> Result<(), String> {
        let job = self
            .jobs
            .get_mut(id)
            .ok_or_else(|| "job not found".to_string())?;
        if !matches!(job.state, AiJobState::Running) {
            return Err("only running jobs accept progress updates".to_string());
        }
        job.progress = progress.min(100);
        Ok(())
    }

    pub fn cancel(&mut self, id: &str) -> Result<AiJob, String> {
        let current = self
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())?;
        if current.state.is_terminal() {
            return Ok(current);
        }
        let was_running = current.state == AiJobState::Running;
        if let Some(job) = self.jobs.get_mut(id) {
            job.state = AiJobState::Cancelled;
            job.error_code = Some("CANCELLED".to_string());
            job.progress = 100;
        }
        if was_running {
            self.running = self.running.saturating_sub(1);
            self.promote_next();
        } else {
            self.queue.retain(|queued| queued != id);
        }
        self.finish_debug(id, AiJobState::Cancelled, "job cancelled", None);
        self.jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())
    }

    pub fn complete(
        &mut self,
        id: &str,
        success: bool,
        error_code: Option<String>,
        summary: impl Into<String>,
        usage: Option<crate::ai::provider::ProviderUsage>,
    ) -> Result<AiJob, String> {
        let current = self
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())?;
        if current.state.is_terminal() {
            return Ok(current);
        }
        if current.state == AiJobState::Running {
            self.running = self.running.saturating_sub(1);
        } else {
            self.queue.retain(|queued| queued != id);
        }
        let state = if success {
            AiJobState::Succeeded
        } else {
            AiJobState::Failed
        };
        if let Some(job) = self.jobs.get_mut(id) {
            job.state = state;
            job.error_code = error_code;
            job.progress = 100;
        }
        self.finish_debug(id, state, summary.into(), usage);
        self.promote_next();
        self.jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())
    }

    pub fn mark_stale(&mut self, id: &str, reason: impl Into<String>) -> Result<AiJob, String> {
        let current = self
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())?;
        if current.state.is_terminal() {
            return Ok(current);
        }
        if current.state == AiJobState::Running {
            self.running = self.running.saturating_sub(1);
        }
        self.queue.retain(|queued| queued != id);
        if let Some(job) = self.jobs.get_mut(id) {
            job.state = AiJobState::Stale;
            job.error_code = Some("STALE".to_string());
            job.progress = 100;
        }
        self.finish_debug(id, AiJobState::Stale, reason.into(), None);
        self.promote_next();
        self.jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())
    }

    pub fn cancel_unfinished(&mut self) {
        let ids = self
            .jobs
            .values()
            .filter(|job| !job.state.is_terminal())
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.cancel(&id);
        }
    }

    #[allow(dead_code)]
    pub fn debug_records(&self) -> &[DebugRecord] {
        &self.debug_records
    }

    /// Read-only clone of non-secret debug records for IPC listing.
    pub fn list_debug_records(&self) -> Vec<DebugRecord> {
        self.debug_records
            .iter()
            .map(sanitize_debug_record)
            .collect()
    }

    /// Clear all retained debug records (non-secret metadata only).
    ///
    /// When a durable store is configured, persists the empty set. On durable
    /// write failure, restores the prior in-memory records so memory and disk
    /// stay consistent and returns `Err` for the caller to observe.
    pub fn clear_debug_records(&mut self) -> Result<(), String> {
        let previous = self.debug_records.clone();
        self.debug_records.clear();
        match self.persist_debug_store() {
            Ok(()) => Ok(()),
            Err(error) => {
                self.debug_records = previous;
                Err(error)
            }
        }
    }

    /// Apply retention bounds and persist when a durable store is configured.
    ///
    /// On durable write failure, restores the pre-prune in-memory set so memory
    /// and disk stay consistent and returns `Err` for the caller to observe.
    #[allow(dead_code)]
    pub fn retain_debug_records(
        &mut self,
        now: u64,
        max_age_seconds: u64,
        max_records: usize,
    ) -> Result<(), String> {
        let previous = self.debug_records.clone();
        self.retain_debug_records_in_memory(now, max_age_seconds, max_records);
        match self.persist_debug_store() {
            Ok(()) => Ok(()),
            Err(error) => {
                self.debug_records = previous;
                Err(error)
            }
        }
    }

    /// Write a redacted JSON export bundle under `export_dir`.
    ///
    /// Returns only safe basename metadata — never raw content or absolute paths.
    /// Rejects the export when a post-redaction canary scan detects residual leakage.
    pub fn export_debug_bundle(
        &self,
        export_dir: impl AsRef<Path>,
    ) -> Result<DebugExportMetadata, String> {
        let export_dir = export_dir.as_ref();
        std::fs::create_dir_all(export_dir)
            .map_err(|error| format!("debug export directory unavailable: {error}"))?;

        let exported_at_unix = now_unix();
        let file_name = format!("ai-debug-export-{exported_at_unix}.json");
        if !is_safe_export_file_name(&file_name) {
            return Err("debug export rejected: unsafe file name".to_string());
        }

        let records = self
            .debug_records
            .iter()
            .map(sanitize_debug_record)
            .collect::<Vec<_>>();
        let record_count = records.len();
        let bundle = serde_json::json!({
            "version": DEBUG_STORE_VERSION,
            "exported_at_unix": exported_at_unix,
            "record_count": record_count,
            "records": records,
        });
        let data = serde_json::to_string_pretty(&bundle)
            .map_err(|error| format!("debug export serialize failed: {error}"))?;

        if debug_bundle_fails_canary_scan(&data) {
            return Err(
                "debug export rejected: redaction canary scan detected residual sensitive content"
                    .to_string(),
            );
        }

        let path = export_dir.join(&file_name);
        atomic_file::write_text_file_atomically(&path, &data)
            .map_err(|error| format!("debug export write failed: {error}"))?;

        Ok(DebugExportMetadata {
            file_name,
            record_count,
            exported_at_unix,
        })
    }

    fn promote_next(&mut self) {
        while self.running < self.max_running {
            let Some(id) = self.queue.pop_front() else {
                break;
            };
            let Some(job) = self.jobs.get_mut(&id) else {
                continue;
            };
            if job.state != AiJobState::Queued {
                continue;
            }
            job.state = AiJobState::Running;
            self.running += 1;
        }
    }

    fn finish_debug(
        &mut self,
        id: &str,
        state: AiJobState,
        summary: impl Into<String>,
        usage: Option<crate::ai::provider::ProviderUsage>,
    ) {
        let summary = summary.into();
        let Some(job_snapshot) = self.jobs.get(id).cloned() else {
            return;
        };
        // Idempotent terminal path: never mint a second debug record for the same job.
        if job_snapshot.debug_record_id.is_some() {
            return;
        }
        // Snapshot prior durable-related state so a failed persist can fail closed
        // without leaving memory ahead of disk. Job terminal result stays non-fatal.
        let previous_records = self.debug_records.clone();
        let previous_debug_record_id = job_snapshot.debug_record_id.clone();
        let debug_id = self.new_id("debug");
        let completed_at = now_unix();
        // Structural redaction of every string field before in-memory or durable retention.
        let record = sanitize_debug_record(&DebugRecord {
            id: debug_id,
            job_id: id.to_string(),
            kind: job_snapshot.kind,
            state,
            created_at_unix: job_snapshot.created_at_unix,
            completed_at_unix: Some(completed_at),
            summary,
            usage,
        });
        if let Some(job) = self.jobs.get_mut(id) {
            job.debug_record_id = Some(record.id.clone());
        }
        self.debug_records.push(record);
        // Bound retention on every terminal mutation (complete / cancel / stale).
        self.retain_debug_records_in_memory(
            completed_at,
            DEBUG_RECORD_MAX_AGE_SECONDS,
            DEBUG_RECORD_MAX_RECORDS,
        );
        // Storage failure is non-fatal to the product job result, but must restore
        // both the record set and the job's debug_record_id so a later terminal
        // path can retry without violating idempotency against a never-persisted id.
        if self.persist_debug_store().is_err() {
            self.debug_records = previous_records;
            if let Some(job) = self.jobs.get_mut(id) {
                job.debug_record_id = previous_debug_record_id;
            }
        }
    }

    fn retain_debug_records_in_memory(
        &mut self,
        now: u64,
        max_age_seconds: u64,
        max_records: usize,
    ) {
        self.debug_records
            .retain(|record| now.saturating_sub(record.created_at_unix) <= max_age_seconds);
        if max_records == 0 {
            self.debug_records.clear();
            return;
        }
        if self.debug_records.len() > max_records {
            let remove_count = self.debug_records.len() - max_records;
            self.debug_records.drain(0..remove_count);
        }
    }

    fn load_debug_store(&mut self) -> DebugStoreLoadOutcome {
        let Some(path) = self.debug_store_path.clone() else {
            return DebugStoreLoadOutcome::Absent;
        };
        if !path.exists() {
            return DebugStoreLoadOutcome::Absent;
        }
        match read_debug_store_file(&path) {
            Ok(records) => {
                // Owned records from disk: sanitize by reference (E0631 if mapped directly).
                self.debug_records = records
                    .into_iter()
                    .map(|record| sanitize_debug_record(&record))
                    .collect();
                DebugStoreLoadOutcome::Loaded
            }
            Err(_error) => {
                // Isolate corrupt file; do not crash and do not treat bytes as plaintext.
                isolate_corrupt_debug_store(&path);
                self.debug_records.clear();
                DebugStoreLoadOutcome::IsolatedCorrupt
            }
        }
    }

    fn sanitize_loaded_summaries(&mut self) {
        for record in &mut self.debug_records {
            *record = sanitize_debug_record(record);
        }
    }

    /// Atomically persist the current debug record set. No-op without a store path.
    /// Errors are returned for tests; product call sites treat them as non-fatal.
    fn persist_debug_store(&self) -> Result<(), String> {
        let Some(path) = self.debug_store_path.as_ref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("debug store directory unavailable: {error}"))?;
        }
        let records = self
            .debug_records
            .iter()
            .map(sanitize_debug_record)
            .collect::<Vec<_>>();
        let envelope = DebugRecordStoreFile {
            version: DEBUG_STORE_VERSION,
            records,
        };
        let data = serde_json::to_string_pretty(&envelope)
            .map_err(|error| format!("debug store serialize failed: {error}"))?;
        // Refuse to write residual leakage. Fail closed without writing; do not
        // invent an empty "recovery" envelope here (later terminal writes retry).
        if debug_bundle_fails_canary_scan(&data) {
            return Err(
                "debug store persist rejected: redaction canary scan detected residual sensitive content"
                    .to_string(),
            );
        }
        atomic_file::write_text_file_atomically(path, &data)
    }

    fn new_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}-{}", now_unix(), self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// Sanitize a human summary with default structural redaction (paths, base64, URL userinfo).
///
/// If residual canary markers remain after structural redaction, replace the entire
/// summary so list/export/persist never retain credential-like fragments.
fn sanitize_debug_summary(summary: &str) -> String {
    let redacted = RedactionPolicy::default().redact_text(summary);
    if debug_bundle_fails_canary_scan(&redacted) {
        "[REDACTED_SUMMARY]".to_string()
    } else {
        redacted
    }
}

/// Whether `value` is a safe debug identifier shape (normal generated `job-…` /
/// `debug-…` ids, or a fixed redaction placeholder). Rejects path, URL, and
/// credential-like material that would fail the canary scan.
fn is_safe_debug_identifier(value: &str) -> bool {
    if ["[REDACTED_ID]", "[REDACTED_JOB_ID]"].contains(&value) {
        return true;
    }
    if value.is_empty() || value.len() > 200 {
        return false;
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return false;
    }
    !raw_text_fails_canary_scan(value)
}

/// Sanitize `id` / `job_id`: preserve normal generated identifiers; replace path,
/// URL, credential-like, or canary-bearing values with a fixed placeholder.
fn sanitize_debug_identifier(value: &str, field: &str) -> String {
    if is_safe_debug_identifier(value) {
        return value.to_string();
    }
    let redacted = RedactionPolicy::default().redact_text(value);
    if is_safe_debug_identifier(&redacted) {
        return redacted;
    }
    match field {
        "job_id" => "[REDACTED_JOB_ID]".to_string(),
        _ => "[REDACTED_ID]".to_string(),
    }
}

fn sanitize_debug_record(record: &DebugRecord) -> DebugRecord {
    let mut sanitized = record.clone();
    sanitized.id = sanitize_debug_identifier(&sanitized.id, "id");
    sanitized.job_id = sanitize_debug_identifier(&sanitized.job_id, "job_id");
    sanitized.summary = sanitize_debug_summary(&sanitized.summary);
    // Fail closed: list/export/persist must never surface a record whose serialized
    // sanitized string fields still trip the canary scan.
    match serde_json::to_string(&sanitized) {
        Ok(serialized) if !debug_bundle_fails_canary_scan(&serialized) => sanitized,
        _ => DebugRecord {
            id: "[REDACTED_ID]".to_string(),
            job_id: "[REDACTED_JOB_ID]".to_string(),
            kind: sanitized.kind,
            state: sanitized.state,
            created_at_unix: sanitized.created_at_unix,
            completed_at_unix: sanitized.completed_at_unix,
            summary: "[REDACTED_SUMMARY]".to_string(),
            usage: sanitized.usage,
        },
    }
}

fn read_debug_store_file(path: &Path) -> Result<Vec<DebugRecord>, String> {
    let data = std::fs::read_to_string(path)
        .map_err(|error| format!("debug store read failed: {error}"))?;
    // Require structured JSON envelope — never fall back to treating file as plaintext.
    let envelope: DebugRecordStoreFile = serde_json::from_str(&data)
        .map_err(|error| format!("debug store parse failed: {error}"))?;
    if envelope.version == 0 || envelope.version > DEBUG_STORE_VERSION {
        return Err(format!(
            "debug store unsupported version: {}",
            envelope.version
        ));
    }
    Ok(envelope.records)
}

/// Rename a corrupt store file beside the original so startup can continue empty.
fn isolate_corrupt_debug_store(path: &Path) {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DEBUG_STORE_FILE_NAME);
    let corrupt_name = format!("{file_name}.corrupt-{}", now_unix());
    let corrupt_path = path.with_file_name(corrupt_name);
    if std::fs::rename(path, &corrupt_path).is_err() {
        // Last resort: try remove so the next persist is not blocked by poison data.
        let _ = std::fs::remove_file(path);
    }
}

fn is_safe_export_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && !file_name.contains("..")
        && file_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// Post-redaction canary scan for residual sensitive material in serialized debug JSON.
///
/// Detects absolute paths, scheme-prefixed paths (`file://`), URL userinfo, Cookie /
/// Authorization headers, image/base64 payloads, tracker/raw-bencode markers, and
/// common credential fragments that must never leave the process.
///
/// When `text` is valid JSON, path/UNC rules run on **decoded** string values so a
/// normal single backslash in a diagnostic (JSON-escaped as `\\` on the wire) does
/// not false-positive as a UNC path. Raw non-JSON inputs are scanned as-is.
pub fn debug_bundle_fails_canary_scan(text: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => json_value_fails_canary_scan(&value),
        Err(_) => raw_text_fails_canary_scan(text),
    }
}

fn json_value_fails_canary_scan(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if sensitive_json_key_canary(key) {
                    return true;
                }
                if json_value_fails_canary_scan(child) {
                    return true;
                }
            }
            false
        }
        serde_json::Value::Array(items) => items.iter().any(json_value_fails_canary_scan),
        // Decoded string content: path rules see real backslashes, not JSON escapes.
        serde_json::Value::String(text) => raw_text_fails_canary_scan(text),
        _ => false,
    }
}

fn sensitive_json_key_canary(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "api_key"
            | "apikey"
            | "cookie"
            | "set-cookie"
            | "set_cookie"
            | "raw_bencode"
            | "rawbencode"
            | "profile_body"
            | "profile_cookies"
            | "trackers"
            | "authorization"
    ) || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("raw_bencode")
        || lower.contains("profile_body")
        || lower.contains("profile_cookies")
}

/// True when `text` contains a Windows root-relative path shape `\Component\...`
/// (single leading `\`, not UNC `\\`). Ordinary single-backslash diagnostics such as
/// `\x1b[0m` lack a second `\` and must not trip this rule.
fn contains_windows_root_relative_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        // Skip UNC / doubled backslash runs — handled by the `\\` canary separately.
        if index + 1 < bytes.len() && bytes[index + 1] == b'\\' {
            index += 2;
            while index < bytes.len() && bytes[index] == b'\\' {
                index += 1;
            }
            continue;
        }
        // `\Component\...` — second separator after a non-empty first component.
        let rest = &bytes[index + 1..];
        if let Some(sep_offset) = rest.iter().position(|&byte| byte == b'\\') {
            if sep_offset > 0 {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// Canary rules applied to a single decoded text fragment (or a non-JSON blob).
fn raw_text_fails_canary_scan(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();

    // Absolute path leakage (Unix / Windows / UNC) and scheme-prefixed absolute paths.
    // UNC uses a real double-backslash in decoded text; JSON wire `\\` (one backslash)
    // must not reach here via the JSON path above.
    // Windows root-relative (`\Users\owen\secret`) is also absolute path material.
    if lower.contains("/users/")
        || lower.contains("/home/")
        || lower.contains("/private/")
        || lower.contains("/var/folders/")
        || lower.contains("c:\\")
        || lower.contains("c:/")
        || text.contains("\\\\")
        || contains_windows_root_relative_path(text)
        || lower.contains("file:")
    {
        return true;
    }
    // Unredacted path markers should be the only path form remaining.
    // Reject raw POSIX absolute tokens that are not the redaction placeholder.
    for token in text.split_whitespace() {
        let trimmed =
            token.trim_matches(|ch: char| matches!(ch, '"' | ',' | '{' | '}' | '[' | ']'));
        if trimmed.starts_with('/')
            && !trimmed.contains("[PATH_REDACTED]")
            && trimmed.len() > 1
            && !trimmed.starts_with("//")
        {
            // Allow JSON pointer-like relative fragments only when not absolute FS paths.
            // `/ai/debug` style keys are short; real home paths are longer.
            if trimmed.matches('/').count() >= 2 && trimmed.len() > 12 {
                return true;
            }
        }
        if trimmed.len() >= 3
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
            && trimmed.as_bytes()[1] == b':'
            && matches!(trimmed.as_bytes().get(2), Some(b'/' | b'\\'))
        {
            return true;
        }
        // scheme://user:pass@host residue (userinfo not fully redacted).
        if let Some(scheme_end) = trimmed.find("://") {
            let authority = &trimmed[scheme_end + 3..];
            let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
            let authority = &authority[..authority_end];
            if let Some((userinfo, _)) = authority.rsplit_once('@') {
                if !userinfo.is_empty() && userinfo != "[REDACTED]" {
                    return true;
                }
            }
        }
    }

    if lower.contains("bearer ")
        || (lower.contains("bearer") && (lower.contains("sk-") || lower.contains("ghp_")))
        || lower.contains("data:image/")
        || lower.contains("authorization:")
        || lower.contains("\"api_key\"")
        || lower.contains("\"apikey\"")
        || lower.contains("set-cookie")
        || lower.contains("cookie:")
        || lower.contains("\"cookie\"")
        || lower.contains("\"raw_bencode\"")
        || lower.contains("\"rawbencode\"")
        || lower.contains("\"profile_body\"")
        || lower.contains("\"profile_cookies\"")
        || lower.contains("\"trackers\"")
    {
        return true;
    }

    // Live / production key canaries and common provider secret prefixes.
    if text.contains("sk-live-")
        || text.contains("sk-canary")
        || text.contains("sk-super-secret")
        || text.contains("sk-proj-")
        || text.contains("sk-ant-")
        || text.contains("xai-")
        || text.contains("AIza")
        || text.contains("ghp_")
        || text.contains("github_pat_")
        || text.contains("AKIA")
    {
        return true;
    }

    // Long base64-looking blobs (image/bytes) that escaped structural redaction.
    for token in text.split(|ch: char| {
        ch.is_whitespace() || matches!(ch, '"' | ',' | ':' | '{' | '}' | '[' | ']')
    }) {
        if token.len() >= 96
            && token.len() % 4 == 0
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_retention_defaults_match_v2_contract() {
        assert_eq!(DEBUG_RECORD_MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
        assert_eq!(DEBUG_RECORD_MAX_RECORDS, 200);
    }

    #[test]
    fn queues_above_concurrency_limit_and_promotes_after_completion() {
        let mut manager = AiJobManager::new(1);
        let first = manager.start(JobKind::Audit, 1, "a", None);
        let second = manager.start(JobKind::Recognition, 1, "a", None);
        assert_eq!(manager.get(&first).unwrap().state, AiJobState::Running);
        assert_eq!(manager.get(&second).unwrap().state, AiJobState::Queued);
        manager.complete(&first, true, None, "ok", None).unwrap();
        assert_eq!(manager.get(&second).unwrap().state, AiJobState::Running);
    }

    #[test]
    fn media_info_stays_queued_until_capacity_then_promotes_to_running() {
        let mut manager = AiJobManager::new(1);
        let running = manager.start(JobKind::MediaInfo, 1, "sha256:media-a", None);
        let queued = manager.start(JobKind::MediaInfo, 2, "sha256:media-b", None);
        assert_eq!(manager.get(&running).unwrap().state, AiJobState::Running);
        assert_eq!(manager.get(&queued).unwrap().state, AiJobState::Queued);
        assert_eq!(manager.get(&queued).unwrap().progress, 0);

        // Completing the running MediaInfo job must promote the queued one.
        manager
            .complete(&running, true, None, "media-a done", None)
            .unwrap();
        let promoted = manager.get(&queued).unwrap();
        assert_eq!(promoted.state, AiJobState::Running);
        assert_eq!(promoted.progress, 0);
        assert_eq!(promoted.kind, JobKind::MediaInfo);

        // Cancel of a running job also frees capacity for a subsequent queue.
        let blocked = manager.start(JobKind::Audit, 3, "sha256:block", None);
        assert_eq!(manager.get(&blocked).unwrap().state, AiJobState::Queued);
        manager.cancel(&queued).unwrap();
        assert_eq!(manager.get(&blocked).unwrap().state, AiJobState::Running);
    }

    #[test]
    fn cancellation_is_idempotent_and_late_completion_cannot_resurrect_job() {
        let mut manager = AiJobManager::default();
        let id = manager.start(JobKind::Vision, 1, "a", None);
        manager.cancel(&id).unwrap();
        manager.cancel(&id).unwrap();
        let result = manager.complete(&id, true, None, "late", None).unwrap();
        assert_eq!(result.state, AiJobState::Cancelled);
        assert_eq!(manager.debug_records().len(), 1);
    }

    #[test]
    fn app_exit_cancels_queued_and_running_jobs() {
        let mut manager = AiJobManager::new(1);
        let running = manager.start(JobKind::Audit, 1, "a", None);
        let queued = manager.start(JobKind::Audit, 1, "a", None);
        manager.cancel_unfinished();
        assert_eq!(manager.get(&running).unwrap().state, AiJobState::Cancelled);
        assert_eq!(manager.get(&queued).unwrap().state, AiJobState::Cancelled);
    }

    #[test]
    fn formal_audit_bind_gate_allows_only_succeeded_or_failed() {
        assert!(formal_audit_may_bind_terminal_evidence(
            AiJobState::Succeeded
        ));
        assert!(formal_audit_may_bind_terminal_evidence(AiJobState::Failed));
        assert!(!formal_audit_may_bind_terminal_evidence(
            AiJobState::Cancelled
        ));
        assert!(!formal_audit_may_bind_terminal_evidence(AiJobState::Stale));
        assert!(!formal_audit_may_bind_terminal_evidence(
            AiJobState::Running
        ));
        assert!(!formal_audit_may_bind_terminal_evidence(AiJobState::Queued));
    }

    #[test]
    fn media_info_success_gate_allows_only_succeeded() {
        assert!(media_info_may_report_success(AiJobState::Succeeded));
        assert!(!media_info_may_report_success(AiJobState::Failed));
        assert!(!media_info_may_report_success(AiJobState::Cancelled));
        assert!(!media_info_may_report_success(AiJobState::Stale));
        assert!(!media_info_may_report_success(AiJobState::Running));
        assert!(!media_info_may_report_success(AiJobState::Queued));
        // Plan bind uses the same Succeeded-only gate.
        assert!(media_info_may_bind_plan_evidence(AiJobState::Succeeded));
        assert!(!media_info_may_bind_plan_evidence(AiJobState::Failed));
        assert!(!media_info_may_bind_plan_evidence(AiJobState::Cancelled));
        assert!(!media_info_may_bind_plan_evidence(AiJobState::Stale));
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
    fn recognition_cancel_then_late_complete_stays_cancelled() {
        let mut manager = AiJobManager::default();
        let id = manager.start(JobKind::Recognition, 4, "sha256:recog", None);
        manager.cancel(&id).unwrap();
        let late = manager
            .complete(&id, true, None, "late recognition", None)
            .unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);
        assert!(!recognition_may_return_result(late.state));
    }

    #[test]
    fn media_info_cancel_then_late_complete_stays_cancelled() {
        let mut manager = AiJobManager::default();
        let id = manager.start(JobKind::MediaInfo, 3, "sha256:media", None);
        manager.cancel(&id).unwrap();
        let late = manager
            .complete(&id, true, None, "late measured", None)
            .unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);
        assert!(!media_info_may_report_success(late.state));
    }

    #[test]
    fn late_success_after_cancel_or_stale_is_not_bindable() {
        let mut manager = AiJobManager::default();
        let cancelled = manager.start(JobKind::Audit, 1, "snap-a", None);
        manager.cancel(&cancelled).unwrap();
        let after_cancel = manager
            .complete(&cancelled, true, None, "late success", None)
            .unwrap();
        assert_eq!(after_cancel.state, AiJobState::Cancelled);
        assert!(!formal_audit_may_bind_terminal_evidence(after_cancel.state));

        let stale = manager.start(JobKind::Audit, 2, "snap-b", None);
        manager.mark_stale(&stale, "app exit").unwrap();
        let after_stale = manager
            .complete(
                &stale,
                false,
                Some("PROVIDER_HTTP".into()),
                "late fail",
                None,
            )
            .unwrap();
        assert_eq!(after_stale.state, AiJobState::Stale);
        assert!(!formal_audit_may_bind_terminal_evidence(after_stale.state));
    }

    #[test]
    fn capability_probe_job_records_identity_and_terminal_states() {
        use crate::ai::provider::{CapabilityIdentity, ProviderKind, ProviderMode};

        let identity = CapabilityIdentity {
            digest: "sha256:probe".into(),
            provider: ProviderKind::OpenAi,
            mode: ProviderMode::Chat,
            endpoint: "https://example.test/v1".into(),
            model: "gpt-test".into(),
        };
        let mut manager = AiJobManager::default();
        let id = manager.start(
            JobKind::CapabilityProbe,
            0,
            identity.digest.clone(),
            Some(identity.clone()),
        );
        let job = manager.get(&id).unwrap();
        assert_eq!(job.kind, JobKind::CapabilityProbe);
        assert_eq!(
            job.provider_identity
                .as_ref()
                .map(|item| item.digest.as_str()),
            Some("sha256:probe")
        );
        manager
            .complete(
                &id,
                true,
                None,
                "strict structured output is available",
                None,
            )
            .unwrap();
        assert_eq!(manager.get(&id).unwrap().state, AiJobState::Succeeded);
        assert!(manager
            .debug_records()
            .iter()
            .any(|record| record.kind == JobKind::CapabilityProbe));
    }

    #[test]
    fn debug_record_retention_is_bounded_by_age_and_count() {
        let mut manager = AiJobManager::default();
        for index in 0..5 {
            let id = manager.start(JobKind::Audit, index, format!("snap-{index}"), None);
            manager
                .complete(&id, true, None, format!("summary-{index}"), None)
                .unwrap();
        }
        assert_eq!(manager.debug_records().len(), 5);

        // Age bound: with max_age 0 and now strictly after created_at, all records drop.
        let now = now_unix().saturating_add(10);
        manager
            .retain_debug_records(now, 0, 64)
            .expect("memory-only retain");
        assert!(manager.debug_records().is_empty());

        // Re-seed and enforce count bound (oldest drained first).
        for index in 0..10 {
            let id = manager.start(JobKind::Recognition, index, format!("c-{index}"), None);
            manager
                .complete(&id, false, Some("X".into()), format!("s-{index}"), None)
                .unwrap();
        }
        assert!(manager.debug_records().len() >= 10);
        manager
            .retain_debug_records(now_unix(), DEBUG_RECORD_MAX_AGE_SECONDS, 3)
            .expect("memory-only retain");
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().all(|record| record.summary.starts_with('s')));
    }

    #[test]
    fn debug_records_clear_and_list_are_non_secret_metadata_only() {
        let mut manager = AiJobManager::default();
        let id = manager.start(JobKind::Vision, 1, "snap", None);
        manager
            .complete(&id, true, None, "vision ok", None)
            .unwrap();
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].summary, "vision ok");
        assert_eq!(listed[0].job_id, id);
        // No raw provider body fields exist on DebugRecord (compile-time shape + empty usage).
        assert!(listed[0].usage.is_none());
        manager.clear_debug_records().expect("memory-only clear");
        assert!(manager.list_debug_records().is_empty());
        assert!(manager.debug_records().is_empty());
    }

    #[test]
    fn terminal_mutations_auto_retain_within_configured_max_records() {
        let mut manager = AiJobManager::default();
        // Create more terminal records than DEBUG_RECORD_MAX_RECORDS.
        let total = DEBUG_RECORD_MAX_RECORDS + 8;
        for index in 0..total {
            let id = manager.start(JobKind::MediaInfo, index as u64, format!("m-{index}"), None);
            manager
                .complete(&id, true, None, format!("media-{index}"), None)
                .unwrap();
        }
        assert!(manager.debug_records().len() <= DEBUG_RECORD_MAX_RECORDS);
        assert_eq!(manager.debug_records().len(), DEBUG_RECORD_MAX_RECORDS);
    }

    fn temp_debug_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "okpgui-ai-debug-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("temp debug dir");
        dir
    }

    #[test]
    fn durable_debug_records_survive_manager_reload() {
        let dir = temp_debug_dir("reload");
        let mut writer = AiJobManager::default();
        writer.init_debug_store(&dir);
        assert!(writer.debug_store_configured());

        let job_id = writer.start(JobKind::Audit, 1, "sha256:durable", None);
        writer
            .complete(&job_id, true, None, "durable summary only", None)
            .unwrap();
        assert_eq!(writer.debug_records().len(), 1);
        assert!(dir.join(DEBUG_STORE_FILE_NAME).exists());

        // Fresh manager loads the same store and retains the terminal record.
        let mut reader = AiJobManager::default();
        reader.init_debug_store(&dir);
        let listed = reader.list_debug_records();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].job_id, job_id);
        assert_eq!(listed[0].summary, "durable summary only");
        assert_eq!(listed[0].state, AiJobState::Succeeded);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_debug_store_is_isolated_without_panic() {
        let dir = temp_debug_dir("corrupt");
        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        std::fs::write(&store_path, "this is not valid json {{{").expect("seed corrupt");

        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);
        assert!(
            manager.debug_records().is_empty(),
            "corrupt store must not load plaintext bytes as records"
        );
        assert!(
            !store_path.exists(),
            "corrupt original must be renamed away from the active store path"
        );
        let isolated = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-"));
        assert!(isolated, "corrupt file must be isolated via rename");

        // Subsequent terminal writes recreate a valid store at the active path.
        let job_id = manager.start(JobKind::Vision, 1, "sha256:after-corrupt", None);
        manager
            .complete(&job_id, true, None, "recovered", None)
            .unwrap();
        assert_eq!(manager.debug_records().len(), 1);
        assert!(
            store_path.exists(),
            "later complete must recreate active store"
        );

        let mut reader = AiJobManager::default();
        reader.init_debug_store(&dir);
        assert_eq!(reader.debug_records().len(), 1, "recreated store must load");
        assert_eq!(reader.debug_records()[0].summary, "recovered");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn durable_retention_prunes_by_age_and_count_deterministically() {
        let dir = temp_debug_dir("retention");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        for index in 0..5 {
            let id = manager.start(JobKind::Audit, index, format!("snap-{index}"), None);
            manager
                .complete(&id, true, None, format!("summary-{index}"), None)
                .unwrap();
        }
        assert_eq!(manager.debug_records().len(), 5);

        // Age prune then persist.
        let now = now_unix().saturating_add(10);
        manager
            .retain_debug_records(now, 0, 64)
            .expect("durable retain");
        assert!(manager.debug_records().is_empty());

        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert!(
            reloaded.debug_records().is_empty(),
            "age prune must persist emptiness"
        );

        for index in 0..10 {
            let id = manager.start(JobKind::Recognition, index, format!("c-{index}"), None);
            manager
                .complete(&id, true, None, format!("s-{index}"), None)
                .unwrap();
        }
        manager
            .retain_debug_records(now_unix(), DEBUG_RECORD_MAX_AGE_SECONDS, 3)
            .expect("durable retain");
        assert_eq!(manager.debug_records().len(), 3);

        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert_eq!(reloaded.debug_records().len(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_persists_empty_store() {
        let dir = temp_debug_dir("clear");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);
        let id = manager.start(JobKind::MediaInfo, 1, "sha256:clear", None);
        manager
            .complete(&id, true, None, "to be cleared", None)
            .unwrap();
        assert_eq!(manager.debug_records().len(), 1);

        manager.clear_debug_records().expect("durable clear");
        assert!(manager.debug_records().is_empty());

        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert!(
            reloaded.debug_records().is_empty(),
            "reload after clear must not resurrect records"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_debug_records_fails_closed_when_durable_persist_fails() {
        let dir = temp_debug_dir("clear-fail");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);
        let id = manager.start(JobKind::MediaInfo, 1, "sha256:clear-fail", None);
        manager
            .complete(&id, true, None, "must not be silently lost", None)
            .unwrap();
        assert_eq!(manager.debug_records().len(), 1);
        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        assert!(store_path.exists());
        let on_disk_before = std::fs::read_to_string(&store_path).expect("read store");
        assert!(
            on_disk_before.contains("must not be silently lost"),
            "precondition: durable store holds the record"
        );

        // Point store under a file path so persist cannot write an empty envelope.
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").expect("blocker file");
        manager.debug_store_path = Some(blocker.join(DEBUG_STORE_FILE_NAME));

        let err = manager
            .clear_debug_records()
            .expect_err("clear must surface durable persist failure");
        assert!(!err.is_empty(), "error message must be observable: {err}");
        assert_eq!(
            manager.debug_records().len(),
            1,
            "in-memory records must be restored on durable clear failure"
        );
        assert_eq!(
            manager.debug_records()[0].summary,
            "must not be silently lost"
        );

        // Original durable file under the real store dir is unchanged (still has the record).
        // Re-point and reload via a fresh manager on the real dir.
        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert_eq!(
            reloaded.debug_records().len(),
            1,
            "durable failure must not leave disk empty while claiming success"
        );
        assert_eq!(
            reloaded.debug_records()[0].summary,
            "must not be silently lost"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retain_debug_records_fails_closed_when_durable_persist_fails() {
        let dir = temp_debug_dir("retain-fail");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);
        for index in 0..5 {
            let id = manager.start(JobKind::Audit, index, format!("snap-{index}"), None);
            manager
                .complete(&id, true, None, format!("summary-{index}"), None)
                .unwrap();
        }
        assert_eq!(manager.debug_records().len(), 5);

        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").expect("blocker file");
        manager.debug_store_path = Some(blocker.join(DEBUG_STORE_FILE_NAME));

        let now = now_unix().saturating_add(10);
        let err = manager
            .retain_debug_records(now, 0, 64)
            .expect_err("retain must surface durable persist failure");
        assert!(!err.is_empty(), "error message must be observable: {err}");
        assert_eq!(
            manager.debug_records().len(),
            5,
            "in-memory records must be restored on durable retain failure"
        );

        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert_eq!(
            reloaded.debug_records().len(),
            5,
            "disk must still hold pre-prune records after failed retain"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_redacts_paths_and_returns_safe_metadata_only() {
        let dir = temp_debug_dir("export");
        let export_dir = dir.join(DEBUG_EXPORT_RELATIVE_DIR);
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        let id = manager.start(JobKind::Audit, 1, "sha256:export", None);
        manager
            .complete(
                &id,
                false,
                Some("PROVIDER_HTTP".into()),
                "error at /Users/owen/secret/project data:image/png;base64,AAAABBBB",
                None,
            )
            .unwrap();

        let meta = manager.export_debug_bundle(&export_dir).expect("export ok");
        assert!(is_safe_export_file_name(&meta.file_name));
        assert!(!meta.file_name.contains('/'));
        assert!(!meta.file_name.contains('\\'));
        assert_eq!(meta.record_count, 1);

        let exported = std::fs::read_to_string(export_dir.join(&meta.file_name)).expect("read");
        assert!(
            !exported.contains("/Users/owen"),
            "export must not contain absolute paths"
        );
        assert!(
            !exported.to_ascii_lowercase().contains("data:image"),
            "export must not contain image payloads"
        );
        assert!(
            exported.contains("[PATH_REDACTED]") || exported.contains("[IMAGE_BYTES_REDACTED]"),
            "export should carry redaction placeholders: {exported}"
        );
        assert!(!debug_bundle_fails_canary_scan(&exported));

        // In-memory summary is also redacted at terminal time.
        let listed = manager.list_debug_records();
        assert!(!listed[0].summary.contains("/Users/owen"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_canary_scan_rejects_residual_secret_markers() {
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"Bearer sk-live-canary-formal-audit-key-9f3c2a1b"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"leak /Users/owen/private/key"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"data:image/png;base64,AAAA"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"Cookie: session=abc123secret"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"Set-Cookie: id=xyz; HttpOnly"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key sk-proj-abcdefghijklmnopqrstuvwxyz"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key sk-ant-api03-abcdefghijklmnopqrst"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key xai-abcdefghijklmnopqrst"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key AIzaSyA-abcdefghijklmnopqrst"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key ghp_abcdefghijklmnopqrstuvwxyz"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"key AKIAAAAAAAAAAAAAAAAA"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"open file:///tmp/secret.pem"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"open file:///var/folders/xx/T/canary"}"#
        ));
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"https://user:pass@evil.example/x"}"#
        ));
        // Decoded UNC (JSON wire `\\\\` → two backslashes) still fails closed.
        assert!(debug_bundle_fails_canary_scan(
            r#"{"summary":"open \\\\server\\share\\secret"}"#
        ));
        // Windows root-relative (JSON wire `\\Users\\...` → decoded `\Users\...`) fails closed.
        assert!(
            debug_bundle_fails_canary_scan(r#"{"summary":"leak \\Users\\owen\\secret"}"#),
            "decoded Windows root-relative path must fail canary"
        );
        assert!(
            debug_bundle_fails_canary_scan(r"leak \Users\owen\secret"),
            "raw Windows root-relative path must fail canary"
        );
        // A normal single backslash in a diagnostic is JSON-escaped as `\\` on the wire
        // and must not false-positive as a UNC canary when scanned as structured JSON.
        assert!(
            !debug_bundle_fails_canary_scan(
                r#"{"version":1,"records":[{"summary":"diag: code \\x1b reset","usage":null}]}"#
            ),
            "JSON-escaped single backslash must not fail canary"
        );
        assert!(!debug_bundle_fails_canary_scan(
            r#"{"version":1,"records":[{"summary":"vision ok","usage":null}]}"#
        ));
        // Raw (non-JSON) inputs still honor path/UNC rules on the text as-is.
        assert!(debug_bundle_fails_canary_scan(r"leak \\server\share"));
        assert!(!debug_bundle_fails_canary_scan("vision ok with code \\x1b"));
    }

    #[test]
    fn windows_root_relative_path_sanitized_in_list_store_and_export() {
        let dir = temp_debug_dir("win-root-rel");
        let export_dir = dir.join(DEBUG_EXPORT_RELATIVE_DIR);
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        // Single leading backslash Windows root-relative path (not drive letter, not UNC).
        let summary = r"provider failed at \Users\owen\secret\project";
        let id = manager.start(JobKind::Audit, 1, "sha256:win-root", None);
        manager
            .complete(&id, false, Some("PROVIDER_HTTP".into()), summary, None)
            .unwrap();

        // List path must not retain the raw root-relative path.
        let listed = manager.list_debug_records();
        let record = listed
            .iter()
            .find(|record| record.job_id == id)
            .expect("listed");
        assert!(
            !record.summary.contains(r"\Users\owen"),
            "list must not retain root-relative Windows path: {}",
            record.summary
        );
        assert!(
            !debug_bundle_fails_canary_scan(&record.summary),
            "sanitized list summary must pass canary: {}",
            record.summary
        );
        assert!(
            record.summary.contains("[PATH_REDACTED]")
                || record.summary.contains("[REDACTED_SUMMARY]"),
            "expected redaction placeholder: {}",
            record.summary
        );

        // Durable store must not retain the residual path material.
        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        assert!(
            store_path.exists(),
            "records.json must exist after complete"
        );
        let stored = std::fs::read_to_string(&store_path).expect("read store");
        assert!(
            !stored.contains(r"\Users\owen") && !stored.contains(r"\\Users\\owen"),
            "durable store must not retain root-relative path: {stored}"
        );
        assert!(
            !debug_bundle_fails_canary_scan(&stored),
            "stored envelope must pass canary: {stored}"
        );

        // Export must sanitize or fail closed for the same shape.
        let meta = manager.export_debug_bundle(&export_dir).expect("export ok");
        let exported = std::fs::read_to_string(export_dir.join(&meta.file_name)).expect("read");
        assert!(
            !exported.contains(r"\Users\owen") && !exported.contains(r"\\Users\\owen"),
            "export must not retain root-relative path: {exported}"
        );
        assert!(
            !debug_bundle_fails_canary_scan(&exported),
            "export must pass canary: {exported}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_strips_cookie_production_keys_and_file_urls_from_list() {
        let mut manager = AiJobManager::default();
        let cases = [
            (
                "cookie",
                "upstream Cookie: session=super-secret-cookie-value rejected",
                "super-secret-cookie-value",
            ),
            (
                "prod-key",
                "invalid api key sk-proj-abcdefghijklmnopqrstuvwxyz012345",
                "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
            ),
            (
                "file-tmp",
                "failed to read file:///tmp/okpgui-canary-secret",
                "file:///tmp/okpgui-canary-secret",
            ),
            (
                "file-var",
                "cache at file:///var/folders/xx/abcdef/T/canary-key",
                "file:///var/folders/xx/abcdef/T/canary-key",
            ),
        ];
        for (label, summary, residual) in cases {
            let id = manager.start(JobKind::Audit, 1, format!("snap-{label}"), None);
            manager
                .complete(&id, false, Some("PROVIDER_HTTP".into()), summary, None)
                .unwrap();
            let listed = manager.list_debug_records();
            let record = listed
                .iter()
                .find(|record| record.job_id == id)
                .expect("listed");
            assert!(
                !record.summary.contains(residual),
                "{label}: list must not retain residual '{residual}': {}",
                record.summary
            );
            assert!(
                !debug_bundle_fails_canary_scan(&record.summary),
                "{label}: sanitized summary must pass canary: {}",
                record.summary
            );
        }
    }

    #[test]
    fn export_and_persist_reject_or_strip_cookie_key_and_file_url() {
        let dir = temp_debug_dir("export-harden");
        let export_dir = dir.join(DEBUG_EXPORT_RELATIVE_DIR);
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        let secrets = [
            "Cookie: session=persist-cookie-canary-9f3c",
            "Authorization: Bearer sk-proj-persist-canary-key-abcdef",
            "read failed file:///tmp/persist-canary.pem",
            "read failed file:///var/folders/zz/T/persist-canary",
        ];
        for (index, summary) in secrets.iter().enumerate() {
            let id = manager.start(JobKind::Vision, index as u64, format!("snap-{index}"), None);
            manager
                .complete(&id, false, Some("X".into()), *summary, None)
                .unwrap();
        }

        // In-memory + list path.
        for record in manager.list_debug_records() {
            assert!(!record.summary.contains("persist-cookie-canary"));
            assert!(!record.summary.contains("sk-proj-persist-canary"));
            assert!(!record.summary.contains("file://"));
            assert!(!record.summary.contains("/tmp/persist"));
            assert!(!record.summary.contains("/var/folders/"));
        }

        // Durable store must exist after terminal complete and must not retain residuals.
        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        assert!(
            store_path.exists(),
            "records.json must exist after terminal complete"
        );
        let stored = std::fs::read_to_string(&store_path).expect("read store");
        assert!(!stored.contains("persist-cookie-canary"), "{stored}");
        assert!(!stored.contains("sk-proj-persist-canary"), "{stored}");
        assert!(!stored.contains("file://"), "{stored}");
        assert!(!debug_bundle_fails_canary_scan(&stored), "{stored}");

        let meta = manager.export_debug_bundle(&export_dir).expect("export ok");
        let exported = std::fs::read_to_string(export_dir.join(&meta.file_name)).expect("read");
        assert!(!exported.contains("persist-cookie-canary"), "{exported}");
        assert!(!exported.contains("sk-proj-persist-canary"), "{exported}");
        assert!(!exported.contains("file://"), "{exported}");
        assert!(!exported.contains("/var/folders/"), "{exported}");
        assert!(!debug_bundle_fails_canary_scan(&exported), "{exported}");

        // Reload path re-sanitizes owned records (compile + security boundary).
        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        for record in reloaded.list_debug_records() {
            assert!(!record.summary.contains("file://"));
            assert!(!record.summary.contains("sk-proj-persist-canary"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn single_backslash_diagnostic_persists_and_exports() {
        let dir = temp_debug_dir("backslash-diag");
        let export_dir = dir.join(DEBUG_EXPORT_RELATIVE_DIR);
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        // A normal single backslash in a diagnostic must survive sanitize/persist/export
        // without tripping the canary on JSON escaping.
        let summary = "provider diag: status \\x1b[0m reset path-safe";
        let id = manager.start(JobKind::Audit, 1, "sha256:backslash", None);
        manager.complete(&id, true, None, summary, None).unwrap();

        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        assert!(
            store_path.exists(),
            "records.json must exist after terminal complete with backslash diagnostic"
        );
        let stored = std::fs::read_to_string(&store_path).expect("read store");
        assert!(
            !debug_bundle_fails_canary_scan(&stored),
            "stored envelope with single-backslash diagnostic must pass canary: {stored}"
        );
        // Wire form may escape the backslash; decoded summary retains it.
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 1);
        assert!(
            listed[0].summary.contains('\\'),
            "decoded summary should retain a single backslash: {}",
            listed[0].summary
        );

        let meta = manager
            .export_debug_bundle(&export_dir)
            .expect("export must succeed for single-backslash diagnostic");
        let exported = std::fs::read_to_string(export_dir.join(&meta.file_name)).expect("read");
        assert!(
            !debug_bundle_fails_canary_scan(&exported),
            "export with single-backslash diagnostic must pass canary: {exported}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_duplicate_terminal_debug_records_across_late_complete_and_reload() {
        let dir = temp_debug_dir("dedupe");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        let id = manager.start(JobKind::Vision, 1, "sha256:dedupe", None);
        manager.cancel(&id).unwrap();
        // Late completion must not mint a second debug record.
        let late = manager
            .complete(&id, true, None, "late success must not record", None)
            .unwrap();
        assert_eq!(late.state, AiJobState::Cancelled);
        assert_eq!(manager.debug_records().len(), 1);
        assert_eq!(manager.debug_records()[0].state, AiJobState::Cancelled);
        assert_eq!(manager.debug_records()[0].summary, "job cancelled");

        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert_eq!(
            reloaded.debug_records().len(),
            1,
            "reload must not invent duplicate terminal records"
        );
        assert_eq!(reloaded.debug_records()[0].state, AiJobState::Cancelled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_failure_is_non_fatal_to_job_completion() {
        // Point the store at a path that cannot be created as a file parent on most OSes:
        // use a file as the "directory" so create_dir_all / write fails after first setup.
        let dir = temp_debug_dir("nonfatal");
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").expect("blocker file");

        // Force a store path under a file path → persist will fail.
        let mut manager = AiJobManager {
            debug_store_path: Some(blocker.join(DEBUG_STORE_FILE_NAME)),
            ..AiJobManager::default()
        };

        let id = manager.start(JobKind::Audit, 1, "sha256:nonfatal", None);
        let result = manager.complete(&id, true, None, "ok despite store fail", None);
        assert!(
            result.is_ok(),
            "job complete must succeed even if persist fails"
        );
        let completed = result.unwrap();
        assert_eq!(completed.state, AiJobState::Succeeded);
        // Fail closed: durable persist failure restores debug memory + linkage.
        assert!(
            manager.debug_records().is_empty(),
            "in-memory debug records must roll back when durable persist fails"
        );
        assert!(
            manager.get(&id).unwrap().debug_record_id.is_none(),
            "debug_record_id must roll back so a later terminal path can retry"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finish_debug_rolls_back_records_and_debug_record_id_on_persist_failure() {
        let dir = temp_debug_dir("finish-rollback");
        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);

        let prior_id = manager.start(JobKind::Audit, 1, "sha256:prior", None);
        manager
            .complete(&prior_id, true, None, "prior durable summary", None)
            .unwrap();
        assert_eq!(manager.debug_records().len(), 1);
        let prior_record = manager.debug_records()[0].clone();
        let prior_link = manager
            .get(&prior_id)
            .and_then(|job| job.debug_record_id.clone());
        assert_eq!(prior_link.as_deref(), Some(prior_record.id.as_str()));

        // Block further durable writes while keeping the prior on-disk envelope intact.
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").expect("blocker file");
        manager.debug_store_path = Some(blocker.join(DEBUG_STORE_FILE_NAME));

        let id = manager.start(JobKind::Vision, 2, "sha256:rollback", None);
        let result = manager.complete(&id, true, None, "must not stick after persist fail", None);
        assert!(result.is_ok(), "terminal job result must stay non-fatal");
        assert_eq!(result.unwrap().state, AiJobState::Succeeded);
        assert_eq!(
            manager.debug_records().len(),
            1,
            "prior records must be restored on durable terminal persist failure"
        );
        assert_eq!(manager.debug_records()[0].id, prior_record.id);
        assert_eq!(manager.debug_records()[0].summary, "prior durable summary");
        assert!(
            manager.get(&id).unwrap().debug_record_id.is_none(),
            "failed job must not keep a never-persisted debug_record_id"
        );
        // Prior successful linkage is untouched.
        assert_eq!(
            manager
                .get(&prior_id)
                .and_then(|job| job.debug_record_id.clone()),
            prior_link
        );

        // Idempotency: a second terminal attempt may retry (id still None) but still
        // fails closed while the store is blocked — never mints a sticky in-memory record.
        let late = manager
            .complete(&id, true, None, "late retry still blocked", None)
            .unwrap();
        assert_eq!(late.state, AiJobState::Succeeded);
        assert_eq!(manager.debug_records().len(), 1);
        assert!(manager.get(&id).unwrap().debug_record_id.is_none());

        // Disk under the real store dir still holds only the prior record.
        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        assert_eq!(reloaded.debug_records().len(), 1);
        assert_eq!(reloaded.debug_records()[0].summary, "prior durable summary");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_and_reload_sanitize_malicious_id_and_job_id() {
        let dir = temp_debug_dir("malicious-ids");
        let store_path = dir.join(DEBUG_STORE_FILE_NAME);
        let created_at = now_unix();
        let envelope = serde_json::json!({
            "version": 1,
            "records": [
                {
                    "id": "file:///tmp/okpgui-canary-debug-id",
                    "job_id": "/Users/owen/secret/job-sk-proj-malicious-canary-key",
                    "kind": "audit",
                    "state": "succeeded",
                    "created_at_unix": created_at,
                    "completed_at_unix": created_at + 1,
                    "summary": "ok summary",
                    "usage": null
                },
                {
                    "id": "debug-1700000000-2",
                    "job_id": "job-1700000000-1",
                    "kind": "vision",
                    "state": "failed",
                    "created_at_unix": created_at + 10,
                    "completed_at_unix": created_at + 11,
                    "summary": "normal generated identifiers",
                    "usage": null
                }
            ]
        });
        std::fs::write(
            &store_path,
            serde_json::to_string_pretty(&envelope).expect("serialize seed"),
        )
        .expect("seed malicious store");

        let mut manager = AiJobManager::default();
        manager.init_debug_store(&dir);
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 2);

        let malicious = listed
            .iter()
            .find(|record| record.summary == "ok summary" || record.summary == "[REDACTED_SUMMARY]")
            .expect("malicious-origin record listed");
        assert!(
            !malicious.id.contains("file:")
                && !malicious.id.contains("/tmp/")
                && !malicious.id.contains("okpgui-canary"),
            "list must not expose path/canary material via id: {}",
            malicious.id
        );
        assert!(
            !malicious.job_id.contains("/Users/")
                && !malicious.job_id.contains("sk-proj-")
                && !malicious.job_id.contains("malicious-canary"),
            "list must not expose path/canary material via job_id: {}",
            malicious.job_id
        );
        let malicious_serialized =
            serde_json::to_string(malicious).expect("serialize malicious listed record");
        assert!(
            !debug_bundle_fails_canary_scan(&malicious_serialized),
            "listed sanitized record must pass canary: {malicious_serialized}"
        );

        let normal = listed
            .iter()
            .find(|record| record.summary == "normal generated identifiers")
            .expect("normal record listed");
        assert_eq!(normal.id, "debug-1700000000-2");
        assert_eq!(normal.job_id, "job-1700000000-1");

        // Reload path re-applies the same identifier boundary.
        let mut reloaded = AiJobManager::default();
        reloaded.init_debug_store(&dir);
        for record in reloaded.list_debug_records() {
            let serialized = serde_json::to_string(&record).expect("serialize");
            assert!(
                !debug_bundle_fails_canary_scan(&serialized),
                "reloaded list record must pass canary: {serialized}"
            );
            assert!(!record.id.contains("file:"));
            assert!(!record.job_id.contains("sk-proj-"));
            assert!(!record.job_id.contains("/Users/"));
        }
        let reloaded_normal = reloaded
            .list_debug_records()
            .into_iter()
            .find(|record| record.summary == "normal generated identifiers")
            .expect("normal after reload");
        assert_eq!(reloaded_normal.id, "debug-1700000000-2");
        assert_eq!(reloaded_normal.job_id, "job-1700000000-1");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
