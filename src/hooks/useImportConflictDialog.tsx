import { useCallback, useEffect, useRef, useState } from 'react';
import ImportConflictDialog from '../components/ImportConflictDialog';
import { ImportConflictStrategy } from '../utils/entityNaming';

interface DialogRequest {
    entityLabel: string;
    targetName: string;
}

export function useImportConflictDialog() {
    const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(null);
    const pendingResolverRef = useRef<((strategy: ImportConflictStrategy | null) => void) | null>(null);

    const resolveRequest = useCallback((strategy: ImportConflictStrategy | null) => {
        pendingResolverRef.current?.(strategy);
        pendingResolverRef.current = null;
        setDialogRequest(null);
    }, []);

    const requestImportConflictStrategy = useCallback(
        (entityLabel: string, targetName: string) =>
            new Promise<ImportConflictStrategy | null>((resolve) => {
                pendingResolverRef.current?.(null);
                pendingResolverRef.current = resolve;
                setDialogRequest({ entityLabel, targetName });
            }),
        [],
    );

    useEffect(() => {
        return () => {
            pendingResolverRef.current?.(null);
            pendingResolverRef.current = null;
        };
    }, []);

    return {
        requestImportConflictStrategy,
        importConflictDialog: (
            <ImportConflictDialog
                isOpen={dialogRequest !== null}
                entityLabel={dialogRequest?.entityLabel ?? ''}
                targetName={dialogRequest?.targetName ?? ''}
                onOverwrite={() => resolveRequest('overwrite')}
                onCopy={() => resolveRequest('copy')}
                onCancel={() => resolveRequest(null)}
            />
        ),
    };
}