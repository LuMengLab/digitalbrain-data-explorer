// Atlas bridge: builds a scope payload from the current Data Explorer selection
// and applies it directly to the embedded atlas (same page, no iframe).
//
// Region crosswalk is an identity map on the Brodmann axis: every atlas acronym
// is a `brod_count` key in the main dataset, so scope region keys are sent
// verbatim and the atlas intersects them with its known acronyms.
//
// Cell types use the Data Explorer's original taxonomy (no folding). Because the
// source data only stores marginals (region totals and cell-type totals, not a
// joint region x cell-type matrix), the composition is scope-level and the atlas
// labels it as such.
(function (global) {
    function buildPayload(scope, selection) {
        const brodCounts = (scope && scope.brodCounts) || {};
        // Identity crosswalk on the Brodmann axis; the atlas keeps only the
        // acronyms it recognizes.
        const regionCells = { ...brodCounts };
        const activeRegions = Object.keys(regionCells);

        const cellCounts = (scope && scope.cellTypeCounts) || {};
        const cellTypes = Object.keys(cellCounts)
            .filter((type) => Number(cellCounts[type]) > 0)
            .sort((a, b) => (Number(cellCounts[b]) || 0) - (Number(cellCounts[a]) || 0));
        const total = cellTypes.reduce((sum, type) => sum + (Number(cellCounts[type]) || 0), 0);
        const composition = Object.fromEntries(
            cellTypes.map((type) => [type, total > 0 ? (Number(cellCounts[type]) || 0) / total : 0]),
        );

        return {
            type: "digitalbrain-scope",
            scopeKey: scope ? scope.scopeKey : "global",
            scopeLabel: scope ? scope.scopeLabel : "All Collections",
            selection: selection || {},
            activeRegions,
            regionCells,
            cellTypes,
            composition,
            cellStats: { totalCount: total },
            totalCells: scope && scope.metrics ? scope.metrics.cells : undefined,
        };
    }

    function sync(scope, selection) {
        if (!scope) return;
        const payload = buildPayload(scope, selection);
        if (global.DigitalBrainAtlas && typeof global.DigitalBrainAtlas.applyScope === "function") {
            global.DigitalBrainAtlas.applyScope(payload);
        }
    }

    // Scope filters that select a collection / dataset / donor. They narrow the cell
    // layer, but the gene layer is a cross-study merge with the dataset axis already
    // collapsed, so they cannot narrow it and must not look as if they could.
    const SCOPE_FILTER_IDS = ["collectionSelect", "datasetSelect", "donorSelect"];

    function installScopeGuard(doc, target) {
        // Snapshot is taken when the gene layer is entered, not at load time: by then
        // the user may have unlocked the dataset and donor selects, and leaving the
        // layer must return them to that state, not to the page's initial one.
        let restore = null;

        function setScopeLocked(locked) {
            if (locked && !restore) {
                restore = SCOPE_FILTER_IDS.map((id) => {
                    const element = doc.getElementById(id);
                    return { element, disabled: element ? element.disabled : false };
                });
            }
            if (restore) {
                restore.forEach((entry) => {
                    if (entry.element) entry.element.disabled = locked ? true : entry.disabled;
                });
                if (!locked) restore = null;
            }
            // The note is armed (not [hidden]) while locked, but CSS renders it as a
            // hover tooltip rather than an inline paragraph, so it no longer squeezes
            // the filter row. The class on the container is the hook for that styling
            // and for the always-visible lock badge that makes the tooltip findable.
            const note = doc.getElementById("geneScopeNote");
            if (note) note.hidden = !locked;
            const controls =
                (note && note.closest && note.closest(".controls")) ||
                doc.querySelector(".controls");
            if (controls) controls.classList.toggle("is-scope-locked", locked);
        }

        target.addEventListener("digitalbrain-atlas-layer", (event) => {
            const detail = event && event.detail;
            setScopeLocked(!!detail && detail.layer === "genes");
        });
    }

    const api = { buildPayload, sync, installScopeGuard };
    global.AtlasBridge = api;
    // The atlas announces its layer as soon as it boots, and this file is loaded
    // before it, so the guard is listening in time for that first announcement.
    if (global.document && typeof global.addEventListener === "function") {
        installScopeGuard(global.document, global);
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
