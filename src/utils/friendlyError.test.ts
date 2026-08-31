import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage } from './friendlyError';

describe('friendlyErrorMessage', () => {
    it('passes through curated Chinese backend messages', () => {
        expect(friendlyErrorMessage('已存在同名身份配置: alpha', '回退。'))
            .toBe('已存在同名身份配置: alpha');
    });

    it('falls back for empty or non-string errors', () => {
        expect(friendlyErrorMessage('', '回退。')).toBe('回退。');
        expect(friendlyErrorMessage(undefined, '回退。')).toBe('回退。');
        expect(friendlyErrorMessage(null, '回退。')).toBe('回退。');
    });

    it('hides technical Rust and JS error noise behind the fallback', () => {
        expect(friendlyErrorMessage('Cookie capture task failed: JoinError::Cancelled', '回退。'))
            .toBe('回退。');
        expect(friendlyErrorMessage('No such file or directory (os error 2)', '回退。'))
            .toBe('回退。');
        expect(friendlyErrorMessage("thread 'main' panicked at src/config.rs:10", '回退。'))
            .toBe('回退。');
        expect(friendlyErrorMessage(new TypeError('Cannot read properties of undefined'), '回退。'))
            .toBe('回退。');
    });

    it('uses Error.message when it is human-readable', () => {
        expect(friendlyErrorMessage(new Error('导入失败，请重试。'), '回退。'))
            .toBe('导入失败，请重试。');
    });

    it('passes through short plain messages without technical markers', () => {
        expect(friendlyErrorMessage('template not found', '回退。')).toBe('template not found');
    });
});
