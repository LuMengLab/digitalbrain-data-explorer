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

    const api = { buildPayload, sync };
    global.AtlasBridge = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
