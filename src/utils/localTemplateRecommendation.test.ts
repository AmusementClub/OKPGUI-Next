import { describe, expect, it } from 'vitest';
import { createDefaultQuickPublishTemplate } from './quickPublish';
import { recommendLocalTemplate } from './localTemplateRecommendation';

function template(id: string, name: string, title = '', summary = '') {
    return {
        ...createDefaultQuickPublishTemplate(),
        id,
        name,
        title,
        summary,
    };
}

describe('recommendLocalTemplate', () => {
    it('selects a unique exact title match while ignoring release metadata', () => {
        const result = recommendLocalTemplate(
            '[Group] Sousou no Frieren - 28 [1080p][HEVC].mkv',
            {
                frieren: template('frieren', 'Sousou no Frieren'),
                apothecary: template('apothecary', 'Kusuriya no Hitorigoto'),
            },
        );
        expect(result?.templateId).toBe('frieren');
        expect(result?.reasons).toContain('种子名称完整包含模板名称');
    });

    it('supports CJK names without whitespace tokenization', () => {
        expect(recommendLocalTemplate('葬送的芙莉莲 第28话 1080P', {
            frieren: template('frieren', '葬送的芙莉莲'),
        })?.templateId).toBe('frieren');
    });

    it('abstains when candidates tie or confidence is low', () => {
        expect(recommendLocalTemplate('Frieren 28', {
            one: template('one', 'Frieren A'),
            two: template('two', 'Frieren B'),
        })).toBeNull();
        expect(recommendLocalTemplate('Unrelated Release', {
            one: template('one', 'Frieren'),
        })).toBeNull();
    });
});
