import type { LegacyPublishTemplatePayload } from '../utils/quickPublish';

export type AiProvider = 'open_ai' | 'anthropic';
export type AiMode = 'auto' | 'responses' | 'chat' | 'anthropic_messages';
export type AiAuthMode = 'bearer' | 'anthropic_api_key' | 'custom_header' | 'none';
export type AiDecision = 'GO' | 'WARNING' | 'NO_GO' | 'PENDING' | 'LOCAL_BLOCKED';
export type FindingSeverity = 'WARNING' | 'CRITICAL';
export type AiCapabilityState = 'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed';

export interface CredentialRef {
    id: string;
}

/** Non-secret capability probe status (never includes secrets or provider bodies). */
export interface AiCapabilityStatus {
    state: AiCapabilityState;
    identity_digest: string;
    resolved_mode?: AiMode | null;
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

export interface AiAuditResult {
    decision: AiDecision;
    findings: AiFinding[];
    unknown_codes: string[];
    local_blockers?: string[];
    formal_ran?: boolean;
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
    profile_name: string;
    template: LegacyPublishTemplatePayload;
}

/** Backend-owned audit evidence bound to a prepared plan token at prepare time. */
export interface PlanAuditEvidence {
    decision: AiDecision;
    findings: AiFinding[];
    unknown_codes?: string[];
    /** False for prepare-time local-only / PENDING seeds; true only after formal provider audit. */
    formal_ran: boolean;
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

export interface AiJob {
    id: string;
    kind: 'capability_probe' | 'recognition' | 'template_selection' | 'media_info' | 'vision' | 'audit';
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
    request_generation: number;
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    debug_record_id?: string | null;
}

export interface TemplateSeed {
    token: string;
    template_id: string;
    template_revision: number;
    template_digest: string;
    torrent_name: string;
}

/** Opaque browser handoff only — never includes torrent_path. */
export interface AutoTemplateSeedHandoff {
    token: string;
    template_id: string;
}

/** Result of a successful one-shot backend consume (public identity + bound path). */
export interface ConsumedTemplateSeed {
    template_id: string;
    template_revision: number;
    template_digest: string;
    torrent_path: string;
    torrent_name?: string;
}

/** Request for Rust-owned automatic template selection (torrent path only). */
export interface AiSelectTemplateRequest {
    torrent_path: string;
}

/**
 * Public TemplateSelection job view from start/poll.
 * Seed is present only when state === 'succeeded'. Never includes torrent_path.
 */
export interface TemplateSelectionJobView {
    job_id: string;
    state: AiJob['state'];
    request_generation: number;
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    /** Redacted status/error message (never secrets or raw provider bodies). */
    message?: string | null;
    /** Opaque seed only when state is succeeded. */
    seed?: TemplateSeed | null;
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
 * Backend-safe recognition draft identity (not a publish-plan token or authority).
 * Derived only from recognition request context: torrent display name + template patterns.
 * Sent as `snapshot_hash` on the recognition wire for stale-result binding only.
 */
export function buildRecognitionDraftIdentity(input: {
    torrentName: string;
    epPattern: string;
    resolutionPattern: string;
    titlePattern: string;
}): string {
    const raw = [
        'recognition_v1',
        input.torrentName.trim(),
        input.epPattern.trim(),
        input.resolutionPattern.trim(),
        input.titlePattern.trim(),
    ].join('\u0001');

    // FNV-1a 32-bit — stable, sync, path-free; not cryptographic.
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `rec:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * One-shot release recognition request (mirrors Rust AiRecognizeRequest).
 * Display torrent name + template patterns only — never absolute paths or publish tokens.
 * snapshot_hash binds draft identity for stale-result rejection (caller-supplied; not publish authority).
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
    /** Client edit/request generation for stale-result binding. */
    request_generation: number;
    /**
     * Draft-identity binding for stale rejection only.
     * Prefer `buildRecognitionDraftIdentity(...)`; never a publish-plan token.
     */
    snapshot_hash: string;
}

/**
 * Redacted, typed recognition result over IPC (mirrors Rust RecognitionResult).
 * episode / resolution / suggested_title are advisory only — never auto-fill the draft.
 */
export interface RecognitionResult {
    schema_version: string;
    episode?: RecognitionCandidate | null;
    resolution?: RecognitionCandidate | null;
    suggested_title?: RecognitionCandidate | null;
    request_generation: number;
    snapshot_hash: string;
    job_id: string;
}

/**
 * Public Recognition job view from start/poll (mirrors Rust RecognitionJobView).
 * Validated result is present only when state === 'succeeded'.
 * Cancelled / stale / failed never include a usable result.
 */
export interface RecognitionJobView {
    job_id: string;
    state: AiJob['state'];
    request_generation: number;
    snapshot_hash: string;
    progress: number;
    error_code?: string | null;
    /** Redacted status/error message (never secrets or raw provider bodies). */
    message?: string | null;
    /** Validated redacted result only when state is succeeded. */
    result?: RecognitionResult | null;
}
