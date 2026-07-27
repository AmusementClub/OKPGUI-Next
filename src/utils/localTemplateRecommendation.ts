import type { QuickPublishTemplate } from './quickPublish';

export interface LocalTemplateRecommendation {
    templateId: string;
    score: number;
    reasons: string[];
}

const TECHNICAL_TOKENS = new Set([
    '1080p', '1080i', '720p', '2160p', '4k', '8k',
    'avc', 'h264', 'x264', 'hevc', 'h265', 'x265', 'av1',
    'aac', 'flac', 'opus', 'web', 'webdl', 'webrip', 'bluray', 'bdrip',
    '10bit', '8bit', 'mkv', 'mp4', 'torrent',
]);

function normalizeText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/\.(torrent|mkv|mp4)$/iu, '')
        .replace(/\b(?:s\d{1,2}e\d{1,4}|ep?\.?\s*\d{1,4}|\d{1,4}v\d)\b/giu, ' ')
        .replace(/[\[\](){}【】（）]/gu, ' ')
        .replace(/(?:发布模板|快速发布|模板|发布)/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function meaningfulTokens(value: string): string[] {
    return normalizeText(value)
        .split(/\s+/u)
        .filter((token) => token.length >= 2 && !TECHNICAL_TOKENS.has(token));
}

function compact(value: string): string {
    return meaningfulTokens(value).join('');
}

function bigrams(value: string): Set<string> {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) {
        result.add(value.slice(index, index + 2));
    }
    return result;
}

function diceSimilarity(left: string, right: string): number {
    if (left.length < 2 || right.length < 2) return 0;
    const leftBigrams = bigrams(left);
    const rightBigrams = bigrams(right);
    let intersection = 0;
    for (const value of leftBigrams) {
        if (rightBigrams.has(value)) intersection += 1;
    }
    return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function scoreTemplate(torrentName: string, template: QuickPublishTemplate): LocalTemplateRecommendation {
    const sourceCompact = compact(torrentName);
    const nameCompact = compact(template.name || template.id);
    const titleCompact = compact(template.title);
    const summaryCompact = compact(template.summary);
    const reasons: string[] = [];
    let score = 0;

    if (nameCompact.length >= 3 && sourceCompact.includes(nameCompact)) {
        score = 100;
        reasons.push('种子名称完整包含模板名称');
    } else if (nameCompact.length >= 4 && nameCompact.includes(sourceCompact)) {
        score = 90;
        reasons.push('模板名称完整包含种子作品名');
    } else {
        const similarity = diceSimilarity(sourceCompact, nameCompact);
        score = Math.round(similarity * 70);
        if (similarity >= 0.6) reasons.push('模板名称与种子作品名高度相似');
    }

    if (titleCompact.length >= 3 && sourceCompact.includes(titleCompact)) {
        score += 20;
        reasons.push('种子名称匹配模板标题');
    }
    if (summaryCompact.length >= 3 && sourceCompact.includes(summaryCompact)) {
        score += 10;
        reasons.push('种子名称匹配模板摘要');
    }

    return {
        templateId: template.id,
        score: Math.min(score, 120),
        reasons,
    };
}

export function recommendLocalTemplate(
    torrentName: string,
    templates: Record<string, QuickPublishTemplate>,
): LocalTemplateRecommendation | null {
    if (!torrentName.trim()) return null;

    const ranked = Object.entries(templates)
        .map(([id, template]) => scoreTemplate(torrentName, {
            ...template,
            id: template.id || id,
        }))
        .sort((left, right) => right.score - left.score || left.templateId.localeCompare(right.templateId));
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (!best || best.score < 65) return null;
    if (runnerUp && best.score - runnerUp.score < 15) return null;
    return best;
}
