export function reconcileSelectableSiteSelection<
    SiteKey extends string,
    SiteSelection extends Record<SiteKey, boolean>,
>(
    currentSelection: SiteSelection,
    selectableSiteKeys: Iterable<SiteKey>,
): SiteSelection {
    const selectableSet = new Set(selectableSiteKeys);
    let nextSelection: SiteSelection | null = null;

    for (const siteKey of Object.keys(currentSelection) as SiteKey[]) {
        if (!currentSelection[siteKey] || selectableSet.has(siteKey)) {
            continue;
        }

        if (!nextSelection) {
            nextSelection = { ...currentSelection };
        }

        nextSelection[siteKey] = false as SiteSelection[SiteKey];
    }

    return nextSelection ?? currentSelection;
}