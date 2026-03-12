import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

const formatVersion = (version: string) => (version.startsWith('v') ? version : `v${version}`);

let resolvedVersion = formatVersion(__APP_VERSION__);
let versionPromise: Promise<string> | null = null;

const loadAppVersion = async () => {
    if (!versionPromise) {
        versionPromise = getVersion()
            .then((version) => formatVersion(version))
            .catch(() => formatVersion(__APP_VERSION__))
            .then((version) => {
                resolvedVersion = version;
                return version;
            });
    }

    return versionPromise;
};

export function useAppVersion() {
    const [appVersion, setAppVersion] = useState(resolvedVersion);

    useEffect(() => {
        let cancelled = false;

        void loadAppVersion().then((version) => {
            if (!cancelled) {
                setAppVersion(version);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    return appVersion;
}