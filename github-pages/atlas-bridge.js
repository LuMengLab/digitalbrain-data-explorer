// Atlas bridge: builds a scope payload from the current Data Explorer selection
// and applies it directly to the embedded atlas (same page, no iframe).
//
// Region crosswalk is an identity map on the Brodmann axis: every atlas acronym
// is a `brod_count` key in the main dataset, so scope region keys are sent
// verbatim and the atlas intersects them with its known acronyms.
//
// Cell types use the Data Explorer's original taxonomy (no folding). The source
// stores only marginals per donor -- a region total (`brod_count`) and a class
// total (`cell_type_count`), never the joint matrix -- so the scope-level
// composition is sent as the fallback, and a per-region composition is derived
// from the donor mix (see buildRegionComposition).
(function (global) {
    function normalizeCounts(counts) {
        const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
        if (!(total > 0)) return null;
        const fractions = {};
        Object.entries(counts).forEach(([key, value]) => {
            fractions[key] = (Number(value) || 0) / total;
        });
        return fractions;
    }

    // Per-region composition, resolved one level below the scope.
    //
    // A donor that sampled exactly one region tells us that region's class profile
    // outright -- and that is the overwhelming majority of them. So for each region
    // we mix the profiles of the donors that touched it, weighting each donor by the
    // cells it contributed *there*. The donor-level assumption (a donor's classes are
    // spread evenly over the regions it sampled) only bites for the few donors that
    // span many regions, instead of flattening every region to one scope average.
    function buildRegionComposition(donors) {
        const totals = {};
        (donors || []).forEach((donor) => {
            const profile = normalizeCounts((donor && donor.cell_type_count) || {});
            if (!profile) return;
            Object.entries((donor && donor.brod_count) || {}).forEach(([region, raw]) => {
                const cells = Number(raw) || 0;
                if (!(cells > 0)) return;
                const bucket = totals[region] || (totals[region] = {});
                Object.entries(profile).forEach(([type, share]) => {
                    bucket[type] = (bucket[type] || 0) + cells * share;
                });
            });
        });

        const regionComposition = {};
        let resolved = 0;
        Object.entries(totals).forEach(([region, bucket]) => {
            const fractions = normalizeCounts(bucket);
            if (!fractions) return;
            regionComposition[region] = fractions;
            resolved += 1;
        });
        return { regionComposition, resolved };
    }

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

        const { regionComposition, resolved } = buildRegionComposition(scope && scope.donors);

        return {
            type: "digitalbrain-scope",
            scopeKey: scope ? scope.scopeKey : "global",
            scopeLabel: scope ? scope.scopeLabel : "All Collections",
            selection: selection || {},
            activeRegions,
            regionCells,
            cellTypes,
            composition,
            regionComposition,
            // Tells the atlas how to label the breakdown it is about to draw, so a
            // repeated scope average is never presented as a regional measurement.
            compositionResolution: resolved > 0 ? "donor-mix" : "scope",
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
        // The lock only makes sense while the locked layer is on screen: the
        // overview view drives its charts from the same selects, so switching away
        // from the atlas must release them, and switching back re-arms the lock if
        // the gene layer is still active.
        let geneLayerActive = false;
        let atlasViewVisible = true;

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

        function applyEffectiveLock() {
            setScopeLocked(geneLayerActive && atlasViewVisible);
        }

        target.addEventListener("digitalbrain-atlas-layer", (event) => {
            const detail = event && event.detail;
            geneLayerActive = !!detail && detail.layer === "genes";
            applyEffectiveLock();
        });

        return {
            setAtlasViewVisible(visible) {
                atlasViewVisible = !!visible;
                applyEffectiveLock();
            },
        };
    }

    const api = { buildPayload, buildRegionComposition, sync, installScopeGuard };
    global.AtlasBridge = api;
    // The atlas announces its layer as soon as it boots, and this file is loaded
    // before it, so the guard is listening in time for that first announcement.
    if (global.document && typeof global.addEventListener === "function") {
        const guard = installScopeGuard(global.document, global);
        if (guard) api.setAtlasViewVisible = guard.setAtlasViewVisible;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
