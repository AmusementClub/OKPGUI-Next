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
/// Offline provider/mock contract surface (fixtures + localhost mock helpers).
/// Test-only: never linked into production; never calls live/paid providers.
#[cfg(test)]
mod provider_contract;
pub mod recognition;
pub mod redaction;
pub mod template_seed;
pub mod vision;
