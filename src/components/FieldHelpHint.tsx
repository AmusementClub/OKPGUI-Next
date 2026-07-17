import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface FieldHelpHintProps {
    /** Accessible name for the help control, e.g. 集数正则说明 */
    label: string;
    /** Multi-line friendly tip body */
    children: string;
}

const TOOLTIP_WIDTH_PX = 256; // w-64
const VIEWPORT_PAD_PX = 8;
const GAP_PX = 6;

/**
 * Compact "?" control with hover/focus tip.
 * Portals to document.body with position:fixed so it is not trapped by
 * overflow-hidden ancestors, CSS grid paint order, or transform stacking contexts.
 */
export default function FieldHelpHint({ label, children }: FieldHelpHintProps) {
    const tipId = useId();
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [coords, setCoords] = useState({ top: 0, left: 0 });

    useLayoutEffect(() => {
        if (!open || !buttonRef.current) {
            return;
        }

        const updatePosition = () => {
            const button = buttonRef.current;
            if (!button) {
                return;
            }

            const rect = button.getBoundingClientRect();
            const maxLeft = window.innerWidth - TOOLTIP_WIDTH_PX - VIEWPORT_PAD_PX;
            const left = Math.max(VIEWPORT_PAD_PX, Math.min(rect.left, maxLeft));
            const top = rect.bottom + GAP_PX;

            setCoords({ top, left });
        };

        updatePosition();
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);

        return () => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        };
    }, [open]);

    const show = () => setOpen(true);
    const hide = () => setOpen(false);

    return (
        <span
            className="relative ml-1 inline-flex align-middle"
            onMouseEnter={show}
            onMouseLeave={hide}
        >
            <button
                ref={buttonRef}
                type="button"
                className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-[10px] leading-none text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
                aria-label={label}
                aria-describedby={open ? tipId : undefined}
                onFocus={show}
                onBlur={hide}
            >
                ?
            </button>
            {open
                && createPortal(
                    <span
                        id={tipId}
                        role="tooltip"
                        className="pointer-events-none fixed z-[60] w-64 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-left text-[11px] leading-relaxed text-slate-300 shadow-lg shadow-slate-950/50"
                        style={{ top: coords.top, left: coords.left }}
                    >
                        {children}
                    </span>,
                    document.body,
                )}
        </span>
    );
}
