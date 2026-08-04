// Gene atlas data layer: fetches per-gene payloads on demand and turns them into
// a { regionAcronym: value } table for the atlas renderer. No DOM access.
//
// Two-tier payload (see scripts/export_gene_atlas_web.py). Region-level colouring
// covers all ~19.3k protein-coding genes; the region x cellType breakdown is ~20x
// larger per gene, so it ships only for a curated subset and loads on demand:
//
//   genes/<SYMBOL>.json         { symbol, ensembl, hasDetail,
//                                 support: { REGION: {datasets,donors,cells} },
//                                 <rule>: { regions: { mean, detection } } }
//   genes/<SYMBOL>.detail.json  { symbol,
//                                 <rule>: { cellTypes: { REGION: { TYPE: {mean,detection,cells} } } } }
//
// Three invariants the whole layer rests on:
//   1. Missing != zero. A region with no data is absent from the returned table so
//      the renderer can paint it neutral grey and keep it out of the colour range.
//   2. A cell-type subset is recomputed with the *same* rule as the global value:
//      cell_weighted weights by cell count, donor_balanced weights types equally.
//      Otherwise "all types selected" would disagree with no filter at all.
//   3. Cell-type filtering needs the detail tier. Callers must ask
//      canFilterByCellType() before offering the control, because without detail
//      the only honest answer is the all-types region value.
(function (global) {
    const RULES = ["cell_weighted", "donor_balanced"];
    const METRICS = ["mean", "detection"];

    const state = {
        base: "gene_atlas_web",
        index: null,
        genes: {},          // symbol -> region-level payload
        details: {},        // symbol -> detail payload
        pending: {},        // symbol -> in-flight promise, so one fetch per gene
        pendingDetail: {},  // symbol -> in-flight detail promise
        rule: "cell_weighted",
        metric: "mean",
    };

    function ingestIndex(payload) {
        state.index = payload || null;
        return state.index;
    }

    function ingestGene(payload) {
        if (!payload || !payload.symbol) return null;
        state.genes[payload.symbol] = payload;
        return payload;
    }

    function ingestGeneDetail(payload) {
        if (!payload || !payload.symbol) return null;
        state.details[payload.symbol] = payload;
        return payload;
    }

    function setRule(rule) {
        if (RULES.indexOf(rule) === -1) {
            throw new Error(`unknown rule ${rule}`);
        }
        state.rule = rule;
        return state.rule;
    }

    function setMetric(metric) {
        if (METRICS.indexOf(metric) === -1) {
            throw new Error(`unknown metric ${metric}`);
        }
        state.metric = metric;
        return state.metric;
    }

    function rule() {
        return state.rule;
    }

    function metric() {
        return state.metric;
    }

    function scope() {
        return (state.index && state.index.scope) || {};
    }

    function cellTypes() {
        return (state.index && state.index.cellTypes) || [];
    }

    function isLoaded(symbol) {
        return Object.prototype.hasOwnProperty.call(state.genes, symbol);
    }

    function isDetailLoaded(symbol) {
        return Object.prototype.hasOwnProperty.call(state.details, symbol);
    }

    // Whether a cellType breakdown exists on the server at all. Answered from the
    // index so the UI can settle the question before fetching anything; falls back
    // to the gene payload's own flag when the index has not arrived yet.
    function hasDetail(symbol) {
        const listed = state.index && state.index.detailGenes;
        if (Array.isArray(listed)) {
            return listed.indexOf(symbol) !== -1;
        }
        const payload = state.genes[symbol];
        return Boolean(payload && payload.hasDetail);
    }

    function canFilterByCellType(symbol) {
        return hasDetail(symbol) && isDetailLoaded(symbol);
    }

    // Case-insensitive prefix search over the index; misses return an empty list
    // rather than throwing, so the UI can render an explicit empty state.
    function search(query) {
        if (!state.index || !state.index.genes) return [];
        const needle = String(query || "").trim().toUpperCase();
        if (!needle) return [];
        return Object.keys(state.index.genes)
            .filter((symbol) => symbol.toUpperCase().indexOf(needle) === 0)
            .sort();
    }

    function bucket(symbol) {
        const payload = state.genes[symbol];
        if (!payload) return null;
        return payload[state.rule] || null;
    }

    function detailBucket(symbol) {
        const payload = state.details[symbol];
        if (!payload) return null;
        return payload[state.rule] || null;
    }

    function weightedAverage(entries) {
        const total = entries.reduce((sum, entry) => sum + entry.cells, 0);
        if (total <= 0) return null;
        return entries.reduce((sum, entry) => sum + entry.value * entry.cells, 0) / total;
    }

    function plainAverage(entries) {
        if (!entries.length) return null;
        return entries.reduce((sum, entry) => sum + entry.value, 0) / entries.length;
    }

    // Recompute one region from a cell-type subset. Only types that actually carry
    // data in that region take part; a subset with no data yields null so the
    // caller drops the region instead of rendering a zero.
    function recomputeRegion(perType, selected) {
        const entries = [];
        selected.forEach((type) => {
            const row = perType[type];
            if (!row) return;
            const value = row[state.metric];
            if (typeof value !== "number") return;
            entries.push({ value, cells: Number(row.cells) || 0 });
        });
        if (!entries.length) return null;
        return state.rule === "cell_weighted" ? weightedAverage(entries) : plainAverage(entries);
    }

    function regionValues(symbol, options) {
        const data = bucket(symbol);
        if (!data) return {};

        const regionTable = (data.regions && data.regions[state.metric]) || {};
        const selected = options && options.cellTypes;
        const detail = detailBucket(symbol);
        // No filter requested, or no detail tier to compute one from: the region
        // value (all cell types mixed) is the only figure we can stand behind.
        if (!selected || !selected.length || !detail || !detail.cellTypes) {
            // Copy so callers cannot mutate the cached payload.
            return Object.assign({}, regionTable);
        }

        const perRegion = detail.cellTypes;
        const values = {};
        Object.keys(perRegion).forEach((region) => {
            const value = recomputeRegion(perRegion[region], selected);
            if (value === null) return;
            values[region] = value;
        });
        return values;
    }

    function cellTypeDetail(symbol, region) {
        const detail = detailBucket(symbol);
        if (!detail || !detail.cellTypes) return [];
        const perType = detail.cellTypes[region];
        if (!perType) return [];
        return Object.keys(perType)
            .sort()
            .map((type) => ({
                cellType: type,
                mean: perType[type].mean,
                detection: perType[type].detection,
                cells: Number(perType[type].cells) || 0,
            }));
    }

    // support is rule-independent evidence, so it lives at the top level of the
    // region-level payload rather than once per aggregation rule.
    function regionSupport(symbol, region) {
        const payload = state.genes[symbol];
        if (!payload || !payload.support) return null;
        return payload.support[region] || null;
    }

    function fetchJson(url) {
        const fetcher = global.fetch;
        if (typeof fetcher !== "function") {
            return Promise.reject(new Error("fetch is unavailable"));
        }
        return fetcher(url).then((response) => {
            if (!response || !response.ok) {
                throw new Error(`request failed: ${url}`);
            }
            return response.json();
        });
    }

    function loadIndex(base) {
        if (base) state.base = base;
        return fetchJson(`${state.base}/index.json`).then(ingestIndex);
    }

    function loadGene(symbol) {
        if (isLoaded(symbol)) {
            return Promise.resolve(state.genes[symbol]);
        }
        if (state.pending[symbol]) {
            return state.pending[symbol];
        }
        const relative =
            (state.index && state.index.genes && state.index.genes[symbol]) ||
            `genes/${symbol}.json`;
        const request = fetchJson(`${state.base}/${relative}`)
            .then((payload) => {
                delete state.pending[symbol];
                return ingestGene(payload);
            })
            .catch((error) => {
                delete state.pending[symbol];
                throw error;
            });
        state.pending[symbol] = request;
        return request;
    }

    // Resolves to null for the ~19.2k genes that ship region-level only, without
    // issuing a request that could only 404.
    function loadGeneDetail(symbol) {
        if (!hasDetail(symbol)) {
            return Promise.resolve(null);
        }
        if (isDetailLoaded(symbol)) {
            return Promise.resolve(state.details[symbol]);
        }
        if (state.pendingDetail[symbol]) {
            return state.pendingDetail[symbol];
        }
        const request = fetchJson(`${state.base}/genes/${symbol}.detail.json`)
            .then((payload) => {
                delete state.pendingDetail[symbol];
                return ingestGeneDetail(payload);
            })
            .catch((error) => {
                delete state.pendingDetail[symbol];
                throw error;
            });
        state.pendingDetail[symbol] = request;
        return request;
    }

    function reset() {
        state.index = null;
        state.genes = {};
        state.details = {};
        state.pending = {};
        state.pendingDetail = {};
        state.rule = "cell_weighted";
        state.metric = "mean";
    }

    const api = {
        RULES,
        METRICS,
        ingestIndex,
        ingestGene,
        ingestGeneDetail,
        setRule,
        setMetric,
        rule,
        metric,
        scope,
        cellTypes,
        isLoaded,
        isDetailLoaded,
        hasDetail,
        canFilterByCellType,
        search,
        regionValues,
        cellTypeDetail,
        regionSupport,
        loadIndex,
        loadGene,
        loadGeneDetail,
        reset,
    };
    global.GeneAtlasData = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
