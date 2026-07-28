import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
    ActiveAiJobCancelResult,
    ActiveAiJobSummary,
    AiAuditResult,
    AiFormalAuditRequest,
    AiJob,
    AiModelDiscoveryResult,
    AiRecognizeRequest,
    AiSettings,
    CancelPendingAuditForPublishResult,
    CancelPreflightSessionResult,
    MediaInfoJobView,
    PlanPrepareResponse,
    PreflightSessionChangedPayload,
    PublishPlan,
    PublishRequestPayload,
    RecognitionJobView,
    RecognitionResult,
} from '../types/ai';

/** Tauri event name for atomic preflight cancel/reconcile convergence. */
export const PREFLIGHT_SESSION_CHANGED_EVENT = 'preflight-session-changed';

export const disabledAiSettings: AiSettings = {
    provider: 'open_ai',
    endpoint: 'https://api.openai.com/v1',
    model: '',
    mode: 'responses',
    auth_mode: 'bearer',
    custom_header_name: null,
    credential_ref: null,
    enabled: false,
    capability: null,
    discovered_models: [],
    models_fetched_at_unix: null,
};

export function isAiConfigured(settings: AiSettings | null | undefined): boolean {
    return Boolean(settings?.enabled)
        && Boolean(settings?.endpoint?.trim())
        && Boolean(settings?.model?.trim())
        && (settings?.auth_mode === 'none' || Boolean(settings?.credential_ref?.id));
}

export async function getAiSettings(): Promise<AiSettings> {
    try {
        const settings = await invoke<AiSettings | null>('ai_get_settings');
        return settings ?? disabledAiSettings;
    } catch {
        return disabledAiSettings;
    }
}

export async function saveAiSettings(settings: AiSettings, secret?: string): Promise<AiSettings> {
    return invoke<AiSettings>('ai_save_settings', { connection: settings, secret: secret || null });
}

/**
 * Refresh provider model list for the current settings draft.
 * Never returns secrets; on failure sets manual_fallback so the UI keeps a manual model.
 * This explicit setup request does not require the draft to be enabled or have a model yet.
 */
export async function listAiModels(settings: AiSettings, secret?: string): Promise<AiModelDiscoveryResult> {
    return invoke<AiModelDiscoveryResult>('ai_list_models', {
        connection: settings,
        secret: secret || null,
    });
}

/**
 * Prepare a publish plan. Backend derives the authoritative snapshot_hash from the
 * complete request + torrent digest and **atomically binds initial audit evidence**:
 * local-only GO/LOCAL_BLOCKED when AI is disabled/unconfigured, or PENDING when AI is
 * enabled and configured. The client never supplies a snapshot hash or decision.
 *
 * Preferred: `(request, requestGeneration)`.
 * Legacy: `(request, ignoredClientHash, requestGeneration)` — the hash argument is
 * discarded so non-owned callers can keep compiling until they migrate.
 */
export async function preparePublishPlan(
    request: PublishRequestPayload,
    requestGeneration: number,
): Promise<PlanPrepareResponse>;
export async function preparePublishPlan(
    request: PublishRequestPayload,
    _ignoredClientHash: string,
    requestGeneration: number,
): Promise<PlanPrepareResponse>;
export async function preparePublishPlan(
    request: PublishRequestPayload,
    generationOrIgnoredHash: number | string,
    maybeGeneration?: number,
): Promise<PlanPrepareResponse> {
    const requestGeneration = typeof generationOrIgnoredHash === 'number'
        ? generationOrIgnoredHash
        : (maybeGeneration ?? 0);
    const { content_root = '', ...publishRequest } = request;
    return invoke<PlanPrepareResponse>('prepare_plan', {
        request: {
            request_generation: requestGeneration,
            content_root,
            request: publishRequest,
        },
    });
}

export async function invalidatePublishPlan(token: string): Promise<void> {
    await invoke('invalidate_plan', { token });
}

/** Record explicit acknowledgement checkboxes against a backend prepared plan token. */
export async function setPlanAcknowledgements(
    token: string,
    acknowledgements: {
        warning: boolean;
        critical: boolean;
        pending: boolean;
    },
): Promise<void> {
    await invoke('set_plan_acknowledgements', { token, acknowledgements });
}

export async function publishPreparedPlan(
    token: string | Pick<PlanPrepareResponse, 'token'>,
): Promise<void> {
    const resolved = typeof token === 'string' ? token : token.token;
    // Acknowledgements must already be bound on the plan via setPlanAcknowledgements.
    // Caller-only decision/hash fields are never accepted here.
    await invoke('publish_prepared_plan', { token: resolved });
}

/** Invoke the Rust-owned formal audit path (local-only when AI is disabled; awaits terminal). */
export async function computeAiAudit(request: AiFormalAuditRequest): Promise<AiAuditResult> {
    return invoke<AiAuditResult>('ai_compute_audit', { request });
}

/**
 * Start a backend-owned Recognition job (returns immediately with queued/running view).
 * Request is content-only (torrent name + patterns); Rust allocates context hash + generation.
 * Provider work runs in the background; poll via pollRecognition; cancel via cancelAiJob.
 * Never mutates publish drafts or decisions; requires a complete saved connection.
 */
export async function startRecognition(request: AiRecognizeRequest): Promise<RecognitionJobView> {
    return invoke<RecognitionJobView>('ai_start_recognition', { request });
}

/**
 * Poll Recognition job. Returns null while queued/running; terminal view when finished.
 * Cancelled/stale/failed never include a usable recognition result.
 */
export async function pollRecognition(jobId: string): Promise<RecognitionJobView | null> {
    return invoke<RecognitionJobView | null>('ai_poll_recognition', { jobId });
}

/** Whether a terminal Recognition view may expose advisory candidates. */
export function isSuccessfulRecognitionResult(
    view: RecognitionJobView | null | undefined,
): boolean {
    return view?.state === 'succeeded' && Boolean(view.result);
}

/**
 * Provider-backed one-shot release recognition (advisory only; backward-compatible).
 * Prefer startRecognition + pollRecognition for cancellable UI flows.
 * Never mutates publish drafts or decisions; requires a complete saved connection.
 */
export async function recognizeWithAi(request: AiRecognizeRequest): Promise<RecognitionResult> {
    return invoke<RecognitionResult>('ai_recognize', { request });
}

/**
 * Start formal audit for a prepared plan.
 * Configured AI returns PENDING+job_id immediately (provider work is backend-background).
 * Disabled/unconfigured/local paths return a terminal local decision synchronously.
 */
export async function startFormalAudit(request: AiFormalAuditRequest): Promise<AiAuditResult> {
    return invoke<AiAuditResult>('ai_start_formal_audit', { request });
}

/** Start a plan-bound MediaInfo pass over every media entry declared by the torrent. */
export async function startPlanMediaInfo(planToken: string): Promise<MediaInfoJobView> {
    return invoke<MediaInfoJobView>('ai_start_media_info', {
        request: {
            plan_token: planToken,
            relative_entries: [],
        },
    });
}

/** Start a local MediaInfo pass using the optional backend-configured default media folder. */
export async function startDefaultMediaInfo(torrentPath: string): Promise<MediaInfoJobView> {
    return invoke<MediaInfoJobView>('ai_start_default_media_info', { torrentPath });
}

/** Poll a MediaInfo task; null means the job is still queued or running. */
export async function pollPlanMediaInfo(jobId: string): Promise<MediaInfoJobView | null> {
    return invoke<MediaInfoJobView | null>('ai_poll_media_info', { jobId });
}

/**
 * Poll plan-bound formal-audit evidence for a backend job.
 * Returns null while the job is still queued/running; throws on cancel/stale/missing plan.
 */
export async function pollFormalAudit(
    planToken: string,
    jobId: string,
): Promise<AiAuditResult | null> {
    return invoke<AiAuditResult | null>('ai_poll_formal_audit', {
        planToken,
        jobId,
    });
}

/** Read-only job status (webview cannot forge start/complete). */
export async function getAiJob(id: string): Promise<AiJob | null> {
    return invoke<AiJob | null>('ai_get_job', { id });
}

/** Cooperative cancel; late completion cannot resurrect or bind terminal evidence. */
export async function cancelAiJob(id: string): Promise<AiJob> {
    return invoke<AiJob>('ai_cancel_job', { id });
}

/**
 * Publish-time PENDING audit cancel: stop the formal job so late completion cannot bind,
 * but keep the frozen plan token live for `publish_prepared_plan`.
 * Do not use `cancelAiJob` / session cancel here — those invalidate plan-bound Audit tokens.
 */
export async function cancelPendingAuditForPublish(
    planToken: string,
    jobId?: string | null,
): Promise<CancelPendingAuditForPublishResult> {
    return invoke<CancelPendingAuditForPublishResult>('ai_cancel_pending_audit_for_publish', {
        planToken,
        jobId: jobId?.trim() ? jobId : null,
    });
}

/**
 * Atomic preflight session cancel/reconcile.
 * Cancels the related audit job (when known), invalidates the plan token, writes a
 * cancellation tombstone, and emits `preflight-session-changed`.
 * `jobId` is optional; when omitted Rust resolves the job from plan-bound evidence.
 */
export async function cancelPreflightSession(
    planToken: string,
    jobId?: string | null,
): Promise<CancelPreflightSessionResult> {
    return invoke<CancelPreflightSessionResult>('ai_cancel_preflight_session', {
        planToken,
        jobId: jobId?.trim() ? jobId : null,
    });
}

/**
 * Subscribe to sanitized preflight session lifecycle events.
 * Returns the Tauri unlisten function (or a no-op when listen is unavailable).
 */
export async function subscribePreflightSessionChanged(
    handler: (payload: PreflightSessionChangedPayload) => void,
): Promise<UnlistenFn> {
    return listen<PreflightSessionChangedPayload>(PREFLIGHT_SESSION_CHANGED_EVENT, (event) => {
        handler(event.payload);
    });
}

export function canPublishAudit(decision: AiAuditResult['decision'], acknowledgements: {
    warning: boolean;
    critical: boolean;
    pending: boolean;
}): boolean {
    if (decision === 'GO') return true;
    if (decision === 'WARNING') return acknowledgements.warning;
    if (decision === 'NO_GO') return acknowledgements.critical;
    if (decision === 'PENDING') return acknowledgements.pending;
    return false;
}

export function readFriendlyError(error: unknown, fallback: string): string {
    return typeof error === 'string' ? error : error instanceof Error ? error.message : fallback;
}

export async function inspectPublishPlan(token: string): Promise<PublishPlan | null> {
    const result = await invoke<{ plan?: PublishPlan | null }>('inspect_plan', { token });
    return result.plan ?? null;
}

/** Sanitized active AI jobs for the global status strip (never full AiJob list). */
export async function listActiveAiJobs(): Promise<ActiveAiJobSummary[]> {
    return invoke<ActiveAiJobSummary[]>('ai_list_active_jobs');
}

/**
 * Kind-dispatching strip cancel. Rust resolves Audit/plan-bound association;
 * React never chooses the authority path.
 */
export async function cancelActiveAiJob(jobId: string): Promise<ActiveAiJobCancelResult> {
    return invoke<ActiveAiJobCancelResult>('ai_cancel_active_job', { jobId });
}
