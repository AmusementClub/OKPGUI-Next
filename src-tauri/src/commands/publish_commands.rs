use crate::ai::audit::Acknowledgements;
use crate::domain::publish_plan::{
    get_or_create_registry, PlanRegistry, PreparedPlanResponse, PublishPlan,
};
use crate::publish::publish_events::emit_publish_event;
use crate::publish::{
    bind_configured_okp_for_prepare, collect_publish_local_blockers_with_resolved_okp,
    prepare_local_blockers_and_okp_identity, PublishComplete, PublishRequest,
};
use crate::services::publish_service::{run_publish, run_publish_with_resolved_okp};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Prepare input: client supplies the full publish request + generation only.
/// Snapshot hash is derived authoritatively on the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPrepareRequest {
    pub request_generation: u64,
    pub request: PublishRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanInspectResponse {
    pub plan: Option<PublishPlan>,
    pub has_blockers: bool,
}

fn registry() -> &'static Mutex<PlanRegistry> {
    get_or_create_registry()
}

#[tauri::command]
pub async fn prepare_plan(
    app: tauri::AppHandle,
    request: PlanPrepareRequest,
) -> Result<PreparedPlanResponse, String> {
    // Single live OKP resolve/capture for prepare: the same resolved executable is used
    // for OKP local checks and identity binding. Never mix two independent live resolves
    // (which could leave okp_identity=None without blockers, or false-block on a different path).
    // Unresolved / identity-capture failure always yields a local blocker (fail closed).
    let bind = bind_configured_okp_for_prepare(&app);
    let (okp_identity, local_blockers) =
        prepare_local_blockers_and_okp_identity(&app, &request.request, bind);
    // AI enabled+configured → PENDING initial evidence; disabled/unconfigured → local-only GO.
    // HomePage compatibility is this backend rule only (no frontend HomePage edits required).
    let ai_enabled_and_configured =
        crate::commands::ai_commands::ai_connection_is_configured_for_app(&app);
    let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
    guard.prepare_plan_with_request_and_blockers(
        request.request_generation,
        request.request,
        local_blockers,
        ai_enabled_and_configured,
        okp_identity,
    )
}

#[tauri::command]
pub async fn inspect_plan(token: String) -> Result<PlanInspectResponse, String> {
    let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
    let plan = guard.inspect_plan(&token).cloned();
    let has_blockers = plan.as_ref().is_some_and(PublishPlan::has_blockers);
    Ok(PlanInspectResponse { plan, has_blockers })
}

#[tauri::command]
pub async fn invalidate_plan(token: String) -> Result<bool, String> {
    let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
    Ok(guard.invalidate_plan(&token))
}

/// Record explicit acknowledgement checkboxes against a backend prepared plan token.
/// Frontend checkboxes are never authoritative on their own at publish time.
#[tauri::command]
pub async fn set_plan_acknowledgements(
    token: String,
    acknowledgements: Acknowledgements,
) -> Result<(), String> {
    let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
    guard.set_acknowledgements(&token, acknowledgements)?;
    Ok(())
}

/// Compatibility path for the existing AI-disabled publisher.
/// New preflight flows must use `publish_prepared_plan` instead.
pub async fn publish_legacy(app: tauri::AppHandle, request: PublishRequest) -> Result<(), String> {
    let app_handle = app.clone();
    let request_payload = request.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || run_publish(&app_handle, &request_payload))
            .await
            .map_err(|error| format!("发布任务执行失败: {}", error))?;

    let completion = match &result {
        Ok(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: true,
            message: message.clone(),
        },
        Err(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: false,
            message: message.clone(),
        },
    };

    emit_publish_event(&app, "publish-complete", completion);
    result.map(|_| ())
}

/// Publish a one-shot prepared plan.
///
/// Safety rules (Rust-owned):
/// - Local blockers always reject publish (`LOCAL_BLOCKED`).
/// - Decision comes only from backend-bound audit evidence that matches plan identity.
///   Missing/mismatched evidence is rejected (never an implicit unbound GO).
/// - WARNING / NO_GO / PENDING require explicit acknowledgements recorded on the plan.
/// - OKP launch uses the revalidated bound executable (identity A), never a live-config
///   re-resolve that could select a different valid executable B.
/// - Local-blocker recheck for prepared publish also uses bound A (not live config), so
///   config drift to B or a missing/invalid live path cannot false-block or leak a
///   live-config path error after prepare bound A.
/// - Authoritative bound OKP revalidation + bound local-blocker recheck run in the same
///   registry-locked pre-consume gate; the one-shot token is only consumed after those
///   checks pass. Launch reuses that already-validated bound executable (no post-consume
///   revalidation window that could burn the token on a pre-launch validation failure).
#[tauri::command]
pub async fn publish_prepared_plan(app: tauri::AppHandle, token: String) -> Result<(), String> {
    // Optional unlocked fast-fail (not authoritative): clone under a brief lock, then
    // revalidate/local-check without holding the registry across OKP version I/O.
    let early_plan = {
        let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
        guard.inspect_plan(&token).cloned()
    };
    if let Some(plan) = early_plan {
        if let Err(error) = publish_evidence_gate(&plan) {
            return Err(error);
        }
        if plan.has_blockers() || !plan.can_publish_now() {
            return Err(publish_gate_error(&plan));
        }
        if let Some(binding) = plan.get_local_binding() {
            if let Ok(bound_okp) = binding.revalidate_for_prepared_publish() {
                let early_blockers = collect_publish_local_blockers_with_resolved_okp(
                    &app,
                    binding.request(),
                    &bound_okp,
                );
                if !early_blockers.is_empty() {
                    return Err(format!(
                        "prepared plan local validation failed: {}",
                        early_blockers.join("；")
                    ));
                }
            }
            // Revalidation failure falls through to the authoritative locked gate.
        }
    }

    // Authoritative pre-consume gate under the registry lock:
    // evidence + decision + bound OKP revalidate + bound local blockers, then consume.
    // Launch uses the bound executable already validated here — never revalidate after consume.
    let (request, bound_okp) = {
        let mut guard = registry().lock().unwrap_or_else(|error| error.into_inner());
        let plan = guard
            .inspect_plan(&token)
            .cloned()
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        if let Err(error) = publish_evidence_gate(&plan) {
            return Err(error);
        }
        if plan.has_blockers() || !plan.can_publish_now() {
            return Err(publish_gate_error(&plan));
        }
        let binding = plan
            .get_local_binding()
            .ok_or_else(|| "prepared plan has no backend execution binding".to_string())?;
        let bound_okp = binding
            .revalidate_for_prepared_publish()
            .map_err(|failures| {
                format!(
                    "prepared plan execution binding revalidation failed: {}",
                    failures.join("；")
                )
            })?;
        let current_blockers =
            collect_publish_local_blockers_with_resolved_okp(&app, binding.request(), &bound_okp);
        if !current_blockers.is_empty() {
            return Err(format!(
                "prepared plan local validation failed: {}",
                current_blockers.join("；")
            ));
        }

        // All pre-launch checks passed — only now consume the one-shot token.
        let plan = guard
            .publish_plan(&token)
            .ok_or_else(|| "prepared plan token is missing or expired".to_string())?;
        let binding = plan
            .get_local_binding_owned()
            .ok_or_else(|| "prepared plan has no backend execution binding".to_string())?;
        // Reuse pre-consume validated bound A for launch (no post-consume revalidation).
        (binding.into_publish_request(), bound_okp)
    };

    let app_handle = app.clone();
    let request_payload = request.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Launch the exact already-resolved OKP whose identity was revalidated pre-consume.
        // Do not call run_publish (live config) for prepared plans.
        run_publish_with_resolved_okp(&app_handle, &request_payload, bound_okp)
    })
    .await
    .map_err(|error| format!("发布任务执行失败: {}", error))?;

    let completion = match &result {
        Ok(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: true,
            message: message.clone(),
        },
        Err(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: false,
            message: message.clone(),
        },
    };

    emit_publish_event(&app, "publish-complete", completion);
    result.map(|_| ())
}

/// Reject missing or identity-mismatched audit evidence at the Rust publish boundary.
fn publish_evidence_gate(plan: &PublishPlan) -> Result<(), String> {
    match &plan.audit_evidence {
        None => Err(
            "prepared plan is missing authoritative audit evidence; prepare must bind initial evidence"
                .to_string(),
        ),
        Some(evidence)
            if !evidence.matches_plan(&plan.snapshot_hash, plan.request_generation) =>
        {
            Err(
                "prepared plan audit evidence does not match plan identity".to_string(),
            )
        }
        Some(_) => Ok(()),
    }
}

fn publish_gate_error(plan: &PublishPlan) -> String {
    use crate::ai::audit::AuditDecision;
    if !plan.has_authoritative_audit_evidence() {
        return "prepared plan is missing authoritative audit evidence".to_string();
    }
    if plan.has_blockers() {
        return format!(
            "local blockers prevent prepared publish: {}",
            plan.local_blockers.join("；")
        );
    }
    match plan.publish_decision() {
        AuditDecision::LocalBlocked => "local blockers prevent prepared publish".to_string(),
        AuditDecision::Warning => {
            "WARNING decision requires explicit warning acknowledgement".to_string()
        }
        AuditDecision::NoGo => {
            "NO_GO decision requires explicit critical acknowledgement".to_string()
        }
        AuditDecision::Pending => {
            "PENDING decision requires explicit pending acknowledgement".to_string()
        }
        AuditDecision::Go => "prepared plan cannot be published".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::audit::{AuditDecision, Finding, FindingSeverity};
    use crate::domain::publish_plan::PlanAuditEvidence;

    fn evidence(
        decision: AuditDecision,
        snapshot_hash: &str,
        request_generation: u64,
    ) -> PlanAuditEvidence {
        PlanAuditEvidence {
            decision,
            findings: Vec::<Finding>::new(),
            unknown_codes: Vec::new(),
            formal_ran: true,
            job_id: Some("job-test".to_string()),
            snapshot_hash: snapshot_hash.to_string(),
            request_generation,
        }
    }

    fn plan_with_decision(decision: AuditDecision) -> PublishPlan {
        let mut plan = PublishPlan::new("sha256:plan".to_string(), 7);
        plan.bind_audit_evidence(evidence(decision, "sha256:plan", 7))
            .expect("identity-matched evidence");
        plan
    }

    #[test]
    fn evidence_gate_rejects_missing_and_mismatched_evidence() {
        let missing = PublishPlan::new("sha256:plan".to_string(), 7);
        let missing_error = publish_evidence_gate(&missing).expect_err("missing evidence");
        assert!(missing_error.contains("missing authoritative audit evidence"));

        let mut mismatched = PublishPlan::new("sha256:plan".to_string(), 7);
        mismatched.audit_evidence = Some(evidence(AuditDecision::Go, "sha256:other", 7));
        let mismatch_error = publish_evidence_gate(&mismatched).expect_err("mismatched evidence");
        assert!(mismatch_error.contains("does not match plan identity"));
    }

    #[test]
    fn warning_pending_and_no_go_require_their_matching_acknowledgement() {
        let mut warning = plan_with_decision(AuditDecision::Warning);
        assert!(!warning.can_publish_now());
        assert!(publish_gate_error(&warning).contains("warning acknowledgement"));
        warning.set_acknowledgements(Acknowledgements {
            warning: true,
            ..Acknowledgements::default()
        });
        assert!(warning.can_publish_now());

        let mut pending = plan_with_decision(AuditDecision::Pending);
        assert!(!pending.can_publish_now());
        assert!(publish_gate_error(&pending).contains("pending acknowledgement"));
        pending.set_acknowledgements(Acknowledgements {
            pending: true,
            ..Acknowledgements::default()
        });
        assert!(pending.can_publish_now());

        let mut no_go = plan_with_decision(AuditDecision::NoGo);
        no_go
            .audit_evidence
            .as_mut()
            .unwrap()
            .findings
            .push(Finding {
                code: "TEST_CRITICAL".to_string(),
                severity: FindingSeverity::Critical,
                message: "blocked".to_string(),
                evidence_path: None,
            });
        assert!(!no_go.can_publish_now());
        assert!(publish_gate_error(&no_go).contains("critical acknowledgement"));
        no_go.set_acknowledgements(Acknowledgements {
            critical: true,
            ..Acknowledgements::default()
        });
        assert!(no_go.can_publish_now());
    }

    #[test]
    fn failed_pre_consume_gate_does_not_mutate_or_consume_plan() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("sha256:plan".to_string(), 7)
            .expect("prepare plan");
        registry
            .bind_audit_evidence(&token, evidence(AuditDecision::Pending, "sha256:plan", 7))
            .expect("bind pending evidence");
        let plan_before = registry.inspect_plan(&token).cloned().expect("plan");
        assert!(publish_evidence_gate(&plan_before).is_ok());
        assert!(!plan_before.can_publish_now());
        assert!(publish_gate_error(&plan_before).contains("pending acknowledgement"));

        let plan_after = registry
            .inspect_plan(&token)
            .expect("failed gate preserves plan");
        assert_eq!(plan_after.snapshot_hash, plan_before.snapshot_hash);
        assert_eq!(
            plan_after.request_generation,
            plan_before.request_generation
        );
        assert!(registry.publish_plan(&token).is_some());
    }

    #[test]
    fn prepared_plan_consumption_is_one_shot_and_replay_fails_closed() {
        let mut registry = PlanRegistry::default();
        let token = registry
            .prepare_plan("sha256:plan".to_string(), 7)
            .expect("prepare plan");
        assert!(registry.publish_plan(&token).is_some());
        assert!(registry.inspect_plan(&token).is_none());
        assert!(registry.publish_plan(&token).is_none());
    }
}
