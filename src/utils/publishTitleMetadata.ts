export interface ParsedTitleDetails {
    title: string;
    episode: string;
    resolution: string;
}

export interface PublishTitleMetadata {
    episode: string;
    resolution: string;
}

export interface PublishTitleTemplate {
    ep_pattern: string;
    resolution_pattern: string;
    title_pattern: string;
}

export interface PublishTitleMetadataDraft {
    title: string;
    episode: string;
    resolution: string;
    is_title_overridden: boolean;
}

export interface ParseTitleDetailsRequest {
    filename: string;
    epPattern: string;
    resolutionPattern: string;
    titlePattern: string;
}

export type ParseTitleDetails = (request: ParseTitleDetailsRequest) => Promise<ParsedTitleDetails>;

const blankMetadata = (): PublishTitleMetadata => ({
    episode: '',
    resolution: '',
});

export async function resolvePublishTitleMetadata({
    finalTitle,
    fallbackFilename,
    template,
    parseTitleDetails,
}: {
    finalTitle: string;
    fallbackFilename?: string;
    template: PublishTitleTemplate;
    parseTitleDetails: ParseTitleDetails;
}): Promise<PublishTitleMetadata> {
    const normalizedFinalTitle = finalTitle.trim();
    const filename = normalizedFinalTitle || fallbackFilename?.trim();

    if (!filename) {
        return blankMetadata();
    }

    try {
        const details = await parseTitleDetails({
            filename,
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        });

        return {
            episode: details.episode.trim(),
            resolution: details.resolution.trim(),
        };
    } catch {
        return blankMetadata();
    }
}

export async function resolveOverriddenDraftPublishMetadata<Draft extends PublishTitleMetadataDraft>({
    draft,
    fallbackFilename,
    template,
    parseTitleDetails,
}: {
    draft: Draft;
    fallbackFilename?: string;
    template: PublishTitleTemplate;
    parseTitleDetails: ParseTitleDetails;
}): Promise<Draft> {
    if (!draft.is_title_overridden) {
        return draft;
    }

    const metadata = await resolvePublishTitleMetadata({
        finalTitle: draft.title,
        fallbackFilename,
        template,
        parseTitleDetails,
    });

    return {
        ...draft,
        ...metadata,
    };
}
