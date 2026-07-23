import { useEffect, useMemo, useState } from 'react';
import { Activity, BrainCircuit, KeyRound, RefreshCw, Save } from 'lucide-react';
import {
    getAiSettings,
    isAiCapabilityReady,
    listAiModels,
    readFriendlyError,
    runAiCapabilityProbe,
    saveAiSettings,
} from '../services/ai';
import type { AiAuthMode, AiMode, AiProvider, AiSettings } from '../types/ai';

function capabilityLabel(settings: AiSettings): string {
    const capability = settings.capability;
    if (!capability) {
        return '未探测';
    }
    if (capability.state === 'ready' && capability.identity_matches) {
        return `Ready（${capability.resolved_mode ?? settings.mode}）`;
    }
    if (capability.state === 'ready' && !capability.identity_matches) {
        return '连接已变更，需重新探测';
    }
    if (capability.state === 'probing') {
        return '探测中…';
    }
    if (capability.state === 'unsupported') {
        return '不支持 strict 结构化输出';
    }
    if (capability.state === 'failed') {
        return '探测失败';
    }
    return '未知';
}
export default function AiSettingsPage() {
    const [settings, setSettings] = useState<AiSettings | null>(null);
    const [secret, setSecret] = useState('');
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<'save' | 'models' | 'probe' | null>(null);

    const load = async () => {
        setError('');
        setSettings(await getAiSettings());
    };

    useEffect(() => { void load(); }, []);

    const update = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => {
        setSettings((current) => (current ? { ...current, [key]: value } : current));
        setStatus('');
    };

    const modelOptions = useMemo(() => {
        const discovered = settings?.discovered_models ?? [];
        const current = settings?.model?.trim() ? [settings.model.trim()] : [];
        return Array.from(new Set([...current, ...discovered]));
    }, [settings?.discovered_models, settings?.model]);

    const save = async () => {
        if (!settings) return;
        setError('');
        setBusy('save');
        try {
            const saved = await saveAiSettings(settings, secret);
            setSettings(saved);
            setSecret('');
            setStatus(
                saved.credential_session_only
                    ? '连接设置已保存；密钥仅保存在本会话中（未写入系统密钥环），退出后需重新输入。相关变更会使能力探测失效。'
                    : '连接设置已保存；密钥只保存在系统凭据存储中。相关变更会使能力探测失效。',
            );
        } catch (saveError) {
            setError(readFriendlyError(saveError, '保存 AI 连接失败。'));
        } finally {
            setBusy(null);
        }
    };

    const refreshModels = async () => {
        if (!settings) return;
        setError('');
        setBusy('models');
        try {
            // Persist draft connection first so discovery uses the intended endpoint/auth.
            const saved = await saveAiSettings(settings, secret);
            setSecret('');
            const discovery = await listAiModels();
            const next = await getAiSettings();
            setSettings({
                ...next,
                // Keep the in-form model if the user typed a manual id not in the list.
                model: saved.model || next.model,
                discovered_models: discovery.models,
                models_fetched_at_unix: discovery.fetched_at_unix,
            });
            if (discovery.manual_fallback) {
                setStatus(`模型列表刷新失败，可继续手动输入模型：${discovery.message}`);
            } else {
                setStatus(`已刷新 ${discovery.models.length} 个模型。`);
            }
        } catch (refreshError) {
            setError(readFriendlyError(refreshError, '刷新模型列表失败。'));
        } finally {
            setBusy(null);
        }
    };

    const runProbe = async () => {
        if (!settings) return;
        setError('');
        setBusy('probe');
        try {
            const saved = await saveAiSettings(settings, secret);
            setSecret('');
            const capability = await runAiCapabilityProbe();
            const next = await getAiSettings();
            setSettings({ ...next, model: saved.model || next.model, capability });
            if (capability.state === 'ready' && capability.identity_matches) {
                setStatus(`能力探测通过（${capability.resolved_mode ?? saved.mode}）。正式 AI 任务已解锁。`);
            } else {
                setStatus(capability.message || '能力探测未通过。');
            }
        } catch (probeError) {
            setError(readFriendlyError(probeError, '能力探测失败。'));
        } finally {
            setBusy(null);
        }
    };

    if (!settings) {
        return <div className="h-full overflow-y-auto p-6 text-sm text-slate-400">加载 AI 设置中...</div>;
    }

    const ready = isAiCapabilityReady(settings);

    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 p-6">
                <header>
                    <div className="flex items-center gap-2 text-emerald-300">
                        <BrainCircuit size={18} />
                        <span className="font-mono text-[11px] uppercase tracking-[0.18em]">AI CONNECTION</span>
                    </div>
                    <h2 className="mt-2 text-xl font-semibold text-slate-100">BYOK AI 连接</h2>
                    <p className="mt-1 text-sm text-slate-500">
                        AI 只提供建议和检查证据，发布仍由本地冻结计划控制。正式审计/自动选模板需先完成 strict 能力探测。
                    </p>
                </header>

                <section className="space-y-4 rounded-xl border border-slate-700 bg-slate-800/50 p-5">
                    <label className="flex items-center gap-3 text-sm text-slate-200">
                        <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={(event) => update('enabled', event.target.checked)}
                        />
                        启用 AI 建议层
                    </label>

                    <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-xs text-slate-500">
                            提供商
                            <select
                                value={settings.provider}
                                onChange={(event) => update('provider', event.target.value as AiProvider)}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                            >
                                <option value="open_ai">OpenAI 兼容</option>
                                <option value="anthropic">Anthropic</option>
                            </select>
                        </label>
                        <label className="text-xs text-slate-500">
                            调用模式
                            <select
                                value={settings.mode}
                                onChange={(event) => update('mode', event.target.value as AiMode)}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                            >
                                <option value="auto">自动</option>
                                <option value="responses">Responses strict</option>
                                <option value="chat">Chat strict</option>
                                <option value="anthropic_messages">Messages strict</option>
                            </select>
                        </label>
                    </div>

                    <label className="block text-xs text-slate-500">
                        接口地址
                        <input
                            value={settings.endpoint}
                            onChange={(event) => update('endpoint', event.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                            placeholder="https://api.openai.com/v1"
                        />
                    </label>

                    <div className="space-y-2">
                        <div className="flex flex-wrap items-end gap-2">
                            <label className="min-w-0 flex-1 text-xs text-slate-500">
                                模型（可从列表选择或手动输入）
                                <input
                                    list="ai-model-options"
                                    value={settings.model}
                                    onChange={(event) => update('model', event.target.value)}
                                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                                    placeholder="输入或选择模型名"
                                    aria-label="模型"
                                />
                                <datalist id="ai-model-options">
                                    {modelOptions.map((model) => (
                                        <option key={model} value={model} />
                                    ))}
                                </datalist>
                            </label>
                            <button
                                type="button"
                                onClick={() => void refreshModels()}
                                disabled={busy !== null || !settings.enabled}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                            >
                                <RefreshCw size={15} />
                                刷新模型
                            </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                            {settings.models_fetched_at_unix
                                ? `上次拉取 ${settings.discovered_models?.length ?? 0} 个模型；失败时可继续手动填写。`
                                : '尚未拉取模型列表；可直接手动填写模型名。'}
                        </p>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-xs text-slate-500">
                            认证
                            <select
                                value={settings.auth_mode}
                                onChange={(event) => update('auth_mode', event.target.value as AiAuthMode)}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                            >
                                <option value="bearer">Bearer</option>
                                <option value="anthropic_api_key">Anthropic API key</option>
                                <option value="custom_header">自定义 header</option>
                                <option value="none">无认证</option>
                            </select>
                        </label>
                        {settings.auth_mode === 'custom_header' ? (
                            <label className="text-xs text-slate-500">
                                自定义 header 名称
                                <input
                                    value={settings.custom_header_name ?? ''}
                                    onChange={(event) => update('custom_header_name', event.target.value)}
                                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                                />
                            </label>
                        ) : (
                            <div />
                        )}
                    </div>

                    {settings.auth_mode !== 'none' ? (
                        <label className="block text-xs text-slate-500">
                            <span className="flex items-center gap-1">
                                <KeyRound size={13} />
                                替换密钥
                            </span>
                            <input
                                type="password"
                                value={secret}
                                onChange={(event) => setSecret(event.target.value)}
                                autoComplete="new-password"
                                placeholder={settings.credential_ref ? '已配置，留空保持不变' : '输入后保存'}
                                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
                            />
                        </label>
                    ) : null}

                    <div className="rounded-lg border border-slate-700/80 bg-slate-900/60 px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <p className="text-xs font-medium text-slate-300">Strict 能力探测</p>
                                <p className="mt-1 text-sm text-slate-200" data-testid="capability-status">
                                    {capabilityLabel(settings)}
                                </p>
                                {settings.capability?.message ? (
                                    <p className="mt-1 text-[11px] text-slate-500">{settings.capability.message}</p>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                onClick={() => void runProbe()}
                                disabled={busy !== null || !settings.enabled}
                                className="inline-flex items-center gap-2 rounded-lg border border-emerald-700/60 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                                <Activity size={15} />
                                运行探测
                            </button>
                        </div>
                        <p className={`mt-2 text-[11px] ${ready ? 'text-emerald-300' : 'text-amber-300'}`}>
                            {ready
                                ? '正式审计与 AI 自动选模板已解锁。'
                                : '正式 AI 任务在探测 Ready 且与当前连接一致前不会发起网络请求。'}
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-4">
                        <button
                            type="button"
                            onClick={() => void save()}
                            disabled={busy !== null}
                            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                            <Save size={15} />
                            保存连接
                        </button>
                        <button
                            type="button"
                            onClick={() => void load()}
                            disabled={busy !== null}
                            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                        >
                            <RefreshCw size={15} />
                            重新加载
                        </button>
                        {settings.credential_ref ? (
                            settings.credential_session_only ? (
                                <span
                                    className="text-xs text-amber-300"
                                    data-testid="credential-session-only"
                                >
                                    密钥已配置（仅本会话，未持久化）
                                </span>
                            ) : (
                                <span className="text-xs text-emerald-300">密钥已配置</span>
                            )
                        ) : null}
                    </div>

                    {status ? <p className="text-xs text-emerald-300">{status}</p> : null}
                    {error ? <p className="text-xs text-rose-300">{error}</p> : null}
                </section>
            </div>
        </div>
    );
}
