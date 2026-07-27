import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAiCapabilityReady, preparePublishPlan } from './ai';
import type { AiSettings, PublishRequestPayload } from '../types/ai';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function settingsWithCapability(capability: AiSettings['capability']): AiSettings {
    return {
        provider: 'open_ai',
        endpoint: 'https://example.test/v1',
        model: 'model',
        mode: 'chat',
        auth_mode: 'bearer',
        credential_ref: { id: 'credential' },
        enabled: true,
        capability,
    };
}

describe('isAiCapabilityReady', () => {
    it('requires an explicit persisted output tier', () => {
        expect(isAiCapabilityReady(settingsWithCapability({
            state: 'ready',
            identity_digest: 'sha256:legacy',
            identity_matches: true,
            message: 'legacy ready record',
        }))).toBe(false);

        for (const output_capability of ['strict_schema', 'json_object'] as const) {
            expect(isAiCapabilityReady(settingsWithCapability({
                state: 'ready',
                identity_digest: `sha256:${output_capability}`,
                output_capability,
                identity_matches: true,
                message: 'ready',
            }))).toBe(true);
        }
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
