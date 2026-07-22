import type { ReactNode } from 'react';

interface WarningBannerProps {
    children: ReactNode;
    className?: string;
}

export default function WarningBanner({ children, className = '' }: WarningBannerProps) {
    return (
        <div
            className={`rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200${
                className ? ` ${className}` : ''
            }`}
        >
            {children}
        </div>
    );
}
