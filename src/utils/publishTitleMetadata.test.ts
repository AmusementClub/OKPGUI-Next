import { describe, expect, it } from 'vitest';
import {
    ParseTitleDetails,
    ParseTitleDetailsRequest,
    ParsedTitleDetails,
    PublishTitleTemplate,
    resolveOverriddenDraftPublishMetadata,
    resolvePublishTitleMetadata,
} from './publishTitleMetadata';

const template: PublishTitleTemplate = {
    ep_pattern: String.raw`(?P<ep>\d+)`,
    resolution_pattern: String.raw`(?P<res>1080p|720p)`,
    title_pattern: '[<ep>][<res>]',
};

function details(episode: string, resolution: string): ParsedTitleDetails {
    return {
        title: '',
        episode,
        resolution,
    };
}

describe('resolvePublishTitleMetadata', () => {
    it('uses the final title before any torrent filename fallback', async () => {
        const calls: ParseTitleDetailsRequest[] = [];
        const parseTitleDetails: ParseTitleDetails = async (request) => {
            calls.push(request);
            return request.filename === '[01][1080p]'
                ? details('01', '1080p')
                : details('02', '720p');
        };

        const result = await resolvePublishTitleMetadata({
            finalTitle: ' [01][1080p] ',
            fallbackFilename: '[Group] Title S2 [02][720p].torrent',
            template,
            parseTitleDetails,
        });

        expect(result).toEqual({ episode: '01', resolution: '1080p' });
        expect(calls).toEqual([{
            filename: '[01][1080p]',
            epPattern: template.ep_pattern,
            resolutionPattern: template.resolution_pattern,
            titlePattern: template.title_pattern,
        }]);
    });

    it('uses the torrent filename fallback when the final title is blank', async () => {
        const calls: ParseTitleDetailsRequest[] = [];
        const parseTitleDetails: ParseTitleDetails = async (request) => {
            calls.push(request);
            return details('02', '720p');
        };

        const result = await resolvePublishTitleMetadata({
            finalTitle: '   ',
            fallbackFilename: ' [Group] Title S2 [02][720p].torrent ',
            template,
            parseTitleDetails,
        });

        expect(result).toEqual({ episode: '02', resolution: '720p' });
        expect(calls.map((call) => call.filename)).toEqual(['[Group] Title S2 [02][720p].torrent']);
    });

    it('returns blank metadata for a nonblank no-match without reparsing fallback', async () => {
        const calls: ParseTitleDetailsRequest[] = [];
        const parseTitleDetails: ParseTitleDetails = async (request) => {
            calls.push(request);
            return request.filename === 'manual title without metadata'
                ? details('', '')
                : details('02', '720p');
        };

        const result = await resolvePublishTitleMetadata({
            finalTitle: 'manual title without metadata',
            fallbackFilename: '[Group] Title S2 [02][720p].torrent',
            template,
            parseTitleDetails,
        });

        expect(result).toEqual({ episode: '', resolution: '' });
        expect(calls.map((call) => call.filename)).toEqual(['manual title without metadata']);
    });

    it('returns blank metadata for a nonblank parse error without reparsing fallback', async () => {
        const calls: ParseTitleDetailsRequest[] = [];
        const parseTitleDetails: ParseTitleDetails = async (request) => {
            calls.push(request);
            if (request.filename === 'manual title with invalid parser input') {
                throw new Error('invalid regex');
            }

            return details('02', '720p');
        };

        const result = await resolvePublishTitleMetadata({
            finalTitle: 'manual title with invalid parser input',
            fallbackFilename: '[Group] Title S2 [02][720p].torrent',
            template,
            parseTitleDetails,
        });

        expect(result).toEqual({ episode: '', resolution: '' });
        expect(calls.map((call) => call.filename)).toEqual(['manual title with invalid parser input']);
    });
});

describe('resolveOverriddenDraftPublishMetadata', () => {
    it('recomputes an overridden quick publish draft before confirm and publish use it', async () => {
        const calls: ParseTitleDetailsRequest[] = [];
        const parseTitleDetails: ParseTitleDetails = async (request) => {
            calls.push(request);
            return details('01', '1080p');
        };
        const staleDraft = {
            title: '[01][1080p]',
            episode: '02',
            resolution: '720p',
            is_title_overridden: true,
            torrent_path: '/tmp/title.torrent',
        };

        const result = await resolveOverriddenDraftPublishMetadata({
            draft: staleDraft,
            fallbackFilename: '[Group] Title S2 [02][720p].torrent',
            template,
            parseTitleDetails,
        });

        expect(result).toEqual({
            ...staleDraft,
            episode: '01',
            resolution: '1080p',
        });
        expect(calls.map((call) => call.filename)).toEqual(['[01][1080p]']);
    });
});
