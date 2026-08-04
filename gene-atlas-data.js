// Gene atlas data layer: fetches per-gene payloads on demand and turns them into
// a { regionAcronym: value } table for the atlas renderer. No DOM access.
//
// Payload layout (one file per gene, see scripts/export_gene_atlas_web.py):
//   { symbol, ensembl, <rule>: { regions: { mean, detection },
//                                cellTypes: { REGION: { TYPE: {mean,detection,cells} } },
//                                support:   { REGION: {datasets,donors,cells} } } }
//
// Two invariants the whole layer rests on:
//   1. Missing != zero. A region with no data is absent from the returned table so
//      the renderer can paint it neutral grey and keep it out of the colour range.
//   2. A cell-type subset is recomputed with the *same* rule as the global value:
//      cell_weighted weights by cell count, donor_balanced weights types equally.
//      Otherwise "all types selected" would disagree with no filter at all.
(function (global) {
    const RULES = ["cell_weighted", "donor_balanced"];
    const METRICS = ["mean", "detection"];

    const state = {
        base: "gene_atlas_web",
        index: null,
        genes: {},        // symbol -> payload
        pending: {},      // symbol -> in-flight promise, so one fetch per gene
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

        const selected = options && options.cellTypes;
        if (!selected || !selected.length) {
            const table = (data.regions && data.regions[state.metric]) || {};
            // Copy so callers cannot mutate the cached payload.
            return Object.assign({}, table);
        }

        const perRegion = data.cellTypes || {};
        const values = {};
        Object.keys(perRegion).forEach((region) => {
            const value = recomputeRegion(perRegion[region], selected);
            if (value === null) return;
            values[region] = value;
        });
        return values;
    }

    function cellTypeDetail(symbol, region) {
        const data = bucket(symbol);
        if (!data || !data.cellTypes) return [];
        const perType = data.cellTypes[region];
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

    function regionSupport(symbol, region) {
        const data = bucket(symbol);
        if (!data || !data.support) return null;
        return data.support[region] || null;
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

    function reset() {
        state.index = null;
        state.genes = {};
        state.pending = {};
        state.rule = "cell_weighted";
        state.metric = "mean";
    }

    const api = {
        RULES,
        METRICS,
        ingestIndex,
        ingestGene,
        setRule,
        setMetric,
        rule,
        metric,
        scope,
        cellTypes,
        isLoaded,
        search,
        regionValues,
        cellTypeDetail,
        regionSupport,
        loadIndex,
        loadGene,
        reset,
    };
    global.GeneAtlasData = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
