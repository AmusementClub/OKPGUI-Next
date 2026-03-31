import {
    DEFAULT_EP_PATTERN,
    DEFAULT_RESOLUTION_PATTERN,
    DEFAULT_TITLE_PATTERN,
    normalizeRuleTemplate,
} from './titleRules';

export interface SiteSelection {
    dmhy: boolean;
    nyaa: boolean;
    acgrip: boolean;
    bangumi: boolean;
    acgnx_asia: boolean;
    acgnx_global: boolean;
}

export interface SitePublishHistoryEntry {
    last_published_at: string;
    last_published_episode: string;
    last_published_resolution: string;
}

export type SitePublishHistory = Record<keyof SiteSelection, SitePublishHistoryEntry>;

export interface ContentTemplate {
    id: string;
    name: string;
    summary: string;
    markdown: string;
    html: string;
    site_notes: string;
    updated_at: string;
}

export interface QuickPublishTemplate {
    id: string;
    name: string;
    summary: string;
    title: string;
    ep_pattern: string;
    resolution_pattern: string;
    title_pattern: string;
    poster: string;
    about: string;
    tags: string;
    default_profile: string;
    default_sites: SiteSelection;
    body_markdown: string;
    body_html: string;
    shared_content_template_id: string | null;
    publish_history: SitePublishHistory;
    updated_at: string;
}

export interface QuickPublishRuntimeDraft {
    template_id: string | null;
    torrent_path: string;
    title: string;
    profile: string;
    sites: SiteSelection;
    poster: string;
    about: string;
    tags: string;
    shared_content_template_id: string | null;
    markdown: string;
    html: string;
    episode: string;
    resolution: string;
    is_content_overridden: boolean;
    is_title_overridden: boolean;
}

export interface LegacyPublishTemplatePayload {
    ep_pattern: string;
    resolution_pattern: string;
    title_pattern: string;
    poster: string;
    about: string;
    tags: string;
    description: string;
    description_html: string;
    profile: string;
    title: string;
    publish_history: SitePublishHistory;
    sites: SiteSelection;
}

export interface QuickPublishConfigPayload {
    last_used_quick_publish_template?: string | null;
    quick_publish_templates?: Record<string, Partial<QuickPublishTemplate>>;
    content_templates?: Record<string, Partial<ContentTemplate>>;
    okp_executable_path?: string;
}

export const quickPublishSiteKeys: (keyof SiteSelection)[] = [
    'dmhy',
    'nyaa',
    'acgrip',
    'bangumi',
    'acgnx_asia',
    'acgnx_global',
];

export const quickPublishSiteLabels: Record<keyof SiteSelection, string> = {
    dmhy: '动漫花园',
    nyaa: 'Nyaa',
    acgrip: 'ACG.RIP',
    bangumi: '萌番组',
    acgnx_asia: 'ACGNx Asia',
    acgnx_global: 'ACGNx Global',
};

export function createDefaultSiteSelection(): SiteSelection {
    return {
        dmhy: false,
        nyaa: false,
        acgrip: false,
        bangumi: false,
        acgnx_asia: false,
        acgnx_global: false,
    };
}

export function createDefaultPublishHistory(): SitePublishHistory {
    return {
        dmhy: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
        nyaa: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
        acgrip: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
        bangumi: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
        acgnx_asia: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
        acgnx_global: { last_published_at: '', last_published_episode: '', last_published_resolution: '' },
    };
}

export function createDefaultContentTemplate(): ContentTemplate {
    return {
        id: '',
        name: '',
        summary: '',
        markdown: '',
        html: '',
        site_notes: '',
        updated_at: '',
    };
}

export function createDefaultQuickPublishTemplate(): QuickPublishTemplate {
    return {
        id: '',
        name: '',
        summary: '',
        title: '',
        ep_pattern: DEFAULT_EP_PATTERN,
        resolution_pattern: DEFAULT_RESOLUTION_PATTERN,
        title_pattern: DEFAULT_TITLE_PATTERN,
        poster: '',
        about: '',
        tags: 'Anime',
        default_profile: '',
        default_sites: createDefaultSiteSelection(),
        body_markdown: '',
        body_html: '',
        shared_content_template_id: null,
        publish_history: createDefaultPublishHistory(),
        updated_at: '',
    };
}

export function createDefaultQuickPublishRuntimeDraft(): QuickPublishRuntimeDraft {
    return {
        template_id: null,
        torrent_path: '',
        title: '',
        profile: '',
        sites: createDefaultSiteSelection(),
        poster: '',
        about: '',
        tags: 'Anime',
        shared_content_template_id: null,
        markdown: '',
        html: '',
        episode: '',
        resolution: '',
        is_content_overridden: false,
        is_title_overridden: false,
    };
}

export function normalizePublishHistory(history?: Partial<SitePublishHistory>): SitePublishHistory {
    const defaults = createDefaultPublishHistory();

    return quickPublishSiteKeys.reduce((result, siteKey) => {
        const entry = history?.[siteKey];
        result[siteKey] = {
            last_published_at:
                typeof entry?.last_published_at === 'string'
                    ? entry.last_published_at
                    : defaults[siteKey].last_published_at,
            last_published_episode:
                typeof entry?.last_published_episode === 'string'
                    ? entry.last_published_episode
                    : defaults[siteKey].last_published_episode,
            last_published_resolution:
                typeof entry?.last_published_resolution === 'string'
                    ? entry.last_published_resolution
                    : defaults[siteKey].last_published_resolution,
        };
        return result;
    }, {} as SitePublishHistory);
}

export function normalizeSiteSelection(selection?: Partial<SiteSelection>): SiteSelection {
    return {
        ...createDefaultSiteSelection(),
        ...selection,
    };
}

export function normalizeContentTemplate(template?: Partial<ContentTemplate>): ContentTemplate {
    return {
        ...createDefaultContentTemplate(),
        ...template,
        id: typeof template?.id === 'string' ? template.id : '',
        name: typeof template?.name === 'string' ? template.name : '',
        summary: typeof template?.summary === 'string' ? template.summary : '',
        markdown: typeof template?.markdown === 'string' ? template.markdown : '',
        html: typeof template?.html === 'string' ? template.html : '',
        site_notes: typeof template?.site_notes === 'string' ? template.site_notes : '',
        updated_at: typeof template?.updated_at === 'string' ? template.updated_at : '',
    };
}

export function normalizeQuickPublishTemplate(
    template?: Partial<QuickPublishTemplate>,
): QuickPublishTemplate {
    const legacyTemplate = template as Partial<QuickPublishTemplate> & {
        content_template_id?: unknown;
    };

    return {
        ...createDefaultQuickPublishTemplate(),
        ...template,
        id: typeof template?.id === 'string' ? template.id : '',
        name: typeof template?.name === 'string' ? template.name : '',
        summary: typeof template?.summary === 'string' ? template.summary : '',
        title: typeof template?.title === 'string' ? template.title : '',
        ep_pattern: normalizeRuleTemplate(template?.ep_pattern, DEFAULT_EP_PATTERN),
        resolution_pattern: normalizeRuleTemplate(template?.resolution_pattern, DEFAULT_RESOLUTION_PATTERN),
        title_pattern: normalizeRuleTemplate(template?.title_pattern, DEFAULT_TITLE_PATTERN),
        poster: typeof template?.poster === 'string' ? template.poster : '',
        about: typeof template?.about === 'string' ? template.about : '',
        tags: typeof template?.tags === 'string' ? template.tags : 'Anime',
        default_profile:
            typeof template?.default_profile === 'string' ? template.default_profile : '',
        default_sites: normalizeSiteSelection(template?.default_sites),
        body_markdown: typeof template?.body_markdown === 'string' ? template.body_markdown : '',
        body_html: typeof template?.body_html === 'string' ? template.body_html : '',
        shared_content_template_id:
            typeof template?.shared_content_template_id === 'string'
                ? template.shared_content_template_id
                : typeof legacyTemplate.content_template_id === 'string'
                  ? legacyTemplate.content_template_id
                  : null,
        publish_history: normalizePublishHistory(template?.publish_history),
        updated_at: typeof template?.updated_at === 'string' ? template.updated_at : '',
    };
}

export function composePublishContent(bodyContent: string, sharedContent: string, separator = '\n\n'): string {
    const normalizedBody = bodyContent.trim();
    const normalizedShared = sharedContent.trim();

    if (!normalizedBody) {
        return normalizedShared;
    }

    if (!normalizedShared) {
        return normalizedBody;
    }

    return `${normalizedBody}${separator}${normalizedShared}`;
}

export function createTemplateIdFromName(name: string, fallbackPrefix: string): string {
    const normalized = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);

    if (normalized) {
        return normalized;
    }

    return `${fallbackPrefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createUpdatedAtTimestamp(): string {
    return new Date().toISOString();
}

export function getPublishedVersionLabel(entry: SitePublishHistoryEntry): string {
    const episode = entry.last_published_episode.trim();
    const resolution = entry.last_published_resolution.trim();

    if (episode && resolution) {
        return `${episode} / ${resolution}`;
    }

    return episode || resolution || '未发布';
}

export function buildLegacyPublishTemplatePayload(
    runtimeDraft: QuickPublishRuntimeDraft,
    template: QuickPublishTemplate,
): LegacyPublishTemplatePayload {
    return {
        ep_pattern: template.ep_pattern,
        resolution_pattern: template.resolution_pattern,
        title_pattern: template.title_pattern,
        poster: runtimeDraft.poster,
        about: runtimeDraft.about,
        tags: runtimeDraft.tags,
        description: runtimeDraft.markdown,
        description_html: runtimeDraft.html,
        profile: runtimeDraft.profile,
        title: runtimeDraft.title,
        publish_history: template.publish_history,
        sites: runtimeDraft.sites,
    };
}

export function buildRuntimeDraftFromTemplate(
    template: QuickPublishTemplate,
    contentTemplate?: ContentTemplate | null,
): QuickPublishRuntimeDraft {
    return {
        ...createDefaultQuickPublishRuntimeDraft(),
        template_id: template.id || null,
        title: template.title,
        profile: template.default_profile,
        sites: normalizeSiteSelection(template.default_sites),
        poster: template.poster,
        about: template.about,
        tags: template.tags,
        shared_content_template_id: template.shared_content_template_id,
        markdown: composePublishContent(template.body_markdown, contentTemplate?.markdown ?? ''),
        html: composePublishContent(template.body_html, contentTemplate?.html ?? '', '\n'),
    };
}
