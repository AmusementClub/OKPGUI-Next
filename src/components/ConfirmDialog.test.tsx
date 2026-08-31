import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderElement } from '../test-utils/react';
import ConfirmDialog from './ConfirmDialog';

function findButton(text: string): HTMLButtonElement | null {
    return (
        Array.from(document.body.querySelectorAll('button')).find((button) =>
            button.textContent?.includes(text),
        ) ?? null
    );
}

describe('ConfirmDialog', () => {
    it('renders nothing when closed', async () => {
        const { unmount } = await renderElement(
            <ConfirmDialog
                open={false}
                title="删除模板"
                message="确定要删除吗？"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        expect(document.body.textContent).not.toContain('确定要删除吗？');
        await unmount();
    });

    it('renders title, message and both action buttons when open', async () => {
        const { unmount } = await renderElement(
            <ConfirmDialog
                open
                title="删除模板"
                message="确定要删除吗？"
                confirmLabel="删除"
                danger
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        expect(document.body.textContent).toContain('删除模板');
        expect(document.body.textContent).toContain('确定要删除吗？');
        expect(findButton('取消')).not.toBeNull();
        expect(findButton('删除')?.className).toContain('bg-rose-500');
        await unmount();
    });

    it('invokes onConfirm and onCancel from the respective buttons', async () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const { unmount } = await renderElement(
            <ConfirmDialog
                open
                title="删除配置"
                message="确定要删除吗？"
                confirmLabel="删除"
                danger
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        await act(async () => {
            findButton('删除')?.click();
        });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();

        await act(async () => {
            findButton('取消')?.click();
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
        await unmount();
    });

    it('uses emerald styling for the confirm button when not danger', async () => {
        const { unmount } = await renderElement(
            <ConfirmDialog open title="继续操作" message="继续吗？" onConfirm={vi.fn()} onCancel={vi.fn()} />,
        );

        expect(findButton('确认')?.className).toContain('bg-emerald-500');
        await unmount();
    });
});
