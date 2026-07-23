//! Rust-owned primitives for the optional BYOK AI layer.
//!
//! The modules in this tree deliberately contain no Tauri UI assumptions. They
//! own the contracts that must remain stable when QuickPublish and HomePage
//! share the same preflight flow.

pub mod audit;
pub mod context;
pub mod credentials;
pub mod jobs;
pub mod media;
pub mod provider;
pub mod recognition;
pub mod redaction;
pub mod template_seed;
pub mod vision;

pub use audit::{compute_decision, Acknowledgements, AuditDecision, Finding, FindingSeverity};
pub use context::{ContextError, ContextProjection, ContextProjectionInput};
pub use credentials::{AuthMode, CredentialRef, SecretStore};
pub use jobs::{AiJob, AiJobManager, AiJobState, JobKind};
pub use provider::{CapabilityIdentity, CapabilityState, ProviderKind, ProviderMode};
pub use recognition::{
    parse_recognition, RecognitionCandidate, RecognitionOutput, RecognitionResult,
};
pub use template_seed::{
    build_eligible_catalog, parse_template_selection, EligibleTemplateCatalogEntry, TemplateSeed,
    TemplateSeedRegistry,
};
