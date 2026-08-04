// Gene search row: the seam between the data layer and the atlas renderer.
//
// It owns the gene selection (chips, active gene), the metric/rule switches and
// the 31-class cell filter, and it turns any change in those into one repaint of
// the 3D view. Both collaborators are injected so this file can be tested without
// booting the atlas.
//
// Two rules this module exists to enforce:
//   1. A cell-class change is a *recolouring*, not a detail-panel tweak. It calls
//      regionValues(gene, {cellTypes}) and repaints, otherwise the drawer would
//      silently disagree with the 3D view.
//   2. Regions absent from the value table are absent on purpose (no data). They
//      are never substituted with a zero on the way to the renderer.
(function (global) {
    // One colour per chip so several genes stay distinguishable in the row. Chosen
    // to survive the dark panel background and to differ for colour-blind viewers.
    const CHIP_COLOURS = [
        "#4cc9f0",
        "#f7b267",
        "#b5e48c",
        "#f4978e",
        "#c8b6ff",
        "#80ffdb",
    ];

    function init(options) {
        const settings = options || {};
        const doc = settings.document || global.document;
        const host = settings.window || global;
        const data = settings.data || global.GeneAtlasData;
        const atlas = settings.atlas || global.DigitalBrainAtlas;
        if (!doc || !data) return null;

        const dom = {
            row: doc.getElementById("geneSearchRow"),
            input: doc.getElementById("geneSearchInput"),
            results: doc.getElementById("geneSearchResults"),
            chips: doc.getElementById("geneChips"),
            metricTabs: doc.getElementById("geneMetricTabs"),
            ruleTabs: doc.getElementById("geneRuleTabs"),
            ruleNote: doc.getElementById("geneRuleNote"),
            cellTypeSection: doc.getElementById("geneCellTypeSection"),
            cellTypeList: doc.getElementById("geneCellTypeList"),
            cellTypeReset: doc.getElementById("geneCellTypeReset"),
            detailNote: doc.getElementById("geneDetailNote"),
            dataNote: doc.getElementById("geneDataNote"),
        };

        const state = {
            genes: [],        // selected symbols, in the order they were added
            active: null,
            // null means "no filter", which is deliberately not the same as an empty
            // array: no filter reads the precomputed region table, whereas an empty
            // selection means no class contributes and nothing can be coloured.
            filter: null,
            layer: null,
            // init() on its own assumes the data is there; bootstrap() corrects this
            // once the index fetch settles.
            dataAvailable: true,
        };

        function colourFor(symbol) {
            const index = state.genes.indexOf(symbol);
            return CHIP_COLOURS[(index < 0 ? 0 : index) % CHIP_COLOURS.length];
        }

        // Region values for the active gene under the current metric, rule and cell
        // filter. An empty selection short-circuits to "nothing has data" instead of
        // reaching the data layer, which would read an empty list as "no filter".
        function currentValues() {
            if (!state.active) return {};
            if (state.filter && !state.filter.length) return {};
            return data.regionValues(state.active, { cellTypes: state.filter || [] });
        }

        function repaint() {
            if (!atlas) return;
            if (!state.active) {
                if (typeof atlas.clearGeneValues === "function") atlas.clearGeneValues();
                return;
            }
            if (typeof atlas.applyGeneValues === "function") {
                atlas.applyGeneValues({
                    values: currentValues(),
                    metric: data.metric(),
                    symbol: state.active,
                });
            }
        }

        function renderChips() {
            if (!dom.chips) return;
            dom.chips.textContent = "";
            state.genes.forEach((symbol) => {
                const chip = doc.createElement("button");
                chip.type = "button";
                chip.className = "gene-chip";
                chip.dataset.gene = symbol;
                chip.dataset.geneColour = colourFor(symbol);
                chip.style.setProperty("--gene-colour", colourFor(symbol));
                if (symbol === state.active) chip.classList.add("active");
                chip.setAttribute("aria-pressed", symbol === state.active ? "true" : "false");

                const label = doc.createElement("span");
                label.textContent = symbol;
                chip.appendChild(label);

                // Nested in the chip so the whole thing stays one tab stop; the
                // click handler tells the two apart by target.
                const remove = doc.createElement("span");
                remove.className = "gene-chip-remove";
                remove.dataset.removeGene = symbol;
                remove.textContent = "×";
                remove.setAttribute("aria-hidden", "true");
                chip.appendChild(remove);

                dom.chips.appendChild(chip);
            });
        }

        function renderResults(matches, query) {
            if (!dom.results) return;
            dom.results.textContent = "";
            if (!query) {
                dom.results.hidden = true;
                return;
            }
            dom.results.hidden = false;
            if (!matches.length) {
                const empty = doc.createElement("p");
                empty.className = "gene-search-empty";
                // Explicit wording: a blank panel reads as a broken UI, and the
                // gene may simply not be in this build's index.
                empty.textContent = `No gene matches “${query}”.`;
                dom.results.appendChild(empty);
                return;
            }
            matches.forEach((symbol) => {
                const option = doc.createElement("button");
                option.type = "button";
                option.className = "gene-search-option";
                option.dataset.gene = symbol;
                option.setAttribute("role", "option");
                option.textContent = symbol;
                dom.results.appendChild(option);
            });
        }

        // Cell-type filtering is computed from the detail tier, which only ships for
        // a curated subset of genes. Ask before offering the control.
        function canFilter(symbol) {
            if (!symbol) return true;
            if (typeof data.canFilterByCellType !== "function") return true;
            return data.canFilterByCellType(symbol);
        }

        function renderCellTypes() {
            if (!dom.cellTypeList) return;
            const types = data.cellTypes();
            const filterable = canFilter(state.active);
            dom.cellTypeList.textContent = "";
            types.forEach((type) => {
                const row = doc.createElement("label");
                row.className = "cell-type-row";
                row.dataset.cellType = type;

                const box = doc.createElement("input");
                box.type = "checkbox";
                box.dataset.cellTypeBox = type;
                // No filter means every class contributes, so they all read as ticked.
                box.checked = !state.filter || state.filter.indexOf(type) !== -1;
                box.disabled = !filterable;
                row.appendChild(box);

                const name = doc.createElement("span");
                name.textContent = type;
                row.appendChild(name);

                dom.cellTypeList.appendChild(row);
            });
            syncDetailNote(filterable);
        }

        // A greyed-out control with no explanation reads as a broken build, so name
        // the gene and say what the map is showing instead.
        function syncDetailNote(filterable) {
            if (!dom.detailNote) return;
            if (!state.active || filterable) {
                dom.detailNote.hidden = true;
                dom.detailNote.textContent = "";
                return;
            }
            dom.detailNote.hidden = false;
            dom.detailNote.textContent = `${state.active} ships region-level values only, so filtering by cell class is unavailable. The atlas shows all classes combined.`;
        }

        function syncTabs(container, attribute, value) {
            if (!container) return;
            container.querySelectorAll(`[data-${attribute}]`).forEach((button) => {
                button.classList.toggle("active", button.dataset[attribute] === value);
            });
        }

        // Warn when the two aggregations disagree enough to change the reading of
        // the map. Cross-study means are dominated by whichever dataset sequenced
        // the most cells, so a large gap is a fact about sampling, not biology.
        function syncRuleNote() {
            if (!dom.ruleNote) return;
            if (!state.active) {
                dom.ruleNote.hidden = true;
                return;
            }
            const current = data.rule();
            const other = current === "cell_weighted" ? "donor_balanced" : "cell_weighted";
            let here = {};
            let there = {};
            try {
                here = currentValues();
                data.setRule(other);
                there = currentValues();
            } finally {
                // The comparison borrows the shared rule, so restore it even if the
                // data layer throws; leaving it flipped would silently mislabel the map.
                data.setRule(current);
            }

            let worst = 0;
            Object.keys(here).forEach((region) => {
                if (!(region in there)) return;
                const scale = Math.max(Math.abs(here[region]), Math.abs(there[region]));
                if (scale <= 0) return;
                worst = Math.max(worst, Math.abs(here[region] - there[region]) / scale);
            });
            if (worst < 0.25) {
                dom.ruleNote.hidden = true;
                return;
            }
            dom.ruleNote.hidden = false;
            dom.ruleNote.textContent = `The two aggregation rules differ by up to ${Math.round(
                worst * 100,
            )}% for ${state.active}. Cell-weighted follows the largest datasets; donor-balanced gives every donor equal say.`;
        }

        function render() {
            renderChips();
            renderCellTypes();
            syncTabs(dom.metricTabs, "metric", data.metric());
            syncTabs(dom.ruleTabs, "rule", data.rule());
            syncRuleNote();
        }

        function search(query) {
            const text = String(query || "").trim();
            renderResults(text ? data.search(text) : [], text);
            return text;
        }

        // Everything this gene needs before it can be drawn: the region tier, plus the
        // detail tier when the gene has one (loadGeneDetail resolves to null without a
        // request for the ~19.2k region-only genes).
        function isReady(symbol) {
            if (typeof data.isLoaded === "function" && !data.isLoaded(symbol)) return false;
            if (typeof data.hasDetail !== "function") return true;
            if (!data.hasDetail(symbol)) return true;
            return typeof data.isDetailLoaded === "function" && data.isDetailLoaded(symbol);
        }

        function ensureLoaded(symbol) {
            return Promise.resolve()
                .then(() => (data.isLoaded(symbol) ? null : data.loadGene(symbol)))
                .then(() =>
                    typeof data.loadGeneDetail === "function"
                        ? data.loadGeneDetail(symbol)
                        : null,
                );
        }

        // A chip whose file never arrived would paint nothing and look like a gene
        // with no expression anywhere, so name the failure instead.
        function reportLoadFailure(symbol) {
            if (!dom.dataNote) return;
            dom.dataNote.hidden = false;
            dom.dataNote.textContent = `Could not load data for ${symbol}. The gene may be missing from this build.`;
        }

        function commit(symbol) {
            if (state.genes.indexOf(symbol) === -1) {
                state.genes.push(symbol);
            }
            state.active = symbol;
            render();
            repaint();
            return symbol;
        }

        // Resolves once the gene is drawn (or known to have failed). Already-loaded
        // genes commit synchronously so a click repaints in the same frame.
        function activate(symbol) {
            if (isReady(symbol)) {
                commit(symbol);
                return Promise.resolve(symbol);
            }
            return ensureLoaded(symbol)
                .then(() => commit(symbol))
                .catch(() => {
                    reportLoadFailure(symbol);
                    return null;
                });
        }

        function setActive(symbol) {
            if (state.genes.indexOf(symbol) === -1) return Promise.resolve(null);
            return activate(symbol);
        }

        function addGene(symbol) {
            if (!symbol) return Promise.resolve(null);
            return activate(symbol);
        }

        function removeGene(symbol) {
            const index = state.genes.indexOf(symbol);
            if (index === -1) return;
            state.genes.splice(index, 1);
            if (state.active === symbol) {
                // Promote the neighbour that took its place, or the new last one if
                // the tail was removed; null once nothing is left.
                state.active = state.genes[Math.min(index, state.genes.length - 1)] || null;
            }
            render();
            repaint();
        }

        // An explicit list, possibly empty. Passing every known class collapses to
        // "no filter" because the precomputed region table is the authoritative
        // answer for that case and the two must not disagree.
        function setCellTypes(list) {
            const known = data.cellTypes();
            const wanted = (list || []).filter((type) => known.indexOf(type) !== -1);
            state.filter = wanted.length === known.length ? null : wanted;
            renderCellTypes();
            syncRuleNote();
            repaint();
        }

        function resetCellTypes() {
            state.filter = null;
            renderCellTypes();
            syncRuleNote();
            repaint();
        }

        // null while no filter is applied, so callers can tell that apart from an
        // empty selection.
        function selectedCellTypes() {
            return state.filter ? state.filter.slice() : null;
        }

        function setMetric(metric) {
            data.setMetric(metric);
            render();
            repaint();
        }

        function setRule(rule) {
            data.setRule(rule);
            render();
            repaint();
        }

        function pickGene(symbol) {
            addGene(symbol);
            if (dom.input) dom.input.value = "";
            renderResults([], "");
        }

        if (dom.input) {
            dom.input.addEventListener("input", (event) => search(event.target.value));
        }
        if (dom.results) {
            dom.results.addEventListener("click", (event) => {
                const option = event.target.closest("[data-gene]");
                if (option) pickGene(option.dataset.gene);
            });
        }
        if (dom.chips) {
            dom.chips.addEventListener("click", (event) => {
                const remove = event.target.closest("[data-remove-gene]");
                if (remove) {
                    removeGene(remove.dataset.removeGene);
                    return;
                }
                const chip = event.target.closest("[data-gene]");
                if (chip) setActive(chip.dataset.gene);
            });
        }
        if (dom.metricTabs) {
            dom.metricTabs.addEventListener("click", (event) => {
                const button = event.target.closest("[data-metric]");
                if (button) setMetric(button.dataset.metric);
            });
        }
        if (dom.ruleTabs) {
            dom.ruleTabs.addEventListener("click", (event) => {
                const button = event.target.closest("[data-rule]");
                if (button) setRule(button.dataset.rule);
            });
        }
        if (dom.cellTypeList) {
            dom.cellTypeList.addEventListener("change", (event) => {
                const box = event.target.closest("[data-cell-type-box]");
                if (!box) return;
                const ticked = [...dom.cellTypeList.querySelectorAll("[data-cell-type-box]")]
                    .filter((node) => node.checked)
                    .map((node) => node.dataset.cellTypeBox);
                setCellTypes(ticked);
            });
        }
        if (dom.cellTypeReset) {
            dom.cellTypeReset.addEventListener("click", () => resetCellTypes());
        }

        // The atlas announces its layer; the row and the gene cell-class section
        // only make sense while that layer is up. The class list additionally needs
        // an index to populate from, so it stays hidden rather than showing empty.
        function syncSections() {
            const genes = state.layer === "genes";
            if (dom.row) dom.row.hidden = !genes;
            if (dom.cellTypeSection) {
                dom.cellTypeSection.hidden = !genes || !state.dataAvailable;
            }
        }

        function setLayer(layer) {
            state.layer = layer;
            syncSections();
        }

        if (host && typeof host.addEventListener === "function") {
            host.addEventListener("digitalbrain-atlas-layer", (event) => {
                const detail = event && event.detail;
                setLayer(detail ? detail.layer : null);
            });
        }

        renderCellTypes();
        render();
        setLayer(null);

        // Called once the index is in, or once it is known to be missing. Without an
        // index there is nothing to search, so the box is disabled and the reason is
        // stated: an empty result for every query would look like a broken build.
        function setDataAvailable(available, reason) {
            state.dataAvailable = !!available;
            if (dom.input) dom.input.disabled = !available;
            if (dom.dataNote) {
                dom.dataNote.hidden = !!available;
                dom.dataNote.textContent = available ? "" : reason;
            }
            syncSections();
        }

        return {
            search,
            addGene,
            removeGene,
            setActive,
            setMetric,
            setRule,
            setCellTypes,
            resetCellTypes,
            selectedCellTypes,
            genes: () => state.genes.slice(),
            activeGene: () => state.active,
            colourFor,
            refreshCellTypes: renderCellTypes,
            setDataAvailable,
        };
    }

    // Wires the row and pulls in the gene index. `ready` resolves once that fetch has
    // settled either way, so callers (and tests) can wait for a settled UI.
    function bootstrap(options) {
        const view = init(options);
        if (!view) return null;
        const settings = options || {};
        const data = settings.data || global.GeneAtlasData;
        const ready = data
            .loadIndex(settings.base)
            .then(() => {
                view.refreshCellTypes();
                view.setDataAvailable(true);
            })
            .catch(() => {
                view.setDataAvailable(
                    false,
                    "Gene expression data is not available in this build.",
                );
            });
        view.ready = ready;
        return view;
    }

    const api = { init, bootstrap, CHIP_COLOURS };
    global.GeneAtlasView = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
