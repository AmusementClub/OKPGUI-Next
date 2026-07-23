use crate::ai::provider::{CapabilityIdentity, ProviderKind, ProviderMode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
            return self
                .entry(reference)?
                .delete_credential()
                .map_err(|error| format!("credential store delete failed: {error}"));
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
    connection.credential_session_only = match (
        connection.auth_mode,
        connection.credential_ref.as_ref(),
    ) {
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
/// - When no secret is provided, keep the explicit connection ref or the previous active ref.
pub fn plan_credential_secret_write(
    auth_mode: AuthMode,
    old_ref_id: Option<String>,
    connection_ref_id: Option<String>,
    secret_provided: bool,
    unique_candidate_id: impl Into<String>,
) -> CredentialSecretWritePlan {
    if auth_mode == AuthMode::None {
        return CredentialSecretWritePlan {
            next_ref_id: None,
            rollback_candidate_id: None,
            // Clear orphan only after successful switch; pre-switch failure keeps old secret.
            delete_after_success_id: old_ref_id,
        };
    }

    if secret_provided {
        let candidate = unique_candidate_id.into();
        let delete_after_success_id = old_ref_id.filter(|old| old != &candidate);
        return CredentialSecretWritePlan {
            next_ref_id: Some(candidate.clone()),
            rollback_candidate_id: Some(candidate),
            delete_after_success_id,
        };
    }

    let next_ref_id = connection_ref_id.or(old_ref_id.clone());
    let delete_after_success_id =
        previous_secret_to_delete_after_successful_switch(old_ref_id.as_deref(), next_ref_id.as_deref());
    CredentialSecretWritePlan {
        next_ref_id,
        rollback_candidate_id: None,
        delete_after_success_id,
    }
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

/// After successful config persist, best-effort delete the previous active secret when planned.
/// Never called on pre-switch failure (rollback keeps the old secret).
pub fn cleanup_previous_secret_after_success(
    store: &impl SecretStore,
    plan: &CredentialSecretWritePlan,
) -> Result<(), String> {
    if let Some(id) = plan.delete_after_success_id.as_ref() {
        // Best-effort: missing entry is fine after a successful pointer switch.
        let _ = store.delete(&CredentialRef { id: id.clone() });
    }
    Ok(())
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
            credential_ref: Some(CredentialRef {
                id: "c1".into(),
            }),
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
        );
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
        );
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
        );
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
        let after_write = linux_overlay_after_set(linux_reconcile_set(
            LinuxOsWriteObservation::Success,
        ));
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
}
