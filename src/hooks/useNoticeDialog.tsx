import { useCallback, useMemo, useState } from 'react';
import NoticeDialog from '../components/NoticeDialog';

interface NoticeRequest {
    title: string;
    message: string;
    confirmLabel?: string;
}

export function useNoticeDialog() {
    const [noticeRequest, setNoticeRequest] = useState<NoticeRequest | null>(null);

    const closeNotice = useCallback(() => {
        setNoticeRequest(null);
    }, []);

    const showNotice = useCallback((request: NoticeRequest) => {
        setNoticeRequest(request);
    }, []);

    const noticeDialog = useMemo(
        () => (
            <NoticeDialog
                isOpen={noticeRequest !== null}
                title={noticeRequest?.title ?? ''}
                message={noticeRequest?.message ?? ''}
                confirmLabel={noticeRequest?.confirmLabel}
                onClose={closeNotice}
            />
        ),
        [closeNotice, noticeRequest],
    );

    return {
        showNotice,
        noticeDialog,
    };
}