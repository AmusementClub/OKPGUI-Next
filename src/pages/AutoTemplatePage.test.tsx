import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutoTemplatePage from './AutoTemplatePage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invokeMock(...args),
}));

const readySettings = {
    provider: 'open_ai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-test',
    mode: 'auto',
    auth_mode: 'bearer',
    custom_header_name: null,
    credential_ref: { id: 'cred-1', backend: 'keyring', label: 't' },
    enabled: true,
    capability: { state: 'ready', output_capability: 'strict_schema', identity_matches: true },
    discovered_models: [],
    models_fetched_at_unix: null,
};

const recommendation = {
    recommendation_id: 'rec_test_1',
    template_id: 't1',
    template_revision: 3,
    template_digest: 'sha256:t1',
    template_name: '模板一',
    summary: '推荐模板「模板一」(revision 3)',
    alternatives: [
        {
            template_id: 't2',
            template_revision: 1,
            template_digest: 'sha256:t2',
            name: '模板二',
            summary: '备选',
        },
    ],
    torrent_digest: 'sha256:torrent',
    torrent_name: 'show.mkv',
    catalog_hash: 'sha256:catalog',
    generation: 1,
    expires_at_unix: Math.floor(Date.now() / 1000) + 600,
};

function defaultInvoke(command: string) {
    switch (command) {
        case 'ai_get_settings':
            return Promise.resolve(readySettings);
        case 'get_config':
            return Promise.resolve({
                quick_publish_templates: {
                    t1: { name: '模板一', revision: 3 },
                    t2: { name: '模板二', revision: 1 },
                },
            });
        case 'ai_start_template_selection':
            return Promise.resolve({
                job_id: 'job-sel-1',
                state: 'succeeded',
                request_generation: 0,
                snapshot_hash: 'sha256:catalog',
                progress: 100,
                message: 'selected',
                recommendation,
                seed: null,
            });
        case 'ai_poll_template_selection':
            return Promise.resolve({
                job_id: 'job-sel-1',
                state: 'succeeded',
                request_generation: 0,
                snapshot_hash: 'sha256:catalog',
                progress: 100,
                recommendation,
                seed: null,
            });
        case 'ai_review_template_recommendation':
            return Promise.resolve({
                status: 'minted',
                recommendation_id: 'rec_test_1',
                seed: {
                    token: 'seed_minted_1',
                    template_id: 't1',
                    template_revision: 3,
                    template_digest: 'sha256:t1',
                    torrent_name: 'show.mkv',
                },
                message: '已生成一次性发布种子。',
            });
        case 'ai_cancel_job':
            return Promise.resolve({
                id: 'job-sel-1',
                kind: 'template_selection',
                state: 'cancelled',
                request_generation: 0,
                snapshot_hash: 'sha256:catalog',
                progress: 100,
            });
        case 'ai_get_job':
            return Promise.resolve(null);
        default:
            return Promise.reject(`unexpected command ${command}`);
    }
}

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('AutoTemplatePage', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockImplementation(defaultInvoke);
        window.localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    async function runSelectionToRecommendation() {
        await act(async () => {
            root.render(<AutoTemplatePage />);
        });
        await flush();
        const input = container.querySelector<HTMLInputElement>('input[placeholder="/path/to/file.torrent"]');
        expect(input).toBeTruthy();
        await act(async () => {
            if (!input) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, '/mock/show.torrent');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const startBtn = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('开始自动选择'),
        );
        expect(startBtn).toBeTruthy();
        await act(async () => {
            startBtn?.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flush();
    }

    it('stays on result view with recommendation and does not mint seed on success', async () => {
        const navigate = vi.fn();
        const onNavigate = (event: Event) => navigate((event as CustomEvent).detail);
        window.addEventListener('okpgui:navigate', onNavigate);

        await runSelectionToRecommendation();
        expect(container.querySelector('[data-testid="auto-template-recommendation"]')).toBeTruthy();
        expect(
            container.querySelector('[data-testid="auto-template-recommendation-summary"]')?.textContent,
        ).toContain('模板一');
        expect(container.querySelector('[data-testid="auto-template-alternatives"]')).toBeTruthy();
        expect(window.localStorage.getItem('okpgui:autoTemplateSeed')).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
        expect(
            invokeMock.mock.calls.some(([command]) => command === 'ai_review_template_recommendation'),
        ).toBe(false);

        window.removeEventListener('okpgui:navigate', onNavigate);
    });

    it('explicit Review mints seed, writes handoff, and navigates', async () => {
        const navigate = vi.fn();
        const onNavigate = (event: Event) => navigate((event as CustomEvent).detail);
        window.addEventListener('okpgui:navigate', onNavigate);

        await runSelectionToRecommendation();
        const reviewBtn = container.querySelector<HTMLButtonElement>('[data-testid="auto-template-review"]');
        expect(reviewBtn).toBeTruthy();
        await act(async () => {
            reviewBtn?.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flush();

        expect(
            invokeMock.mock.calls.some(([command]) => command === 'ai_review_template_recommendation'),
        ).toBe(true);
        const raw = window.localStorage.getItem('okpgui:autoTemplateSeed');
        expect(raw).toBeTruthy();
        const handoff = JSON.parse(raw!);
        expect(handoff.token).toBe('seed_minted_1');
        expect(handoff.template_id).toBe('t1');
        expect(navigate).toHaveBeenCalledWith('quick_publish');

        window.removeEventListener('okpgui:navigate', onNavigate);
    });

    it('cancel never mints or writes handoff', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_start_template_selection') {
                return Promise.resolve({
                    job_id: 'job-running',
                    state: 'running',
                    request_generation: 0,
                    snapshot_hash: 'sha256:catalog',
                    progress: 10,
                    recommendation: null,
                    seed: null,
                });
            }
            return defaultInvoke(command);
        });

        await act(async () => {
            root.render(<AutoTemplatePage />);
        });
        await flush();
        const input = container.querySelector<HTMLInputElement>('input[placeholder="/path/to/file.torrent"]');
        await act(async () => {
            if (!input) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, '/mock/show.torrent');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const startBtn = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('开始自动选择'),
        );
        await act(async () => {
            startBtn?.click();
            await Promise.resolve();
        });
        await flush();
        const cancelBtn = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent?.includes('取消'),
        );
        expect(cancelBtn).toBeTruthy();
        await act(async () => {
            cancelBtn?.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flush();
        expect(container.querySelector('[data-testid="auto-template-error"]')?.textContent).toContain('取消');
        expect(window.localStorage.getItem('okpgui:autoTemplateSeed')).toBeNull();
        expect(
            invokeMock.mock.calls.some(([command]) => command === 'ai_review_template_recommendation'),
        ).toBe(false);
    });

    it('manual choose navigates without mint', async () => {
        const navigate = vi.fn();
        const onNavigate = (event: Event) => navigate((event as CustomEvent).detail);
        window.addEventListener('okpgui:navigate', onNavigate);

        await runSelectionToRecommendation();
        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="auto-template-choose-manual"]')?.click();
        });
        expect(navigate).toHaveBeenCalledWith('quick_publish');
        expect(window.localStorage.getItem('okpgui:autoTemplateSeed')).toBeNull();
        expect(
            invokeMock.mock.calls.some(([command]) => command === 'ai_review_template_recommendation'),
        ).toBe(false);

        window.removeEventListener('okpgui:navigate', onNavigate);
    });

    it('already_consumed Review surfaces error without handoff', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_review_template_recommendation') {
                return Promise.resolve({
                    status: 'already_consumed',
                    recommendation_id: 'rec_test_1',
                    seed: null,
                    message: '该推荐生成的种子已被模板发布消费，请重新自动选择模板。',
                });
            }
            return defaultInvoke(command);
        });

        await runSelectionToRecommendation();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-testid="auto-template-review"]')?.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flush();
        expect(container.querySelector('[data-testid="auto-template-error"]')?.textContent).toContain('消费');
        expect(window.localStorage.getItem('okpgui:autoTemplateSeed')).toBeNull();
    });

    it('expired recommendation Review shows terminal error without handoff', async () => {
        invokeMock.mockImplementation((command: string) => {
            if (command === 'ai_review_template_recommendation') {
                return Promise.reject('template recommendation is missing, expired, or already discarded');
            }
            return defaultInvoke(command);
        });

        await runSelectionToRecommendation();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-testid="auto-template-review"]')?.click();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flush();
        expect(container.querySelector('[data-testid="auto-template-error"]')?.textContent).toMatch(
            /expired|失败|审阅|missing/i,
        );
        expect(window.localStorage.getItem('okpgui:autoTemplateSeed')).toBeNull();
    });
});
