/**
 * Deterministic mocked Tauri IPC/event bridge for browser/UI integration tests.
 *
 * This is not desktop E2E: production command handlers, keyring, MediaInfo
 * sidecars, and real OS IPC are not exercised. The mock is injected before any
 * page script so `@tauri-apps/api` resolve against `__TAURI_INTERNALS__`.
 */

export type InvokeHandler = (
  command: string,
  args?: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface MockAiSettings {
  provider: string;
  endpoint: string;
  model: string;
  mode: string;
  auth_mode: string;
  custom_header_name: string | null;
  credential_ref: { id: string } | null;
  enabled: boolean;
  capability: {
    state: string;
    identity_digest: string;
    message: string;
    identity_matches: boolean;
    resolved_mode?: string | null;
    output_capability?: 'strict_schema' | 'json_object' | null;
  } | null;
  discovered_models: string[];
  models_fetched_at_unix: number | null;
  credential_session_only?: boolean;
}

export interface BridgeState {
  settings: MockAiSettings;
  invokeLog: Array<{ command: string; args?: Record<string, unknown> }>;
  publishCalls: number;
  formalAuditStarts: number;
  seedHandoff: { seed_id: string } | null;
  acknowledgements: { warning: boolean; critical: boolean; pending: boolean };
  decision: 'GO' | 'WARNING' | 'NO_GO' | 'PENDING' | 'LOCAL_BLOCKED';
}

export function defaultDisabledSettings(): MockAiSettings {
  return {
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
}

export function defaultReadySettings(): MockAiSettings {
  return {
    provider: 'open_ai',
    endpoint: 'https://example.test/v1',
    model: 'mock-gpt-contract',
    mode: 'chat',
    auth_mode: 'bearer',
    custom_header_name: null,
    credential_ref: { id: 'cred-mock-1' },
    enabled: true,
    capability: {
      state: 'ready',
      identity_digest: 'sha256:mock-identity',
      message: 'strict structured output is available',
      identity_matches: true,
      resolved_mode: 'chat',
      output_capability: 'strict_schema',
    },
    discovered_models: ['mock-gpt-contract', 'mock-gpt-mini'],
    models_fetched_at_unix: 1,
  };
}

export function buildDefaultBridgeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    settings: defaultReadySettings(),
    invokeLog: [],
    publishCalls: 0,
    formalAuditStarts: 0,
    seedHandoff: null,
    acknowledgements: { warning: false, critical: false, pending: false },
    decision: 'GO',
    ...overrides,
  };
}

/**
 * Source text installed via page.addInitScript. Kept as a string factory so the
 * mock runs in the page context without bundling Node modules into the browser.
 */
export function tauriMockInitScript(initial: BridgeState): string {
  const payload = JSON.stringify(initial);
  return `(() => {
    const state = ${payload};
    window.__OKPGUI_UI_BRIDGE__ = state;

    const emptyCookies = () => ({
      dmhy: { raw_text: '' },
      nyaa: { raw_text: '' },
      acgrip: { raw_text: '' },
      bangumi: { raw_text: '' },
    });

    const profile = () => ({
      user_agent: '',
      site_cookies: emptyCookies(),
      dmhy_name: 'u',
      nyaa_name: 'u',
      acgrip_name: 'u',
      acgrip_api_token: 'token',
      bangumi_name: 'u',
      acgnx_asia_name: 'u',
      acgnx_asia_token: 't',
      acgnx_global_name: 'u',
      acgnx_global_token: 't',
    });

    const planView = () => ({
      token: 'plan-mock-token',
      snapshot_hash: 'sha256:mock-snapshot',
      request_generation: 1,
      title: 'Mock Release Title',
      local_blockers: [],
    });

    const auditFor = (decision) => ({
      decision,
      findings: decision === 'GO' ? [] : [{
        code: decision === 'WARNING' ? 'WARN_GENERIC' : 'CRIT_GENERIC',
        severity: decision === 'WARNING' ? 'WARNING' : 'CRITICAL',
        message: decision === 'WARNING' ? 'mock warning finding' : 'mock critical finding',
      }],
      unknown_codes: [],
      formal_ran: state.settings.enabled === true,
      job_id: state.settings.enabled ? 'job-mock-1' : null,
      snapshot_hash: 'sha256:mock-snapshot',
      request_generation: 1,
      local_blockers: decision === 'LOCAL_BLOCKED' ? ['mock local blocker'] : [],
    });

    async function defaultInvoke(command, args) {
      state.invokeLog.push({ command, args: args || {} });
      switch (command) {
        case 'ai_get_settings':
          return state.settings;
        case 'ai_save_settings': {
          const connection = (args && args.connection) || {};
          state.settings = {
            ...state.settings,
            ...connection,
            credential_ref: connection.credential_ref
              || state.settings.credential_ref
              || (args && args.secret ? { id: 'cred-mock-1' } : null),
          };
          // Never echo secrets into settings.
          return { ...state.settings };
        }
        case 'ai_list_models':
          return {
            models: (args?.connection?.discovered_models?.length > 0)
              ? args.connection.discovered_models
              : ['mock-gpt-contract'],
            fetched_at_unix: 99,
            manual_fallback: false,
            message: 'ok',
          };
        case 'ai_run_capability_probe':
          state.settings.capability = {
            state: 'ready',
            identity_digest: 'sha256:mock-identity',
            message: 'strict structured output is available',
            identity_matches: true,
            resolved_mode: state.settings.mode === 'auto' ? 'chat' : state.settings.mode,
            output_capability: 'strict_schema',
          };
          return state.settings.capability;
        case 'ai_get_capability_status':
          return state.settings.capability || {
            state: 'unknown',
            identity_digest: '',
            message: 'no capability probe has been run',
            identity_matches: false,
          };
        case 'get_config':
          return {
            last_used_template: 'default',
            last_used_quick_publish_template: 'qp-default',
            okp_executable_path: '/mock/okp',
            templates: {
              default: {
                title: 'Mock Title',
                profile: 'p1',
                content: 'mock body',
                sites: { dmhy: true, nyaa: false, acgrip: false, bangumi: false, acgnx_asia: false, acgnx_global: false },
              },
            },
            quick_publish_templates: {
              'qp-default': {
                name: 'qp-default',
                title: 'QP Mock',
                profile: 'p1',
                content: 'qp body',
                sites: { dmhy: true, nyaa: false, acgrip: false, bangumi: false, acgnx_asia: false, acgnx_global: false },
              },
            },
            content_templates: {},
          };
        case 'get_profile_list':
          return ['p1'];
        case 'get_profiles':
          return { profiles: { p1: profile() } };
        case 'parse_torrent':
          return {
            name: 'Mock.Torrent',
            total_size: 1024,
            files: [{ path: 'video.mkv', size: 1024 }],
            file_tree: { name: 'Mock.Torrent', children: [] },
            info_hash: 'a'.repeat(40),
          };
        case 'prepare_plan':
          return {
            token: 'plan-mock-token',
            snapshot_hash: 'sha256:mock-snapshot',
            request_generation: (args && args.requestGeneration) || 1,
            plan: planView(),
            audit: auditFor(state.decision),
          };
        case 'inspect_plan':
          return {
            token: 'plan-mock-token',
            snapshot_hash: 'sha256:mock-snapshot',
            plan: planView(),
            audit: auditFor(state.decision),
            acknowledgements: state.acknowledgements,
          };
        case 'set_plan_acknowledgements':
          state.acknowledgements = {
            warning: !!(args && args.acknowledgements && args.acknowledgements.warning),
            critical: !!(args && args.acknowledgements && args.acknowledgements.critical),
            pending: !!(args && args.acknowledgements && args.acknowledgements.pending),
          };
          return {
            token: 'plan-mock-token',
            acknowledgements: state.acknowledgements,
            can_publish: state.decision === 'GO'
              || (state.decision === 'WARNING' && state.acknowledgements.warning)
              || (state.decision === 'NO_GO' && state.acknowledgements.critical)
              || (state.decision === 'PENDING' && state.acknowledgements.pending),
          };
        case 'publish_prepared_plan':
          state.publishCalls += 1;
          return { ok: true, message: 'mock publish accepted' };
        case 'ai_start_formal_audit':
          state.formalAuditStarts += 1;
          return {
            state: 'succeeded',
            job_id: 'job-mock-1',
            audit: auditFor(state.decision),
          };
        case 'ai_poll_formal_audit':
          return {
            state: 'succeeded',
            job_id: 'job-mock-1',
            audit: auditFor(state.decision),
          };
        case 'ai_start_template_selection':
          return {
            job_id: 'job-template-1',
            state: 'running',
            request_generation: 1,
            snapshot_hash: 'sha256:catalog-mock',
            progress: 10,
            error_code: null,
            message: 'selecting',
            recommendation: null,
            seed: null,
          };
        case 'ai_poll_template_selection':
          return {
            job_id: 'job-template-1',
            state: 'succeeded',
            request_generation: 1,
            snapshot_hash: 'sha256:catalog-mock',
            progress: 100,
            error_code: null,
            message: 'matched',
            recommendation: {
              recommendation_id: 'rec-mock-1',
              template_id: 'qp-default',
              template_revision: 1,
              template_digest: 'sha256:template',
              template_name: 'Default QP',
              summary: '推荐模板「Default QP」(revision 1)',
              alternatives: [],
              torrent_digest: 'sha256:torrent',
              torrent_name: 'Mock.Torrent',
              catalog_hash: 'sha256:catalog-mock',
              generation: 1,
              expires_at_unix: Math.floor(Date.now() / 1000) + 600,
            },
            seed: null,
          };
        case 'ai_review_template_recommendation':
          state.seedHandoff = { seed_id: 'seed-mock-1' };
          return {
            status: 'minted',
            recommendation_id: 'rec-mock-1',
            seed: {
              token: 'seed-mock-1',
              template_id: 'qp-default',
              template_revision: 1,
              template_digest: 'sha256:template',
              torrent_name: 'Mock.Torrent',
            },
            message: '已生成一次性发布种子。',
          };
        case 'ai_prepare_template_seed':
          return {
            token: 'seed-mock-1',
            template_id: 'qp-default',
            template_revision: 1,
            template_digest: 'sha256:template',
            torrent_name: 'Mock.Torrent',
          };
        case 'ai_inspect_template_seed':
          return {
            token: 'seed-mock-1',
            template_id: 'qp-default',
            template_revision: 1,
            template_digest: 'sha256:template',
            torrent_name: 'Mock.Torrent',
          };
        case 'ai_consume_template_seed':
          return {
            template_id: 'qp-default',
            template_revision: 1,
            template_digest: 'sha256:template',
            torrent_path: '/mock/release.torrent',
            torrent_name: 'Mock.Torrent',
          };
        case 'ai_list_jobs':
          return [];
        case 'ai_list_active_jobs':
          return [];
        case 'ai_cancel_active_job':
          return {
            job_id: (args && args.jobId) || 'job-mock',
            kind: 'audit',
            job_state: 'cancelled',
            used_preflight_session: true,
            reconciled: true,
          };
        case 'ai_cancel_pending_audit_for_publish':
          return {
            job_state: 'cancelled',
            plan_token_live: true,
            decision: 'PENDING',
          };
        case 'ai_cancel_preflight_session':
          return {
            job_state: 'cancelled',
            token_state: 'invalidated',
            reconciled: true,
          };
        case 'ai_get_job':
          return null;
        case 'ai_cancel_job':
          return { ok: true };
        case 'ai_list_debug_records':
          return [];
        case 'save_template':
        case 'save_quick_publish_template':
        case 'set_last_used_template':
        case 'set_last_used_quick_publish_template':
          return args || {};
        default:
          return null;
      }
    }

    const callbacks = new Map();
    let nextCallbackId = 1;

    // Tauri 2 core.invoke reads window.__TAURI_INTERNALS__.invoke.
    // isTauri() checks window.isTauri — set both so app paths do not treat the page as browser-only.
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      plugins: {},
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      invoke: async (command, args) => defaultInvoke(command, args || {}),
      transformCallback: (callback, once) => {
        const id = nextCallbackId++;
        callbacks.set(id, { callback, once: !!once });
        return id;
      },
      unregisterCallback: (id) => {
        callbacks.delete(id);
      },
      runCallback: (id, data) => {
        const entry = callbacks.get(id);
        if (!entry) return;
        entry.callback(data);
        if (entry.once) callbacks.delete(id);
      },
      convertFileSrc: (filePath) => filePath,
    };

    // Minimal plugin stubs used by the app shell.
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  })();`;
}

export async function installTauriMock(
  page: {
    addInitScript: (script: string | (() => void)) => Promise<void>;
    // Playwright Page.context()
    context?: () => { addInitScript: (script: string | (() => void)) => Promise<void> };
    evaluate?: (fn: (code: string) => void, arg: string) => Promise<void>;
    url?: () => string;
  },
  state: BridgeState = buildDefaultBridgeState(),
): Promise<void> {
  const script = tauriMockInitScript(state);
  // Prefer context so every subsequent navigation gets the mock.
  if (typeof page.context === 'function') {
    await page.context().addInitScript(script);
  } else {
    await page.addInitScript(script);
  }
}

/**
 * Ensure the mock is present on the current document after `page.goto`.
 * Init scripts should already apply; this re-evaluates if a race left the page bare.
 */
export async function ensureTauriMockOnPage(
  page: {
    evaluate: (fn: ((code: string) => unknown) | (() => unknown), arg?: string) => Promise<unknown>;
  },
  state: BridgeState = buildDefaultBridgeState(),
): Promise<void> {
  // evaluate() serializes the function body to the browser — pure JS only (no TypeScript `as`).
  const present = await page.evaluate(() => {
    const w = window;
    return !!(w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke);
  });
  if (present) {
    return;
  }
  const script = tauriMockInitScript(state);
  await page.evaluate((code) => {
    // Test-only re-injection when init script did not attach.
    // eslint-disable-next-line no-eval, @typescript-eslint/no-implied-eval
    (0, eval)(code);
  }, script);
  const ok = await page.evaluate(() => {
    const w = window;
    return !!(w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke);
  });
  if (!ok) {
    throw new Error('Failed to install __TAURI_INTERNALS__ mock on page');
  }
}

export async function readBridgeState(
  page: { evaluate: (fn: () => unknown) => Promise<unknown> },
): Promise<BridgeState> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__OKPGUI_UI_BRIDGE__ as BridgeState;
  }) as Promise<BridgeState>;
}

export async function navigateToPage(
  page: {
    evaluate: (fn: (p: string) => void, arg: string) => Promise<void>;
  },
  pageKey: string,
): Promise<void> {
  await page.evaluate((key) => {
    window.dispatchEvent(new CustomEvent('okpgui:navigate', { detail: key }));
  }, pageKey);
}
