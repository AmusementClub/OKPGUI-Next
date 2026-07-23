use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ai::audit::{Acknowledgements, AuditDecision, Finding};
use crate::config::{SiteSelection, Template};
use crate::publish::{OkpExecutableIdentity, PublishRequest, ResolvedOkpExecutable};

/// Backend-owned formal/local audit evidence bound to a prepared plan token.
/// Never accepts a client-supplied decision as authoritative without binding here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanAuditEvidence {
    pub decision: AuditDecision,
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
}

/// Private execution binding: raw paths and identity material never leave Rust.
#[derive(Debug, Clone)]
pub(crate) struct LocalExecutionBinding {
    request: PublishRequest,
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
    pub fn from_publish_request(
        request_generation: u64,
        request: PublishRequest,
        okp_identity: Option<OkpExecutableIdentity>,
    ) -> Result<Self, String> {
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
        );
        let binding_fingerprint = compute_binding_fingerprint(
            &request,
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
        });
        plan.set_local_binding(LocalExecutionBinding {
            request,
            torrent_digest: torrent_identity.digest,
            torrent_len: torrent_identity.len,
            binding_fingerprint,
            okp_identity,
        });
        Ok(plan)
    }

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
        }
        bytes
    }

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

    pub(crate) fn torrent_digest(&self) -> &str {
        &self.torrent_digest
    }

    pub(crate) fn binding_fingerprint(&self) -> &str {
        &self.binding_fingerprint
    }

    pub(crate) fn okp_identity(&self) -> Option<&OkpExecutableIdentity> {
        self.okp_identity.as_ref()
    }

    /// Re-check torrent existence/identity/digest, OKP executable identity, and
    /// private execution fingerprint against the bound request. Returns
    /// human-readable failures without consuming the plan token.
    /// On success, yields the revalidated `ResolvedOkpExecutable` when identity
    /// was bound (for prepared-plan launch). `None` only when identity was never
    /// captured (legacy/test bindings); prepared publish must fail closed on `None`.
    /// Failure messages never include raw OKP or torrent absolute paths (path-free
    /// categories for existence/read/type and identity errors).
    pub(crate) fn revalidate(&self) -> Result<Option<ResolvedOkpExecutable>, Vec<String>> {
        let mut failures = Vec::new();
        let torrent_identity = match read_torrent_identity_path_free(&self.request.torrent_path) {
            Ok(identity) => identity,
            Err(error) => {
                failures.push(error);
                return Err(failures);
            }
        };
        if torrent_identity.digest != self.torrent_digest {
            failures.push("种子文件内容已变化，请重新执行发布前检查。".to_string());
        }
        if torrent_identity.len != self.torrent_len {
            failures.push("种子文件大小已变化，请重新执行发布前检查。".to_string());
        }

        let sites = selected_site_codes(&self.request.template.sites);
        let template_digest = digest_template(&self.request.template);
        let fingerprint = compute_binding_fingerprint(
            &self.request,
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
    /// with a path-free message.
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

/// Prepared-publish revalidation: same torrent identity checks as prepare, but
/// failure messages never include absolute torrent paths (IPC-safe).
fn read_torrent_identity_path_free(torrent_path: &str) -> Result<TorrentIdentity, String> {
    let path = validate_torrent_file_path_path_free(torrent_path)?;
    let bytes =
        std::fs::read(&path).map_err(|_| "无法读取种子文件，请重新执行发布前检查。".to_string())?;
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

/// Path-free torrent path validation for prepared-publish revalidation IPC errors.
fn validate_torrent_file_path_path_free(torrent_path: &str) -> Result<PathBuf, String> {
    let torrent_path = torrent_path.trim();
    if torrent_path.is_empty() {
        return Err("未选择种子文件，请先选择 .torrent 文件。".to_string());
    }
    let torrent = PathBuf::from(torrent_path);
    if !torrent.exists() {
        return Err("种子文件不存在，请重新执行发布前检查。".to_string());
    }
    let metadata = std::fs::metadata(&torrent)
        .map_err(|_| "无法读取种子文件，请重新执行发布前检查。".to_string())?;
    if !metadata.is_file() {
        return Err("种子路径不是文件，请重新执行发布前检查。".to_string());
    }
    let is_torrent = torrent
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !is_torrent {
        return Err("所选文件不是 .torrent 文件，请重新执行发布前检查。".to_string());
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
) -> String {
    #[derive(Serialize)]
    struct CanonicalPayload<'a> {
        version: u32,
        torrent_digest: &'a str,
        torrent_name: &'a str,
        profile_name: &'a str,
        template_digest: &'a str,
        sites: &'a [String],
    }
    let payload = CanonicalPayload {
        version: 2,
        torrent_digest,
        torrent_name,
        profile_name,
        template_digest,
        sites,
    };
    digest_json(&payload)
}

/// Private execution binding fingerprint over path + identity + inputs.
fn compute_binding_fingerprint(
    request: &PublishRequest,
    torrent_digest: &str,
    torrent_len: u64,
    template_digest: &str,
    sites: &[String],
) -> String {
    #[derive(Serialize)]
    struct BindingPayload<'a> {
        publish_id: &'a str,
        torrent_path: &'a str,
        torrent_digest: &'a str,
        torrent_len: u64,
        profile_name: &'a str,
        template_digest: &'a str,
        sites: &'a [String],
    }
    let payload = BindingPayload {
        publish_id: &request.publish_id,
        torrent_path: &request.torrent_path,
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

#[derive(Debug, Clone)]
pub struct PlanRegistry {
    plans: HashMap<String, PublishPlan>,
    expires_at: HashMap<String, Instant>,
    ttl_seconds: u64,
}

impl PlanRegistry {
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
        let mut plan =
            PublishPlan::from_publish_request(request_generation, request, okp_identity)?;
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
        }
    }

    /// Lightweight prepare without a publish request binding.
    /// Always binds local-only initial evidence (not AI-pending) so the token is never unbound.
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
        let token = token.trim();
        if token.is_empty() {
            return Err("prepared plan token is required".to_string());
        }
        let plan = self
            .inspect_plan(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        plan.get_local_binding_owned().ok_or_else(|| {
            "prepared plan has no local execution binding".to_string()
        })
    }

    pub fn invalidate_plan(&mut self, token: &str) -> bool {
        // Always remove both maps; short-circuit `||` previously left orphan plan entries.
        let had_expiry = self.expires_at.remove(token).is_some();
        let had_plan = self.plans.remove(token).is_some();
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
        let plan = self
            .plans
            .get_mut(token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        plan.bind_audit_evidence(evidence)?;
        Ok(plan)
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
            !joined.contains(&okp_path_str),
            "failure must not expose OKP path: {joined}"
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
        // Prepared publish requires bound OKP and fails closed path-free.
        let failures = binding
            .revalidate_for_prepared_publish()
            .expect_err("unbound OKP must fail prepared publish");
        let joined = failures.join("；");
        assert!(
            joined.contains("未绑定") || joined.contains("OKP"),
            "unexpected: {joined}"
        );
        assert!(!joined.contains('/'), "must be path-free: {joined}");
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
    fn prepared_publish_revalidate_torrent_errors_are_path_free() {
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
            !joined.contains(&torrent_path_str),
            "must not expose absolute torrent path: {joined}"
        );
        assert!(
            !joined.contains("/tmp") && !joined.contains("okpgui"),
            "must not leak path fragments: {joined}"
        );
        // Token remains available after revalidation failure (not consumed).
        assert!(registry.inspect_plan(&prepared.token).is_some());

        let _ = std::fs::remove_dir_all(okp_path.parent().expect("okp parent"));
    }

    #[test]
    fn prepare_unresolved_okp_identity_none_requires_blockers_for_fail_closed() {
        // Registry contract: okp_identity=None is only safe when local blockers make
        // the plan unpublishable. Prepare IPC must supply blockers from the single
        // resolve/bind path (Unresolved error or capture-failure path-free blocker).
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
    fn test_config_migration_default_old_schema_v2() {
        // legacy schema-v2 handling covered in config.rs tests already; future schema uses default via serde
    }
}
