import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    canPublishAudit,
    cancelPendingAuditForPublish,
    computeAiAudit,
    isAiConfigured,
    preparePublishPlan,
    setPlanAcknowledgements,
    startFormalAudit,
} from './ai';
import type { AiSettings, PublishRequestPayload } from '../types/ai';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function configuredSettings(overrides: Partial<AiSettings> = {}): AiSettings {
    return {
        provider: 'open_ai',
        endpoint: 'https://example.test/v1',
        model: 'model',
        mode: 'chat',
        auth_mode: 'bearer',
        credential_ref: { id: 'credential' },
        enabled: true,
        capability: null,
        ...overrides,
    };
}

describe('isAiConfigured', () => {
    it('allows configured AI without a capability probe', () => {
        expect(isAiConfigured(configuredSettings())).toBe(true);
        expect(isAiConfigured(configuredSettings({ model: '' }))).toBe(false);
        expect(isAiConfigured(configuredSettings({ credential_ref: null }))).toBe(false);
    });
});

describe('preparePublishPlan', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue({});
    });

    it('sends content_root only as private prepare metadata', async () => {
        const request = {
            publish_id: 'publish-1',
            torrent_path: '/downloads/release.torrent',
            content_root: '/media/release',
            profile_name: 'default',
            template: {},
        } as PublishRequestPayload;

        await preparePublishPlan(request, 7);

        expect(invokeMock).toHaveBeenCalledWith('prepare_plan', {
            request: {
                request_generation: 7,
                content_root: '/media/release',
                request: {
                    publish_id: 'publish-1',
                    torrent_path: '/downloads/release.torrent',
                    profile_name: 'default',
                    template: {},
                },
            },
        });
    });
});

describe('computeAiAudit', () => {
    beforeEach(() => {
        invokeMock.mockReset();
    });

    it('sends plan_token and never invents a client snapshot authority', async () => {
        invokeMock.mockResolvedValue({
            decision: 'WARNING',
            findings: [],
            unknown_codes: [],
            local_blockers: [],
            formal_ran: true,
            job_id: 'job-1',
            plan_token: 'plan_abc',
            snapshot_hash: 'sha256:backend',
            request_generation: 2,
        });

        const result = await computeAiAudit({
            plan_token: 'plan_abc',
        });

        expect(invokeMock).toHaveBeenCalledWith('ai_compute_audit', {
            request: {
                plan_token: 'plan_abc',
            },
        });
        expect(result.plan_token).toBe('plan_abc');
        expect(result.snapshot_hash).toBe('sha256:backend');
    });
});

describe('formal audit IPC', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue({});
    });

    it('starts formal audit with only the backend plan token', async () => {
        await startFormalAudit({ plan_token: 'plan_abc' });

        expect(invokeMock).toHaveBeenCalledWith('ai_start_formal_audit', {
            request: { plan_token: 'plan_abc' },
        });
    });

    it('uses publish-safe cancellation without invalidating the plan token', async () => {
        await cancelPendingAuditForPublish('plan_abc', 'job_123');

        expect(invokeMock).toHaveBeenCalledWith('ai_cancel_pending_audit_for_publish', {
            planToken: 'plan_abc',
            jobId: 'job_123',
        });
    });
});

describe('setPlanAcknowledgements', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue(null);
    });

    it('binds acknowledgements to a plan token', async () => {
        await setPlanAcknowledgements('plan_abc', {
            warning: true,
            critical: false,
            pending: false,
        });
        expect(invokeMock).toHaveBeenCalledWith('set_plan_acknowledgements', {
            token: 'plan_abc',
            acknowledgements: { warning: true, critical: false, pending: false },
        });
    });
});

describe('canPublishAudit', () => {
    it('requires the matching acknowledgement for non-GO decisions', () => {
        expect(canPublishAudit('WARNING', { warning: false, critical: false, pending: false })).toBe(false);
        expect(canPublishAudit('WARNING', { warning: true, critical: false, pending: false })).toBe(true);
        expect(canPublishAudit('LOCAL_BLOCKED', { warning: true, critical: true, pending: true })).toBe(false);
        expect(canPublishAudit('PENDING', { warning: false, critical: false, pending: true })).toBe(true);
        expect(canPublishAudit('GO', { warning: false, critical: false, pending: false })).toBe(true);
    });
});
