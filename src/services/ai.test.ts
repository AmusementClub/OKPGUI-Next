import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAiConfigured, preparePublishPlan } from './ai';
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
