import { invoke } from '@tauri-apps/api/core';
import type {
    AiAuditResult,
    AiCapabilityStatus,
    AiFormalAuditRequest,
    AiJob,
    AiModelDiscoveryResult,
    AiRecognizeRequest,
    AiSelectTemplateRequest,
    AiSettings,
    AutoTemplateSeedHandoff,
    ConsumedTemplateSeed,
    PlanPrepareResponse,
    PlanVisionBindRequest,
    PlanVisionBindResponse,
    PlanVisionCandidatesResponse,
    PublishPlan,
    PublishRequestPayload,
    RecognitionJobView,
    RecognitionResult,
    TemplateSeed,
    TemplateSelectionJobView,
} from '../types/ai';

export const AUTO_TEMPLATE_SEED_STORAGE_KEY = 'okpgui:autoTemplateSeed';

export const disabledAiSettings: AiSettings = {
    provider: 'open_ai',
    endpoint: 'https://api.openai.com/v1',
    model: '',
    mode: 'auto',
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

/** Formal AI tasks require a Ready capability whose identity matches the stored connection. */
export function isAiCapabilityReady(settings: AiSettings | null | undefined): boolean {
    return Boolean(settings?.capability)
        && settings?.capability?.state === 'ready'
        && Boolean(settings?.capability?.identity_matches);
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
 * Refresh provider model list for the saved connection.
 * Never returns secrets; on failure sets manual_fallback so the UI keeps a manual model.
 * Disabled AI must not be called (backend also zero-networks).
 */
export async function listAiModels(): Promise<AiModelDiscoveryResult> {
    return invoke<AiModelDiscoveryResult>('ai_list_models');
}

/** Live backend-owned strict capability probe; persists non-secret Ready/Failed state. */
export async function runAiCapabilityProbe(): Promise<AiCapabilityStatus> {
    return invoke<AiCapabilityStatus>('ai_run_capability_probe');
}

/** Read current non-secret capability status (identity_matches uses stored credentials only). */
export async function getAiCapabilityStatus(): Promise<AiCapabilityStatus> {
    return invoke<AiCapabilityStatus>('ai_get_capability_status');
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
    return invoke<PlanPrepareResponse>('prepare_plan', {
        request: {
            request_generation: requestGeneration,
            request,
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

/**
 * @deprecated Backend owns snapshot identity. Kept as a no-op stub so non-owned
 * call sites compile; never hashes client data and never falls back to FNV.
 */
export async function snapshotHash(_request: PublishRequestPayload): Promise<string> {
    return '';
}

/** Invoke the Rust-owned formal audit path (local-only when AI is disabled; awaits terminal). */
export async function computeAiAudit(request: AiFormalAuditRequest): Promise<AiAuditResult> {
    return invoke<AiAuditResult>('ai_compute_audit', { request });
}

/**
 * Start a backend-owned Recognition job (returns immediately with queued/running view).
 * Provider work runs in the background; poll via pollRecognition; cancel via cancelAiJob.
 * Never mutates publish drafts or decisions; capability-gated on the backend.
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
 * Never mutates publish drafts or decisions; capability-gated on the backend.
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

/**
 * List Vision image candidates derived only from the prepared plan's final content.
 * Zero network; does not mutate the plan. Callers must not invent snapshot hashes.
 */
export async function listPlanVisionCandidates(
    planToken: string,
): Promise<PlanVisionCandidatesResponse> {
    return invoke<PlanVisionCandidatesResponse>('ai_list_plan_vision_candidates', {
        planToken,
    });
}

/**
 * Bind selected Vision images to a prepared plan token.
 * Backend fetches/normalizes, rolls the plan hash, and invalidates prior audit evidence.
 * Never accepts client-supplied image bytes, hashes, or decisions as authority.
 */
export async function bindPlanVision(
    request: PlanVisionBindRequest,
): Promise<PlanVisionBindResponse> {
    return invoke<PlanVisionBindResponse>('ai_bind_plan_vision', { request });
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

/** Module-scoped so React StrictMode remounts reuse the same one-shot consume. */
let autoTemplateSeedConsumeInFlight: Promise<ConsumedTemplateSeed | null> | null = null;

/**
 * Start a backend-owned TemplateSelection job.
 * Never invents a catalog pick client-side; seed is only present after poll reports succeeded.
 */
export async function startTemplateSelection(
    request: AiSelectTemplateRequest,
): Promise<TemplateSelectionJobView> {
    return invoke<TemplateSelectionJobView>('ai_start_template_selection', { request });
}

/**
 * Poll TemplateSelection job. Returns null while queued/running; terminal view when finished.
 * Cancelled/stale/failed never include a usable seed.
 */
export async function pollTemplateSelection(
    jobId: string,
): Promise<TemplateSelectionJobView | null> {
    return invoke<TemplateSelectionJobView | null>('ai_poll_template_selection', { jobId });
}

/** Whether a terminal TemplateSelection view may hand off an opaque seed. */
export function isSuccessfulTemplateSelection(
    view: TemplateSelectionJobView | null | undefined,
): boolean {
    return view?.state === 'succeeded' && Boolean(view.seed?.token && view.seed?.template_id);
}

/** Persist only opaque token + public template identity for AutoTemplate → QuickPublish handoff. */
export function writeAutoTemplateSeedHandoff(seed: Pick<TemplateSeed, 'token' | 'template_id'>): void {
    // A new handoff supersedes any prior in-flight/settled consume cycle.
    autoTemplateSeedConsumeInFlight = null;
    const handoff: AutoTemplateSeedHandoff = {
        token: seed.token,
        template_id: seed.template_id,
    };
    window.localStorage.setItem(AUTO_TEMPLATE_SEED_STORAGE_KEY, JSON.stringify(handoff));
}

/**
 * Peek handoff without clearing — used to wait for catalog load before consume.
 * Any torrent path present in a legacy payload is discarded.
 */
export function peekAutoTemplateSeedHandoff(): AutoTemplateSeedHandoff | null {
    const raw = window.localStorage.getItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
        const templateId = typeof parsed.template_id === 'string' ? parsed.template_id.trim() : '';
        if (!token || !templateId) {
            return null;
        }
        return { token, template_id: templateId };
    } catch {
        return null;
    }
}

/**
 * Read-and-clear handoff. Only opaque token + public template identity are returned.
 * Any torrent path present in a legacy payload is discarded and never used for hydration.
 */
export function takeAutoTemplateSeedHandoff(): AutoTemplateSeedHandoff | null {
    const handoff = peekAutoTemplateSeedHandoff();
    if (!handoff) {
        window.localStorage.removeItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
        return null;
    }
    window.localStorage.removeItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
    return handoff;
}

/**
 * Explicit terminal backend consume rejections that may clear the opaque handoff.
 * Transport/IPC failures must not match so a remount can retry the same handoff.
 */
function isTerminalTemplateSeedConsumeError(error: unknown): boolean {
    const message = readFriendlyError(error, '').toLowerCase();
    if (!message) {
        return false;
    }
    return (
        message.includes('missing')
        || message.includes('expired')
        || message.includes('already consumed')
        || message.includes('stale')
        || message.includes('replay')
        || message.includes('mismatch')
        || message.includes('revision')
        || message.includes('no longer a regular')
    );
}

/**
 * Consume a template seed exactly once via the backend (catalog + torrent gates).
 * Returns null on explicit missing/expired/replayed/stale/invalid payloads.
 * Rethrows transient invoke/transport errors so callers can leave the handoff recoverable.
 */
export async function consumeTemplateSeed(token: string): Promise<ConsumedTemplateSeed | null> {
    try {
        const result = await invoke<Record<string, unknown> | null>('ai_consume_template_seed', { token });
        if (!result || typeof result !== 'object') {
            return null;
        }

        const templateId = typeof result.template_id === 'string' ? result.template_id.trim() : '';
        const torrentPath = typeof result.torrent_path === 'string' ? result.torrent_path.trim() : '';
        const templateRevision = typeof result.template_revision === 'number'
            ? result.template_revision
            : Number(result.template_revision);
        const templateDigest = typeof result.template_digest === 'string'
            ? result.template_digest.trim()
            : '';

        if (!templateId || !torrentPath || !templateDigest || !Number.isFinite(templateRevision)) {
            return null;
        }

        return {
            template_id: templateId,
            template_revision: templateRevision,
            template_digest: templateDigest,
            torrent_path: torrentPath,
            torrent_name: typeof result.torrent_name === 'string' ? result.torrent_name : undefined,
        };
    } catch (error) {
        if (isTerminalTemplateSeedConsumeError(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * Peek the browser handoff (if any) and consume the backend seed exactly once.
 * Handoff remains in storage until consume succeeds so a mid-flight failure/crash
 * stays recoverable. Explicit terminal consume rejection clears the handoff;
 * transport failures leave it in place and clear the in-flight latch so remount can retry.
 * Safe under StrictMode: concurrent callers share one in-flight promise.
 */
export function takeAndConsumeAutoTemplateSeed(): Promise<ConsumedTemplateSeed | null> {
    if (autoTemplateSeedConsumeInFlight) {
        return autoTemplateSeedConsumeInFlight;
    }

    const handoff = peekAutoTemplateSeedHandoff();
    if (!handoff) {
        return Promise.resolve(null);
    }

    let consumePromise!: Promise<ConsumedTemplateSeed | null>;
    consumePromise = consumeTemplateSeed(handoff.token)
        .then((consumed) => {
            if (!consumed) {
                // Terminal backend rejection (missing/expired/replayed/stale/invalid): drop handoff.
                window.localStorage.removeItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
                return null;
            }
            // Only clear handoff after a successful backend consume.
            window.localStorage.removeItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
            return {
                ...consumed,
                // Prefer backend identity; fall back to public handoff id only if needed.
                template_id: consumed.template_id || handoff.template_id,
            };
        })
        .catch(() => {
            // Transient invoke/transport failure: leave opaque handoff for remount retry.
            // Drop the in-flight latch so a later attempt is not stuck on this rejection.
            if (autoTemplateSeedConsumeInFlight === consumePromise) {
                autoTemplateSeedConsumeInFlight = null;
            }
            // Resolve null without clearing storage; callers can peek handoff to distinguish.
            return null;
        });

    autoTemplateSeedConsumeInFlight = consumePromise;
    return consumePromise;
}

/** Mark the current seed cycle as fully applied so later page mounts do not re-hydrate it. */
export function acknowledgeAutoTemplateSeedHydration(): void {
    autoTemplateSeedConsumeInFlight = Promise.resolve(null);
}

/** Clear any in-flight consume so a failed hydration cannot be re-acked as success later. */
export function clearAutoTemplateSeedHydrationCycle(): void {
    autoTemplateSeedConsumeInFlight = Promise.resolve(null);
    window.localStorage.removeItem(AUTO_TEMPLATE_SEED_STORAGE_KEY);
}

/** True while a one-shot consume promise is active (including StrictMode remounts). */
export function hasAutoTemplateSeedConsumeInFlight(): boolean {
    return autoTemplateSeedConsumeInFlight !== null;
}
