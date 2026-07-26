import { act, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flushAsync, renderElement } from '../test-utils/react';
import ModelCombobox from './ModelCombobox';

beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
});

function setInputValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function Harness({ onChange = vi.fn() }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState('');

    return (
        <ModelCombobox
            options={['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet']}
            value={value}
            onChange={(nextValue) => {
                setValue(nextValue);
                onChange(nextValue);
            }}
        />
    );
}

describe('ModelCombobox', () => {
    it('accepts a model id entered manually without a native datalist', async () => {
        const onChange = vi.fn();
        const rendered = await renderElement(<Harness onChange={onChange} />);
        const input = rendered.container.querySelector<HTMLInputElement>('input[aria-label="模型"]');

        expect(input).toBeTruthy();
        expect(rendered.container.querySelector('datalist')).toBeNull();

        await act(async () => {
            setInputValue(input!, 'custom-model-v2');
        });
        await flushAsync();

        expect(input!.value).toBe('custom-model-v2');
        expect(onChange).toHaveBeenLastCalledWith('custom-model-v2');
        expect(rendered.container.textContent).toContain('没有匹配的模型，可继续手动输入');
        await rendered.unmount();
    });

    it('opens the custom listbox, filters options, and selects a discovered model', async () => {
        const onChange = vi.fn();
        const rendered = await renderElement(<Harness onChange={onChange} />);
        const input = rendered.container.querySelector<HTMLInputElement>('input[aria-label="模型"]');
        const button = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="展开模型列表"]');

        expect(button).toBeTruthy();
        await act(async () => button!.click());
        await flushAsync();

        const listbox = rendered.container.querySelector<HTMLElement>('[role="listbox"]');
        expect(listbox).toBeTruthy();
        expect(listbox!.className).toContain('bg-slate-900/95');

        await act(async () => {
            setInputValue(input!, 'mini');
        });
        await flushAsync();

        const options = Array.from(rendered.container.querySelectorAll<HTMLElement>('[role="option"]'));
        expect(options.map((option) => option.textContent)).toEqual(['gpt-4o-mini']);

        await act(async () => {
            input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await flushAsync();

        expect(input!.value).toBe('gpt-4o-mini');
        expect(onChange).toHaveBeenLastCalledWith('gpt-4o-mini');
        await rendered.unmount();
    });
});
