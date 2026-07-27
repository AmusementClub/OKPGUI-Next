import { describe, expect, it } from 'vitest';
import { isAiCapabilityReady } from './ai';
import type { AiSettings } from '../types/ai';

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
