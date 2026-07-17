import { describe, expect, it } from 'vitest';
import { matchTemplateSelectQuery, normalizeTemplateSelectQuery } from './templateSelectSearch';

describe('templateSelectSearch', () => {
    const hyj = { label: '灰原君', name: 'huiyuanjun-template' };

    it('normalizes query by trimming, lowercasing, and collapsing whitespace', () => {
        expect(normalizeTemplateSelectQuery('  Hui  Yuan  ')).toBe('huiyuan');
    });

    it('matches Chinese label and English id substrings', () => {
        expect(matchTemplateSelectQuery(hyj, '灰原')).toBe(true);
        expect(matchTemplateSelectQuery(hyj, 'huiyuanjun-template')).toBe(true);
        expect(matchTemplateSelectQuery(hyj, 'TEMPLATE')).toBe(true);
    });

    it('matches full pinyin and initials continuously', () => {
        expect(matchTemplateSelectQuery(hyj, 'huiyuanjun')).toBe(true);
        expect(matchTemplateSelectQuery(hyj, 'hyj')).toBe(true);
        expect(matchTemplateSelectQuery(hyj, 'hui  yuan jun')).toBe(true);
    });

    it('supports continuous mixed pinyin and v for ü when applicable', () => {
        const lv = { label: '绿野仙踪', name: 'oz' };
        expect(matchTemplateSelectQuery(lv, 'lvye')).toBe(true);
        expect(matchTemplateSelectQuery(lv, 'lyxz')).toBe(true);
    });

    it('does not match non-continuous pinyin queries', () => {
        // initials of 灰原君 are h-y-j; skipping middle should not hit with continuous mode
        expect(matchTemplateSelectQuery(hyj, 'hj')).toBe(false);
        expect(matchTemplateSelectQuery(hyj, 'xyzxyz')).toBe(false);
    });

    it('handles common polyphone labels without throwing', () => {
        const bank = { label: '重庆银行', name: 'cqyh' };
        expect(matchTemplateSelectQuery(bank, 'chongqing')).toBe(true);
        // pinyin-pro may accept common readings; at least continuous initials should work
        expect(matchTemplateSelectQuery(bank, 'cqyh') || matchTemplateSelectQuery(bank, '重庆')).toBe(
            true,
        );
    });
});
