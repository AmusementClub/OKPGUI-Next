use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ai::audit::{
    media_findings_from_plan_evidence, Acknowledgements, AuditDecision, Finding,
    MediaEvidenceAuditState,
};
use crate::config::{SiteSelection, Template};
use crate::publish::{OkpExecutableIdentity, PublishRequest, ResolvedOkpExecutable};

/// Backend-owned formal/local audit evidence bound to a prepared plan token.
/// Never accepts a client-supplied decision as authoritative without binding here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanAuditEvidence {
    pub decision: AuditDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub unknown_codes: Vec<String>,
    pub formal_ran: bool,
    #[serde(default)]
    pub job_id: Option<String>,
    /// Must equal the plan's snapshot_hash at bind time.
    pub snapshot_hash: String,
    pub request_generation: u64,
}

/// Outcome of a plan-owned MediaInfo bind (only written on Succeeded terminal jobs).
///
/// Formal/local audit derives `MEDIA_NOT_TESTED` / `MEDIA_CHECK_FAILED` from this
/// plan state — never from client probe snapshots or string heuristics.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanMediaStatus {
    /// At least one Measured summary was bound.
    Tested,
    /// Terminal MediaInfo success with no usable measured media.
    CheckFailed,
}

/// Relative, normalized media summary owned by a prepared plan.
/// Absolute paths never appear; codec/language strings are free-text only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct PlanMediaSummary {
    pub relative_name: String,
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    #[serde(default)]
    pub audio_codecs: Vec<String>,
    #[serde(default)]
    pub subtitle_languages: Vec<String>,
    pub scan_type: Option<String>,
}

/// One validated per-file MediaInfo outcome retained for formal AI audit context.
/// The state is a stable English machine value; messages and paths are preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct PlanMediaFileResult {
    pub relative_name: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<PlanMediaSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Backend-owned MediaInfo evidence bound to a prepared plan token.
///
/// Only identity-matched Succeeded terminal results may bind. Cancel / timeout /
/// nonzero / malformed / oversized / Failed results must leave this field untouched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanMediaEvidence {
    pub job_id: String,
    /// Must equal the plan's snapshot_hash at bind time.
    pub snapshot_hash: String,
    pub request_generation: u64,
    pub status: PlanMediaStatus,
    /// Valid relative measured summaries only.
    #[serde(default)]
    pub summaries: Vec<PlanMediaSummary>,
    /// Includes every torrent media file considered by the bound MediaInfo run.
    #[serde(default)]
    pub results: Vec<PlanMediaFileResult>,
}

impl PlanMediaEvidence {
    pub fn matches_plan(&self, snapshot_hash: &str, request_generation: u64) -> bool {
        self.snapshot_hash == snapshot_hash && self.request_generation == request_generation
    }

    /// Digest only the normalized media outcome, excluding job identity and plan identity.
    /// Sorting makes equivalent probe batches hash identically even if completion order differs.
    pub fn canonical_content_hash(&self) -> String {
        #[derive(Serialize)]
        struct MediaPayload<'a> {
            status: PlanMediaStatus,
            summaries: &'a [PlanMediaSummary],
            results: &'a [PlanMediaFileResult],
        }

        let mut summaries = self.summaries.clone();
        let mut results = self.results.clone();
        summaries.sort();
        results.sort();
        digest_json(&MediaPayload {
            status: self.status,
            summaries: &summaries,
            results: &results,
        })
    }

    /// Map identity-matched plan media evidence to formal/local audit state.
    pub fn audit_state(&self) -> MediaEvidenceAuditState {
        if self.status == PlanMediaStatus::CheckFailed
            || self.results.iter().any(|result| result.state != "measured")
        {
            MediaEvidenceAuditState::CheckFailed
        } else {
            MediaEvidenceAuditState::Tested
        }
    }
}

#[cfg(test)]
mod media_audit_state_tests {
    use super::*;

    #[test]
    fn partial_media_probe_failure_is_check_failed_for_local_audit() {
        let evidence = PlanMediaEvidence {
            job_id: "media-job".into(),
            snapshot_hash: "sha256:media".into(),
            request_generation: 1,
            status: PlanMediaStatus::Tested,
            summaries: vec![PlanMediaSummary {
                relative_name: "show/ep01.mkv".into(),
                ..PlanMediaSummary::default()
            }],
            results: vec![
                PlanMediaFileResult {
                    relative_name: "show/ep01.mkv".into(),
                    state: "measured".into(),
                    summary: None,
                    message: None,
                },
                PlanMediaFileResult {
                    relative_name: "show/ep02.mkv".into(),
                    state: "timed_out".into(),
                    summary: None,
                    message: Some("timeout".into()),
                },
            ],
        };

        assert_eq!(evidence.audit_state(), MediaEvidenceAuditState::CheckFailed);
    }
}

impl PlanAuditEvidence {
    /// Authoritative initial evidence bound atomically at `prepare_plan` time.
    ///
    /// - Local blockers always produce `LOCAL_BLOCKED` (`formal_ran=false`).
    /// - AI enabled **and** fully configured → `PENDING` until formal audit replaces it.
    /// - AI disabled/unconfigured → explicit local-only `GO` (`formal_ran=false`), zero network.
    pub fn initial_for_prepare(
        snapshot_hash: String,
        request_generation: u64,
        has_blockers: bool,
        ai_enabled_and_configured: bool,
    ) -> Self {
        let decision = if has_blockers {
            AuditDecision::LocalBlocked
        } else if ai_enabled_and_configured {
            AuditDecision::Pending
        } else {
            AuditDecision::Go
        };
        Self {
            decision,
            description: None,
            findings: Vec::new(),
            unknown_codes: Vec::new(),
            formal_ran: false,
            job_id: None,
            snapshot_hash,
            request_generation,
        }
    }

    pub fn matches_plan(&self, snapshot_hash: &str, request_generation: u64) -> bool {
        self.snapshot_hash == snapshot_hash && self.request_generation == request_generation
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishPlan {
    pub version: u32,
    pub snapshot_hash: String,
    pub request_generation: u64,
    pub local_blockers: Vec<String>,
    #[serde(skip)]
    #[allow(dead_code)]
    prepare_token: Option<String>,
    #[serde(skip)]
    publish_token: Option<String>,
    #[serde(default)]
    pub canonical_snapshot: Option<CanonicalSnapshot>,
    #[serde(skip)]
    local_execution_binding: Option<LocalExecutionBinding>,
    /// Rust-owned audit result bound to this plan (formal or local-only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_evidence: Option<PlanAuditEvidence>,
    /// Rust-owned MediaInfo evidence bound only after identity-matched success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_evidence: Option<PlanMediaEvidence>,
    /// Explicit user acknowledgements recorded against this plan token.
    #[serde(default)]
    pub acknowledgements: Acknowledgements,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanonicalSnapshot {
    pub hash: String,
    pub template_id: String,
    #[serde(default)]
    pub template_digest: String,
    pub sites: Vec<String>,
    /// Basename only — never a raw absolute path.
    #[serde(default)]
    pub torrent_name: String,
    #[serde(default)]
    pub torrent_digest: String,
    #[serde(default)]
    pub profile_name: String,
    /// Digest of Rust-owned normalized MediaInfo status/summaries, when measured.
    #[serde(default)]
    pub media_evidence_hash: String,
}

/// Private execution binding: raw paths and identity material never leave Rust.
#[derive(Debug, Clone)]
pub(crate) struct LocalExecutionBinding {
    request: PublishRequest,
    content_root: String,
    torrent_digest: String,
    torrent_len: u64,
    /// Private fingerprint over path + digest + profile/template/site inputs.
    binding_fingerprint: String,
    /// Selected OKP executable identity (path + launch mode + file-byte SHA-256).
    /// Optional only when prepare could not resolve OKP (already a local blocker).
    okp_identity: Option<OkpExecutableIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedPlanResponse {
    pub token: String,
    pub snapshot_hash: String,
    pub request_generation: u64,
    pub local_blockers: Vec<String>,
    pub has_blockers: bool,
}

impl PublishPlan {
    pub fn new(snapshot_hash: String, request_generation: u64) -> Self {
        Self {
            version: 2,
            snapshot_hash,
            request_generation,
            local_blockers: vec![],
            prepare_token: None,
            publish_token: None,
            canonical_snapshot: None,
            local_execution_binding: None,
            audit_evidence: None,
            media_evidence: None,
            acknowledgements: Acknowledgements::default(),
        }
    }

    pub fn add_local_blocker(&mut self, blocker: String) {
        if !self.local_blockers.contains(&blocker) {
            self.local_blockers.push(blocker);
        }
    }

    pub fn has_blockers(&self) -> bool {
        !self.local_blockers.is_empty()
    }

    pub fn set_local_binding(&mut self, binding: LocalExecutionBinding) {
        self.local_execution_binding = Some(binding);
    }

    /// Bind backend-computed audit evidence to this plan. Rejects identity mismatch.
    pub fn bind_audit_evidence(&mut self, evidence: PlanAuditEvidence) -> Result<(), String> {
        if evidence.snapshot_hash != self.snapshot_hash {
            return Err("audit evidence snapshot_hash does not match prepared plan".to_string());
        }
        if evidence.request_generation != self.request_generation {
            return Err(
                "audit evidence request_generation does not match prepared plan".to_string(),
            );
        }
        // Local blockers always win: never allow a formal GO to clear blockers.
        let decision = if self.has_blockers() {
            AuditDecision::LocalBlocked
        } else {
            evidence.decision
        };
        self.audit_evidence = Some(PlanAuditEvidence {
            decision,
            description: evidence.description,
            findings: evidence.findings,
            unknown_codes: evidence.unknown_codes,
            formal_ran: evidence.formal_ran,
            job_id: evidence.job_id,
            snapshot_hash: evidence.snapshot_hash,
            request_generation: evidence.request_generation,
        });
        // New audit invalidates prior acknowledgements.
        self.acknowledgements.clear();
        Ok(())
    }

    /// Bind MediaInfo summaries to this plan. Rejects identity mismatch.
    ///
    /// A changed normalized media outcome rolls the plan snapshot hash and invalidates
    /// previous audit evidence/acknowledgements. Rebinding identical media is idempotent.
    /// Callers must only invoke this for Succeeded terminal MediaInfo jobs after
    /// revalidating the private local execution binding.
    pub fn bind_media_evidence(&mut self, evidence: PlanMediaEvidence) -> Result<String, String> {
        if evidence.snapshot_hash != self.snapshot_hash {
            return Err("media evidence snapshot_hash does not match prepared plan".to_string());
        }
        if evidence.request_generation != self.request_generation {
            return Err(
                "media evidence request_generation does not match prepared plan".to_string(),
            );
        }
        // Defense in depth: only relative measured labels may be stored.
        for summary in &evidence.summaries {
            if !is_safe_plan_media_relative_name(&summary.relative_name) {
                return Err("media evidence contains unsafe relative path".to_string());
            }
        }
        let media_evidence_hash = evidence.canonical_content_hash();
        let snapshot = self
            .canonical_snapshot
            .as_mut()
            .ok_or_else(|| "prepared plan has no canonical snapshot".to_string())?;
        let media_changed = snapshot.media_evidence_hash != media_evidence_hash;
        let next_hash = compute_canonical_snapshot_hash(
            &snapshot.torrent_digest,
            &snapshot.torrent_name,
            &snapshot.profile_name,
            &snapshot.template_digest,
            &snapshot.sites,
            Some(&media_evidence_hash),
        );
        snapshot.media_evidence_hash = media_evidence_hash;
        snapshot.hash = next_hash.clone();
        self.snapshot_hash = next_hash.clone();
        let mut evidence = evidence;
        evidence.snapshot_hash = next_hash.clone();
        self.media_evidence = Some(evidence);
        if media_changed {
            self.audit_evidence = None;
            self.acknowledgements.clear();
        }
        Ok(next_hash)
    }

    /// True when this plan has identity-matched backend-owned MediaInfo evidence.
    #[allow(dead_code)]
    pub fn has_authoritative_media_evidence(&self) -> bool {
        self.media_evidence.as_ref().is_some_and(|evidence| {
            evidence.matches_plan(&self.snapshot_hash, self.request_generation)
        })
    }

    /// Derive MediaInfo findings from this plan's identity-matched media evidence only.
    ///
    /// Missing or identity-mismatched media evidence yields `MEDIA_NOT_TESTED`.
    /// Never uses client probe snapshots or free-text heuristics.
    pub fn media_audit_findings(&self) -> Vec<Finding> {
        let state = self
            .media_evidence
            .as_ref()
            .filter(|evidence| evidence.matches_plan(&self.snapshot_hash, self.request_generation))
            .map(PlanMediaEvidence::audit_state)
            .unwrap_or(MediaEvidenceAuditState::NotTested);
        media_findings_from_plan_evidence(state)
    }

    pub fn set_acknowledgements(&mut self, acknowledgements: Acknowledgements) {
        self.acknowledgements = acknowledgements;
    }

    /// True when this plan has identity-matched backend-owned audit evidence.
    /// Missing or mismatched evidence must never be treated as an implicit GO.
    pub fn has_authoritative_audit_evidence(&self) -> bool {
        self.audit_evidence.as_ref().is_some_and(|evidence| {
            evidence.matches_plan(&self.snapshot_hash, self.request_generation)
        })
    }

    /// Authoritative publish decision for this plan.
    /// Requires backend-bound audit evidence. Never defaults to unbound GO.
    pub fn publish_decision(&self) -> AuditDecision {
        if self.has_blockers() {
            return AuditDecision::LocalBlocked;
        }
        if let Some(evidence) = &self.audit_evidence {
            if evidence.matches_plan(&self.snapshot_hash, self.request_generation) {
                // Local blockers always win even if evidence was bound earlier.
                if self.has_blockers() {
                    return AuditDecision::LocalBlocked;
                }
                return evidence.decision;
            }
        }
        // Fail closed: absent/mismatched evidence is not publishable without an ack path
        // that could be confused for a real formal PENDING. Callers must reject via
        // `has_authoritative_audit_evidence` before treating this as a user decision.
        AuditDecision::Pending
    }

    pub fn can_publish_now(&self) -> bool {
        if !self.has_authoritative_audit_evidence() {
            return false;
        }
        crate::ai::audit::can_publish(self.publish_decision(), self.acknowledgements)
    }

    /// Build a plan from a complete PublishRequest. Backend owns the snapshot hash:
    /// derived from public request fields + current torrent file digest. Raw paths
    /// stay only inside the private execution binding.
    ///
    /// `okp_identity` is the selected OKP executable identity captured at prepare
    /// time (canonical path, launch mode, file-byte SHA-256). It is private Rust
    /// data and never appears in public plan responses.
    #[cfg(test)]
    pub fn from_publish_request(
        request_generation: u64,
        request: PublishRequest,
        okp_identity: Option<OkpExecutableIdentity>,
    ) -> Result<Self, String> {
        Self::from_publish_request_with_content_root(
            request_generation,
            request,
            String::new(),
            okp_identity,
        )
    }

    pub fn from_publish_request_with_content_root(
        request_generation: u64,
        request: PublishRequest,
        content_root: String,
        okp_identity: Option<OkpExecutableIdentity>,
    ) -> Result<Self, String> {
        let content_root = if content_root.trim().is_empty() {
            String::new()
        } else {
            crate::ai::media::validate_media_content_root(&content_root)?
                .to_string_lossy()
                .into_owned()
        };
        let torrent_identity = read_torrent_identity(&request.torrent_path)?;
        let sites = selected_site_codes(&request.template.sites);
        let template_digest = digest_template(&request.template);
        let torrent_name = torrent_basename(&request.torrent_path);
        let snapshot_hash = compute_canonical_snapshot_hash(
            &torrent_identity.digest,
            &torrent_name,
            &request.profile_name,
            &template_digest,
            &sites,
            None,
        );
        let binding_fingerprint = compute_binding_fingerprint(
            &request,
            &content_root,
            &torrent_identity.digest,
            torrent_identity.len,
            &template_digest,
            &sites,
        );
        let mut plan = Self::new(snapshot_hash.clone(), request_generation);
        plan.canonical_snapshot = Some(CanonicalSnapshot {
            hash: snapshot_hash,
            template_id: "ipc-publish-request".to_string(),
            template_digest,
            sites,
            torrent_name,
            torrent_digest: torrent_identity.digest.clone(),
            profile_name: request.profile_name.clone(),
            media_evidence_hash: String::new(),
        });
        plan.set_local_binding(LocalExecutionBinding {
            request,
            content_root,
            torrent_digest: torrent_identity.digest,
            torrent_len: torrent_identity.len,
            binding_fingerprint,
            okp_identity,
        });
        Ok(plan)
    }

    #[allow(dead_code)]
    fn to_deterministic_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&self.version.to_le_bytes());
        let snapshot_hash = self.snapshot_hash.as_bytes();
        bytes.extend_from_slice(&(snapshot_hash.len() as u64).to_le_bytes());
        bytes.extend_from_slice(snapshot_hash);
        bytes.extend_from_slice(&self.request_generation.to_le_bytes());
        bytes.extend_from_slice(&(self.local_blockers.len() as u64).to_le_bytes());
        for blocker in &self.local_blockers {
            let b = blocker.as_bytes();
            bytes.extend_from_slice(&(b.len() as u64).to_le_bytes());
            bytes.extend_from_slice(b);
        }
        bytes.push(u8::from(self.canonical_snapshot.is_some()));
        if let Some(snapshot) = &self.canonical_snapshot {
            let hash = snapshot.hash.as_bytes();
            bytes.extend_from_slice(&(hash.len() as u64).to_le_bytes());
            bytes.extend_from_slice(hash);
            let template_id = snapshot.template_id.as_bytes();
            bytes.extend_from_slice(&(template_id.len() as u64).to_le_bytes());
            bytes.extend_from_slice(template_id);
            let template_digest = snapshot.template_digest.as_bytes();
            bytes.extend_from_slice(&(template_digest.len() as u64).to_le_bytes());
            bytes.extend_from_slice(template_digest);
            bytes.extend_from_slice(&(snapshot.sites.len() as u64).to_le_bytes());
            for site in &snapshot.sites {
                let s = site.as_bytes();
                bytes.extend_from_slice(&(s.len() as u64).to_le_bytes());
                bytes.extend_from_slice(s);
            }
            let media_evidence_hash = snapshot.media_evidence_hash.as_bytes();
            bytes.extend_from_slice(&(media_evidence_hash.len() as u64).to_le_bytes());
            bytes.extend_from_slice(media_evidence_hash);
        }
        bytes
    }

    #[allow(dead_code)]
    pub fn compute_deterministic_hash(&self) -> String {
        let bytes = self.to_deterministic_bytes();
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }

    pub(crate) fn get_local_binding(&self) -> Option<&LocalExecutionBinding> {
        self.local_execution_binding.as_ref()
    }

    pub(crate) fn get_local_binding_owned(&self) -> Option<LocalExecutionBinding> {
        self.local_execution_binding.clone()
    }
}

impl LocalExecutionBinding {
    pub(crate) fn into_publish_request(self) -> PublishRequest {
        self.request
    }

    pub(crate) fn request(&self) -> &PublishRequest {
        &self.request
    }

    pub(crate) fn content_root(&self) -> &str {
        &self.content_root
    }

    #[allow(dead_code)]
    pub(crate) fn torrent_digest(&self) -> &str {
        &self.torrent_digest
    }

    #[allow(dead_code)]
    pub(crate) fn binding_fingerprint(&self) -> &str {
        &self.binding_fingerprint
    }

    #[allow(dead_code)]
    pub(crate) fn okp_identity(&self) -> Option<&OkpExecutableIdentity> {
        self.okp_identity.as_ref()
    }

    /// Re-check torrent existence/identity/digest, OKP executable identity, and
    /// private execution fingerprint against the bound request. Returns
    /// human-readable failures without consuming the plan token.
    /// On success, yields the revalidated `ResolvedOkpExecutable` when identity
    /// was bound (for prepared-plan launch). `None` only when identity was never
    /// captured (legacy/test bindings); prepared publish must fail closed on `None`.
    pub(crate) fn revalidate(&self) -> Result<Option<ResolvedOkpExecutable>, Vec<String>> {
        let mut failures = Vec::new();
        let torrent_identity = match read_torrent_identity(&self.request.torrent_path) {
            Ok(identity) => identity,
            Err(error) => {
                failures.push(error);
                return Err(failures);
            }
        };
        if torrent_identity.digest != self.torrent_digest {
            failures.push(format!(
                "种子文件内容已变化：{}，请重新执行发布前检查。",
                self.request.torrent_path
            ));
        }
        if torrent_identity.len != self.torrent_len {
            failures.push(format!(
                "种子文件大小已变化：{}，请重新执行发布前检查。",
                self.request.torrent_path
            ));
        }
        if !self.content_root.is_empty() {
            match crate::ai::media::validate_media_content_root(&self.content_root) {
                Ok(current) if current == std::path::Path::new(&self.content_root) => {}
                _ => failures.push(format!(
                    "实际媒体文件夹已变化：{}，请重新执行发布前检查。",
                    self.content_root
                )),
            }
        }

        let sites = selected_site_codes(&self.request.template.sites);
        let template_digest = digest_template(&self.request.template);
        let fingerprint = compute_binding_fingerprint(
            &self.request,
            &self.content_root,
            &torrent_identity.digest,
            torrent_identity.len,
            &template_digest,
            &sites,
        );
        if fingerprint != self.binding_fingerprint {
            failures.push("发布执行绑定已失效，请重新执行发布前检查。".to_string());
        }

        let mut resolved_okp = None;
        if let Some(okp_identity) = &self.okp_identity {
            match okp_identity.revalidate() {
                Ok(resolved) => resolved_okp = Some(resolved),
                Err(error) => failures.push(error),
            }
        }

        if failures.is_empty() {
            Ok(resolved_okp)
        } else {
            Err(failures)
        }
    }

    /// Prepared-plan publish gate: revalidate binding and require a bound OKP
    /// executable. Live app config is never consulted; returns the exact binary
    /// whose private identity was revalidated. Unbound identity fails closed
    /// with an actionable message.
    pub(crate) fn revalidate_for_prepared_publish(
        &self,
    ) -> Result<ResolvedOkpExecutable, Vec<String>> {
        match self.revalidate()? {
            Some(resolved) => Ok(resolved),
            None => Err(vec![crate::publish::okp_identity_unbound_blocker()]),
        }
    }
}

#[derive(Debug, Clone)]
struct TorrentIdentity {
    digest: String,
    len: u64,
}

fn read_torrent_identity(torrent_path: &str) -> Result<TorrentIdentity, String> {
    let path = validate_torrent_file_path(torrent_path)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("无法读取种子文件：{} ({})", path.display(), error))?;
    let len = bytes.len() as u64;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(TorrentIdentity {
        digest: format!("sha256:{}", hex::encode(hasher.finalize())),
        len,
    })
}

fn validate_torrent_file_path(torrent_path: &str) -> Result<PathBuf, String> {
    let torrent_path = torrent_path.trim();
    if torrent_path.is_empty() {
        return Err("未选择种子文件，请先选择 .torrent 文件。".to_string());
    }
    let torrent = PathBuf::from(torrent_path);
    if !torrent.exists() {
        return Err(format!("种子文件不存在：{}", torrent.display()));
    }
    let metadata = std::fs::metadata(&torrent)
        .map_err(|error| format!("无法读取种子文件：{} ({})", torrent.display(), error))?;
    if !metadata.is_file() {
        return Err(format!("种子路径不是文件：{}", torrent.display()));
    }
    let is_torrent = torrent
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !is_torrent {
        return Err(format!("所选文件不是 .torrent 文件：{}", torrent.display()));
    }
    Ok(torrent)
}

fn torrent_basename(torrent_path: &str) -> String {
    Path::new(torrent_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string()
}

/// Public canonical snapshot hash. Never includes raw absolute paths.
fn compute_canonical_snapshot_hash(
    torrent_digest: &str,
    torrent_name: &str,
    profile_name: &str,
    template_digest: &str,
    sites: &[String],
    media_evidence_hash: Option<&str>,
) -> String {
    #[derive(Serialize)]
    struct CanonicalPayload<'a> {
        version: u32,
        torrent_digest: &'a str,
        torrent_name: &'a str,
        profile_name: &'a str,
        template_digest: &'a str,
        sites: &'a [String],
        #[serde(skip_serializing_if = "Option::is_none")]
        media_evidence_hash: Option<&'a str>,
    }
    let payload = CanonicalPayload {
        version: 2,
        torrent_digest,
        torrent_name,
        profile_name,
        template_digest,
        sites,
        media_evidence_hash,
    };
    digest_json(&payload)
}

/// Private execution binding fingerprint over path + identity + inputs.
fn compute_binding_fingerprint(
    request: &PublishRequest,
    content_root: &str,
    torrent_digest: &str,
    torrent_len: u64,
    template_digest: &str,
    sites: &[String],
) -> String {
    #[derive(Serialize)]
    struct BindingPayload<'a> {
        publish_id: &'a str,
        torrent_path: &'a str,
        content_root: &'a str,
        torrent_digest: &'a str,
        torrent_len: u64,
        profile_name: &'a str,
        template_digest: &'a str,
        sites: &'a [String],
    }
    let payload = BindingPayload {
        publish_id: &request.publish_id,
        torrent_path: &request.torrent_path,
        content_root,
        torrent_digest,
        torrent_len,
        profile_name: &request.profile_name,
        template_digest,
        sites,
    };
    digest_json(&payload)
}

fn digest_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn selected_site_codes(sites: &SiteSelection) -> Vec<String> {
    [
        ("dmhy", sites.dmhy),
        ("nyaa", sites.nyaa),
        ("acgrip", sites.acgrip),
        ("bangumi", sites.bangumi),
        ("acgnx_asia", sites.acgnx_asia),
        ("acgnx_global", sites.acgnx_global),
    ]
    .into_iter()
    .filter_map(|(code, enabled)| enabled.then_some(code.to_string()))
    .collect()
}

#[derive(Serialize)]
struct CanonicalTemplatePayload<'a> {
    ep_pattern: &'a str,
    resolution_pattern: &'a str,
    title_pattern: &'a str,
    poster: &'a str,
    about: &'a str,
    tags: &'a str,
    description: &'a str,
    description_html: &'a str,
    title: &'a str,
    sites: &'a SiteSelection,
}

fn digest_template(template: &Template) -> String {
    let payload = CanonicalTemplatePayload {
        ep_pattern: &template.ep_pattern,
        resolution_pattern: &template.resolution_pattern,
        title_pattern: &template.title_pattern,
        poster: &template.poster,
        about: &template.about,
        tags: &template.tags,
        description: &template.description,
        description_html: &template.description_html,
        title: &template.title,
        sites: &template.sites,
    };
    digest_json(&payload)
}

/// Final token state recorded by atomic preflight cancellation/reconciliation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreflightTokenState {
    Invalidated,
    AlreadyMissing,
}

/// Bounded cancellation tombstone keyed by SHA-256 digest of an opaque plan token.
///
/// Never stores the raw token, frozen request, paths, or provider data. Enables
/// idempotent `ai_cancel_preflight_session` after IPC loss / client job-ID loss.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreflightCancellationTombstone {
    /// SHA-256 hex digest of the opaque plan token (not the token itself).
    pub token_digest: String,
    /// Related formal-audit job id when known at cancel time.
    pub job_id: Option<String>,
    /// Final job lifecycle state after cancel (snake_case string), if any.
    pub job_state: Option<String>,
    pub token_state: PreflightTokenState,
    /// True only when cancel/invalidate completed authoritatively.
    pub reconciled: bool,
    /// Unix seconds when the tombstone was written (for TTL pruning).
    pub created_at_unix: u64,
}

/// Result of atomic preflight session cancellation/reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CancelPreflightSessionResult {
    /// Final related job state (snake_case), or null when no job was bound.
    pub job_state: Option<String>,
    pub token_state: PreflightTokenState,
    /// True only when job (if any) is terminal/absent and token is invalidated/missing.
    pub reconciled: bool,
}

/// Default tombstone TTL (1 hour) and max retained entries.
pub const PREFLIGHT_TOMBSTONE_TTL_SECONDS: u64 = 3600;
pub const PREFLIGHT_TOMBSTONE_MAX_ENTRIES: usize = 256;

/// SHA-256 hex digest of an opaque plan token (never log or store the raw token).
pub fn plan_token_digest(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn job_state_label(state: &str) -> String {
    state.to_string()
}

#[derive(Debug, Clone)]
pub struct PlanRegistry {
    plans: HashMap<String, PublishPlan>,
    expires_at: HashMap<String, Instant>,
    ttl_seconds: u64,
    /// Cancellation tombstones keyed by plan-token digest (not raw token).
    cancellation_tombstones: HashMap<String, PreflightCancellationTombstone>,
    /// Live plan-token digest → audit job id (survives only while plan is live or until tombstone).
    plan_job_index: HashMap<String, String>,
    /// Reverse: audit job id → raw plan token (for strip cancel kind-dispatch).
    job_plan_tokens: HashMap<String, String>,
    tombstone_ttl_seconds: u64,
    tombstone_max_entries: usize,
}

impl PlanRegistry {
    #[allow(dead_code)]
    pub fn prepare_plan_with_request(
        &mut self,
        request_generation: u64,
        request: PublishRequest,
    ) -> Result<PreparedPlanResponse, String> {
        // Legacy helper path is local-only (AI disabled/unconfigured).
        self.prepare_plan_with_request_and_blockers(
            request_generation,
            request,
            Vec::new(),
            false,
            None,
        )
    }

    /// Prepare a plan token and **atomically** bind authoritative initial audit evidence.
    ///
    /// `ai_enabled_and_configured`:
    /// - `false` → local-only GO / LOCAL_BLOCKED (`formal_ran=false`), publish-compatible.
    /// - `true` → PENDING until `ai_start_formal_audit` / `ai_compute_audit` replaces evidence
    ///   with a terminal decision (Succeeded/Failed job only; cancel/stale never forge bind).
    ///
    /// `okp_identity`: private selected OKP executable identity captured at prepare.
    /// Bound for revalidation at publish; never exposed in the public response.
    pub fn prepare_plan_with_request_and_blockers(
        &mut self,
        request_generation: u64,
        request: PublishRequest,
        local_blockers: Vec<String>,
        ai_enabled_and_configured: bool,
        okp_identity: Option<OkpExecutableIdentity>,
    ) -> Result<PreparedPlanResponse, String> {
        self.prepare_plan_with_request_blockers_and_content_root(
            request_generation,
            request,
            String::new(),
            local_blockers,
            ai_enabled_and_configured,
            okp_identity,
        )
    }

    pub fn prepare_plan_with_request_blockers_and_content_root(
        &mut self,
        request_generation: u64,
        request: PublishRequest,
        content_root: String,
        local_blockers: Vec<String>,
        ai_enabled_and_configured: bool,
        okp_identity: Option<OkpExecutableIdentity>,
    ) -> Result<PreparedPlanResponse, String> {
        let mut plan = PublishPlan::from_publish_request_with_content_root(
            request_generation,
            request,
            content_root,
            okp_identity,
        )?;
        for blocker in local_blockers {
            plan.add_local_blocker(blocker);
        }
        let snapshot_hash = plan.snapshot_hash.clone();
        let has_blockers = plan.has_blockers();
        let blockers = plan.local_blockers.clone();
        // Atomic initial bind: no token is ever publishable without backend-owned evidence.
        let initial = PlanAuditEvidence::initial_for_prepare(
            snapshot_hash.clone(),
            request_generation,
            has_blockers,
            ai_enabled_and_configured,
        );
        plan.bind_audit_evidence(initial)?;
        let token = new_opaque_token();
        let expires = Instant::now() + Duration::from_secs(self.ttl_seconds);
        self.plans.insert(token.clone(), plan);
        self.expires_at.insert(token.clone(), expires);
        Ok(PreparedPlanResponse {
            token,
            snapshot_hash,
            request_generation,
            local_blockers: blockers,
            has_blockers,
        })
    }

    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            plans: HashMap::new(),
            expires_at: HashMap::new(),
            ttl_seconds,
            cancellation_tombstones: HashMap::new(),
            plan_job_index: HashMap::new(),
            job_plan_tokens: HashMap::new(),
            tombstone_ttl_seconds: PREFLIGHT_TOMBSTONE_TTL_SECONDS,
            tombstone_max_entries: PREFLIGHT_TOMBSTONE_MAX_ENTRIES,
        }
    }

    /// Test/helper override for tombstone bounds.
    #[cfg(test)]
    pub fn with_tombstone_bounds(mut self, ttl_seconds: u64, max_entries: usize) -> Self {
        self.tombstone_ttl_seconds = ttl_seconds;
        self.tombstone_max_entries = max_entries.max(1);
        self
    }

    /// Record a live plan → audit job association for token-only cancel resolution.
    pub fn note_plan_audit_job(&mut self, token: &str, job_id: &str) {
        let token = token.trim();
        let job_id = job_id.trim();
        if token.is_empty() || job_id.is_empty() {
            return;
        }
        self.plan_job_index
            .insert(plan_token_digest(token), job_id.to_string());
        self.job_plan_tokens
            .insert(job_id.to_string(), token.to_string());
    }

    /// Resolve the raw plan token for an audit job id (strip cancel kind-dispatch).
    pub fn resolve_plan_token_for_job(&mut self, job_id: &str) -> Option<String> {
        let job_id = job_id.trim();
        if job_id.is_empty() {
            return None;
        }
        if let Some(token) = self.job_plan_tokens.get(job_id).cloned() {
            // Prefer reverse index when the plan is still live.
            if self.inspect_plan(&token).is_some() {
                return Some(token);
            }
        }
        // Scan live plans for bound audit job id (covers index loss after partial cleanup).
        let mut matched: Option<String> = None;
        let mut expired: Vec<String> = Vec::new();
        for (token, plan) in &self.plans {
            if self.is_expired(token) {
                expired.push(token.clone());
                continue;
            }
            if plan
                .audit_evidence
                .as_ref()
                .and_then(|evidence| evidence.job_id.as_deref())
                .map(str::trim)
                == Some(job_id)
            {
                matched = Some(token.clone());
                break;
            }
        }
        for token in expired {
            self.remove(&token);
        }
        matched
    }

    /// Look up a cancellation tombstone by raw plan token (hashed internally).
    pub fn get_cancellation_tombstone(
        &mut self,
        token: &str,
    ) -> Option<&PreflightCancellationTombstone> {
        self.prune_cancellation_tombstones();
        let digest = plan_token_digest(token.trim());
        self.cancellation_tombstones.get(&digest)
    }

    /// Write or replace a cancellation tombstone and prune bounds.
    pub fn put_cancellation_tombstone(&mut self, tombstone: PreflightCancellationTombstone) {
        let digest = tombstone.token_digest.clone();
        // Drop reverse job→token for any job recorded on this tombstone.
        if let Some(job_id) = tombstone.job_id.as_deref() {
            self.job_plan_tokens.remove(job_id);
        }
        self.cancellation_tombstones
            .insert(digest.clone(), tombstone);
        // Drop plan→job index once reconciled; tombstone is the durable record.
        self.plan_job_index.remove(&digest);
        self.prune_cancellation_tombstones();
    }

    /// Prune expired and over-capacity cancellation tombstones (oldest first).
    pub fn prune_cancellation_tombstones(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let ttl = self.tombstone_ttl_seconds;
        self.cancellation_tombstones
            .retain(|_, entry| now.saturating_sub(entry.created_at_unix) <= ttl);
        if self.cancellation_tombstones.len() <= self.tombstone_max_entries {
            return;
        }
        let mut entries: Vec<(String, u64)> = self
            .cancellation_tombstones
            .iter()
            .map(|(digest, entry)| (digest.clone(), entry.created_at_unix))
            .collect();
        entries.sort_by_key(|(_, created)| *created);
        let remove_count = self
            .cancellation_tombstones
            .len()
            .saturating_sub(self.tombstone_max_entries);
        for (digest, _) in entries.into_iter().take(remove_count) {
            self.cancellation_tombstones.remove(&digest);
        }
    }

    /// Resolve related audit job id from live plan evidence or plan→job index.
    pub fn resolve_related_audit_job_id(&mut self, token: &str) -> Option<String> {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        if let Some(plan) = self.inspect_plan(token) {
            if let Some(job_id) = plan
                .audit_evidence
                .as_ref()
                .and_then(|evidence| evidence.job_id.as_ref())
            {
                let trimmed = job_id.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        let digest = plan_token_digest(token);
        self.plan_job_index.get(&digest).cloned()
    }

    /// Build a recorded cancel result from a tombstone (idempotent replay).
    pub fn cancel_result_from_tombstone(
        tombstone: &PreflightCancellationTombstone,
    ) -> CancelPreflightSessionResult {
        CancelPreflightSessionResult {
            job_state: tombstone.job_state.clone(),
            token_state: tombstone.token_state,
            reconciled: tombstone.reconciled,
        }
    }

    /// Record tombstone after cancel work and return the public result.
    pub fn record_preflight_cancellation(
        &mut self,
        token: &str,
        job_id: Option<String>,
        job_state: Option<String>,
        token_state: PreflightTokenState,
        reconciled: bool,
    ) -> CancelPreflightSessionResult {
        let digest = plan_token_digest(token.trim());
        let created_at_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let tombstone = PreflightCancellationTombstone {
            token_digest: digest,
            job_id,
            job_state: job_state.clone().map(|state| job_state_label(&state)),
            token_state,
            reconciled,
            created_at_unix,
        };
        self.put_cancellation_tombstone(tombstone);
        CancelPreflightSessionResult {
            job_state,
            token_state,
            reconciled,
        }
    }

    /// Lightweight prepare without a publish request binding.
    /// Always binds local-only initial evidence (not AI-pending) so the token is never unbound.
    #[allow(dead_code)]
    pub fn prepare_plan(
        &mut self,
        snapshot_hash: String,
        request_generation: u64,
    ) -> Result<String, String> {
        if snapshot_hash.trim().is_empty() {
            return Err("snapshot hash is required".to_string());
        }
        let mut plan = PublishPlan::new(snapshot_hash.clone(), request_generation);
        let initial =
            PlanAuditEvidence::initial_for_prepare(snapshot_hash, request_generation, false, false);
        plan.bind_audit_evidence(initial)?;
        let token = new_opaque_token();
        let expires = Instant::now() + Duration::from_secs(self.ttl_seconds);
        self.plans.insert(token.clone(), plan);
        self.expires_at.insert(token.clone(), expires);
        Ok(token)
    }

    pub fn inspect_plan(&mut self, token: &str) -> Option<&PublishPlan> {
        if self.is_expired(token) {
            self.remove(token);
            return None;
        }
        self.plans.get(token)
    }

    /// Resolve a prepared plan token to its private local execution binding for AI context.
    ///
    /// Fail-closed:
    /// - empty / missing / expired token → error (no plan leak)
    /// - plan without a prepared binding (lightweight prepare) → error
    ///
    /// Does not consume the token. Never returns absolute paths in error messages.
    pub fn resolve_binding_for_context(
        &mut self,
        token: &str,
    ) -> Result<LocalExecutionBinding, String> {
        self.resolve_context_for_audit(token)
            .map(|(binding, _)| binding)
    }

    /// Resolve the private binding and identity-matched per-file MediaInfo outcomes atomically.
    pub fn resolve_context_for_audit(
        &mut self,
        token: &str,
    ) -> Result<(LocalExecutionBinding, Vec<PlanMediaFileResult>), String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("prepared plan token is required".to_string());
        }
        let plan = self
            .inspect_plan(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        let binding = plan
            .get_local_binding_owned()
            .ok_or_else(|| "prepared plan has no local execution binding".to_string())?;
        let media_info = plan
            .media_evidence
            .as_ref()
            .filter(|evidence| evidence.matches_plan(&plan.snapshot_hash, plan.request_generation))
            .map(|evidence| evidence.results.clone())
            .unwrap_or_default();
        Ok((binding, media_info))
    }

    pub fn invalidate_plan(&mut self, token: &str) -> bool {
        // Always remove both maps; short-circuit `||` previously left orphan plan entries.
        let had_expiry = self.expires_at.remove(token).is_some();
        let had_plan = self.plans.remove(token).is_some();
        // Keep plan_job_index until a cancellation tombstone is written so token-only
        // cancel can still resolve the related audit job after plain invalidate.
        had_expiry || had_plan
    }

    /// Bind Rust-owned audit evidence to a live prepared plan token.
    pub fn bind_audit_evidence(
        &mut self,
        token: &str,
        evidence: PlanAuditEvidence,
    ) -> Result<&PublishPlan, String> {
        if self.is_expired(token) {
            self.remove(token);
            return Err("prepared plan token is missing or expired".to_string());
        }
        if !self.plans.contains_key(token) {
            return Err("prepared plan token is missing or expired".to_string());
        }
        if let Some(job_id) = evidence.job_id.as_deref() {
            let trimmed = job_id.trim();
            if !trimmed.is_empty() {
                // Index so token-only cancel can resolve the related audit job.
                self.plan_job_index
                    .insert(plan_token_digest(token), trimmed.to_string());
            }
        }
        let plan = self
            .plans
            .get_mut(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        plan.bind_audit_evidence(evidence)?;
        Ok(plan)
    }

    /// Bind MediaInfo evidence to a live prepared plan token.
    ///
    /// Fail-closed:
    /// - empty / missing / expired token → error (no plan leak; plan state untouched)
    /// - identity mismatch (snapshot_hash / request_generation) → error without mutation
    /// - binding revalidation failure (identity drift) → error without mutation
    ///
    /// A changed normalized media outcome rolls the plan snapshot hash and invalidates
    /// earlier audit evidence/acknowledgements; identical media rebinds are idempotent.
    pub fn bind_media_evidence(
        &mut self,
        token: &str,
        evidence: PlanMediaEvidence,
    ) -> Result<String, String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("prepared plan token is required".to_string());
        }
        if self.is_expired(token) {
            self.remove(token);
            return Err("prepared plan token is missing or expired".to_string());
        }
        let plan = self
            .plans
            .get_mut(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        // Identity must match the plan's current backend-owned snapshot before any write.
        if evidence.snapshot_hash != plan.snapshot_hash
            || evidence.request_generation != plan.request_generation
        {
            return Err("media evidence identity does not match prepared plan".to_string());
        }
        // Revalidate private binding so same-path replacements fail closed without bind.
        if let Some(binding) = plan.get_local_binding() {
            if let Err(failures) = binding.revalidate() {
                return Err(failures.join("；"));
            }
        } else {
            return Err("prepared plan has no local execution binding".to_string());
        }
        plan.bind_media_evidence(evidence)
    }

    /// Resolve plan identity + private binding for MediaInfo start.
    ///
    /// Backend snapshot_hash / request_generation / torrent_path come only from the
    /// prepared plan. Client-supplied hashes, generations, torrent paths, relative
    /// paths, and content roots are never plan identity.
    ///
    /// Does not consume the token. Revalidates the binding so drift fails closed
    /// before a job starts (plan state is not weakened on failure).
    pub fn resolve_for_media_info(
        &mut self,
        token: &str,
    ) -> Result<(String, u64, LocalExecutionBinding), String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("prepared plan token is required".to_string());
        }
        let plan = self
            .inspect_plan(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        let snapshot_hash = plan.snapshot_hash.clone();
        let request_generation = plan.request_generation;
        let binding = plan
            .get_local_binding_owned()
            .ok_or_else(|| "prepared plan has no local execution binding".to_string())?;
        if let Err(failures) = binding.revalidate() {
            return Err(failures.join("；"));
        }
        Ok((snapshot_hash, request_generation, binding))
    }

    /// Record explicit acknowledgements against a live prepared plan token.
    pub fn set_acknowledgements(
        &mut self,
        token: &str,
        acknowledgements: Acknowledgements,
    ) -> Result<&PublishPlan, String> {
        if self.is_expired(token) {
            self.remove(token);
            return Err("prepared plan token is missing or expired".to_string());
        }
        let plan = self
            .plans
            .get_mut(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        plan.set_acknowledgements(acknowledgements);
        Ok(plan)
    }

    pub fn publish_plan(&mut self, token: &str) -> Option<PublishPlan> {
        if self.is_expired(token) {
            self.remove(token);
            None
        } else {
            self.expires_at.remove(token)?;
            let mut plan = self.plans.remove(token)?;
            plan.publish_token = Some(token.to_string());
            Some(plan)
        }
    }

    fn is_expired(&self, token: &str) -> bool {
        self.expires_at
            .get(token)
            .is_none_or(|expires_at| Instant::now() >= *expires_at)
    }

    fn remove(&mut self, token: &str) {
        self.expires_at.remove(token);
        self.plans.remove(token);
    }
}

impl Default for PlanRegistry {
    fn default() -> Self {
        Self::new(3600) // 1 hour TTL
    }
}

static REGISTRY: OnceLock<Mutex<PlanRegistry>> = OnceLock::new();
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn get_or_create_registry() -> &'static Mutex<PlanRegistry> {
    REGISTRY.get_or_init(|| Mutex::new(PlanRegistry::default()))
}

fn new_opaque_token() -> String {
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(timestamp.to_le_bytes());
    hasher.update(counter.to_le_bytes());
    format!("plan_{}", hex::encode(hasher.finalize()))
}

/// Safe relative media labels for plan-owned evidence (no absolute / traversal forms).
fn is_safe_plan_media_relative_name(path: &str) -> bool {
    if path.is_empty() || path.trim().is_empty() {
        return false;
    }
    if path != path.trim() {
        return false;
    }
    if path.chars().any(|character| character.is_control()) {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.contains(':') {
        return false;
    }
    for component in path.split(['/', '\\']) {
        if component.is_empty() || component == ".." {
            return false;
        }
    }
    path.chars().count() <= 256
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_publish_plan_hash_determinism() {
        let plan = PublishPlan::new("torrent_hash".to_string(), 1);
        let hash1 = plan.compute_deterministic_hash();
        let hash2 = plan.compute_deterministic_hash();
        assert_eq!(hash1, hash2);
        // mutation changes hash
        let mut plan2 = plan.clone();
        plan2.add_local_blocker("test".to_string());
        let hash3 = plan2.compute_deterministic_hash();
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_local_blockers() {
        let mut plan = PublishPlan::new("hash".to_string(), 1);
        assert!(!plan.has_blockers());
        plan.add_local_blocker("block1".to_string());
        assert!(plan.has_blockers());
        plan.add_local_blocker("block1".to_string()); // duplicate
        assert_eq!(plan.local_blockers.len(), 1);
    }

    #[test]
    fn test_opaque_token_ttl_invalidate_consume_once() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("snapshot".to_string(), 1)
            .expect("failed to prepare plan");
        let plan = registry.inspect_plan(&token).unwrap();
        assert_eq!(plan.prepare_token, None);
        registry.invalidate_plan(&token);
        assert!(registry.inspect_plan(&token).is_none());
        // consume once
        let published = registry.publish_plan(&token);
        assert!(published.is_none());

        let mut expiring = PlanRegistry::new(0);
        let expired_token = expiring
            .prepare_plan("snapshot".to_string(), 1)
            .expect("failed to prepare expiring plan");
        assert!(expiring.inspect_plan(&expired_token).is_none());
        assert!(expiring.publish_plan(&expired_token).is_none());
    }

    #[test]
    fn invalidate_plan_always_removes_both_expiry_and_plan_entries() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("snapshot".to_string(), 1)
            .expect("failed to prepare plan");
        assert!(registry.plans.contains_key(&token));
        assert!(registry.expires_at.contains_key(&token));
        assert!(registry.invalidate_plan(&token));
        assert!(
            !registry.plans.contains_key(&token),
            "plan entry must be removed"
        );
        assert!(
            !registry.expires_at.contains_key(&token),
            "expiry entry must be removed"
        );
        assert!(!registry.invalidate_plan(&token));

        // Orphan plan (no expiry) and orphan expiry (no plan) must both clear fully.
        let orphan_token = "plan_orphan".to_string();
        registry.plans.insert(
            orphan_token.clone(),
            PublishPlan::new("snap".to_string(), 2),
        );
        assert!(registry.invalidate_plan(&orphan_token));
        assert!(!registry.plans.contains_key(&orphan_token));
        assert!(!registry.expires_at.contains_key(&orphan_token));

        let expiry_only = "plan_expiry_only".to_string();
        registry.expires_at.insert(
            expiry_only.clone(),
            Instant::now() + Duration::from_secs(60),
        );
        assert!(registry.invalidate_plan(&expiry_only));
        assert!(!registry.plans.contains_key(&expiry_only));
        assert!(!registry.expires_at.contains_key(&expiry_only));
    }

    fn write_temp_torrent(contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "okpgui-plan-{}-{}.torrent",
            std::process::id(),
            TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, contents).expect("write temp torrent");
        path
    }

    fn sample_request(torrent_path: PathBuf) -> PublishRequest {
        PublishRequest {
            publish_id: "publish".to_string(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "profile".to_string(),
            template: Template::default(),
        }
    }

    #[test]
    fn test_revalidation_failure_does_not_consume_prepared_binding() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(1, request, Vec::new(), false, None)
            .expect("failed to prepare plan");
        let token = prepared.token;

        // Mutate torrent so revalidation fails while the plan token remains.
        std::fs::write(&torrent_path, b"d4:infod4:name7:changedee").expect("mutate torrent");
        let binding = registry
            .inspect_plan(&token)
            .and_then(|plan| plan.get_local_binding().cloned())
            .expect("binding present");
        assert!(binding.revalidate().is_err());
        assert!(registry.inspect_plan(&token).is_some());

        assert!(registry.publish_plan(&token).is_some());
        assert!(registry.publish_plan(&token).is_none());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn test_inspect_then_consume_successfully_binds_request_once() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(1, request, Vec::new(), false, None)
            .expect("failed to prepare plan");
        let token = prepared.token;
        assert!(prepared.snapshot_hash.starts_with("sha256:"));

        let inspected = registry
            .inspect_plan(&token)
            .cloned()
            .expect("plan missing");
        let binding = inspected.get_local_binding().expect("binding present");
        assert!(binding.revalidate().is_ok());
        assert!(registry.publish_plan(&token).is_some());
        assert!(registry.inspect_plan(&token).is_none());
        assert!(registry.publish_plan(&token).is_none());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn backend_snapshot_hash_ignores_client_supplied_values_and_hides_paths() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let plan = PublishPlan::from_publish_request(7, request.clone(), None).expect("plan");
        // Borrow snapshot so plan remains usable for public serialization and binding checks.
        let snapshot = plan.canonical_snapshot.as_ref().expect("snapshot");
        assert_eq!(plan.snapshot_hash, snapshot.hash);
        assert!(!plan.snapshot_hash.is_empty());
        // Public snapshot never embeds the absolute torrent path.
        let public = serde_json::to_string(&plan).expect("serialize");
        assert!(!public.contains(&request.torrent_path));
        assert!(public.contains(&snapshot.torrent_name));
        let binding = plan.get_local_binding().expect("binding");
        assert!(!binding.binding_fingerprint().is_empty());
        assert!(binding.torrent_digest().starts_with("sha256:"));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn content_root_is_private_and_changes_the_execution_binding() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let base = std::env::temp_dir().join(format!(
            "okpgui-plan-content-root-{}-{}",
            std::process::id(),
            TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let first_root = base.join("one");
        let second_root = base.join("two");
        std::fs::create_dir_all(&first_root).unwrap();
        std::fs::create_dir_all(&second_root).unwrap();

        let first = PublishPlan::from_publish_request_with_content_root(
            7,
            request.clone(),
            first_root.display().to_string(),
            None,
        )
        .expect("first plan");
        let second = PublishPlan::from_publish_request_with_content_root(
            7,
            request,
            second_root.display().to_string(),
            None,
        )
        .expect("second plan");

        let public = serde_json::to_string(&first).expect("serialize public plan");
        assert!(!public.contains(first_root.to_string_lossy().as_ref()));
        assert_ne!(
            first.get_local_binding().unwrap().binding_fingerprint(),
            second.get_local_binding().unwrap().binding_fingerprint()
        );

        std::fs::remove_dir_all(&first_root).unwrap();
        let failures = first
            .get_local_binding()
            .unwrap()
            .revalidate()
            .expect_err("removed content root must invalidate the binding");
        assert!(failures
            .iter()
            .any(|message| message.contains("实际媒体文件夹")));

        let _ = std::fs::remove_file(&torrent_path);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn bound_audit_evidence_and_acknowledgements_gate_publish() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(3, request, Vec::new(), false, None)
            .expect("prepare");
        let token = prepared.token;
        // Disabled AI: prepare binds explicit local-only GO with formal_ran=false.
        {
            let plan = registry.inspect_plan(&token).expect("plan");
            assert!(plan.has_authoritative_audit_evidence());
            assert_eq!(plan.publish_decision(), AuditDecision::Go);
            let evidence = plan.audit_evidence.as_ref().expect("evidence");
            assert!(!evidence.formal_ran);
            assert!(plan.can_publish_now());
        }

        registry
            .bind_audit_evidence(
                &token,
                PlanAuditEvidence {
                    decision: AuditDecision::Warning,
                    description: Some("标题与媒体信息需要进一步确认。".to_string()),
                    findings: vec![],
                    unknown_codes: vec![],
                    formal_ran: true,
                    job_id: Some("job-1".into()),
                    snapshot_hash: prepared.snapshot_hash.clone(),
                    request_generation: 3,
                },
            )
            .expect("bind warning");
        {
            let plan = registry.inspect_plan(&token).expect("plan");
            assert_eq!(plan.publish_decision(), AuditDecision::Warning);
            assert_eq!(
                plan.audit_evidence
                    .as_ref()
                    .and_then(|evidence| evidence.description.as_deref()),
                Some("标题与媒体信息需要进一步确认。")
            );
            assert!(!plan.can_publish_now());
        }
        registry
            .set_acknowledgements(
                &token,
                Acknowledgements {
                    warning: true,
                    critical: false,
                    pending: false,
                },
            )
            .expect("ack");
        assert!(registry
            .inspect_plan(&token)
            .expect("plan")
            .can_publish_now());

        // LOCAL_BLOCKED is absolute even with every acknowledgement set.
        let blocked = registry
            .prepare_plan_with_request_and_blockers(
                4,
                sample_request(torrent_path.clone()),
                vec!["missing profile".into()],
                false,
                None,
            )
            .expect("prepare blocked");
        registry
            .bind_audit_evidence(
                &blocked.token,
                PlanAuditEvidence {
                    decision: AuditDecision::Go,
                    description: None,
                    findings: vec![],
                    unknown_codes: vec![],
                    formal_ran: false,
                    job_id: None,
                    snapshot_hash: blocked.snapshot_hash.clone(),
                    request_generation: 4,
                },
            )
            .expect("bind");
        let plan = registry.inspect_plan(&blocked.token).expect("plan");
        assert_eq!(plan.publish_decision(), AuditDecision::LocalBlocked);
        assert!(!plan.can_publish_now());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn prepare_binds_disabled_local_evidence_and_enabled_pending() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let mut registry = PlanRegistry::default();

        // Disabled / unconfigured: local-only GO, formal_ran=false, publish-compatible.
        let local = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                None,
            )
            .expect("prepare local");
        {
            let plan = registry.inspect_plan(&local.token).expect("plan");
            assert!(plan.has_authoritative_audit_evidence());
            let evidence = plan.audit_evidence.as_ref().expect("evidence");
            assert_eq!(evidence.decision, AuditDecision::Go);
            assert!(!evidence.formal_ran);
            assert!(evidence.job_id.is_none());
            assert!(plan.can_publish_now());
        }

        // Enabled+configured: PENDING until formal audit replaces evidence.
        let pending = registry
            .prepare_plan_with_request_and_blockers(
                2,
                sample_request(torrent_path.clone()),
                Vec::new(),
                true,
                None,
            )
            .expect("prepare pending");
        {
            let plan = registry.inspect_plan(&pending.token).expect("plan");
            assert!(plan.has_authoritative_audit_evidence());
            let evidence = plan.audit_evidence.as_ref().expect("evidence");
            assert_eq!(evidence.decision, AuditDecision::Pending);
            assert!(!evidence.formal_ran);
            assert!(!plan.can_publish_now());
        }

        // Local blockers always win at prepare, even when AI is configured.
        let blocked = registry
            .prepare_plan_with_request_and_blockers(
                3,
                sample_request(torrent_path.clone()),
                vec!["missing profile".into()],
                true,
                None,
            )
            .expect("prepare blocked");
        {
            let plan = registry.inspect_plan(&blocked.token).expect("plan");
            assert_eq!(plan.publish_decision(), AuditDecision::LocalBlocked);
            assert!(!plan.can_publish_now());
            assert!(!plan.audit_evidence.as_ref().expect("e").formal_ran);
        }

        let _ = std::fs::remove_file(&torrent_path);
    }

    fn create_test_okp_layout_for_binding(file_name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "okpgui-plan-okp-{}-{}",
            std::process::id(),
            TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let tags_dir = root.join("config").join("tags");
        std::fs::create_dir_all(&tags_dir).expect("tags dir");
        for file in [
            "acgnx_asia.json",
            "acgnx_global.json",
            "acgrip.json",
            "bangumi.json",
            "dmhy.json",
            "nyaa.json",
        ] {
            std::fs::write(tags_dir.join(file), "{}").expect("tag file");
        }
        let executable_path = root.join(file_name);
        std::fs::write(&executable_path, b"okp-identity-v1").expect("okp binary");
        executable_path
    }

    #[test]
    fn okp_identity_binding_revalidates_unchanged_and_rejects_replacement_without_path() {
        use crate::publish::capture_okp_executable_identity;

        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let okp_path = create_test_okp_layout_for_binding("OKP.Core.dll");
        let okp_path_str = okp_path.display().to_string();
        let identity = capture_okp_executable_identity(&okp_path_str).expect("capture okp");

        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                Some(identity),
            )
            .expect("prepare with okp identity");

        // Public prepare response and plan serialization never embed the OKP path.
        // Serialize before moving `token` out of `prepared` (avoids E0382 partial-move).
        let public_response = serde_json::to_string(&prepared).expect("serialize response");
        assert!(!public_response.contains(&okp_path_str));
        let token = prepared.token;
        let plan = registry.inspect_plan(&token).cloned().expect("plan");
        let public_plan = serde_json::to_string(&plan).expect("serialize plan");
        assert!(!public_plan.contains(&okp_path_str));
        assert!(plan
            .get_local_binding()
            .expect("binding")
            .okp_identity()
            .is_some());

        // Unchanged executable identity passes revalidation (token not consumed)
        // and returns the bound resolved executable for launch.
        let binding = plan.get_local_binding().cloned().expect("binding");
        let resolved = binding
            .revalidate_for_prepared_publish()
            .expect("bound identity must revalidate for publish");
        assert_eq!(resolved.executable_path(), okp_path.as_path());
        assert!(registry.inspect_plan(&token).is_some());

        // Same-path replacement fails before any token consumption.
        std::fs::write(&okp_path, b"okp-identity-replaced").expect("replace okp");
        let failures = binding.revalidate().expect_err("replacement must fail");
        let joined = failures.join("；");
        assert!(
            joined.contains("替换") || joined.contains("重新执行"),
            "unexpected failures: {joined}"
        );
        assert!(
            joined.contains(&okp_path_str),
            "failure must preserve the OKP path: {joined}"
        );
        // Token remains available after revalidation failure (not consumed).
        assert!(registry.inspect_plan(&token).is_some());

        let _ = std::fs::remove_file(&torrent_path);
        let _ = std::fs::remove_dir_all(okp_path.parent().expect("okp parent"));
    }

    #[test]
    fn prepared_publish_revalidate_fails_closed_without_bound_okp_identity() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                None, // unbound identity must not be publishable via prepared path
            )
            .expect("prepare");
        let binding = registry
            .inspect_plan(&prepared.token)
            .and_then(|plan| plan.get_local_binding().cloned())
            .expect("binding");
        // Generic revalidate may succeed (torrent/fingerprint only).
        assert!(binding.revalidate().expect("torrent ok").is_none());
        // Prepared publish requires bound OKP and fails closed.
        let failures = binding
            .revalidate_for_prepared_publish()
            .expect_err("unbound OKP must fail prepared publish");
        let joined = failures.join("；");
        assert!(
            joined.contains("未绑定") || joined.contains("OKP"),
            "unexpected: {joined}"
        );
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn prepared_publish_revalidate_stays_on_bound_okp_when_alternate_exists() {
        use crate::publish::capture_okp_executable_identity;

        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let okp_a = create_test_okp_layout_for_binding("OKP.Core.dll");
        let okp_b = create_test_okp_layout_for_binding("OKP.Core.dll");
        let identity_a =
            capture_okp_executable_identity(&okp_a.display().to_string()).expect("capture A");
        // B is a valid alternate executable that live config could drift to.
        let _ = capture_okp_executable_identity(&okp_b.display().to_string()).expect("capture B");

        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                Some(identity_a),
            )
            .expect("prepare with A");
        let binding = registry
            .inspect_plan(&prepared.token)
            .and_then(|plan| plan.get_local_binding().cloned())
            .expect("binding");
        let resolved = binding
            .revalidate_for_prepared_publish()
            .expect("bound A must resolve");
        assert_eq!(resolved.executable_path(), okp_a.as_path());
        assert_ne!(resolved.executable_path(), okp_b.as_path());

        let public = serde_json::to_string(registry.inspect_plan(&prepared.token).expect("plan"))
            .expect("serialize");
        assert!(!public.contains(&okp_a.display().to_string()));
        assert!(!public.contains(&okp_b.display().to_string()));

        let _ = std::fs::remove_file(&torrent_path);
        let _ = std::fs::remove_dir_all(okp_a.parent().expect("parent A"));
        let _ = std::fs::remove_dir_all(okp_b.parent().expect("parent B"));
    }

    #[test]
    fn resolve_binding_for_context_missing_unbound_expired() {
        let mut registry = PlanRegistry::default();
        assert!(registry
            .resolve_binding_for_context("plan_missing")
            .unwrap_err()
            .contains("missing or expired"));

        let unbound = registry
            .prepare_plan("sha256:snap".into(), 1)
            .expect("prepare");
        assert!(registry
            .resolve_binding_for_context(&unbound)
            .unwrap_err()
            .contains("no local execution binding"));

        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let mut expiring = PlanRegistry::new(0);
        let prepared = expiring
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                None,
            )
            .expect("prepare");
        assert!(expiring
            .resolve_binding_for_context(&prepared.token)
            .unwrap_err()
            .contains("missing or expired"));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn prepared_publish_revalidate_torrent_errors_preserve_path() {
        use crate::publish::capture_okp_executable_identity;

        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let torrent_path_str = torrent_path.display().to_string();
        let okp_path = create_test_okp_layout_for_binding("OKP.Core.dll");
        let identity =
            capture_okp_executable_identity(&okp_path.display().to_string()).expect("capture");

        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                Some(identity),
            )
            .expect("prepare");
        let binding = registry
            .inspect_plan(&prepared.token)
            .and_then(|plan| plan.get_local_binding().cloned())
            .expect("binding");

        // Remove torrent so revalidation hits existence failure.
        let _ = std::fs::remove_file(&torrent_path);
        let failures = binding
            .revalidate_for_prepared_publish()
            .expect_err("missing torrent must fail prepared revalidate");
        let joined = failures.join("；");
        assert!(
            joined.contains("种子") || joined.contains("不存在"),
            "unexpected category: {joined}"
        );
        assert!(
            joined.contains(&torrent_path_str),
            "must preserve the absolute torrent path: {joined}"
        );
        // Token remains available after revalidation failure (not consumed).
        assert!(registry.inspect_plan(&prepared.token).is_some());

        let _ = std::fs::remove_dir_all(okp_path.parent().expect("okp parent"));
    }

    #[test]
    fn prepare_unresolved_okp_identity_none_requires_blockers_for_fail_closed() {
        // Registry contract: okp_identity=None is only safe when local blockers make
        // the plan unpublishable. Prepare IPC must supply blockers from the single
        // resolve/bind path (Unresolved error or capture-failure blocker).
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone()),
                vec!["OKP 可执行文件身份未绑定，请重新执行发布前检查。".to_string()],
                false,
                None,
            )
            .expect("prepare with blockers");
        let plan = registry.inspect_plan(&prepared.token).expect("plan");
        assert!(plan
            .get_local_binding()
            .expect("binding")
            .okp_identity()
            .is_none());
        assert!(plan.has_blockers());
        assert!(!plan.can_publish_now());
        assert_eq!(plan.publish_decision(), AuditDecision::LocalBlocked);

        // Contrast: unbound identity with empty blockers would be a prepare bug
        // (publish revalidate still fails closed, but plan must not look publishable).
        let prepared_bad = registry
            .prepare_plan_with_request_and_blockers(
                2,
                sample_request(torrent_path.clone()),
                Vec::new(),
                false,
                None,
            )
            .expect("prepare without blockers");
        let plan_bad = registry.inspect_plan(&prepared_bad.token).expect("plan");
        assert!(plan_bad
            .get_local_binding()
            .expect("binding")
            .okp_identity()
            .is_none());
        // Without prepare-time blockers the local-only path may appear GO — prepared
        // publish still fails closed via revalidate_for_prepared_publish.
        let binding = plan_bad.get_local_binding().cloned().expect("binding");
        assert!(binding
            .revalidate_for_prepared_publish()
            .expect_err("unbound must fail prepared publish")
            .iter()
            .any(|m| m.contains("未绑定") || m.contains("OKP")));

        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn prepare_without_audit_evidence_is_not_publishable() {
        // Direct construction without prepare binding must fail closed.
        let mut plan = PublishPlan::new("sha256:abc".into(), 9);
        assert!(!plan.has_authoritative_audit_evidence());
        assert!(!plan.can_publish_now());
        // Even a pending acknowledgement cannot open an unbound plan.
        plan.set_acknowledgements(Acknowledgements {
            warning: true,
            critical: true,
            pending: true,
        });
        assert!(!plan.can_publish_now());

        // Mismatched evidence is also unusable.
        plan.audit_evidence = Some(PlanAuditEvidence {
            decision: AuditDecision::Go,
            description: None,
            findings: vec![],
            unknown_codes: vec![],
            formal_ran: false,
            job_id: None,
            snapshot_hash: "sha256:other".into(),
            request_generation: 9,
        });
        assert!(!plan.has_authoritative_audit_evidence());
        assert!(!plan.can_publish_now());
    }

    #[test]
    fn media_evidence_success_bind_is_identity_matched() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(5, request, Vec::new(), false, None)
            .expect("prepare");
        let token = prepared.token;
        registry
            .bind_media_evidence(
                &token,
                PlanMediaEvidence {
                    job_id: "media-job-1".into(),
                    snapshot_hash: prepared.snapshot_hash.clone(),
                    request_generation: 5,
                    status: PlanMediaStatus::Tested,
                    summaries: vec![PlanMediaSummary {
                        relative_name: "show/ep01.mkv".into(),
                        duration_ms: Some(1_000),
                        width: Some(1920),
                        height: Some(1080),
                        video_codec: Some("AV1".into()),
                        audio_codecs: vec!["AAC".into()],
                        subtitle_languages: vec![],
                        scan_type: None,
                    }],
                    results: vec![],
                },
            )
            .expect("bind media");

        {
            let plan = registry.inspect_plan(&token).expect("plan");
            assert!(plan.has_authoritative_media_evidence());
            let media = plan.media_evidence.as_ref().expect("media");
            assert_eq!(media.status, PlanMediaStatus::Tested);
            assert_eq!(media.summaries[0].relative_name, "show/ep01.mkv");
            assert_ne!(plan.snapshot_hash, prepared.snapshot_hash);
            assert!(plan.audit_evidence.is_none());
            assert!(plan.acknowledgements == Acknowledgements::default());
            assert_ne!(
                plan.media_evidence.as_ref().unwrap().snapshot_hash,
                prepared.snapshot_hash
            );
            let public = serde_json::to_string(plan).expect("serialize");
            assert!(!public.contains(torrent_path.to_string_lossy().as_ref()));
            assert!(!public.contains("/private"));
            assert!(!public.contains("/Users"));
        }
        // Token remains live after media bind.
        assert!(registry.inspect_plan(&token).is_some());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn media_evidence_token_mismatch_and_identity_mismatch_do_not_mutate() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(8, request, Vec::new(), false, None)
            .expect("prepare");
        let token = prepared.token;

        // Unknown token: no mutation path available.
        let err = registry
            .bind_media_evidence(
                "plan_not_real",
                PlanMediaEvidence {
                    job_id: "j".into(),
                    snapshot_hash: prepared.snapshot_hash.clone(),
                    request_generation: 8,
                    status: PlanMediaStatus::Tested,
                    summaries: vec![],
                    results: vec![],
                },
            )
            .expect_err("unknown token");
        assert!(err.contains("missing") || err.contains("expired"), "{err}");

        // Snapshot mismatch must leave media_evidence unset.
        let err = registry
            .bind_media_evidence(
                &token,
                PlanMediaEvidence {
                    job_id: "j".into(),
                    snapshot_hash: "sha256:forged-client-hash".into(),
                    request_generation: 8,
                    status: PlanMediaStatus::Tested,
                    summaries: vec![PlanMediaSummary {
                        relative_name: "ep.mkv".into(),
                        ..PlanMediaSummary::default()
                    }],
                    results: vec![],
                },
            )
            .expect_err("forged snapshot");
        assert!(
            err.contains("identity") || err.contains("snapshot"),
            "{err}"
        );
        assert!(
            registry
                .inspect_plan(&token)
                .and_then(|plan| plan.media_evidence.as_ref())
                .is_none(),
            "mismatch must not bind media evidence"
        );

        // Generation mismatch.
        let err = registry
            .bind_media_evidence(
                &token,
                PlanMediaEvidence {
                    job_id: "j".into(),
                    snapshot_hash: prepared.snapshot_hash.clone(),
                    request_generation: 999,
                    status: PlanMediaStatus::CheckFailed,
                    summaries: vec![],
                    results: vec![],
                },
            )
            .expect_err("forged generation");
        assert!(
            err.contains("identity") || err.contains("generation"),
            "{err}"
        );
        assert!(registry
            .inspect_plan(&token)
            .and_then(|plan| plan.media_evidence.as_ref())
            .is_none());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn media_evidence_identity_drift_after_start_does_not_bind() {
        let torrent_path = write_temp_torrent(b"d4:infod4:name4:testee");
        let request = sample_request(torrent_path.clone());
        let mut registry = PlanRegistry::default();
        let prepared = registry
            .prepare_plan_with_request_and_blockers(2, request, Vec::new(), false, None)
            .expect("prepare");
        let token = prepared.token;
        let (snap, gen, _binding) = registry
            .resolve_for_media_info(&token)
            .expect("resolve at start");
        assert_eq!(snap, prepared.snapshot_hash);
        assert_eq!(gen, 2);

        // Replace torrent bytes so revalidation fails (identity drift).
        std::fs::write(&torrent_path, b"d4:infod4:name7:changedee").expect("mutate");
        let err = registry
            .bind_media_evidence(
                &token,
                PlanMediaEvidence {
                    job_id: "media-drift".into(),
                    snapshot_hash: prepared.snapshot_hash.clone(),
                    request_generation: 2,
                    status: PlanMediaStatus::Tested,
                    summaries: vec![PlanMediaSummary {
                        relative_name: "ep.mkv".into(),
                        duration_ms: Some(1),
                        ..PlanMediaSummary::default()
                    }],
                    results: vec![],
                },
            )
            .expect_err("drift must reject bind");
        assert!(!err.is_empty());
        assert!(
            registry
                .inspect_plan(&token)
                .and_then(|plan| plan.media_evidence.as_ref())
                .is_none(),
            "drift must leave media evidence unset"
        );
        // Plan token and audit evidence remain live (not consumed / not weakened).
        let plan = registry.inspect_plan(&token).expect("plan still live");
        assert!(plan.has_authoritative_audit_evidence());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn resolve_for_media_info_rejects_client_identity_and_lightweight_prepare() {
        let mut registry = PlanRegistry::default();
        // Lightweight prepare has no LocalExecutionBinding.
        let light = registry
            .prepare_plan("sha256:client-forged".into(), 1)
            .expect("light prepare");
        let err = registry
            .resolve_for_media_info(&light)
            .expect_err("lightweight plan cannot start media");
        assert!(
            err.contains("local execution binding") || err.contains("binding"),
            "{err}"
        );

        let empty = registry
            .resolve_for_media_info("  ")
            .expect_err("empty token");
        assert!(empty.contains("required"), "{empty}");
    }

    #[test]
    fn test_config_migration_default_old_schema_v2() {
        // legacy schema-v2 handling covered in config.rs tests already; future schema uses default via serde
    }

    #[test]
    fn plan_token_digest_is_stable_and_non_empty() {
        let digest_a = plan_token_digest("plan_abc");
        let digest_b = plan_token_digest("plan_abc");
        let digest_c = plan_token_digest("plan_xyz");
        assert_eq!(digest_a, digest_b);
        assert_ne!(digest_a, digest_c);
        assert_eq!(digest_a.len(), 64);
        assert!(!digest_a.contains("plan_abc"));
    }

    #[test]
    fn cancellation_tombstone_replay_and_job_index_resolution() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("sha256:cancel-tomb".into(), 1)
            .expect("prepare");
        registry.note_plan_audit_job(&token, "job-audit-1");
        assert_eq!(
            registry.resolve_related_audit_job_id(&token).as_deref(),
            Some("job-audit-1")
        );

        let first = registry.record_preflight_cancellation(
            &token,
            Some("job-audit-1".into()),
            Some("cancelled".into()),
            PreflightTokenState::Invalidated,
            true,
        );
        assert!(first.reconciled);
        assert_eq!(first.token_state, PreflightTokenState::Invalidated);
        assert_eq!(first.job_state.as_deref(), Some("cancelled"));

        // Index is cleared once tombstone is written.
        assert!(registry.resolve_related_audit_job_id(&token).is_none());

        let tombstone = registry
            .get_cancellation_tombstone(&token)
            .expect("tombstone present")
            .clone();
        assert_eq!(tombstone.token_digest, plan_token_digest(&token));
        assert_eq!(tombstone.job_id.as_deref(), Some("job-audit-1"));
        let replay = PlanRegistry::cancel_result_from_tombstone(&tombstone);
        assert_eq!(replay, first);
    }

    #[test]
    fn cancellation_tombstone_prunes_by_size_and_ttl() {
        let mut registry = PlanRegistry::default().with_tombstone_bounds(3600, 2);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        for index in 0..3 {
            let token = format!("plan_tomb_{index}");
            registry.put_cancellation_tombstone(PreflightCancellationTombstone {
                token_digest: plan_token_digest(&token),
                job_id: Some(format!("job-{index}")),
                job_state: Some("cancelled".into()),
                token_state: PreflightTokenState::Invalidated,
                reconciled: true,
                created_at_unix: now + index as u64,
            });
        }
        assert_eq!(registry.cancellation_tombstones.len(), 2);
        assert!(
            registry.get_cancellation_tombstone("plan_tomb_0").is_none(),
            "oldest must be pruned"
        );
        assert!(registry.get_cancellation_tombstone("plan_tomb_1").is_some());
        assert!(registry.get_cancellation_tombstone("plan_tomb_2").is_some());

        let mut short_ttl = PlanRegistry::default().with_tombstone_bounds(0, 256);
        short_ttl.put_cancellation_tombstone(PreflightCancellationTombstone {
            token_digest: plan_token_digest("plan_expired"),
            job_id: None,
            job_state: None,
            token_state: PreflightTokenState::AlreadyMissing,
            reconciled: true,
            created_at_unix: now.saturating_sub(10),
        });
        // TTL 0 retains only entries created at exactly "now"; past entries prune.
        assert!(short_ttl
            .get_cancellation_tombstone("plan_expired")
            .is_none());
    }

    #[test]
    fn bind_audit_evidence_indexes_job_for_token_only_cancel() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("sha256:indexed".into(), 2)
            .expect("prepare");
        registry
            .bind_audit_evidence(
                &token,
                PlanAuditEvidence {
                    decision: AuditDecision::Pending,
                    description: None,
                    findings: Vec::new(),
                    unknown_codes: Vec::new(),
                    formal_ran: false,
                    job_id: Some("job-from-bind".into()),
                    snapshot_hash: "sha256:indexed".into(),
                    request_generation: 2,
                },
            )
            .expect("bind");
        assert_eq!(
            registry.resolve_related_audit_job_id(&token).as_deref(),
            Some("job-from-bind")
        );
        // After plain invalidate, plan is gone but index remains for cancel resolution.
        assert!(registry.invalidate_plan(&token));
        assert!(registry.inspect_plan(&token).is_none());
        assert_eq!(
            registry.resolve_related_audit_job_id(&token).as_deref(),
            Some("job-from-bind")
        );
    }
}
