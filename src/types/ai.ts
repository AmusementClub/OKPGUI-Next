import type { LegacyPublishTemplatePayload } from '../utils/quickPublish';

export type AiProvider = 'open_ai' | 'anthropic';
export type AiMode = 'auto' | 'responses' | 'chat' | 'anthropic_messages';
export type AiAuthMode = 'bearer' | 'anthropic_api_key' | 'custom_header' | 'none';
export type AiDecision = 'GO' | 'WARNING' | 'NO_GO' | 'PENDING' | 'LOCAL_BLOCKED';
export type FindingSeverity = 'WARNING' | 'CRITICAL';
export type AiCapabilityState = 'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed';
export type AiOutputCapability = 'strict_schema' | 'json_object';

/**
 * Frontend audit lifecycle, separate from the authoritative audit decision.
 * `reconciling` always has canConfirm=false until Rust returns reconciled=true.
 */
export type AiPreflightLifecycle =
    | 'idle'
    | 'preparing'
    | 'auditing'
    | 'reconciling'
    | 'terminal'
    | 'unavailable'
    | 'cancelled';

/** Token state after atomic preflight cancel/reconcile. */
export type PreflightTokenState = 'invalidated' | 'already_missing';

export interface CredentialRef {
    id: string;
}

/** Non-secret capability probe status (never includes secrets or provider bodies). */
export interface AiCapabilityStatus {
    state: AiCapabilityState;
    identity_digest: string;
    resolved_mode?: AiMode | null;
    output_capability?: AiOutputCapability | null;
    message: string;
    probed_at_unix?: number | null;
    /** True only when stored Ready digest matches the current stored connection. */
    identity_matches: boolean;
}

export interface AiModelDiscoveryResult {
    models: string[];
    fetched_at_unix: number;
    /** True when discovery failed; UI should keep/allow a manual model entry. */
    manual_fallback: boolean;
    message: string;
}

export interface AiSettings {
    provider: AiProvider;
    endpoint: string;
    model: string;
    mode: AiMode;
    auth_mode: AiAuthMode;
    custom_header_name?: string | null;
    credential_ref?: CredentialRef | null;
    enabled: boolean;
    capability?: AiCapabilityStatus | null;
    discovered_models?: string[];
    models_fetched_at_unix?: number | null;
    /**
     * True when the active credential is held only in process session storage
     * (not durable OS keyring). Never includes secret material.
     */
    credential_session_only?: boolean;
}

export interface AiFinding {
    code: string;
    severity: FindingSeverity;
    message: string;
    evidence_path?: string | null;
}

export interface AiAuditInput {
    local_blockers: string[];
    findings: AiFinding[];
    checking: boolean;
}

/**
 * Request for the Rust-owned formal audit command (bound to a prepared plan token).
 * Send `plan_token` only — provider prompt is projected from the plan binding server-side.
 * Deprecated optional fields remain for transitional wire compatibility and are ignored.
 */
export interface AiFormalAuditRequest {
    /** Opaque prepared-plan token; backend snapshot identity + binding are authoritative. */
    plan_token: string;
    /** @deprecated Ignored; prompt uses plan-token ContextProjection only. */
    title?: string | null;
    /** @deprecated Ignored; prompt uses plan-token ContextProjection only. */
    torrent_name?: string | null;
    /** @deprecated Ignored; prompt uses plan-token ContextProjection only. */
    sites?: string[];
    /** @deprecated Ignored by backend; retained only for transitional callers. */
    request_generation?: number;
    /** @deprecated Ignored by backend; retained only for transitional callers. */
    snapshot_hash?: string;
    /** @deprecated Ignored by backend; plan blockers are authoritative. */
    local_blockers?: string[];
}

export interface AiProviderUsage {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cached_tokens?: number | null;
    reasoning_tokens?: number | null;
}

export interface AiAuditResult {
    decision: AiDecision;
    /** AI-generated Simplified Chinese summary for the user; absent on local-only paths. */
    description?: string | null;
    findings: AiFinding[];
    unknown_codes: string[];
    local_blockers?: string[];
    formal_ran?: boolean;
    model?: string | null;
    usage?: AiProviderUsage | null;
    duration_ms?: number | null;
    job_id?: string | null;
    /** Backend-issued plan identity echoed with the audit result. */
    plan_token?: string;
    snapshot_hash?: string;
    request_generation?: number;
}

export interface AiAcknowledgements {
    warning: boolean;
    critical: boolean;
    pending: boolean;
}

export interface PublishRequestPayload {
    publish_id: string;
    torrent_path: string;
    /** Private prepare-time input; stripped before serializing the Rust PublishRequest. */
    content_root?: string;
    profile_name: string;
    template: LegacyPublishTemplatePayload;
}

/** Backend-owned audit evidence bound to a prepared plan token at prepare time. */
export interface PlanAuditEvidence {
    decision: AiDecision;
    description?: string | null;
    findings: AiFinding[];
    unknown_codes?: string[];
    /** False for prepare-time local-only / PENDING seeds; true only after formal provider audit. */
    formal_ran: boolean;
    model?: string | null;
    usage?: AiProviderUsage | null;
    duration_ms?: number | null;
    job_id?: string | null;
    snapshot_hash: string;
    request_generation: number;
}

export interface PublishPlan {
    version: number;
    snapshot_hash: string;
    request_generation: number;
    local_blockers: string[];
    /** Always present after prepare: local GO/LOCAL_BLOCKED or PENDING, never unbound. */
    audit_evidence?: PlanAuditEvidence | null;
    acknowledgements?: AiAcknowledgements;
    canonical_snapshot?: {
        hash: string;
        template_id: string;
        template_digest: string;
        sites: string[];
        torrent_name?: string;
        torrent_digest?: string;
        profile_name?: string;
    } | null;
}

/** Authoritative prepare response: backend derives snapshot_hash and binds initial audit evidence. */
export interface PlanPrepareResponse {
    token: string;
    snapshot_hash: string;
    request_generation: number;
    local_blockers: string[];
    has_blockers: boolean;
}

export type MediaProbeState =
    | 'measured'
    | 'missing_sidecar'
    | 'start_failed'
    | 'non_zero_exit'
    | 'malformed_json'
    | 'oversized_output'
    | 'timed_out'
    | 'cancelled'
    | 'missing_file'
    | 'ambiguous_match'
    | 'size_mismatch';

export interface MediaInfoSummary {
    duration_ms?: number | null;
    width?: number | null;
    height?: number | null;
    video_codec?: string | null;
    audio_codecs: string[];
    subtitle_languages: string[];
    scan_type?: string | null;
}

export interface MediaProbeResult {
    relative_name: string;
    state: MediaProbeState;
    summary?: MediaInfoSummary | null;
    message?: string | null;
}

export interface MediaInfoJobView {
    job_id: string;
    plan_token: string;
    state: AiJob['state'];
    request_generation: number;
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    results: MediaProbeResult[];
}

export interface AiJob {
    id: string;
    kind: 'capability_probe' | 'recognition' | 'media_info' | 'audit';
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
    request_generation: number;
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    debug_record_id?: string | null;
}

/** Result of `ai_cancel_preflight_session`. */
export interface CancelPreflightSessionResult {
    /** Final related job state (snake_case), or null when no job was bound. */
    job_state: AiJob['state'] | string | null;
    token_state: PreflightTokenState;
    /** True only when job (if any) is terminal/absent and token is invalidated/missing. */
    reconciled: boolean;
}

/**
 * Result of `ai_cancel_pending_audit_for_publish`.
 * Cancels the formal audit job without invalidating the frozen plan token.
 */
export interface CancelPendingAuditForPublishResult {
    job_state: AiJob['state'] | string | null;
    /** Must be true — publish_prepared_plan requires a live token. */
    plan_token_live: boolean;
    /** Authoritative decision still bound on the plan (typically PENDING). */
    decision: string;
}

/**
 * Sanitized cross-surface lifecycle event (`preflight-session-changed`).
 * Never includes frozen request, paths, secrets, or provider bodies.
 */
export interface PreflightSessionChangedPayload {
    plan_token?: string | null;
    token_digest: string;
    job_id?: string | null;
    /** Authoritative lifecycle after reconciliation. */
    lifecycle: AiPreflightLifecycle | string;
    token_state: PreflightTokenState;
    reconciled: boolean;
}

/**
 * Sanitized active-job strip projection (never full AiJob).
 * No secrets, paths, snapshot hashes, capability identity, or provider bodies.
 */
export interface ActiveAiJobSummary {
    job_id: string;
    kind: AiJob['kind'];
    stage: string;
    progress: number;
    cancellable: boolean;
    navigation_target?: string | null;
    started_at_unix: number;
}

export interface ActiveAiJobCancelResult {
    job_id: string;
    kind: AiJob['kind'];
    job_state: string;
    used_preflight_session: boolean;
    reconciled: boolean;
}

/** One optional recognition candidate with confidence and short evidence. */
export interface RecognitionCandidate {
    value: string;
    confidence: number;
    evidence: string;
}

/**
 * Provenance of a draft field that recognition may advise on.
 * Title is always deterministic/manual and is never adopted from recognition.
 */
export type FieldOrigin = 'empty' | 'deterministic' | 'manual' | 'adopted';

/** Fields that support explicit per-field adoption (title is never adopted). */
export type RecognitionAdoptableField = 'episode' | 'resolution';

/** Edit-generation metadata for a single draft field. */
export interface FieldEditMeta {
    origin: FieldOrigin;
    /** Monotonic generation; bumps on manual edits to block silent late overwrites. */
    editGeneration: number;
}

export function createEmptyFieldEditMeta(): FieldEditMeta {
    return { origin: 'empty', editGeneration: 0 };
}

export function markFieldManual(meta: FieldEditMeta): FieldEditMeta {
    return {
        origin: 'manual',
        editGeneration: meta.editGeneration + 1,
    };
}

export function markFieldAdopted(meta: FieldEditMeta): FieldEditMeta {
    return {
        origin: 'adopted',
        editGeneration: meta.editGeneration,
    };
}

/**
 * Local-only key for detecting torrent/template draft drift in the UI.
 * Never serialized as wire identity — Rust owns context hash + generation.
 */
export function buildRecognitionLocalContextKey(input: {
    torrentName: string;
    epPattern: string;
    resolutionPattern: string;
    titlePattern: string;
}): string {
    return [
        input.torrentName.trim(),
        input.epPattern.trim(),
        input.resolutionPattern.trim(),
        input.titlePattern.trim(),
    ].join('\u0001');
}

/**
 * One-shot / start release recognition request (mirrors Rust AiRecognizeRequest).
 * Content only: display torrent name + template patterns.
 * Never includes snapshot_hash or request_generation — Rust allocates those on start.
 */
export interface AiRecognizeRequest {
    /** Display torrent name only (never a filesystem path). */
    torrent_name: string;
    /** Episode regex/context from the active template. */
    ep_pattern: string;
    /** Resolution regex/context from the active template. */
    resolution_pattern: string;
    /** Title pattern context (deterministic final title still uses this locally). */
    title_pattern: string;
}

/**
 * Typed recognition result over IPC (mirrors Rust RecognitionResult).
 * episode / resolution / suggested_title are advisory only — never auto-fill the draft.
 * request_generation + snapshot_hash are backend-owned context identity.
 */
export interface RecognitionResult {
    schema_version: string;
    episode?: RecognitionCandidate | null;
    resolution?: RecognitionCandidate | null;
    suggested_title?: RecognitionCandidate | null;
    /** Backend-allocated monotonic recognition generation. */
    request_generation: number;
    /** Backend-computed cryptographic context hash (`sha256:…`). */
    snapshot_hash: string;
    job_id: string;
}

/**
 * Public Recognition job view from start/poll (mirrors Rust RecognitionJobView).
 * Validated result is present only when state === 'succeeded'.
 * Cancelled / stale / failed never include a usable result.
 * request_generation + snapshot_hash are backend-owned context identity.
 */
export interface RecognitionJobView {
    job_id: string;
    state: AiJob['state'];
    /** Backend-allocated monotonic recognition generation. */
    request_generation: number;
    /** Backend-computed cryptographic context hash (`sha256:…`). */
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    /** Bounded status/error message. */
    message?: string | null;
    /** Validated result only when state is succeeded. */
    result?: RecognitionResult | null;
}
