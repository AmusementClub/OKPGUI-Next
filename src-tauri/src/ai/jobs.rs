//! Backend-owned AI job registry.
//!
//! Lifecycle mutations (`start` / `complete` / `mark_stale`) are for crate-private
//! workers only. Webview IPC must not expose forgeable job creation or completion;
//! registered commands are limited to read status and cancel.

use crate::ai::provider::CapabilityIdentity;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
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

#[derive(Debug, Clone)]
pub struct AiJobManager {
    jobs: HashMap<String, AiJob>,
    queue: VecDeque<String>,
    debug_records: Vec<DebugRecord>,
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
            running: 0,
            max_running: max_running.max(1),
            next_id: 1,
        }
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
        let state = self
            .jobs
            .get(id)
            .map(|job| job.state)
            .ok_or_else(|| "job not found".to_string())?;
        if state.is_terminal() {
            return Ok(self.jobs.get(id).cloned().unwrap());
        }
        let was_running = state == AiJobState::Running;
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
        self.finish_debug(id, AiJobState::Cancelled, "job cancelled".to_string(), None);
        Ok(self.jobs.get(id).cloned().unwrap())
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
        Ok(self.jobs.get(id).cloned().unwrap())
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
        Ok(self.jobs.get(id).cloned().unwrap())
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

    pub fn debug_records(&self) -> &[DebugRecord] {
        &self.debug_records
    }

    /// Read-only clone of non-secret debug records for IPC listing.
    pub fn list_debug_records(&self) -> Vec<DebugRecord> {
        self.debug_records.clone()
    }

    /// Clear all retained debug records (non-secret metadata only).
    pub fn clear_debug_records(&mut self) {
        self.debug_records.clear();
    }

    pub fn retain_debug_records(&mut self, now: u64, max_age_seconds: u64, max_records: usize) {
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
        summary: String,
        usage: Option<crate::ai::provider::ProviderUsage>,
    ) {
        let Some(job_snapshot) = self.jobs.get(id).cloned() else {
            return;
        };
        let debug_id = self.new_id("debug");
        if let Some(job) = self.jobs.get_mut(id) {
            job.debug_record_id = Some(debug_id.clone());
        }
        let completed_at = now_unix();
        self.debug_records.push(DebugRecord {
            id: debug_id,
            job_id: id.to_string(),
            kind: job_snapshot.kind,
            state,
            created_at_unix: job_snapshot.created_at_unix,
            completed_at_unix: Some(completed_at),
            summary,
            usage,
        });
        // Bound retention on every terminal mutation (complete / cancel / stale).
        self.retain_debug_records(
            completed_at,
            DEBUG_RECORD_MAX_AGE_SECONDS,
            DEBUG_RECORD_MAX_RECORDS,
        );
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
            job.provider_identity.as_ref().map(|item| item.digest.as_str()),
            Some("sha256:probe")
        );
        manager
            .complete(&id, true, None, "strict structured output is available", None)
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
        manager.retain_debug_records(now, 0, 64);
        assert!(manager.debug_records().is_empty());

        // Re-seed and enforce count bound (oldest drained first).
        for index in 0..10 {
            let id = manager.start(JobKind::Recognition, index, format!("c-{index}"), None);
            manager
                .complete(&id, false, Some("X".into()), format!("s-{index}"), None)
                .unwrap();
        }
        assert!(manager.debug_records().len() >= 10);
        manager.retain_debug_records(now_unix(), DEBUG_RECORD_MAX_AGE_SECONDS, 3);
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().all(|record| record.summary.starts_with('s')));
    }

    #[test]
    fn debug_records_clear_and_list_are_non_secret_metadata_only() {
        let mut manager = AiJobManager::default();
        let id = manager.start(JobKind::Vision, 1, "snap", None);
        manager
            .complete(&id, true, None, "vision ok".to_string(), None)
            .unwrap();
        let listed = manager.list_debug_records();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].summary, "vision ok");
        assert_eq!(listed[0].job_id, id);
        // No raw provider body fields exist on DebugRecord (compile-time shape + empty usage).
        assert!(listed[0].usage.is_none());
        manager.clear_debug_records();
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
}
