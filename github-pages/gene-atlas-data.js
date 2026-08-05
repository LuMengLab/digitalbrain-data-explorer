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
//   search-index.json           columnar search metadata for the dropdown, fetched on
//                               the first keystroke (see scripts/export_gene_search_index.py)
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
        // The search index (see scripts/export_gene_search_index.py): one columnar
        // payload covering every gene, fetched once on the first keystroke. null means
        // "not fetched", and searchIndexMissing means "this build ships none", which is
        // not an error -- search then falls back to symbol prefixes over the payload
        // index, which is all it could ever do before.
        searchIndex: null,
        searchColumns: null,   // case-folded copies built once, for matching
        searchDetail: null,    // positions with a cellType tier, as a Set
        pendingIndex: null,
        searchIndexMissing: false,
        rule: "cell_weighted",
        metric: "mean",
    };

    const SEARCH_INDEX_FILE = "search-index.json";

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

    // The density calibration for the current rule and metric. Returns null rather
    // than a fallback when the index predates the calibration: the atlas refuses a
    // payload without one, which is the point -- a made-up range would render every
    // density quietly wrong.
    function densityScale() {
        const table = state.index && state.index.densityScale;
        return (table && table[rule()] && table[rule()][metric()]) || null;
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

    // Whether this build ships the gene at all, answered from the payload index without
    // fetching. A caller offering a fixed list of genes -- housekeeping references, say --
    // needs this to avoid offering one that can only 404.
    function hasGene(symbol) {
        const listed = state.index && state.index.genes;
        if (!listed) return false;
        return Object.prototype.hasOwnProperty.call(listed, symbol);
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

    // Ranked match tiers. The order is the answer to "why is this row here": a symbol
    // hit always outranks an identifier hit, which outranks anything found in the prose
    // metadata. Callers render them in this order and may cap the list, so a wide query
    // loses its weakest matches first, never its symbol matches.
    const MATCH_SYMBOL_EXACT = 0;
    const MATCH_SYMBOL_PREFIX = 1;
    const MATCH_ENSEMBL = 2;
    const MATCH_SYMBOL_PART = 3;
    const MATCH_NAME = 4;
    const MATCH_PLACE = 5;

    // A query this short is a symbol prefix and nothing else: one or two letters inside
    // 19k HGNC names matches almost everything, which would bury the symbol hits under
    // noise the moment the index arrives.
    const META_MATCH_MIN_LENGTH = 3;

    // Case-folded copies of the columns worth matching against, built once per index.
    // Keeping them beside the index rather than re-folding 19k strings per keystroke is
    // the difference between a search box that keeps up with typing and one that does not.
    function searchColumns() {
        if (state.searchColumns) return state.searchColumns;
        const index = state.searchIndex;
        if (!index || !Array.isArray(index.symbols)) return null;
        const prefix = index.ensemblPrefix || "";
        const packed = index.ensembl || [];
        state.searchColumns = {
            symbols: index.symbols.map((symbol) => String(symbol).toUpperCase()),
            // Two views of the identifier: the full "ENSG00000131095" and the part the
            // exporter actually stores. Both are prefix-matched, so a query can be the
            // whole id, a prefix of it, or just the digits people usually paste.
            ensembl: index.symbols.map((_, position) => {
                const value = String(packed[position] || "");
                if (!value) return "";
                return value.indexOf("ENS") === 0 ? value : prefix + value;
            }),
            ensemblPacked: index.symbols.map((_, position) => String(packed[position] || "")),
            names: (index.names || []).map((name) => String(name || "").toLowerCase()),
            locations: (index.locations || []).map((place) => String(place || "").toLowerCase()),
            classes: (index.classes || []).map((name) => String(name || "").toLowerCase()),
        };
        return state.searchColumns;
    }

    // Symbol-prefix search over the payload index. The only search possible before the
    // search index lands, and the whole of it on a build that ships none.
    function searchSymbolsOnly(needle) {
        if (!state.index || !state.index.genes) return [];
        return Object.keys(state.index.genes)
            .filter((symbol) => symbol.toUpperCase().indexOf(needle) === 0)
            .sort()
            .map((symbol) => ({
                symbol,
                tier: symbol.toUpperCase() === needle ? MATCH_SYMBOL_EXACT : MATCH_SYMBOL_PREFIX,
                field: "symbol",
                text: symbol,
            }));
    }

    // Only worth scanning the identifier column for something shaped like an Ensembl id:
    // the full "ENSG00000131095", any prefix of it, or the bare digits.
    function looksLikeEnsembl(needle) {
        return needle.indexOf("ENS") === 0 || /^[0-9]{3,}$/.test(needle);
    }

    function isWordCharacter(code) {
        return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    }

    // Whether the query appears in the text at the start of a word. A plain substring
    // test looks reasonable until you try it: "astro" then matches "g-astro-kine", and
    // the genes anyone typing that wants are buried under the accidents. Multi-word
    // queries still work, because only the start of the phrase has to land on a boundary.
    function matchesAtWordStart(text, needle) {
        let at = text.indexOf(needle);
        while (at !== -1) {
            if (at === 0 || !isWordCharacter(text.charCodeAt(at - 1))) return true;
            at = text.indexOf(needle, at + 1);
        }
        return false;
    }

    // Case-insensitive search over the symbol, the Ensembl id, the HGNC name, the
    // cytoband and the peak cell class. Returns [{ symbol, tier, field, text }] in rank
    // order -- text is what actually matched, so a row found by name or id can say so
    // instead of looking like an unrelated gene. Misses return an empty list rather than
    // throwing, so the UI can render an explicit empty state.
    function search(query) {
        const needle = String(query || "").trim().toUpperCase();
        if (!needle) return [];
        const columns = searchColumns();
        if (!columns) return searchSymbolsOnly(needle);

        const index = state.searchIndex;
        const lower = needle.toLowerCase();
        const wide = needle.length >= META_MATCH_MIN_LENGTH;
        const scanEnsembl = looksLikeEnsembl(needle);
        const known = (state.index && state.index.genes) || null;
        const matches = [];

        for (let position = 0; position < columns.symbols.length; position += 1) {
            const symbol = index.symbols[position];
            // A search index from an older build may name genes this payload no longer
            // ships; offering them would hand the user a row that 404s on click.
            if (known && !Object.prototype.hasOwnProperty.call(known, symbol)) continue;

            const upper = columns.symbols[position];
            const at = upper.indexOf(needle);
            if (at === 0) {
                matches.push({
                    symbol,
                    tier: upper === needle ? MATCH_SYMBOL_EXACT : MATCH_SYMBOL_PREFIX,
                    field: "symbol",
                    text: symbol,
                });
                continue;
            }

            const ensembl = columns.ensembl[position];
            if (
                scanEnsembl && ensembl
                && (ensembl.indexOf(needle) === 0 || columns.ensemblPacked[position].indexOf(needle) === 0)
            ) {
                matches.push({ symbol, tier: MATCH_ENSEMBL, field: "ensembl", text: ensembl });
                continue;
            }

            if (at > 0) {
                matches.push({ symbol, tier: MATCH_SYMBOL_PART, field: "symbol", text: symbol });
                continue;
            }
            if (!wide) continue;

            const name = columns.names[position];
            if (name && matchesAtWordStart(name, lower)) {
                matches.push({
                    symbol,
                    tier: MATCH_NAME,
                    field: "name",
                    text: (index.names || [])[position] || "",
                });
                continue;
            }

            const place = columns.locations[position];
            if (place && place.indexOf(lower) === 0) {
                matches.push({
                    symbol,
                    tier: MATCH_PLACE,
                    field: "location",
                    text: (index.locations || [])[position] || "",
                });
                continue;
            }
            const classIndex = (index.peak || [])[position];
            const className = classIndex >= 0 ? columns.classes[classIndex] : "";
            if (className && className.indexOf(lower) === 0) {
                matches.push({
                    symbol,
                    tier: MATCH_PLACE,
                    field: "class",
                    text: (index.classes || [])[classIndex] || "",
                });
            }
        }

        // Stable within a tier: alphabetical, which is what the symbol-only search always
        // returned, so the top of a prefix query looks exactly as it did before.
        matches.sort((a, b) => a.tier - b.tier || a.symbol.localeCompare(b.symbol));
        return matches;
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

    // One value per cell class for the whole brain, aggregated over every region the
    // detail tier covers under the current metric and rule -- the same arithmetic
    // recomputeRegion() applies within a region, so a class's row and a filtered map
    // cannot tell different stories.
    //
    // The class list needs this to answer "which classes actually carry this gene"
    // before anything is ticked. Without it all 31 rows look equally plausible and
    // the only way to find the carrier is to tick classes one at a time.
    //
    // Classes absent from the result have no data for this gene, which is not the
    // same as a zero and must not be rendered as one.
    function cellTypeSummary(symbol) {
        const detail = detailBucket(symbol);
        if (!detail || !detail.cellTypes) return {};

        const perRegion = detail.cellTypes;
        const collected = {};
        Object.keys(perRegion).forEach((region) => {
            const perType = perRegion[region];
            Object.keys(perType).forEach((type) => {
                const row = perType[type];
                const value = row[state.metric];
                if (typeof value !== "number") return;
                const cells = Number(row.cells) || 0;
                const entry = collected[type] || (collected[type] = { entries: [], cells: 0 });
                entry.entries.push({ value, cells });
                entry.cells += cells;
            });
        });

        const summary = {};
        Object.keys(collected).forEach((type) => {
            const { entries, cells } = collected[type];
            const value =
                state.rule === "cell_weighted" ? weightedAverage(entries) : plainAverage(entries);
            if (value === null) return;
            summary[type] = { value, cells, regions: entries.length };
        });
        return summary;
    }

    // One all-classes figure for the whole brain, aggregated over every region that
    // carries the gene under the current metric and rule.
    //
    // Deliberately the same arithmetic cellTypeSummary() applies across regions --
    // cell-weighted weights each region by its cell count, donor-balanced gives each
    // region equal say -- because the two figures are read side by side: a housekeeping
    // gene has no cell-class tier, so its only honest place next to a per-class row is
    // an all-classes reference computed the same way. A different aggregation here would
    // make that comparison an artefact of the arithmetic.
    //
    // null, not 0, when the gene carries no region at all.
    function wholeBrainValue(symbol) {
        const data = bucket(symbol);
        if (!data) return null;
        const regionTable = (data.regions && data.regions[state.metric]) || {};
        const entries = [];
        Object.keys(regionTable).forEach((region) => {
            const value = regionTable[region];
            if (typeof value !== "number" || !Number.isFinite(value)) return;
            const evidence = regionSupport(symbol, region);
            entries.push({ value, cells: (evidence && Number(evidence.cells)) || 0 });
        });
        if (!entries.length) return null;
        return state.rule === "cell_weighted" ? weightedAverage(entries) : plainAverage(entries);
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

    // What the dropdown knows about a gene beyond its symbol: HGNC name, Ensembl id,
    // cytoband, biotype, the cell class carrying it and how many regions it covers.
    // Reassembled from the columnar index, which is why it is a lookup and not a field
    // access. null until the index has arrived, and null for good on a build that ships
    // none -- the dropdown then lists symbols only, as it always did.
    function searchMeta(symbol) {
        const index = state.searchIndex;
        if (!index || !Array.isArray(index.symbols)) return null;
        const position = searchPosition(symbol);
        if (position < 0) return null;

        const record = {};
        const ensembl = searchColumns().ensembl[position];
        if (ensembl) record.ensembl = ensembl;
        const name = (index.names || [])[position];
        if (name) record.name = name;
        const location = (index.locations || [])[position];
        if (location) record.location = location;
        const biotype = (index.biotypes || [])[(index.biotype || [])[position]];
        if (biotype) record.biotype = biotype;
        const peakClass = (index.classes || [])[(index.peak || [])[position]];
        if (peakClass) record.peakClass = peakClass;
        const regions = (index.regions || [])[position];
        if (regions) record.regions = regions;
        if (detailPositions().has(position)) record.detail = true;
        return record;
    }

    // symbols is sorted, so the lookup is a binary search rather than a 19k scan per
    // rendered row.
    function searchPosition(symbol) {
        const symbols = (state.searchIndex && state.searchIndex.symbols) || null;
        if (!symbols) return -1;
        let low = 0;
        let high = symbols.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (symbols[middle] === symbol) return middle;
            if (symbols[middle] < symbol) low = middle + 1;
            else high = middle - 1;
        }
        return -1;
    }

    function detailPositions() {
        if (!state.searchDetail) {
            state.searchDetail = new Set((state.searchIndex && state.searchIndex.detail) || []);
        }
        return state.searchDetail;
    }

    // One request for the whole search box, not one per keystroke and not one per letter:
    // matching on names and Ensembl ids crosses every letter, so there is nothing to
    // shard by. Resolves to null when the build ships no index, and remembers that so a
    // missing file is not re-requested on every keystroke.
    function loadSearchIndex() {
        if (state.searchIndex) return Promise.resolve(state.searchIndex);
        if (state.searchIndexMissing) return Promise.resolve(null);
        if (state.pendingIndex) return state.pendingIndex;

        const request = fetchJson(`${state.base}/${SEARCH_INDEX_FILE}`)
            .then((payload) => {
                state.pendingIndex = null;
                return ingestSearchIndex(payload);
            })
            .catch(() => {
                // Not an error here: the dropdown simply has less to say, and search
                // falls back to symbol prefixes.
                state.pendingIndex = null;
                state.searchIndexMissing = true;
                return null;
            });
        state.pendingIndex = request;
        return request;
    }

    function ingestSearchIndex(payload) {
        if (!payload || !Array.isArray(payload.symbols)) {
            state.searchIndexMissing = true;
            return null;
        }
        state.searchIndex = payload;
        state.searchColumns = null;
        state.searchDetail = null;
        return state.searchIndex;
    }

    function reset() {
        state.index = null;
        state.genes = {};
        state.details = {};
        state.pending = {};
        state.pendingDetail = {};
        state.searchIndex = null;
        state.searchColumns = null;
        state.searchDetail = null;
        state.pendingIndex = null;
        state.searchIndexMissing = false;
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
        densityScale,
        scope,
        cellTypes,
        isLoaded,
        hasGene,
        isDetailLoaded,
        hasDetail,
        canFilterByCellType,
        search,
        searchMeta,
        loadSearchIndex,
        ingestSearchIndex,
        regionValues,
        cellTypeDetail,
        cellTypeSummary,
        wholeBrainValue,
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
