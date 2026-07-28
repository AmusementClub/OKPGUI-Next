//! Host-side desktop / packaged smoke exercised by the **built** application binary.
//!
//! When launched with `OKPGUI_DESKTOP_SMOKE_OUT=<path>`, the process runs production
//! domain paths (prepare plan, acknowledgements, publish-safe audit cancel, session
//! cancel, MediaInfo resolve+spawn, keyring session-only policy) and
//! writes a compact JSON handshake for the package-smoke runner.
//!
//! Honesty contract:
//! - This is **not** mocked Playwright / Vite invoke.
//! - This is **not** Tauri WebView IPC or WebDriver UI automation.
//! - It runs inside the release binary against the same Rust modules that back commands.
//! - `production_binary_marker` is true when hard probes pass.
//! - Dual-entry UI names (`home-*` / `quick-publish-*`) are **skipped**, not dual-passed.
//! - Event delivery to a WebView is **skipped** (no AppHandle/WebView in this path).
//! - Package-smoke gates on process exit status; this JSON is a four-field handshake only.

use crate::ai::audit::{Acknowledgements, AuditDecision};
use crate::ai::credentials::{decide_session_only_cold_start, SessionOnlyColdStartAction};
use crate::ai::jobs::{AiJobState, JobKind};
use crate::ai::media::{
    configure_mediainfo_command, packaged_mediainfo_candidates,
    resolve_or_release_packaged_mediainfo,
};
use crate::commands::ai_commands::{
    ai_cancel_job, ai_get_job, cancel_pending_audit_for_publish_core,
    cancel_preflight_session_core, start_job_backend,
};
use crate::config::{config_schema_version, Template};
use crate::domain::publish_plan::{get_or_create_registry, PlanAuditEvidence};
use crate::publish::PublishRequest;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Compact package-smoke handshake. Diagnostics go to stdout/stderr, not this report.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    /// True when hard production binary probes passed.
    production_binary_marker: bool,
    /// Stable fingerprint string for the Node harness (binary production paths).
    production_marker: String,
    ok: bool,
    /// Whether current_exe appears to live inside a macOS .app bundle.
    packaged_app_layout: bool,
}

fn log_probe(name: &str, ok: bool, detail: &str) {
    if ok {
        println!("desktop-smoke: pass {name}: {detail}");
    } else {
        eprintln!("desktop-smoke: fail {name}: {detail}");
    }
}

fn log_skip(name: &str, detail: &str) {
    println!("desktop-smoke: skip {name}: {detail}");
}

fn write_temp_torrent() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("okpgui-desktop-smoke-{nanos}.torrent"));
    let _ = std::fs::write(
        &path,
        b"d4:infod4:name12:smoke-show.mkv8:piece lengthi16384e6:pieces20:\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0ee",
    );
    path
}

fn sample_request(torrent_path: PathBuf) -> PublishRequest {
    PublishRequest {
        publish_id: "desktop-smoke".to_string(),
        torrent_path: torrent_path.display().to_string(),
        profile_name: "smoke-profile".to_string(),
        template: Template {
            title: "Desktop Smoke Title".to_string(),
            description: "desktop smoke body".to_string(),
            description_html: "<p>desktop smoke body</p>".to_string(),
            ..Default::default()
        },
    }
}

fn bind_pending_audit(
    token: &str,
    snapshot_hash: &str,
    generation: u64,
    job_id: &str,
) -> Result<(), String> {
    let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
    guard.bind_audit_evidence(
        token,
        PlanAuditEvidence {
            decision: AuditDecision::Pending,
            description: None,
            findings: vec![],
            unknown_codes: vec![],
            formal_ran: false,
            model: None,
            usage: None,
            duration_ms: None,
            job_id: Some(job_id.to_string()),
            snapshot_hash: snapshot_hash.to_string(),
            request_generation: generation,
        },
    )?;
    guard.note_plan_audit_job(token, job_id);
    Ok(())
}

fn detect_packaged_app_layout() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        let s = exe.to_string_lossy();
        if s.contains(".app/Contents/MacOS/") {
            return true;
        }
    }
    false
}

/// Resource roots to search for the packaged MediaInfo sidecar.
fn smoke_resource_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let packaged_only = std::env::var("OKPGUI_SMOKE_PACKAGED_ONLY")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !packaged_only {
        if let Ok(override_dir) = std::env::var("OKPGUI_SMOKE_RESOURCE_DIR") {
            if !override_dir.is_empty() {
                roots.push(PathBuf::from(override_dir));
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            roots.push(exe_dir.to_path_buf());
            // macOS .app: Contents/MacOS → Contents/Resources
            if let Some(contents) = exe_dir.parent() {
                roots.push(contents.join("Resources"));
                roots.push(contents.join("MacOS"));
                // Flat sibling of Contents
                if let Some(app_root) = contents.parent() {
                    roots.push(app_root.to_path_buf());
                }
            }
            // Dev/CI host smoke only: repo-layout binaries next to target/{debug,release}.
            if !packaged_only {
                if let Some(target_dir) = exe_dir.parent() {
                    // .../target/release → .../src-tauri/binaries
                    if let Some(src_tauri) = target_dir.parent() {
                        roots.push(src_tauri.join("binaries"));
                    }
                    // .../target/<triple>/release
                    if let Some(triple_dir) = target_dir.parent() {
                        if let Some(target_root) = triple_dir.parent() {
                            if let Some(src_tauri) = target_root.parent() {
                                roots.push(src_tauri.join("binaries"));
                            }
                        }
                    }
                }
            }
        }
    }
    if !packaged_only {
        // CWD fallbacks for local `cargo run` / harness launches from repo root.
        roots.push(PathBuf::from("src-tauri/binaries"));
        roots.push(PathBuf::from("binaries"));
    }
    roots
}

/// Resolve MediaInfo from smoke resource roots and spawn it (version probe).
fn probe_mediainfo_sidecar() -> Result<String, String> {
    let mut last_err = "MediaInfo sidecar is unavailable".to_string();
    let mut tried = Vec::new();
    let release_root = std::env::temp_dir().join("okpgui-next-desktop-smoke");
    for root in smoke_resource_roots() {
        tried.push(root.display().to_string());
        match resolve_or_release_packaged_mediainfo(&root, Some(&release_root)) {
            Ok(path) => {
                return spawn_mediainfo_version(&path);
            }
            Err(err) => {
                last_err = err;
            }
        }
        // Also try candidates listing for diagnostics when resolve fails on empty roots.
        let _ = packaged_mediainfo_candidates(&root);
    }
    Err(format!(
        "{last_err}; searched roots: {}",
        tried.into_iter().take(8).collect::<Vec<_>>().join(", ")
    ))
}

fn spawn_mediainfo_version(sidecar: &Path) -> Result<String, String> {
    if !sidecar.is_file() {
        return Err(format!("sidecar path is not a file: {}", sidecar.display()));
    }
    let mut command = Command::new(sidecar);
    configure_mediainfo_command(&mut command);
    let mut child = command
        .arg("--Version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn MediaInfo {}: {e}", sidecar.display()))?;

    // Bounded wait — MediaInfo --Version should be instant.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = {
                    let mut buf = String::new();
                    if let Some(mut out) = child.stdout.take() {
                        use std::io::Read;
                        let _ = out.read_to_string(&mut buf);
                    }
                    buf
                };
                let stderr = {
                    let mut buf = String::new();
                    if let Some(mut err) = child.stderr.take() {
                        use std::io::Read;
                        let _ = err.read_to_string(&mut buf);
                    }
                    buf
                };
                if !status.success() {
                    return Err(format!(
                        "MediaInfo --Version exited {:?}; stderr={}",
                        status.code(),
                        stderr.chars().take(200).collect::<String>()
                    ));
                }
                let preview = stdout
                    .lines()
                    .next()
                    .unwrap_or("MediaInfo")
                    .chars()
                    .take(120)
                    .collect::<String>();
                return Ok(format!(
                    "spawned {} (--Version ok: {preview})",
                    sidecar.display()
                ));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "MediaInfo --Version timed out: {}",
                        sidecar.display()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("MediaInfo wait error: {e}")),
        }
    }
}

/// Run production smoke and write JSON to `out_path`.
/// Returns process exit code (0 = all hard probes pass).
pub fn run_and_write(out_path: &Path) -> i32 {
    let mut all_ok = true;
    let packaged_app_layout = detect_packaged_app_layout();
    // When require-sidecar is set (packaged CI) or we are inside a .app, sidecar is hard.
    let require_sidecar = packaged_app_layout
        || std::env::var("OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

    // Schema validation remains a hard internal probe; not part of the JSON handshake.
    let schema_version = config_schema_version();
    let schema_ok = schema_version >= 3;
    log_probe(
        "schema-version-v3",
        schema_ok,
        &format!("CONFIG_SCHEMA_VERSION={schema_version}"),
    );
    all_ok &= schema_ok;

    let torrent = write_temp_torrent();

    // Shared backend prepare + PENDING ack + publish-safe cancel (token must stay live).
    // This is NOT dual UI-entry proof — Home/Quick Publish WebDriver flows stay skipped.
    let prepare_publish_ok = (|| -> Result<String, String> {
        let request = sample_request(torrent.clone());
        let prepared = {
            let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
            guard.prepare_plan_with_request_and_blockers(1, request, Vec::new(), true, None)?
        };
        let token = prepared.token.clone();
        let job_id = start_job_backend(JobKind::Audit, 1, prepared.snapshot_hash.clone(), None);
        bind_pending_audit(&token, &prepared.snapshot_hash, 1, &job_id)?;
        {
            let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
            guard.set_acknowledgements(
                &token,
                Acknowledgements {
                    warning: false,
                    critical: false,
                    pending: true,
                },
            )?;
            let plan = guard
                .inspect_plan(&token)
                .ok_or_else(|| "plan missing after prepare".to_string())?;
            if plan.publish_decision() != AuditDecision::Pending {
                return Err(format!(
                    "expected PENDING, got {:?}",
                    plan.publish_decision()
                ));
            }
            if !plan.can_publish_now() {
                return Err("PENDING+pending ack must be publishable".to_string());
            }
        }

        let result = cancel_pending_audit_for_publish_core(&token, Some(job_id.as_str()))?;
        if !result.plan_token_live {
            return Err("publish-safe cancel lost plan token".to_string());
        }
        if result.decision != "PENDING" {
            return Err(format!(
                "expected PENDING decision, got {}",
                result.decision
            ));
        }
        if ai_get_job(job_id).map(|j| j.state) != Some(AiJobState::Cancelled) {
            return Err("expected cancelled formal-audit job".to_string());
        }
        {
            let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
            let plan = guard
                .inspect_plan(&token)
                .ok_or_else(|| "token missing after publish-safe cancel".to_string())?;
            if !plan.can_publish_now() {
                return Err("token must remain publishable after publish-safe cancel".to_string());
            }
        }
        Ok(token)
    })();

    match &prepare_publish_ok {
        Ok(token) => {
            let preview = token.chars().take(12).collect::<String>();
            log_probe(
                "shared-backend-prepare-observe-ack-publish",
                true,
                &format!(
                    "host/packaged binary backend contract: prepare+pending-ack+publish-safe cancel kept token live ({preview}…). Not WebView IPC; not dual UI entry."
                ),
            );
        }
        Err(err) => {
            log_probe(
                "shared-backend-prepare-observe-ack-publish",
                false,
                &format!("shared backend contract failed: {err}"),
            );
            all_ok = false;
        }
    }

    // Dual-entry UI critical flows: host smoke cannot prove Home vs Quick Publish UI paths.
    log_skip(
        "home-prepare-observe-ack-publish",
        "host/packaged binary smoke cannot exercise the Home UI entry or WebView IPC; covered by Playwright UI integration (mocked IPC). Shared backend proven under shared-backend-prepare-observe-ack-publish.",
    );
    log_skip(
        "quick-publish-prepare-observe-ack-publish",
        "host/packaged binary smoke cannot exercise the Quick Publish UI entry or WebView IPC; covered by Playwright UI integration (mocked IPC). Shared backend proven under shared-backend-prepare-observe-ack-publish.",
    );

    // Session cancel / recovery: invalidate token (poll-failure / return-to-edit path).
    let cancel_recovery_ok = (|| -> Result<(), String> {
        let request = sample_request(torrent.clone());
        let prepared = {
            let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
            guard.prepare_plan_with_request_and_blockers(2, request, Vec::new(), true, None)?
        };
        let token = prepared.token;
        let job_id = start_job_backend(JobKind::Audit, 2, prepared.snapshot_hash.clone(), None);
        bind_pending_audit(&token, &prepared.snapshot_hash, 2, &job_id)?;
        let (result, _) = cancel_preflight_session_core(&token, Some(job_id.as_str()))?;
        if !result.reconciled {
            return Err("session cancel must report reconciled".to_string());
        }
        let still = get_or_create_registry()
            .lock()
            .map_err(|e| e.to_string())?
            .inspect_plan(&token)
            .is_some();
        if still {
            return Err("session cancel must invalidate plan token".to_string());
        }
        Ok(())
    })();
    let cancel_recovery_pass = cancel_recovery_ok.is_ok();
    log_probe(
        "cancellation-and-failed-poll-recovery",
        cancel_recovery_pass,
        &cancel_recovery_ok.err().unwrap_or_else(|| {
            "session cancel invalidates token; job cancelled (backend lifecycle, not event bus)"
                .to_string()
        }),
    );
    all_ok &= cancel_recovery_pass;

    // Generic ai_cancel_job still escalates plan-bound Audit (strip harden).
    let escalate_ok = (|| -> Result<(), String> {
        let request = sample_request(torrent.clone());
        let prepared = {
            let mut guard = get_or_create_registry().lock().map_err(|e| e.to_string())?;
            guard.prepare_plan_with_request_and_blockers(3, request, Vec::new(), true, None)?
        };
        let token = prepared.token;
        let job_id = start_job_backend(JobKind::Audit, 3, prepared.snapshot_hash.clone(), None);
        bind_pending_audit(&token, &prepared.snapshot_hash, 3, &job_id)?;
        let _ = ai_cancel_job(job_id)?;
        let gone = get_or_create_registry()
            .lock()
            .map_err(|e| e.to_string())?
            .inspect_plan(&token)
            .is_none();
        if !gone {
            return Err(
                "ai_cancel_job must escalate plan-bound audit and invalidate token".to_string(),
            );
        }
        Ok(())
    })();
    let escalate_pass = escalate_ok.is_ok();
    log_probe(
        "plan-bound-ai-cancel-job-escalates",
        escalate_pass,
        &escalate_ok
            .err()
            .unwrap_or_else(|| "ai_cancel_job invalidates plan-bound audit token".to_string()),
    );
    all_ok &= escalate_pass;

    // MediaInfo: resolve from package/resource layout and actually spawn --Version.
    let sidecar_result = probe_mediainfo_sidecar();
    match &sidecar_result {
        Ok(detail) => {
            log_probe("sidecar-mediainfo-probe", true, detail);
        }
        Err(err) => {
            if require_sidecar {
                log_probe(
                    "sidecar-mediainfo-probe",
                    false,
                    &format!("required sidecar probe failed: {err}"),
                );
                all_ok = false;
            } else {
                // Soft only when not packaged and not explicitly required — skip, do not fake pass.
                log_skip(
                    "sidecar-mediainfo-probe",
                    &format!(
                        "MediaInfo not resolved/spawned in this layout ({err}). Set OKPGUI_DESKTOP_SMOKE_REQUIRE_SIDECAR=1 or run from packaged .app for a hard gate."
                    ),
                );
            }
        }
    }

    // Keyring session-only: exercise pure cold-start policy (no OS keyring UI prompts).
    let keyring_ok = {
        use SessionOnlyColdStartAction::*;
        decide_session_only_cold_start(false, Some("cred-1"), false) == LeaveUnchanged
            && decide_session_only_cold_start(true, Some("cred-1"), true) == LeaveUnchanged
            && decide_session_only_cold_start(true, Some("cred-1"), false) == ClearStalePointer
            && decide_session_only_cold_start(true, None, false) == ClearStalePointer
            && decide_session_only_cold_start(false, Some("cred-1"), false) == LeaveUnchanged
    };
    log_probe(
        "keyring-session-only-probe",
        keyring_ok,
        if keyring_ok {
            "decide_session_only_cold_start: session-only missing secret → ClearStalePointer; durable/missing marker → LeaveUnchanged; no secret restore invented"
        } else {
            "session-only cold-start policy assertions failed"
        },
    );
    all_ok &= keyring_ok;

    // Event delivery to WebView cannot be proven without AppHandle + listener.
    log_skip(
        "event-delivery-probe",
        "host/packaged binary smoke has no WebView/AppHandle; PreflightSessionChanged emit/subscribe is not exercised. Session cancel lifecycle is covered by cancellation-and-failed-poll-recovery.",
    );

    log_probe(
        "production-binary-probe",
        all_ok,
        if all_ok {
            "Production prepare_plan / cancel / MediaInfo / keyring-policy paths exercised in built binary (not WebView IPC)"
        } else {
            "One or more hard production binary probes failed"
        },
    );
    log_probe(
        "minimal-backend-roundtrip",
        prepare_publish_ok.is_ok(),
        "prepare_plan + pending bind + cancel_pending_audit_for_publish round-trip (backend modules, not IPC)",
    );

    if packaged_app_layout {
        log_probe(
            "packaged-app-layout",
            true,
            "current_exe path contains .app/Contents/MacOS/",
        );
    } else {
        log_skip(
            "packaged-app-layout",
            "Not running from a macOS .app bundle path; raw/host binary layout.",
        );
    }

    let report = SmokeReport {
        production_binary_marker: all_ok,
        production_marker: "OKPGUI_PRODUCTION_BINARY_V1".to_string(),
        ok: all_ok,
        packaged_app_layout,
    };

    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec_pretty(&report) {
        Ok(bytes) => {
            if let Err(err) = std::fs::write(out_path, bytes) {
                eprintln!("desktop-smoke: failed to write report: {err}");
                return 1;
            }
        }
        Err(err) => {
            eprintln!("desktop-smoke: failed to serialize report: {err}");
            return 1;
        }
    }

    let _ = std::fs::remove_file(&torrent);
    if all_ok {
        0
    } else {
        1
    }
}
