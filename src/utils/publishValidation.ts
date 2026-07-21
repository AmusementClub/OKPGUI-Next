import { renderMarkdownToHtml } from './markdown';

export interface PublishContentValidationIssue {
    siteCode: string;
    siteLabel: string;
    message: string;
}

export interface PublishContentTemplateLike {
    description: string;
    description_html: string;
}

export interface PublishValidationSiteLike {
    key: string;
    label: string;
}

const htmlPreferredSiteKeys = new Set<string>(['dmhy', 'bangumi', 'acgnx_asia', 'acgnx_global']);
const markdownRequiredSiteKeys = new Set<string>(['nyaa', 'acgrip']);

export function isHtmlPreferredSite(siteKey: string): boolean {
    return htmlPreferredSiteKeys.has(siteKey);
}

export function validatePublishContentForSites(
    template: PublishContentTemplateLike,
    selectedSites: PublishValidationSiteLike[],
): PublishContentValidationIssue[] {
    const markdown = template.description.trim();
    const html = template.description_html.trim();
    const convertedHtml = markdown ? renderMarkdownToHtml(template.description).trim() : '';

    return selectedSites.flatMap((site) => {
        if (markdownRequiredSiteKeys.has(site.key) && !markdown) {
            return [{
                siteCode: site.key,
                siteLabel: site.label,
                message: `${site.label} 需要 Markdown 发布内容，请先填写 Markdown。`,
            }];
        }

        if (htmlPreferredSiteKeys.has(site.key) && !html && !convertedHtml) {
            return [{
                siteCode: site.key,
                siteLabel: site.label,
                message: `${site.label} 需要 HTML 内容，或可转换为 HTML 的 Markdown 发布内容。`,
            }];
        }

        return [];
    });
}
