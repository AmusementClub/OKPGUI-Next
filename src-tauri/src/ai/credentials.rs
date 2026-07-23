use crate::ai::provider::{CapabilityIdentity, ProviderKind, ProviderMode};
use crate::atomic_file::write_text_file_atomically;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Bearer,
    AnthropicApiKey,
    CustomHeader,
    None,
}

impl Default for AuthMode {
    fn default() -> Self {
        Self::Bearer
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialRef {
    pub id: String,
}

/// Non-secret capability status exposed to the webview (never includes secrets or bodies).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PublicCapabilityStatus {
    pub state: crate::ai::provider::CapabilityState,
    /// Exact identity digest that was probed; empty when unknown.
    #[serde(default)]
    pub identity_digest: String,
    /// Resolved mode that passed (may differ from configured Auto).
    #[serde(default)]
    pub resolved_mode: Option<ProviderMode>,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub probed_at_unix: Option<u64>,
    /// True when stored Ready digest matches the current stored connection + secret.
    #[serde(default)]
    pub identity_matches: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicConnectionConfig {
    pub provider: ProviderKind,
    pub endpoint: String,
    pub model: String,
    pub mode: ProviderMode,
    pub auth_mode: AuthMode,
    #[serde(default)]
    pub custom_header_name: Option<String>,
    #[serde(default)]
    pub credential_ref: Option<CredentialRef>,
    #[serde(default)]
    pub enabled: bool,
    /// Last persisted capability probe outcome (non-secret).
    #[serde(default)]
    pub capability: Option<PublicCapabilityStatus>,
    /// Cached model ids from the last discovery refresh (non-secret).
    #[serde(default)]
    pub discovered_models: Vec<String>,
    #[serde(default)]
    pub models_fetched_at_unix: Option<u64>,
    /// True when the active credential is held only in process session storage
    /// (Linux keyring fallback), not durable OS keyring. Never includes secret material.
    #[serde(default)]
    pub credential_session_only: bool,
}

impl Default for PublicConnectionConfig {
    fn default() -> Self {
        Self {
            provider: ProviderKind::OpenAi,
            endpoint: "https://api.openai.com/v1".to_string(),
            model: String::new(),
            mode: ProviderMode::Auto,
            auth_mode: AuthMode::Bearer,
            custom_header_name: None,
            credential_ref: None,
            enabled: false,
            capability: None,
            discovered_models: Vec::new(),
            models_fetched_at_unix: None,
            credential_session_only: false,
        }
    }
}

/// In-memory secret holder. Debug redacts contents; Drop best-effort zeroizes bytes.
#[derive(Clone)]
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        // Best-effort wipe without extra crates (Cargo.toml is out of scope).
        // SAFETY: owned buffer is zeroed then cleared; all-NUL remains valid UTF-8.
        unsafe {
            let bytes = self.0.as_mut_vec();
            for byte in bytes.iter_mut() {
                std::ptr::write_volatile(byte, 0);
            }
        }
        self.0.clear();
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &CredentialRef, value: SecretValue) -> Result<(), String>;
    fn get(&self, reference: &CredentialRef) -> Result<Option<SecretValue>, String>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), String>;
}

#[derive(Clone, Default)]
pub struct SessionSecretStore {
    values: Arc<Mutex<HashMap<String, SecretValue>>>,
}

impl SessionSecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for SessionSecretStore {
    fn set(&self, reference: &CredentialRef, value: SecretValue) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "session secret store lock poisoned".to_string())?
            .insert(reference.id.clone(), value);
        Ok(())
    }

    fn get(&self, reference: &CredentialRef) -> Result<Option<SecretValue>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "session secret store lock poisoned".to_string())?
            .get(&reference.id)
            .cloned())
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "session secret store lock poisoned".to_string())?
            .remove(&reference.id);
        Ok(())
    }
}

/// Non-secret public view of where credentials may live. Never includes secret material.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStorageBackend {
    /// Platform keyring / Secret Service when available.
    OsKeyring,
    /// Process-local zeroizing session store (fallback or non-desktop targets).
    SessionOnly,
}

/// Non-secret store status for diagnostics / settings UI. No secret ids or values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialStorePublicStatus {
    pub backend: CredentialStorageBackend,
    /// True when Linux keyring operational failures use the session-only path.
    pub linux_session_fallback_enabled: bool,
}

/// Serializes credential save / rotation / clear so candidate create, config pointer
/// switch, and old-secret cleanup cannot interleave across concurrent settings saves.
#[derive(Default)]
pub struct CredentialMutationGate {
    lock: Mutex<()>,
}

impl CredentialMutationGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.lock
            .lock()
            .map_err(|_| "credential mutation lock poisoned".to_string())
    }
}

#[derive(Clone)]
pub struct OsCredentialStore {
    service: String,
    session_fallback: SessionSecretStore,
    /// Linux dual-store: ids suppressed after non-durable OS delete so get cannot
    /// resurrect a stale OS secret. Cleared only by durable OS write/delete success.
    linux_tombstones: Arc<Mutex<HashSet<String>>>,
}

impl OsCredentialStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            session_fallback: SessionSecretStore::new(),
            linux_tombstones: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Non-secret backend description only (never lists keys or values).
    pub fn public_status(&self) -> CredentialStorePublicStatus {
        #[cfg(target_os = "linux")]
        {
            return CredentialStorePublicStatus {
                backend: CredentialStorageBackend::OsKeyring,
                linux_session_fallback_enabled: true,
            };
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            return CredentialStorePublicStatus {
                backend: CredentialStorageBackend::OsKeyring,
                linux_session_fallback_enabled: false,
            };
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            CredentialStorePublicStatus {
                backend: CredentialStorageBackend::SessionOnly,
                linux_session_fallback_enabled: false,
            }
        }
    }

    /// True when this credential id is held only in the process session layer
    /// (Linux OS-write fallback). Never exposes secret material or keyring errors.
    pub fn credential_is_session_only(&self, reference: &CredentialRef) -> bool {
        matches!(self.session_fallback.get(reference), Ok(Some(_)))
    }

    /// Test-only: seed a session-authoritative secret without touching the OS keyring.
    #[cfg(test)]
    fn seed_session_only_for_tests(
        &self,
        reference: &CredentialRef,
        value: SecretValue,
    ) -> Result<(), String> {
        self.mark_session_authoritative(reference, value)
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    fn entry(&self, reference: &CredentialRef) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &reference.id)
            .map_err(|error| format!("credential store entry failed: {error}"))
    }

    fn clear_local_overlay(&self, reference: &CredentialRef) {
        let _ = self.session_fallback.delete(reference);
        if let Ok(mut tombstones) = self.linux_tombstones.lock() {
            tombstones.remove(&reference.id);
        }
    }

    fn mark_session_authoritative(
        &self,
        reference: &CredentialRef,
        value: SecretValue,
    ) -> Result<(), String> {
        if let Ok(mut tombstones) = self.linux_tombstones.lock() {
            tombstones.remove(&reference.id);
        }
        self.session_fallback.set(reference, value)
    }

    fn mark_tombstone(&self, reference: &CredentialRef) {
        let _ = self.session_fallback.delete(reference);
        if let Ok(mut tombstones) = self.linux_tombstones.lock() {
            tombstones.insert(reference.id.clone());
        }
    }

    fn local_overlay_for(&self, reference: &CredentialRef) -> LinuxLocalOverlay {
        let tombstoned = self
            .linux_tombstones
            .lock()
            .map(|tombstones| tombstones.contains(&reference.id))
            .unwrap_or(false);
        if tombstoned {
            return LinuxLocalOverlay::Tombstone;
        }
        match self.session_fallback.get(reference) {
            Ok(Some(_)) => LinuxLocalOverlay::SessionAuthoritative,
            _ => LinuxLocalOverlay::None,
        }
    }

    /// Linux dual-store: OS keyring with session overlay + tombstones.
    /// Session fallback values are authoritative until a durable OS write/delete clears local state.
    /// Missing-entry delete remains idempotent success; operational OS delete fails without durable claim.
    #[cfg(target_os = "linux")]
    fn set_linux(&self, reference: &CredentialRef, value: SecretValue) -> Result<(), String> {
        let os_observation = match self.entry(reference) {
            Ok(entry) => match entry.set_password(value.expose()) {
                Ok(()) => LinuxOsWriteObservation::Success,
                Err(_error) => LinuxOsWriteObservation::OperationalFailure,
            },
            Err(_error) => LinuxOsWriteObservation::OperationalFailure,
        };
        match linux_reconcile_set(os_observation) {
            LinuxSetDecision::DurableClearLocal => {
                self.clear_local_overlay(reference);
                Ok(())
            }
            LinuxSetDecision::SessionAuthoritative => {
                self.mark_session_authoritative(reference, value)
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn get_linux(&self, reference: &CredentialRef) -> Result<Option<SecretValue>, String> {
        let overlay = self.local_overlay_for(reference);
        // Short-circuit local authority before consulting OS (avoids write-shadow / resurrection).
        // Local overlay is authoritative: session value wins; tombstone suppresses OS entirely.
        match linux_reconcile_get(overlay, LinuxOsGetObservation::Present) {
            LinuxGetDecision::UseSession => return self.session_fallback.get(reference),
            LinuxGetDecision::SuppressedNone => return Ok(None),
            LinuxGetDecision::UseOs | LinuxGetDecision::Missing => {}
        }

        let os_observation = match self.entry(reference) {
            Ok(entry) => match entry.get_password() {
                Ok(value) => {
                    return Ok(Some(SecretValue::new(value)));
                }
                Err(error) if is_missing_credential_error(&error.to_string()) => {
                    LinuxOsGetObservation::Missing
                }
                Err(_error) => LinuxOsGetObservation::OperationalFailure,
            },
            Err(_error) => LinuxOsGetObservation::OperationalFailure,
        };
        match linux_reconcile_get(LinuxLocalOverlay::None, os_observation) {
            LinuxGetDecision::UseOs => Ok(None), // present handled above
            LinuxGetDecision::UseSession => self.session_fallback.get(reference),
            LinuxGetDecision::SuppressedNone | LinuxGetDecision::Missing => Ok(None),
        }
    }

    #[cfg(target_os = "linux")]
    fn delete_linux(&self, reference: &CredentialRef) -> Result<(), String> {
        let os_observation = match self.entry(reference) {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) => LinuxOsDeleteObservation::DeletedOrMissing,
                Err(error) if is_missing_credential_error(&error.to_string()) => {
                    LinuxOsDeleteObservation::DeletedOrMissing
                }
                Err(_error) => LinuxOsDeleteObservation::OperationalFailure,
            },
            // Cannot reach durable storage → same as operational failure (tombstone, no success claim).
            Err(_error) => LinuxOsDeleteObservation::OperationalFailure,
        };
        match linux_reconcile_delete(os_observation) {
            LinuxDeleteDecision::DurableClearLocal => {
                self.clear_local_overlay(reference);
                Ok(())
            }
            LinuxDeleteDecision::TombstoneAndFail => {
                self.mark_tombstone(reference);
                // Generic failure only — never raw keyring errors or secret material.
                Err(
                    "credential store delete failed: secret could not be removed from durable storage"
                        .to_string(),
                )
            }
        }
    }
}

impl SecretStore for OsCredentialStore {
    fn set(&self, reference: &CredentialRef, value: SecretValue) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            return self.set_linux(reference, value);
        }

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            return self
                .entry(reference)?
                .set_password(value.expose())
                .map_err(|error| format!("credential store write failed: {error}"));
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            self.session_fallback.set(reference, value)
        }
    }

    fn get(&self, reference: &CredentialRef) -> Result<Option<SecretValue>, String> {
        #[cfg(target_os = "linux")]
        {
            return self.get_linux(reference);
        }

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            return match self.entry(reference)?.get_password() {
                Ok(value) => Ok(Some(SecretValue::new(value))),
                Err(error) if is_missing_credential_error(&error.to_string()) => Ok(None),
                Err(error) => Err(format!("credential store read failed: {error}")),
            };
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            self.session_fallback.get(reference)
        }
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            return self.delete_linux(reference);
        }

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            // Missing-entry delete is idempotent success (matches Linux/session), so
            // ConfigCommitted cleanup retries and rollback of already-gone candidates succeed.
            return match self.entry(reference)?.delete_credential() {
                Ok(()) => Ok(()),
                Err(error) if is_missing_credential_error(&error.to_string()) => Ok(()),
                Err(error) => Err(format!("credential store delete failed: {error}")),
            };
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            self.session_fallback.delete(reference)
        }
    }
}

fn is_missing_credential_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("not found") || lower.contains("no matching") || lower.contains("no entry")
}

/// Pure classifier: missing-entry vs operational keyring failure (Linux fallback decisions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyringErrorClass {
    MissingEntry,
    OperationalFailure,
}

pub fn classify_keyring_error(error: &str) -> KeyringErrorClass {
    if is_missing_credential_error(error) {
        KeyringErrorClass::MissingEntry
    } else {
        KeyringErrorClass::OperationalFailure
    }
}

/// Linux get/set/delete: operational failures use session fallback; missing is not an error.
pub fn linux_keyring_should_use_session_fallback(error: &str) -> bool {
    matches!(
        classify_keyring_error(error),
        KeyringErrorClass::OperationalFailure
    )
}

/// Local dual-store overlay for a credential id (Linux reconciliation policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxLocalOverlay {
    /// No local state; OS keyring is consulted.
    None,
    /// Session holds the authoritative secret (OS may still hold a stale value).
    SessionAuthoritative,
    /// Delete was requested; suppress any OS value until durable OS write/delete clears local state.
    Tombstone,
}

/// Observed OS keyring get outcome (no secret material).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxOsGetObservation {
    Present,
    Missing,
    OperationalFailure,
}

/// Observed OS keyring write outcome (no secret material).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxOsWriteObservation {
    Success,
    OperationalFailure,
}

/// Observed OS keyring delete outcome (no secret material).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxOsDeleteObservation {
    /// Deleted successfully or already missing (idempotent durable success).
    DeletedOrMissing,
    OperationalFailure,
}

/// Get decision after reconciling local overlay with OS observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxGetDecision {
    /// Return the session overlay secret (caller must have one).
    UseSession,
    /// Return None; do not surface an OS secret for this id.
    SuppressedNone,
    /// Return the OS secret.
    UseOs,
    /// No secret available.
    Missing,
}

/// Set decision after an OS write attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxSetDecision {
    /// OS write durable; clear session value and tombstone for this id.
    DurableClearLocal,
    /// Keep secret only in session; authoritative over any stale OS value.
    SessionAuthoritative,
}

/// Delete decision after an OS delete attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxDeleteDecision {
    /// Durable delete (or missing); clear all local state and report success.
    DurableClearLocal,
    /// OS may still hold the secret; tombstone id, clear session value, report failure.
    TombstoneAndFail,
}

/// Session fallback is authoritative when present; tombstones suppress OS resurrection.
pub fn linux_reconcile_get(
    overlay: LinuxLocalOverlay,
    os: LinuxOsGetObservation,
) -> LinuxGetDecision {
    match overlay {
        LinuxLocalOverlay::SessionAuthoritative => LinuxGetDecision::UseSession,
        LinuxLocalOverlay::Tombstone => LinuxGetDecision::SuppressedNone,
        LinuxLocalOverlay::None => match os {
            LinuxOsGetObservation::Present => LinuxGetDecision::UseOs,
            LinuxOsGetObservation::Missing | LinuxOsGetObservation::OperationalFailure => {
                LinuxGetDecision::Missing
            }
        },
    }
}

pub fn linux_reconcile_set(os: LinuxOsWriteObservation) -> LinuxSetDecision {
    match os {
        LinuxOsWriteObservation::Success => LinuxSetDecision::DurableClearLocal,
        LinuxOsWriteObservation::OperationalFailure => LinuxSetDecision::SessionAuthoritative,
    }
}

pub fn linux_reconcile_delete(os: LinuxOsDeleteObservation) -> LinuxDeleteDecision {
    match os {
        LinuxOsDeleteObservation::DeletedOrMissing => LinuxDeleteDecision::DurableClearLocal,
        LinuxOsDeleteObservation::OperationalFailure => LinuxDeleteDecision::TombstoneAndFail,
    }
}

/// Next local overlay after applying a set decision.
pub fn linux_overlay_after_set(decision: LinuxSetDecision) -> LinuxLocalOverlay {
    match decision {
        LinuxSetDecision::DurableClearLocal => LinuxLocalOverlay::None,
        LinuxSetDecision::SessionAuthoritative => LinuxLocalOverlay::SessionAuthoritative,
    }
}

/// Next local overlay after applying a delete decision.
pub fn linux_overlay_after_delete(decision: LinuxDeleteDecision) -> LinuxLocalOverlay {
    match decision {
        LinuxDeleteDecision::DurableClearLocal => LinuxLocalOverlay::None,
        LinuxDeleteDecision::TombstoneAndFail => LinuxLocalOverlay::Tombstone,
    }
}

/// Project non-secret `credential_session_only` onto a public connection.
/// True only when the active credential id is held in the process session layer.
pub fn apply_public_credential_session_flag(
    connection: &mut PublicConnectionConfig,
    store: &OsCredentialStore,
) {
    connection.credential_session_only =
        match (connection.auth_mode, connection.credential_ref.as_ref()) {
            (AuthMode::None, _) | (_, None) => false,
            (_, Some(reference)) => store.credential_is_session_only(reference),
        };
}

/// Managed auth/transport names plus RFC hop-by-hop headers that must not be
/// set via custom BYOK headers (case-insensitive).
const DENIED_CUSTOM_HEADER_NAMES: &[&str] = &[
    // Managed authorization / cookie / host material
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "host",
    "content-length",
    // Provider-managed request transport (set by the HTTP client / Anthropic path)
    "content-type",
    "anthropic-version",
    // RFC hop-by-hop / transport
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
    "proxy-authenticate",
];

pub fn validate_custom_header_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
    {
        return Err("invalid custom header name".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    if DENIED_CUSTOM_HEADER_NAMES.contains(&lower.as_str()) || lower.starts_with("x-api-key") {
        return Err("managed authorization or transport header cannot be overridden".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn capability_identity(
    config: &PublicConnectionConfig,
    secret: Option<&SecretValue>,
) -> CapabilityIdentity {
    CapabilityIdentity::from_connection(
        config.provider,
        &config.endpoint,
        &config.model,
        config.mode,
        config.auth_mode,
        config.custom_header_name.as_deref(),
        secret.map(SecretValue::expose),
    )
}

/// Exact match between a stored Ready digest and the current stored connection fingerprint.
pub fn capability_identity_matches(
    stored_digest: &str,
    config: &PublicConnectionConfig,
    secret: Option<&SecretValue>,
) -> bool {
    !stored_digest.is_empty() && capability_identity(config, secret).digest == stored_digest
}

/// Project non-secret `identity_matches` onto a public connection.
///
/// When AI is disabled, compatibility paths must keep `identity_matches=false` and must not
/// require a credential-store secret even if a stale `credential_ref` remains.
pub fn apply_public_identity_matches(
    connection: &mut PublicConnectionConfig,
    secret: Option<&SecretValue>,
) {
    if connection.capability.is_none() {
        return;
    }
    if !connection.enabled {
        if let Some(capability) = connection.capability.as_mut() {
            capability.identity_matches = false;
        }
        return;
    }
    // Snapshot identity fields first so the match computation only needs shared borrows.
    let (digest, ready) = {
        let capability = connection
            .capability
            .as_ref()
            .expect("capability presence checked above");
        (
            capability.identity_digest.clone(),
            capability.state == crate::ai::provider::CapabilityState::Ready,
        )
    };
    let matches = ready && capability_identity_matches(&digest, connection, secret);
    if let Some(capability) = connection.capability.as_mut() {
        capability.identity_matches = matches;
    }
}

/// True when settings/preflight may read the credential store for identity projection.
/// Disabled AI is a true compatibility path: zero keyring work for settings reads.
pub fn may_read_credential_store_for_settings(connection: &PublicConnectionConfig) -> bool {
    connection.enabled
}

/// Pure plan for credential-pointer + optional secret write during settings save.
///
/// New secrets always target a unique candidate reference so a failed config switch never
/// deletes or overwrites the previously active secret in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSecretWritePlan {
    /// Credential id that should be stored in public config after a successful switch.
    pub next_ref_id: Option<String>,
    /// Present only when this call created a new secret entry eligible for rollback delete.
    pub rollback_candidate_id: Option<String>,
    /// After the new config is successfully persisted, best-effort delete this previous secret.
    /// Set for `AuthMode::None` (orphan clear) and for successful rotation away from the old id.
    pub delete_after_success_id: Option<String>,
}

/// Decide next credential pointer and whether a candidate secret may be rolled back.
///
/// - `AuthMode::None` clears the pointer, never writes a secret, and schedules old-secret cleanup
///   only after a successful config persist (never on pre-switch failure).
/// - When a new secret is provided, always allocate `unique_candidate_id` (never in-place replace).
/// - When a caller-supplied candidate equals the active `old_ref_id`, reject with an error so
///   rollback/cleanup cannot overwrite or delete the live secret under the same id.
/// - When no secret is provided, keep the explicit connection ref or the previous active ref.
pub fn plan_credential_secret_write(
    auth_mode: AuthMode,
    old_ref_id: Option<String>,
    connection_ref_id: Option<String>,
    secret_provided: bool,
    unique_candidate_id: impl Into<String>,
) -> Result<CredentialSecretWritePlan, String> {
    if auth_mode == AuthMode::None {
        return Ok(CredentialSecretWritePlan {
            next_ref_id: None,
            rollback_candidate_id: None,
            // Clear orphan only after successful switch; pre-switch failure keeps old secret.
            delete_after_success_id: old_ref_id,
        });
    }

    if secret_provided {
        let candidate = unique_candidate_id.into();
        // Plan-level defense: never treat the active ref as a disposable candidate.
        // (Caller-supplied collisions used to set rollback_candidate_id == old_ref, so pre-switch
        // rollback deleted the live secret and delete_after_success_id was cleared.)
        if old_ref_id.as_ref() == Some(&candidate) {
            return Err(format!(
                "credential candidate id collides with active ref; refusing overwrite/rollback of active secret ({candidate})"
            ));
        }
        return Ok(CredentialSecretWritePlan {
            next_ref_id: Some(candidate.clone()),
            rollback_candidate_id: Some(candidate),
            // Candidate is distinct from old when present; schedule old cleanup after switch.
            delete_after_success_id: old_ref_id,
        });
    }

    let next_ref_id = connection_ref_id.or(old_ref_id.clone());
    let delete_after_success_id = previous_secret_to_delete_after_successful_switch(
        old_ref_id.as_deref(),
        next_ref_id.as_deref(),
    );
    Ok(CredentialSecretWritePlan {
        next_ref_id,
        rollback_candidate_id: None,
        delete_after_success_id,
    })
}

/// Pure helper: which previous secret id (if any) should be deleted after config switch succeeds.
///
/// - Switch to no credential (`next` is `None`) → delete `old` when present (`AuthMode::None`).
/// - Rotation to a different id → delete `old` when it differs from `next`.
/// - Same id kept → delete nothing (rollback path never reaches this on failure either).
pub fn previous_secret_to_delete_after_successful_switch(
    old_ref_id: Option<&str>,
    next_ref_id: Option<&str>,
) -> Option<String> {
    match (old_ref_id, next_ref_id) {
        (Some(old), Some(next)) if old != next => Some(old.to_string()),
        (Some(old), None) => Some(old.to_string()),
        _ => None,
    }
}

/// Delete only a candidate secret that this save call newly created. Never touches the old active id.
pub fn rollback_credential_candidate(
    store: &impl SecretStore,
    plan: &CredentialSecretWritePlan,
) -> Result<(), String> {
    if let Some(id) = plan.rollback_candidate_id.as_ref() {
        store.delete(&CredentialRef { id: id.clone() })?;
    }
    Ok(())
}

/// Pre-switch failure after a candidate may exist: clear the journal only when candidate
/// rollback is confirmed. If delete cannot be confirmed, retain a recoverable
/// `CandidateStored` journal for startup recovery and return `Err`.
///
/// Never discards a rollback error and then clears the journal (that would orphan the candidate).
pub fn rollback_candidate_or_retain_journal(
    store: &impl SecretStore,
    plan: &CredentialSecretWritePlan,
    journal_path: &Path,
    journal: &CredentialRotationJournal,
) -> Result<(), String> {
    match rollback_credential_candidate(store, plan) {
        Ok(()) => {
            // Candidate confirmed gone (or none planned). Safe to drop the journal.
            clear_credential_journal(journal_path)?;
            Ok(())
        }
        Err(error) => {
            // Candidate may still exist. Keep a phase startup recovery can process.
            let retain = journal
                .clone()
                .with_phase(CredentialJournalPhase::CandidateStored);
            // Best-effort phase write; even a Prepared journal with candidate_ref recovers.
            let _ = write_credential_journal(journal_path, &retain);
            Err(format!(
                "credential candidate rollback unconfirmed; journal retained for recovery: {error}"
            ))
        }
    }
}

/// After successful config persist, delete the previous active secret when planned.
/// Never called on pre-switch failure (rollback keeps the old secret).
/// Missing-entry deletes are success; operational store failures propagate so the
/// durable rotation journal can retain ConfigCommitted for startup retry.
pub fn cleanup_previous_secret_after_success(
    store: &impl SecretStore,
    plan: &CredentialSecretWritePlan,
) -> Result<(), String> {
    if let Some(id) = plan.delete_after_success_id.as_ref() {
        store.delete(&CredentialRef { id: id.clone() })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Crash-consistent credential rotation journal (non-secret, app-local, atomic)
// ---------------------------------------------------------------------------

/// On-disk schema version for [`CredentialRotationJournal`].
pub const CREDENTIAL_JOURNAL_VERSION: u32 = 1;

/// Default TTL for an in-flight rotation journal (7 days).
pub const CREDENTIAL_JOURNAL_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Filename under the app data directory (never stores secret material).
pub const CREDENTIAL_JOURNAL_FILE_NAME: &str = "ai_credential_rotation_journal.json";

/// Durable phases of a credential rotation transaction.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialJournalPhase {
    /// Journal written before any candidate secret is stored.
    Prepared,
    /// Candidate secret is in the store; config pointer not yet switched.
    CandidateStored,
    /// AIConfig pointer switched to next generation; old cleanup may still be pending.
    ConfigCommitted,
}

/// Redacted, non-secret settings snapshot for audit / recovery correlation.
/// Never includes `SecretValue`, raw keys, or keyring payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CredentialJournalSettingsMetadata {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub auth_mode: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: String,
}

/// App-local durable journal for one in-flight credential rotation.
///
/// Bytes on disk are intentionally non-secret: only credential *refs* (ids),
/// phase, TTL, and redacted connection metadata. Never serialize `SecretValue`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialRotationJournal {
    pub version: u32,
    pub phase: CredentialJournalPhase,
    /// New secret id created by this rotation (if any).
    #[serde(default)]
    pub candidate_ref: Option<String>,
    /// Previously active credential id (cleanup target after commit).
    #[serde(default)]
    pub old_ref: Option<String>,
    /// Credential id the config pointer should hold after a successful switch.
    #[serde(default)]
    pub next_ref: Option<String>,
    pub created_at_unix: u64,
    pub expires_at_unix: u64,
    #[serde(default)]
    pub settings_metadata: CredentialJournalSettingsMetadata,
}

impl CredentialRotationJournal {
    /// Build a `Prepared` journal from a write plan and redacted metadata.
    pub fn prepare(
        plan: &CredentialSecretWritePlan,
        metadata: CredentialJournalSettingsMetadata,
        now_unix: u64,
        ttl_secs: u64,
    ) -> Self {
        Self {
            version: CREDENTIAL_JOURNAL_VERSION,
            phase: CredentialJournalPhase::Prepared,
            candidate_ref: plan.rollback_candidate_id.clone(),
            old_ref: plan.delete_after_success_id.clone(),
            next_ref: plan.next_ref_id.clone(),
            created_at_unix: now_unix,
            expires_at_unix: now_unix.saturating_add(ttl_secs),
            settings_metadata: metadata,
        }
    }

    pub fn is_expired(&self, now_unix: u64) -> bool {
        now_unix > self.expires_at_unix
    }

    pub fn with_phase(mut self, phase: CredentialJournalPhase) -> Self {
        self.phase = phase;
        self
    }
}

/// Recovery decision derived from journal + current config pointer (fail closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialJournalRecoveryAction {
    /// Config still on old / not on next: delete only this journal's candidate, clear journal.
    RollbackCandidate,
    /// Config points at next/candidate: keep candidate, finish old cleanup, clear journal.
    FinishCommittedCleanup,
    /// Config generation is unrelated: clear journal without deleting active secrets.
    ClearJournalOnly,
}

/// True when the live config credential pointer matches the journal's next generation.
///
/// `AuthMode::None` commits with `next_ref = None`; that matches only when the live
/// config also has no credential ref (and the journal recorded an old ref or commit).
pub fn config_points_to_journal_next(
    active_ref: Option<&str>,
    journal: &CredentialRotationJournal,
) -> bool {
    match journal.next_ref.as_deref() {
        Some(next) => active_ref == Some(next),
        None => {
            // Clearing credentials: treat as committed next-gen when config has no ref
            // and this journal intended a clear (old present) or already marked committed.
            active_ref.is_none()
                && (journal.old_ref.is_some()
                    || matches!(journal.phase, CredentialJournalPhase::ConfigCommitted))
        }
    }
}

/// Decide idempotent recovery for a durable rotation journal.
///
/// Config pointer is authoritative over phase. Expired journals still reconcile
/// against the live pointer (TTL does not orphan a committed next secret).
pub fn decide_credential_journal_recovery(
    journal: &CredentialRotationJournal,
    active_ref: Option<&str>,
    _now_unix: u64,
) -> CredentialJournalRecoveryAction {
    // Successful pointer switch (or None-mode clear): finish old cleanup.
    if config_points_to_journal_next(active_ref, journal) {
        return CredentialJournalRecoveryAction::FinishCommittedCleanup;
    }

    // Live config holds this journal's candidate even if phase lagged (crash after
    // config save but before ConfigCommitted phase write).
    if let (Some(active), Some(candidate)) = (active_ref, journal.candidate_ref.as_deref()) {
        if active == candidate {
            return CredentialJournalRecoveryAction::FinishCommittedCleanup;
        }
    }

    // Unrelated generation: active is neither old, next, nor candidate.
    if let Some(active) = active_ref {
        let is_old = journal.old_ref.as_deref() == Some(active);
        let is_next = journal.next_ref.as_deref() == Some(active);
        let is_candidate = journal.candidate_ref.as_deref() == Some(active);
        if !is_old && !is_next && !is_candidate {
            return CredentialJournalRecoveryAction::ClearJournalOnly;
        }
    }

    // Config still on old (or missing next): remove only this rotation's candidate.
    CredentialJournalRecoveryAction::RollbackCandidate
}

/// Resolve the journal path under an app-local data directory.
pub fn credential_journal_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CREDENTIAL_JOURNAL_FILE_NAME)
}

/// Load a journal from disk. Missing file → `Ok(None)`. Corrupt JSON → error (fail closed).
pub fn load_credential_journal(path: &Path) -> Result<Option<CredentialRotationJournal>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(path)
        .map_err(|error| format!("credential journal read failed: {error}"))?;
    if data.trim().is_empty() {
        return Ok(None);
    }
    let journal: CredentialRotationJournal = serde_json::from_str(&data)
        .map_err(|error| format!("credential journal parse failed: {error}"))?;
    if journal.version != CREDENTIAL_JOURNAL_VERSION {
        return Err(format!(
            "credential journal version unsupported: {}",
            journal.version
        ));
    }
    Ok(Some(journal))
}

/// Atomically persist a non-secret journal (temp write + replace).
pub fn write_credential_journal(
    path: &Path,
    journal: &CredentialRotationJournal,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("credential journal dir create failed: {error}"))?;
    }
    let data = serde_json::to_string_pretty(journal)
        .map_err(|error| format!("credential journal serialize failed: {error}"))?;
    // Atomic replace so a crash cannot leave a truncated journal as the only copy.
    write_text_file_atomically(path, &data)
}

/// Remove the journal file (idempotent).
pub fn clear_credential_journal(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("credential journal clear failed: {error}")),
    }
}

/// Apply a recovery decision against the secret store and journal file.
///
/// Idempotent and fail closed: never deletes the live active secret; never rewrites config.
/// Returns whether the journal was cleared (cleanup may leave it for retry).
pub fn apply_credential_journal_recovery(
    store: &impl SecretStore,
    path: &Path,
    journal: &CredentialRotationJournal,
    active_ref: Option<&str>,
    now_unix: u64,
) -> Result<CredentialJournalRecoveryAction, String> {
    let action = decide_credential_journal_recovery(journal, active_ref, now_unix);
    match action {
        CredentialJournalRecoveryAction::RollbackCandidate => {
            if let Some(candidate_id) = journal.candidate_ref.as_ref() {
                // Never delete the currently active ref (fail closed).
                if active_ref != Some(candidate_id.as_str()) {
                    // Propagate operational delete failures so the journal is retained for retry.
                    store.delete(&CredentialRef {
                        id: candidate_id.clone(),
                    })?;
                }
            }
            clear_credential_journal(path)?;
        }
        CredentialJournalRecoveryAction::FinishCommittedCleanup => {
            if let Some(old_id) = journal.old_ref.as_ref() {
                // Never delete the live active secret if it still equals old (should not
                // happen when config_points_to_journal_next, but guard anyway).
                if active_ref != Some(old_id.as_str()) {
                    if let Err(error) = store.delete(&CredentialRef { id: old_id.clone() }) {
                        // Keep journal so the next startup can retry old cleanup.
                        return Err(error);
                    }
                }
            }
            clear_credential_journal(path)?;
        }
        CredentialJournalRecoveryAction::ClearJournalOnly => {
            clear_credential_journal(path)?;
        }
    }
    Ok(action)
}

/// True when a write plan needs a durable rotation journal.
pub fn credential_write_plan_needs_journal(plan: &CredentialSecretWritePlan) -> bool {
    plan.rollback_candidate_id.is_some() || plan.delete_after_success_id.is_some()
}

/// Before writing a new rotation journal, reconcile any existing journal against the
/// live config pointer (fail closed). Prevents overwriting a prior `ConfigCommitted`
/// cleanup record with a new `Prepared` journal.
///
/// Returns `Ok(None)` when no journal exists, `Ok(Some(action))` after successful
/// recovery, and `Err` when existing recovery cannot complete (caller must not start
/// a new rotation).
pub fn reconcile_existing_credential_journal_before_new(
    store: &impl SecretStore,
    path: &Path,
    active_ref: Option<&str>,
    now_unix: u64,
) -> Result<Option<CredentialJournalRecoveryAction>, String> {
    let Some(existing) = load_credential_journal(path)? else {
        return Ok(None);
    };
    let action = apply_credential_journal_recovery(store, path, &existing, active_ref, now_unix)?;
    Ok(Some(action))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::to_string;

    #[test]
    fn secret_value_does_not_serialize_or_debug_in_plaintext() {
        let secret = SecretValue::new("sk-test-secret");
        assert!(!format!("{secret:?}").contains("sk-test-secret"));
        assert!(to_string(&PublicConnectionConfig::default())
            .unwrap()
            .contains("enabled"));
    }

    #[test]
    fn custom_headers_reject_managed_names_and_controls() {
        assert!(validate_custom_header_name("Authorization").is_err());
        assert!(validate_custom_header_name("X-Trace\nId").is_err());
        assert_eq!(
            validate_custom_header_name("X-Request-Id").unwrap(),
            "X-Request-Id"
        );
    }

    #[test]
    fn custom_headers_reject_proxy_auth_and_hop_by_hop_names() {
        // Case-insensitive denylist for proxy-auth and RFC hop-by-hop/transport names.
        for name in [
            "Proxy-Authorization",
            "proxy-authorization",
            "Connection",
            "Keep-Alive",
            "Proxy-Connection",
            "TE",
            "Trailer",
            "Transfer-Encoding",
            "Upgrade",
            "Via",
            "Proxy-Authenticate",
            // Existing managed names remain denied
            "Cookie",
            "Set-Cookie",
            "Host",
            "Content-Length",
            "X-Api-Key",
            "x-api-key-extra",
        ] {
            assert!(
                validate_custom_header_name(name).is_err(),
                "expected denial for header {name}"
            );
        }
        // Benign custom headers still allowed.
        assert_eq!(
            validate_custom_header_name("X-Request-Id").unwrap(),
            "X-Request-Id"
        );
        assert_eq!(
            validate_custom_header_name("X-Client-Trace").unwrap(),
            "X-Client-Trace"
        );
    }

    #[test]
    fn custom_headers_reject_provider_managed_content_type_and_anthropic_version() {
        // Provider HTTP stack sets content-type; Anthropic path sets anthropic-version.
        // Custom BYOK headers must not override either (case-insensitive).
        for name in [
            "content-type",
            "Content-Type",
            "CONTENT-TYPE",
            "anthropic-version",
            "Anthropic-Version",
            "ANTHROPIC-VERSION",
        ] {
            assert!(
                validate_custom_header_name(name).is_err(),
                "expected denial for provider-managed header {name}"
            );
        }
        // Adjacent / benign names remain allowed.
        assert_eq!(
            validate_custom_header_name("X-Request-Id").unwrap(),
            "X-Request-Id"
        );
        assert_eq!(
            validate_custom_header_name("X-Content-Type-Options").unwrap(),
            "X-Content-Type-Options"
        );
        assert_eq!(
            validate_custom_header_name("X-Anthropic-Beta").unwrap(),
            "X-Anthropic-Beta"
        );
    }

    #[test]
    fn session_store_replaces_and_deletes_without_serializing_values() {
        let store = SessionSecretStore::new();
        let reference = CredentialRef { id: "one".into() };
        store.set(&reference, SecretValue::new("value")).unwrap();
        assert_eq!(store.get(&reference).unwrap().unwrap().expose(), "value");
        store.delete(&reference).unwrap();
        assert!(store.get(&reference).unwrap().is_none());
    }

    #[test]
    fn capability_identity_match_requires_exact_digest() {
        let config = PublicConnectionConfig {
            provider: ProviderKind::OpenAi,
            endpoint: "https://example.test/v1".into(),
            model: "m".into(),
            mode: ProviderMode::Chat,
            auth_mode: AuthMode::Bearer,
            custom_header_name: None,
            credential_ref: Some(CredentialRef { id: "c1".into() }),
            enabled: true,
            capability: None,
            discovered_models: Vec::new(),
            models_fetched_at_unix: None,
            credential_session_only: false,
        };
        let secret = SecretValue::new("sk-one");
        let digest = capability_identity(&config, Some(&secret)).digest;
        assert!(capability_identity_matches(&digest, &config, Some(&secret)));
        assert!(!capability_identity_matches(
            &digest,
            &config,
            Some(&SecretValue::new("sk-two"))
        ));
        assert!(!capability_identity_matches("", &config, Some(&secret)));
    }

    #[test]
    fn disabled_settings_path_skips_secret_and_forces_identity_matches_false() {
        let secret = SecretValue::new("sk-stale");
        let mut connection = PublicConnectionConfig {
            provider: ProviderKind::OpenAi,
            endpoint: "https://example.test/v1".into(),
            model: "m".into(),
            mode: ProviderMode::Chat,
            auth_mode: AuthMode::Bearer,
            custom_header_name: None,
            // Stale credential pointer may remain after disable.
            credential_ref: Some(CredentialRef {
                id: "stale-cred".into(),
            }),
            enabled: false,
            capability: Some(PublicCapabilityStatus {
                state: crate::ai::provider::CapabilityState::Ready,
                identity_digest: capability_identity(
                    &PublicConnectionConfig {
                        enabled: true,
                        credential_ref: Some(CredentialRef {
                            id: "stale-cred".into(),
                        }),
                        provider: ProviderKind::OpenAi,
                        endpoint: "https://example.test/v1".into(),
                        model: "m".into(),
                        mode: ProviderMode::Chat,
                        auth_mode: AuthMode::Bearer,
                        custom_header_name: None,
                        capability: None,
                        discovered_models: Vec::new(),
                        models_fetched_at_unix: None,
                        credential_session_only: false,
                    },
                    Some(&secret),
                )
                .digest,
                resolved_mode: Some(ProviderMode::Chat),
                message: "stale ready".into(),
                probed_at_unix: Some(1),
                // Would be true if a secret were incorrectly read while disabled.
                identity_matches: true,
            }),
            discovered_models: Vec::new(),
            models_fetched_at_unix: None,
            credential_session_only: false,
        };

        assert!(!may_read_credential_store_for_settings(&connection));
        // Callers must not resolve secrets when this is false; projection still clears matches.
        apply_public_identity_matches(&mut connection, None);
        assert_eq!(
            connection.capability.as_ref().map(|c| c.identity_matches),
            Some(false)
        );

        // Even if a secret is mistakenly supplied, disabled stays non-matching.
        apply_public_identity_matches(&mut connection, Some(&secret));
        assert_eq!(
            connection.capability.as_ref().map(|c| c.identity_matches),
            Some(false)
        );
    }

    #[test]
    fn failed_save_rollback_preserves_previous_active_secret() {
        let store = SessionSecretStore::new();
        let old_ref = CredentialRef {
            id: "active-connection".into(),
        };
        store
            .set(&old_ref, SecretValue::new("old-active-secret"))
            .unwrap();

        // New secret writes must use a unique candidate, never overwrite `old_ref` in place.
        let plan = plan_credential_secret_write(
            AuthMode::Bearer,
            Some(old_ref.id.clone()),
            Some(old_ref.id.clone()),
            true,
            "candidate-connection",
        )
        .expect("distinct candidate must plan");
        assert_eq!(plan.next_ref_id.as_deref(), Some("candidate-connection"));
        assert_eq!(
            plan.rollback_candidate_id.as_deref(),
            Some("candidate-connection")
        );
        assert_eq!(
            plan.delete_after_success_id.as_deref(),
            Some("active-connection")
        );
        assert_ne!(plan.rollback_candidate_id.as_ref(), Some(&old_ref.id));

        let candidate = CredentialRef {
            id: plan.rollback_candidate_id.clone().unwrap(),
        };
        store
            .set(&candidate, SecretValue::new("new-candidate-secret"))
            .unwrap();
        assert_eq!(
            store.get(&old_ref).unwrap().unwrap().expose(),
            "old-active-secret"
        );
        assert_eq!(
            store.get(&candidate).unwrap().unwrap().expose(),
            "new-candidate-secret"
        );

        // Config switch fails → delete only the candidate created by this call.
        // Do not run cleanup_previous_secret_after_success on pre-switch failure.
        rollback_credential_candidate(&store, &plan).unwrap();
        assert!(store.get(&candidate).unwrap().is_none());
        assert_eq!(
            store.get(&old_ref).unwrap().unwrap().expose(),
            "old-active-secret"
        );

        // No secret provided → keep old pointer, nothing to roll back or delete.
        let keep = plan_credential_secret_write(
            AuthMode::Bearer,
            Some(old_ref.id.clone()),
            None,
            false,
            "unused-candidate",
        )
        .expect("no-secret plan must succeed");
        assert_eq!(keep.next_ref_id.as_deref(), Some("active-connection"));
        assert!(keep.rollback_candidate_id.is_none());
        assert!(keep.delete_after_success_id.is_none());
        rollback_credential_candidate(&store, &keep).unwrap();
        assert_eq!(
            store.get(&old_ref).unwrap().unwrap().expose(),
            "old-active-secret"
        );
    }

    #[test]
    fn plan_rejects_candidate_equal_to_old_ref() {
        // High-severity defense: candidate == old_ref must not produce a plan that would
        // overwrite the active secret or schedule it as a disposable rollback candidate.
        let err = plan_credential_secret_write(
            AuthMode::Bearer,
            Some("active-connection".into()),
            Some("active-connection".into()),
            true,
            "active-connection",
        )
        .expect_err("candidate colliding with old_ref must be rejected");
        assert!(
            err.contains("collides with active ref"),
            "error should name the collision clearly: {err}"
        );
        assert!(
            err.contains("active-connection"),
            "error should mention the colliding id without embedding secret material: {err}"
        );

        // AuthMode::None still ignores the candidate id entirely (even when equal to old_ref).
        let none_plan = plan_credential_secret_write(
            AuthMode::None,
            Some("active-connection".into()),
            Some("active-connection".into()),
            true,
            "active-connection",
        )
        .expect("AuthMode::None must ignore candidate collision");
        assert!(none_plan.next_ref_id.is_none());
        assert!(none_plan.rollback_candidate_id.is_none());
        assert_eq!(
            none_plan.delete_after_success_id.as_deref(),
            Some("active-connection")
        );

        // No-secret path keeps previous semantics and does not consume the candidate id.
        let keep = plan_credential_secret_write(
            AuthMode::Bearer,
            Some("active-connection".into()),
            None,
            false,
            "active-connection",
        )
        .expect("no-secret plan ignores candidate id");
        assert_eq!(keep.next_ref_id.as_deref(), Some("active-connection"));
        assert!(keep.rollback_candidate_id.is_none());
        assert!(keep.delete_after_success_id.is_none());
    }

    #[test]
    fn auth_mode_none_never_creates_candidate_and_clears_old_after_success() {
        let store = SessionSecretStore::new();
        let old_ref = CredentialRef {
            id: "was-active".into(),
        };
        store
            .set(&old_ref, SecretValue::new("orphan-risk-secret"))
            .unwrap();

        let plan = plan_credential_secret_write(
            AuthMode::None,
            Some(old_ref.id.clone()),
            Some(old_ref.id.clone()),
            true, // even if a secret string is present, None mode ignores it
            "must-not-be-used",
        )
        .expect("AuthMode::None plan must succeed");
        assert!(plan.next_ref_id.is_none());
        assert!(plan.rollback_candidate_id.is_none());
        assert_eq!(plan.delete_after_success_id.as_deref(), Some("was-active"));

        // Pre-switch failure: rollback is a no-op for None; old secret remains.
        rollback_credential_candidate(&store, &plan).unwrap();
        assert_eq!(
            store.get(&old_ref).unwrap().unwrap().expose(),
            "orphan-risk-secret"
        );

        // Successful switch: clear previous active secret so it is not an orphan.
        cleanup_previous_secret_after_success(&store, &plan).unwrap();
        assert!(store.get(&old_ref).unwrap().is_none());
    }

    #[test]
    fn previous_secret_delete_helper_covers_none_and_rotation() {
        assert_eq!(
            previous_secret_to_delete_after_successful_switch(Some("old"), None).as_deref(),
            Some("old")
        );
        assert_eq!(
            previous_secret_to_delete_after_successful_switch(Some("old"), Some("new")).as_deref(),
            Some("old")
        );
        assert!(
            previous_secret_to_delete_after_successful_switch(Some("same"), Some("same")).is_none()
        );
        assert!(previous_secret_to_delete_after_successful_switch(None, None).is_none());
        assert!(previous_secret_to_delete_after_successful_switch(None, Some("new")).is_none());
    }

    #[test]
    fn keyring_error_classification_distinguishes_missing_from_operational() {
        assert_eq!(
            classify_keyring_error("No matching entry found in secure storage"),
            KeyringErrorClass::MissingEntry
        );
        assert_eq!(
            classify_keyring_error("secret service not available"),
            KeyringErrorClass::OperationalFailure
        );
        assert!(linux_keyring_should_use_session_fallback(
            "DBus connection refused"
        ));
        assert!(!linux_keyring_should_use_session_fallback(
            "credential not found"
        ));
    }

    #[test]
    fn credential_mutation_gate_serializes_exclusive_access() {
        let gate = CredentialMutationGate::new();
        let first = gate.lock().expect("first lock");
        // Nested lock would poison/deadlock with std Mutex; drop then re-acquire.
        drop(first);
        let second = gate.lock().expect("second lock");
        drop(second);
    }

    #[test]
    fn os_store_public_status_exposes_only_non_secret_state() {
        let store = OsCredentialStore::new("com.okpgui.test.credentials");
        let status = store.public_status();
        let encoded = to_string(&status).unwrap();
        assert!(encoded.contains("backend"));
        assert!(!encoded.contains("sk-"));
        assert!(!encoded.contains("password"));
        #[cfg(target_os = "linux")]
        {
            assert!(status.linux_session_fallback_enabled);
            assert_eq!(status.backend, CredentialStorageBackend::OsKeyring);
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            assert!(!status.linux_session_fallback_enabled);
            assert_eq!(status.backend, CredentialStorageBackend::OsKeyring);
        }
    }

    #[test]
    fn session_fallback_set_get_delete_is_consistent_zeroizing_path() {
        // Models the Linux operational-failure path: secrets live only in session store.
        let session = SessionSecretStore::new();
        let reference = CredentialRef {
            id: "linux-fallback-ref".into(),
        };
        // Missing-entry semantics before set.
        assert!(session.get(&reference).unwrap().is_none());
        session
            .set(&reference, SecretValue::new("session-only-secret"))
            .unwrap();
        assert_eq!(
            session.get(&reference).unwrap().unwrap().expose(),
            "session-only-secret"
        );
        session.delete(&reference).unwrap();
        assert!(session.get(&reference).unwrap().is_none());
        // Delete of missing remains Ok.
        session.delete(&reference).unwrap();
    }

    #[test]
    fn linux_write_shadow_session_is_authoritative_over_stale_os() {
        // After an OS write failure, session holds the new secret while OS may still have stale.
        let set_decision = linux_reconcile_set(LinuxOsWriteObservation::OperationalFailure);
        assert_eq!(set_decision, LinuxSetDecision::SessionAuthoritative);
        let overlay = linux_overlay_after_set(set_decision);
        assert_eq!(overlay, LinuxLocalOverlay::SessionAuthoritative);
        // Stale OS Present must not shadow the session value.
        assert_eq!(
            linux_reconcile_get(overlay, LinuxOsGetObservation::Present),
            LinuxGetDecision::UseSession
        );
        assert_eq!(
            linux_reconcile_get(overlay, LinuxOsGetObservation::Missing),
            LinuxGetDecision::UseSession
        );
    }

    #[test]
    fn linux_delete_failure_tombstones_and_blocks_os_resurrection() {
        let decision = linux_reconcile_delete(LinuxOsDeleteObservation::OperationalFailure);
        assert_eq!(decision, LinuxDeleteDecision::TombstoneAndFail);
        // Must not claim durable success — caller reports Err after tombstone.
        let overlay = linux_overlay_after_delete(decision);
        assert_eq!(overlay, LinuxLocalOverlay::Tombstone);
        // When Secret Service recovers, OS Present must still be suppressed.
        assert_eq!(
            linux_reconcile_get(overlay, LinuxOsGetObservation::Present),
            LinuxGetDecision::SuppressedNone
        );
        assert_eq!(
            linux_reconcile_get(overlay, LinuxOsGetObservation::Missing),
            LinuxGetDecision::SuppressedNone
        );
    }

    #[test]
    fn linux_missing_entry_delete_is_idempotent_and_clears_local() {
        let decision = linux_reconcile_delete(LinuxOsDeleteObservation::DeletedOrMissing);
        assert_eq!(decision, LinuxDeleteDecision::DurableClearLocal);
        assert_eq!(
            linux_overlay_after_delete(decision),
            LinuxLocalOverlay::None
        );
        // After clear, OS missing → no secret; no false suppression of a later write.
        assert_eq!(
            linux_reconcile_get(LinuxLocalOverlay::None, LinuxOsGetObservation::Missing),
            LinuxGetDecision::Missing
        );
    }

    #[test]
    fn linux_recovery_clears_tombstone_and_session_on_durable_os_ops() {
        // Tombstone after failed delete.
        let tombstoned = linux_overlay_after_delete(linux_reconcile_delete(
            LinuxOsDeleteObservation::OperationalFailure,
        ));
        assert_eq!(tombstoned, LinuxLocalOverlay::Tombstone);

        // Successful durable OS write recovers: clear local, OS becomes source of truth.
        let after_write =
            linux_overlay_after_set(linux_reconcile_set(LinuxOsWriteObservation::Success));
        assert_eq!(after_write, LinuxLocalOverlay::None);
        assert_eq!(
            linux_reconcile_get(after_write, LinuxOsGetObservation::Present),
            LinuxGetDecision::UseOs
        );

        // Successful durable OS delete also clears tombstone / session authority.
        let after_delete = linux_overlay_after_delete(linux_reconcile_delete(
            LinuxOsDeleteObservation::DeletedOrMissing,
        ));
        assert_eq!(after_delete, LinuxLocalOverlay::None);
        assert_eq!(
            linux_reconcile_get(after_delete, LinuxOsGetObservation::Missing),
            LinuxGetDecision::Missing
        );
    }

    /// In-memory dual-store model exercising the pure reconciliation policy end-to-end.
    #[derive(Default)]
    struct LinuxDualStoreModel {
        os: HashMap<String, String>,
        session: HashMap<String, String>,
        tombstones: HashSet<String>,
    }

    impl LinuxDualStoreModel {
        fn overlay(&self, id: &str) -> LinuxLocalOverlay {
            if self.tombstones.contains(id) {
                LinuxLocalOverlay::Tombstone
            } else if self.session.contains_key(id) {
                LinuxLocalOverlay::SessionAuthoritative
            } else {
                LinuxLocalOverlay::None
            }
        }

        fn set(&mut self, id: &str, value: &str, os_write_ok: bool) {
            let observation = if os_write_ok {
                LinuxOsWriteObservation::Success
            } else {
                LinuxOsWriteObservation::OperationalFailure
            };
            match linux_reconcile_set(observation) {
                LinuxSetDecision::DurableClearLocal => {
                    self.os.insert(id.to_string(), value.to_string());
                    self.session.remove(id);
                    self.tombstones.remove(id);
                }
                LinuxSetDecision::SessionAuthoritative => {
                    self.session.insert(id.to_string(), value.to_string());
                    self.tombstones.remove(id);
                    // Intentionally leave any stale OS value untouched.
                }
            }
        }

        fn get(&self, id: &str) -> Option<String> {
            let os_obs = if self.os.contains_key(id) {
                LinuxOsGetObservation::Present
            } else {
                LinuxOsGetObservation::Missing
            };
            match linux_reconcile_get(self.overlay(id), os_obs) {
                LinuxGetDecision::UseSession => self.session.get(id).cloned(),
                LinuxGetDecision::UseOs => self.os.get(id).cloned(),
                LinuxGetDecision::SuppressedNone | LinuxGetDecision::Missing => None,
            }
        }

        fn delete(&mut self, id: &str, os_delete_ok: bool) -> Result<(), ()> {
            let observation = if os_delete_ok {
                // Missing is also durable success.
                LinuxOsDeleteObservation::DeletedOrMissing
            } else {
                LinuxOsDeleteObservation::OperationalFailure
            };
            match linux_reconcile_delete(observation) {
                LinuxDeleteDecision::DurableClearLocal => {
                    self.os.remove(id);
                    self.session.remove(id);
                    self.tombstones.remove(id);
                    Ok(())
                }
                LinuxDeleteDecision::TombstoneAndFail => {
                    self.session.remove(id);
                    self.tombstones.insert(id.to_string());
                    Err(())
                }
            }
        }
    }

    #[test]
    fn linux_dual_store_model_write_shadow_delete_tombstone_and_recovery() {
        let mut store = LinuxDualStoreModel::default();
        let id = "cred-dual";

        // Durable OS write.
        store.set(id, "os-old", true);
        assert_eq!(store.get(id).as_deref(), Some("os-old"));
        assert!(!store.session.contains_key(id));

        // OS write fails → session authoritative over stale OS.
        store.set(id, "session-new", false);
        assert_eq!(store.os.get(id).map(String::as_str), Some("os-old"));
        assert_eq!(store.get(id).as_deref(), Some("session-new"));
        assert!(store.overlay(id) == LinuxLocalOverlay::SessionAuthoritative);

        // Operational delete fails: no durable success; tombstone suppresses OS resurrection.
        assert!(store.delete(id, false).is_err());
        assert_eq!(store.os.get(id).map(String::as_str), Some("os-old"));
        assert!(store.get(id).is_none());
        assert_eq!(store.overlay(id), LinuxLocalOverlay::Tombstone);

        // Recovery via durable OS delete clears tombstone.
        assert!(store.delete(id, true).is_ok());
        assert!(store.get(id).is_none());
        assert_eq!(store.overlay(id), LinuxLocalOverlay::None);
        // Idempotent missing delete.
        assert!(store.delete(id, true).is_ok());

        // Recovery via durable OS write after a later session-only path + tombstone.
        store.set(id, "os-again", true);
        assert_eq!(store.get(id).as_deref(), Some("os-again"));
        store.set(id, "sess-2", false);
        assert!(store.delete(id, false).is_err());
        assert!(store.get(id).is_none());
        store.set(id, "os-recovered", true);
        assert_eq!(store.overlay(id), LinuxLocalOverlay::None);
        assert_eq!(store.get(id).as_deref(), Some("os-recovered"));
    }

    #[test]
    fn public_session_only_flag_is_non_secret_and_defaults_false() {
        let mut connection = PublicConnectionConfig::default();
        assert!(!connection.credential_session_only);
        let store = OsCredentialStore::new("com.okpgui.test.session-flag");
        apply_public_credential_session_flag(&mut connection, &store);
        assert!(!connection.credential_session_only);

        // Session-held secret for active ref surfaces the non-secret indicator only.
        let reference = CredentialRef {
            id: "session-flag-ref".into(),
        };
        store
            .seed_session_only_for_tests(&reference, SecretValue::new("must-not-leak"))
            .unwrap();
        connection.credential_ref = Some(reference);
        connection.auth_mode = AuthMode::Bearer;
        apply_public_credential_session_flag(&mut connection, &store);
        assert!(connection.credential_session_only);
        let encoded = to_string(&connection).unwrap();
        assert!(encoded.contains("credential_session_only"));
        assert!(!encoded.contains("must-not-leak"));
        assert!(!encoded.contains("sk-"));
    }

    fn sample_plan_rotation() -> CredentialSecretWritePlan {
        plan_credential_secret_write(
            AuthMode::Bearer,
            Some("old-ref".into()),
            Some("old-ref".into()),
            true,
            "candidate-ref",
        )
        .expect("sample rotation plan uses distinct candidate")
    }

    fn sample_journal(phase: CredentialJournalPhase) -> CredentialRotationJournal {
        CredentialRotationJournal::prepare(
            &sample_plan_rotation(),
            CredentialJournalSettingsMetadata {
                provider: "openai".into(),
                endpoint: "https://example.test/v1".into(),
                model: "gpt-test".into(),
                auth_mode: "bearer".into(),
                enabled: true,
                mode: "auto".into(),
            },
            1_700_000_000,
            CREDENTIAL_JOURNAL_TTL_SECS,
        )
        .with_phase(phase)
    }

    fn temp_journal_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "okpgui-cred-journal-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp journal dir");
        dir
    }

    #[test]
    fn credential_journal_phase_serializes_snake_case() {
        for (phase, expected) in [
            (CredentialJournalPhase::Prepared, "prepared"),
            (CredentialJournalPhase::CandidateStored, "candidate_stored"),
            (CredentialJournalPhase::ConfigCommitted, "config_committed"),
        ] {
            let encoded = to_string(&phase).unwrap();
            assert_eq!(encoded, format!("\"{expected}\""));
            let decoded: CredentialJournalPhase = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, phase);
        }

        let journal = sample_journal(CredentialJournalPhase::CandidateStored);
        let body = to_string(&journal).unwrap();
        assert!(body.contains("candidate_stored"));
        assert!(body.contains("\"version\":1"));
        let roundtrip: CredentialRotationJournal = serde_json::from_str(&body).unwrap();
        assert_eq!(roundtrip, journal);
    }

    #[test]
    fn credential_journal_contains_no_secret_bytes() {
        let secret_canary = "sk-live-super-secret-value-do-not-persist";
        // Even if a caller tried to stuff a canary into free-form metadata, the journal
        // type has no secret fields; sample metadata is non-secret by construction.
        let journal = sample_journal(CredentialJournalPhase::Prepared);
        let body = serde_json::to_string_pretty(&journal).unwrap();
        assert!(!body.contains(secret_canary));
        assert!(!body.contains("SecretValue"));
        assert!(!body.contains("password"));
        assert!(!body.contains("api_key"));
        assert!(!body.contains("\"secret\""));
        assert!(!body.contains("sk-"));
        // Refs and redacted connection metadata only.
        assert!(body.contains("candidate-ref"));
        assert!(body.contains("old-ref"));
        assert!(body.contains("openai"));
        assert!(body.contains("settings_metadata"));
    }

    #[test]
    fn credential_journal_old_config_rollback_deletes_only_candidate() {
        let store = SessionSecretStore::new();
        let old = CredentialRef {
            id: "old-ref".into(),
        };
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        store
            .set(&old, SecretValue::new("old-active-secret"))
            .unwrap();
        store
            .set(&candidate, SecretValue::new("new-candidate-secret"))
            .unwrap();

        let dir = temp_journal_dir("rollback");
        let path = credential_journal_path(&dir);
        let journal = sample_journal(CredentialJournalPhase::CandidateStored);
        write_credential_journal(&path, &journal).unwrap();

        // Config still points at old → rollback candidate only.
        let action = apply_credential_journal_recovery(
            &store,
            &path,
            &journal,
            Some("old-ref"),
            journal.created_at_unix,
        )
        .unwrap();
        assert_eq!(action, CredentialJournalRecoveryAction::RollbackCandidate);
        assert!(store.get(&candidate).unwrap().is_none());
        assert_eq!(
            store.get(&old).unwrap().unwrap().expose(),
            "old-active-secret"
        );
        assert!(load_credential_journal(&path).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_journal_committed_config_finishes_old_cleanup() {
        let store = SessionSecretStore::new();
        let old = CredentialRef {
            id: "old-ref".into(),
        };
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        store
            .set(&old, SecretValue::new("old-active-secret"))
            .unwrap();
        store
            .set(&candidate, SecretValue::new("new-candidate-secret"))
            .unwrap();

        let dir = temp_journal_dir("committed");
        let path = credential_journal_path(&dir);
        let journal = sample_journal(CredentialJournalPhase::ConfigCommitted);
        write_credential_journal(&path, &journal).unwrap();

        // Config already switched to candidate/next.
        let action = apply_credential_journal_recovery(
            &store,
            &path,
            &journal,
            Some("candidate-ref"),
            journal.created_at_unix,
        )
        .unwrap();
        assert_eq!(
            action,
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );
        assert_eq!(
            store.get(&candidate).unwrap().unwrap().expose(),
            "new-candidate-secret"
        );
        assert!(store.get(&old).unwrap().is_none());
        assert!(load_credential_journal(&path).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_journal_recovery_is_idempotent() {
        let store = SessionSecretStore::new();
        let old = CredentialRef {
            id: "old-ref".into(),
        };
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        store
            .set(&old, SecretValue::new("old-active-secret"))
            .unwrap();
        store
            .set(&candidate, SecretValue::new("new-candidate-secret"))
            .unwrap();

        let dir = temp_journal_dir("idempotent");
        let path = credential_journal_path(&dir);
        let journal = sample_journal(CredentialJournalPhase::ConfigCommitted);
        write_credential_journal(&path, &journal).unwrap();

        let first = apply_credential_journal_recovery(
            &store,
            &path,
            &journal,
            Some("candidate-ref"),
            journal.created_at_unix,
        )
        .unwrap();
        assert_eq!(
            first,
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );

        // Second pass: no journal left → load None; re-applying decision with no file is no-op.
        assert!(load_credential_journal(&path).unwrap().is_none());
        // Re-run pure decision + apply against already-clean state (simulate double recovery).
        write_credential_journal(&path, &journal).unwrap();
        let second = apply_credential_journal_recovery(
            &store,
            &path,
            &journal,
            Some("candidate-ref"),
            journal.created_at_unix + 10,
        )
        .unwrap();
        assert_eq!(
            second,
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );
        assert_eq!(
            store.get(&candidate).unwrap().unwrap().expose(),
            "new-candidate-secret"
        );
        assert!(store.get(&old).unwrap().is_none());
        assert!(load_credential_journal(&path).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_journal_stale_expired_still_reconciles_by_config_pointer() {
        let mut expired = sample_journal(CredentialJournalPhase::CandidateStored);
        expired.expires_at_unix = expired.created_at_unix; // already expired at created+1
        assert!(expired.is_expired(expired.created_at_unix + 1));

        // Expired + config still old → rollback (not leave orphan forever).
        assert_eq!(
            decide_credential_journal_recovery(
                &expired,
                Some("old-ref"),
                expired.created_at_unix + 1
            ),
            CredentialJournalRecoveryAction::RollbackCandidate
        );

        // Expired + config already on next → still finish cleanup.
        let mut committed = expired.clone();
        committed.phase = CredentialJournalPhase::ConfigCommitted;
        assert_eq!(
            decide_credential_journal_recovery(
                &committed,
                Some("candidate-ref"),
                committed.created_at_unix + CREDENTIAL_JOURNAL_TTL_SECS + 100
            ),
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );

        // Unrelated live ref → clear journal only (do not touch that generation).
        assert_eq!(
            decide_credential_journal_recovery(
                &committed,
                Some("totally-other-ref"),
                committed.created_at_unix + 1
            ),
            CredentialJournalRecoveryAction::ClearJournalOnly
        );
    }

    #[test]
    fn credential_journal_atomic_file_writes_replace_destination() {
        let dir = temp_journal_dir("atomic");
        let path = credential_journal_path(&dir);
        let first = sample_journal(CredentialJournalPhase::Prepared);
        write_credential_journal(&path, &first).unwrap();
        let loaded = load_credential_journal(&path).unwrap().unwrap();
        assert_eq!(loaded.phase, CredentialJournalPhase::Prepared);

        let second = first
            .clone()
            .with_phase(CredentialJournalPhase::CandidateStored);
        write_credential_journal(&path, &second).unwrap();
        let loaded = load_credential_journal(&path).unwrap().unwrap();
        assert_eq!(loaded.phase, CredentialJournalPhase::CandidateStored);
        // No leftover temp beside the journal after atomic replace.
        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists(), "atomic write must not leave .json.tmp");
        // Destination remains a single valid journal file.
        assert!(path.exists());
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("candidate_stored"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credential_journal_candidate_stored_with_switched_config_finishes_cleanup() {
        // Crash after config save but before phase advanced to ConfigCommitted.
        let journal = sample_journal(CredentialJournalPhase::CandidateStored);
        assert_eq!(
            decide_credential_journal_recovery(
                &journal,
                Some("candidate-ref"),
                journal.created_at_unix
            ),
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );
    }

    #[test]
    fn credential_journal_auth_mode_none_clear_recovery() {
        let plan = plan_credential_secret_write(
            AuthMode::None,
            Some("was-active".into()),
            None,
            false,
            "unused",
        )
        .expect("AuthMode::None clear plan");
        let journal = CredentialRotationJournal::prepare(
            &plan,
            CredentialJournalSettingsMetadata {
                auth_mode: "none".into(),
                enabled: false,
                ..Default::default()
            },
            100,
            1000,
        )
        .with_phase(CredentialJournalPhase::ConfigCommitted);
        assert!(journal.candidate_ref.is_none());
        assert_eq!(journal.next_ref, None);
        assert_eq!(
            decide_credential_journal_recovery(&journal, None, 100),
            CredentialJournalRecoveryAction::FinishCommittedCleanup
        );
        // Pre-switch: config still has old.
        let prepared = journal.clone().with_phase(CredentialJournalPhase::Prepared);
        assert_eq!(
            decide_credential_journal_recovery(&prepared, Some("was-active"), 100),
            CredentialJournalRecoveryAction::RollbackCandidate
        );
    }

    /// Store that fails delete for selected ids (models OS operational delete failure).
    struct FailDeleteStore {
        inner: SessionSecretStore,
        fail_ids: HashSet<String>,
    }

    impl SecretStore for FailDeleteStore {
        fn set(&self, reference: &CredentialRef, value: SecretValue) -> Result<(), String> {
            self.inner.set(reference, value)
        }

        fn get(&self, reference: &CredentialRef) -> Result<Option<SecretValue>, String> {
            self.inner.get(reference)
        }

        fn delete(&self, reference: &CredentialRef) -> Result<(), String> {
            if self.fail_ids.contains(&reference.id) {
                return Err("simulated operational delete failure".to_string());
            }
            self.inner.delete(reference)
        }
    }

    #[test]
    fn missing_credential_delete_errors_are_idempotent_success_policy() {
        // Shared policy used by macOS/Windows/Linux OS delete paths and session store.
        // Retrying committed cleanup against an already-absent old ref must succeed.
        for message in [
            "No matching entry found in secure storage",
            "credential not found",
            "No entry for service",
            "Password not found",
        ] {
            assert_eq!(
                classify_keyring_error(message),
                KeyringErrorClass::MissingEntry,
                "missing-style error must be success for delete: {message}"
            );
            assert!(
                is_missing_credential_error(message),
                "is_missing_credential_error must accept: {message}"
            );
        }
        // Operational failures remain failures (not treated as missing).
        assert_eq!(
            classify_keyring_error("keychain access denied"),
            KeyringErrorClass::OperationalFailure
        );
        // Session store delete of absent id is already Ok (Linux/session baseline).
        let session = SessionSecretStore::new();
        let missing = CredentialRef {
            id: "never-written".into(),
        };
        session.delete(&missing).unwrap();
        session.delete(&missing).unwrap();
    }

    #[test]
    fn pre_switch_rollback_clears_journal_only_after_confirmed_candidate_delete() {
        let store = SessionSecretStore::new();
        let plan = sample_plan_rotation();
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        store
            .set(&candidate, SecretValue::new("candidate-secret"))
            .unwrap();

        let dir = temp_journal_dir("pre-switch-ok");
        let path = credential_journal_path(&dir);
        let journal = sample_journal(CredentialJournalPhase::CandidateStored);
        write_credential_journal(&path, &journal).unwrap();

        rollback_candidate_or_retain_journal(&store, &plan, &path, &journal).unwrap();
        assert!(store.get(&candidate).unwrap().is_none());
        assert!(load_credential_journal(&path).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_switch_rollback_retains_journal_when_candidate_delete_unconfirmed() {
        let inner = SessionSecretStore::new();
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        inner
            .set(&candidate, SecretValue::new("candidate-secret"))
            .unwrap();
        let store = FailDeleteStore {
            inner,
            fail_ids: HashSet::from(["candidate-ref".to_string()]),
        };
        let plan = sample_plan_rotation();
        let dir = temp_journal_dir("pre-switch-retain");
        let path = credential_journal_path(&dir);
        // Disk may still be Prepared if CandidateStored phase write failed.
        let journal = sample_journal(CredentialJournalPhase::Prepared);
        write_credential_journal(&path, &journal).unwrap();

        let err = rollback_candidate_or_retain_journal(&store, &plan, &path, &journal)
            .expect_err("unconfirmed rollback must not clear journal");
        assert!(err.contains("rollback unconfirmed"));
        // Journal retained and advanced to a recovery-processable phase.
        let retained = load_credential_journal(&path)
            .unwrap()
            .expect("journal retained");
        assert_eq!(retained.phase, CredentialJournalPhase::CandidateStored);
        assert_eq!(retained.candidate_ref.as_deref(), Some("candidate-ref"));
        // Non-secret journal body only.
        let body = serde_json::to_string(&retained).unwrap();
        assert!(!body.contains("candidate-secret"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_existing_journal_before_new_finishes_committed_cleanup() {
        let store = SessionSecretStore::new();
        let old = CredentialRef {
            id: "old-ref".into(),
        };
        let candidate = CredentialRef {
            id: "candidate-ref".into(),
        };
        store
            .set(&old, SecretValue::new("old-active-secret"))
            .unwrap();
        store
            .set(&candidate, SecretValue::new("new-candidate-secret"))
            .unwrap();

        let dir = temp_journal_dir("reconcile-before-new");
        let path = credential_journal_path(&dir);
        let existing = sample_journal(CredentialJournalPhase::ConfigCommitted);
        write_credential_journal(&path, &existing).unwrap();

        // Config already on next; prior cleanup must finish before a new journal is written.
        let action = reconcile_existing_credential_journal_before_new(
            &store,
            &path,
            Some("candidate-ref"),
            existing.created_at_unix,
        )
        .unwrap();
        assert_eq!(
            action,
            Some(CredentialJournalRecoveryAction::FinishCommittedCleanup)
        );
        assert!(store.get(&old).unwrap().is_none());
        assert!(load_credential_journal(&path).unwrap().is_none());

        // A new Prepared journal can now be written without clobbering pending cleanup.
        let new_journal = sample_journal(CredentialJournalPhase::Prepared);
        write_credential_journal(&path, &new_journal).unwrap();
        assert_eq!(
            load_credential_journal(&path).unwrap().unwrap().phase,
            CredentialJournalPhase::Prepared
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_existing_journal_before_new_fail_closed_on_incomplete_recovery() {
        let inner = SessionSecretStore::new();
        let old = CredentialRef {
            id: "old-ref".into(),
        };
        inner
            .set(&old, SecretValue::new("old-active-secret"))
            .unwrap();
        let store = FailDeleteStore {
            inner,
            fail_ids: HashSet::from(["old-ref".to_string()]),
        };
        let dir = temp_journal_dir("reconcile-fail-closed");
        let path = credential_journal_path(&dir);
        let existing = sample_journal(CredentialJournalPhase::ConfigCommitted);
        write_credential_journal(&path, &existing).unwrap();

        // Cannot finish old cleanup → must not start a new rotation (journal retained).
        let err = reconcile_existing_credential_journal_before_new(
            &store,
            &path,
            Some("candidate-ref"),
            existing.created_at_unix,
        )
        .expect_err("incomplete recovery must fail closed");
        assert!(err.contains("simulated operational delete failure"));
        let retained = load_credential_journal(&path)
            .unwrap()
            .expect("journal retained");
        assert_eq!(retained.phase, CredentialJournalPhase::ConfigCommitted);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_existing_journal_before_new_noop_when_absent() {
        let store = SessionSecretStore::new();
        let dir = temp_journal_dir("reconcile-absent");
        let path = credential_journal_path(&dir);
        let action =
            reconcile_existing_credential_journal_before_new(&store, &path, Some("any"), 1)
                .unwrap();
        assert!(action.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
