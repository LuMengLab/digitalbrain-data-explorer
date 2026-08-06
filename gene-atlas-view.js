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

    // Search now matches metadata as well as symbols, so a broad query can hit
    // thousands of genes. The list is capped and the remainder is reported rather than
    // dropped silently; the cap is generous enough that a real prefix query is never
    // truncated ("AB" -> 71 genes) but small enough to stay scrollable.
    const MAX_RESULTS = 40;

    // What to call the field a row was found by. Only shown when it is not the symbol,
    // which is the one case that needs no explanation.
    const MATCH_LABELS = {
        ensembl: "id",
        name: "name",
        location: "locus",
        class: "peaks in",
    };

    // Which aggregation rules the row offers, and which one it starts on.
    //
    // Only donor-balanced is on offer at the moment: it gives every donor equal say,
    // whereas cell-weighted lets whichever study sequenced the most cells dominate the
    // cross-study mean. Both paths stay intact end to end -- the data layer, the atlas
    // payload and the density calibration all still carry both rules -- so putting the
    // switch back is a matter of listing "cell_weighted" here again, not of
    // re-implementing anything. A button for a rule that is not offered is hidden rather
    // than removed from the markup, for the same reason.
    const OFFERED_RULES = ["donor_balanced"];
    const DEFAULT_RULE = "donor_balanced";

    function init(options) {
        const settings = options || {};
        const doc = settings.document || global.document;
        const host = settings.window || global;
        const data = settings.data || global.GeneAtlasData;
        // Not const: the atlas IIFE may still be booting when the row is wired, so
        // the host can hand it over later through attachAtlas().
        let atlas = settings.atlas || global.DigitalBrainAtlas;
        if (!doc || !data) return null;

        // The comparison panels below the 3D view. A separate module because it is a
        // separate concern -- charts, not selection -- but it cannot own the selection, so
        // this row pushes a snapshot on every change. Injectable (and skippable with
        // `compare: null`) so the row can be tested without it.
        const compare = Object.prototype.hasOwnProperty.call(settings, "compare")
            ? settings.compare
            : (global.GeneCompareView
                ? global.GeneCompareView.init({ document: doc, window: host, data, atlas })
                : null);

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
            cellTypeCount: doc.getElementById("geneCellTypeCount"),
            valueNote: doc.getElementById("geneCellTypeValueNote"),
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
            // The query the dropdown is currently showing, so a search index that
            // lands late cannot repopulate a list the user has already moved past.
            query: "",
            // Settles when the current query has been re-rendered against the search
            // index (or that fetch has failed). Exposed as searchIndexReady() so callers
            // and tests can wait for the second render instead of racing it.
            metaReady: Promise.resolve(null),
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

        // Values for any selected gene, not just the active one: the cloud draws them
        // all at once. Same short-circuit on an empty class selection.
        function valuesFor(symbol) {
            if (state.filter && !state.filter.length) return {};
            return data.regionValues(symbol, { cellTypes: state.filter || [] });
        }

        // The cell counts behind each value. They travel with the gene because the
        // atlas needs them to merge the several DigitalBrain regions that can share one
        // Allen label, and only the atlas knows that mapping.
        //
        // Reduced to the cell count on the way out: regionSupport() answers with the
        // full { datasets, donors, cells } evidence record, and the weighting is by
        // cells. Handing the record over unchanged would leave every weight at zero,
        // which blanks the whole cloud without raising anything.
        function supportFor(symbol, values) {
            const support = {};
            Object.keys(values).forEach((acronym) => {
                const evidence = data.regionSupport(symbol, acronym);
                const cells = evidence && Number(evidence.cells);
                if (cells > 0) support[acronym] = cells;
            });
            return support;
        }

        // Painting and tearing the layer down are different intents, and only the
        // second one belongs to the atlas's clearGeneValues() -- that call also drops
        // back to the cells layer and hands the scope filters back. Routing "no gene
        // selected" through it meant a metric or rule click ejected the user from the
        // layer they had just entered. With no gene the overlay is simply empty, which
        // is a legitimate state of the gene layer.
        //
        // Genes go over in selection order because that order fixes each gene's offset
        // angle in the cloud, and each carries the chip colour so the chips and the
        // cloud cannot drift apart.
        function repaint() {
            if (!atlas || typeof atlas.applyGeneValues !== "function") return;
            const scale = data.densityScale();
            // No calibration means the index predates it. The atlas would throw, which
            // is right for a stale payload but wrong as an unhandled error here, so say
            // it in the row instead.
            if (!scale) {
                if (dom.dataNote) {
                    dom.dataNote.textContent = "This gene atlas build ships no density calibration, so expression cannot be drawn. Re-export the atlas data.";
                }
                return;
            }
            atlas.applyGeneValues({
                metric: data.metric(),
                rule: data.rule(),
                // Named so the atlas knows which gene its markers, legend range and
                // detail headline belong to; without it the first chip spoke for all.
                active: state.active,
                scale,
                genes: state.genes.map((symbol) => {
                    const values = valuesFor(symbol);
                    return {
                        symbol,
                        colour: colourFor(symbol),
                        values,
                        support: supportFor(symbol, values),
                    };
                }),
            });
        }

        // What the atlas needs to fill its region detail panel. Every selected gene
        // goes over, not just the active one: a region is where a multi-gene selection
        // is actually compared, and the panel showing one number while the cloud showed
        // six was the single-gene assumption outliving its layer.
        //
        // Per-class rows travel for the active gene only -- that is the one whose
        // breakdown the panel draws, and 31 rows per gene would be paid for nothing.
        //
        // Reads live state, so installing it once is enough: later metric, rule and
        // gene switches are picked up on the next call.
        function geneDetailSnapshot(acronym) {
            if (!state.genes.length) return null;
            return {
                metric: data.metric(),
                rule: data.rule(),
                active: state.active,
                genes: state.genes.map((symbol) => {
                    const raw = valuesFor(symbol)[acronym];
                    const detailAvailable = canFilter(symbol);
                    const isActive = symbol === state.active;
                    return {
                        symbol,
                        colour: colourFor(symbol),
                        value: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
                        support: data.regionSupport(symbol, acronym) || null,
                        detailAvailable,
                        rows: isActive && detailAvailable ? data.cellTypeDetail(symbol, acronym) : [],
                    };
                }),
            };
        }

        function installDetailProvider() {
            if (atlas && typeof atlas.setGeneDetailProvider === "function") {
                atlas.setGeneDetailProvider(geneDetailSnapshot);
            }
        }

        function attachAtlas(next) {
            atlas = next || atlas;
            installDetailProvider();
            // The class palette comes from the atlas, so the rows only get their
            // colours once it is here.
            renderCellTypes();
            // Same for the panels below, which additionally need the atlas's region
            // catalogue to name anything.
            if (compare && typeof compare.attachAtlas === "function") compare.attachAtlas(atlas);
            refreshCompare();
            repaint();
            return atlas;
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

        // One result row. A bare symbol is not enough to choose between 19k genes that
        // all look like acronyms: the HGNC name says what the gene is, the peak class
        // says which cells carry it here, and the detail badge says whether the
        // cell-class filter will even be available once it is picked.
        //
        // A row can also be here because the query matched its Ensembl id, its name, its
        // cytoband or its peak class rather than its symbol. That has to be said out
        // loud, or the row reads as an unrelated gene the search threw in.
        //
        // Every line beyond the symbol is optional: the search index may not have
        // arrived yet, or the build may ship none at all.
        function buildResultOption(match) {
            const symbol = match.symbol;
            const option = doc.createElement("button");
            option.type = "button";
            option.className = "gene-search-option";
            option.dataset.gene = symbol;
            option.setAttribute("role", "option");

            const meta = (typeof data.searchMeta === "function" && data.searchMeta(symbol)) || null;

            const head = doc.createElement("span");
            head.className = "gene-option-head";
            const label = doc.createElement("strong");
            label.className = "gene-option-symbol";
            label.textContent = symbol;
            head.appendChild(label);
            if (match.field && match.field !== "symbol") {
                const why = doc.createElement("span");
                why.className = "gene-option-why";
                why.dataset.matchField = match.field;
                why.textContent = `${MATCH_LABELS[match.field] || "matched"}: ${match.text}`;
                head.appendChild(why);
            }
            if (meta && meta.peakClass) {
                const peak = doc.createElement("span");
                peak.className = "gene-option-peak";
                peak.dataset.peakClass = meta.peakClass;
                const dot = doc.createElement("i");
                dot.style.background = classColour(meta.peakClass);
                peak.appendChild(dot);
                peak.appendChild(doc.createTextNode(meta.peakClass));
                peak.title = `Highest ${
                    data.metric() === "detection" ? "detection rate" : "mean expression"
                } in ${meta.peakClass}`;
                head.appendChild(peak);
            }
            option.appendChild(head);

            if (meta && meta.name) {
                const name = doc.createElement("span");
                name.className = "gene-option-name";
                name.textContent = meta.name;
                option.appendChild(name);
            }

            if (meta) {
                const facts = doc.createElement("span");
                facts.className = "gene-option-facts";
                const parts = [];
                if (meta.ensembl) parts.push(meta.ensembl);
                if (meta.location) parts.push(meta.location);
                if (meta.biotype) parts.push(meta.biotype);
                if (meta.regions) parts.push(`${meta.regions} regions`);
                if (parts.length) {
                    const text = doc.createElement("span");
                    text.textContent = parts.join(" · ");
                    facts.appendChild(text);
                }
                if (meta.detail) {
                    // The one field that changes what you can do next, so it is a badge
                    // rather than another item in the sentence.
                    const badge = doc.createElement("span");
                    badge.className = "gene-option-badge";
                    badge.dataset.detailBadge = "";
                    badge.textContent = "cell-type detail";
                    facts.appendChild(badge);
                }
                if (facts.childElementCount) option.appendChild(facts);
            }

            return option;
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
            matches.slice(0, MAX_RESULTS).forEach((match) => {
                dom.results.appendChild(buildResultOption(match));
            });
            // Matching names as well as symbols means a broad query can hit thousands of
            // genes. Rendering all of them is both slow and useless, and silently cutting
            // the list is worse -- so say how much was cut and what to do about it.
            if (matches.length > MAX_RESULTS) {
                const more = doc.createElement("p");
                more.className = "gene-search-more";
                more.dataset.resultOverflow = "";
                more.textContent = `Showing the ${MAX_RESULTS} closest of ${matches.length} matches — keep typing to narrow.`;
                dom.results.appendChild(more);
            }
        }

        // Cell-type filtering is computed from the detail tier, which only ships for
        // a curated subset of genes. Ask before offering the control.
        function canFilter(symbol) {
            if (!symbol) return true;
            if (typeof data.canFilterByCellType !== "function") return true;
            return data.canFilterByCellType(symbol);
        }

        // The atlas owns the class palette (curated for the baseline classes, derived
        // for the rest), so the list asks for it rather than keeping a second copy that
        // would drift from the canvas. Neutral grey until the atlas is attached.
        function classColour(type) {
            if (atlas && typeof atlas.cellTypeColour === "function") {
                return atlas.cellTypeColour(type) || "#8ea6ad";
            }
            return "#8ea6ad";
        }

        // Same shape as the atlas detail panel: a rate reads as a percentage, an
        // expression level as a number. Two decimals here, three in the detail panel,
        // because this column is a ranking cue rather than the figure to quote.
        function formatValue(value) {
            if (typeof value !== "number" || !Number.isFinite(value)) return "—";
            return data.metric() === "detection"
                ? `${Math.round(value * 100)}%`
                : value.toFixed(2);
        }

        // "All classes" first, exactly as the cell-profiles list opens with "All cell
        // types". It is the honest label for no filter -- the state the precomputed
        // region table answers -- and gives the panel a one-click way back.
        function buildAllRow(count) {
            const row = doc.createElement("button");
            row.type = "button";
            row.className = "cell-type-button cell-type-all";
            row.dataset.cellTypeAll = "";
            row.classList.toggle("active", !state.filter);
            row.setAttribute("aria-pressed", state.filter ? "false" : "true");

            const dot = doc.createElement("span");
            dot.className = "cell-type-dot multicolor";
            row.appendChild(dot);

            const name = doc.createElement("span");
            name.textContent = "All cell types";
            row.appendChild(name);

            const meta = doc.createElement("small");
            meta.textContent = `${count} classes`;
            row.appendChild(meta);
            return row;
        }

        // One class. Visually a cell-profiles pill, semantically a checkbox: the filter
        // is a subset, so a radio-style button would misdescribe it and lose the
        // keyboard and screen-reader behaviour that comes free with an input.
        function buildClassRow(type, entry, peak, filterable) {
            const row = doc.createElement("label");
            row.className = "cell-type-button cell-type-check";
            row.dataset.cellType = type;
            row.style.setProperty("--class-colour", classColour(type));

            const box = doc.createElement("input");
            box.type = "checkbox";
            box.dataset.cellTypeBox = type;
            // No filter means every class contributes, so they all read as ticked.
            box.checked = !state.filter || state.filter.indexOf(type) !== -1;
            box.disabled = !filterable;
            row.appendChild(box);

            const dot = doc.createElement("span");
            dot.className = "cell-type-dot";
            dot.style.color = classColour(type);
            row.appendChild(dot);

            const name = doc.createElement("span");
            name.className = "cell-type-name";
            name.textContent = type;
            row.appendChild(name);

            const meta = doc.createElement("span");
            meta.className = "cell-type-meta";
            const value = doc.createElement("small");
            value.dataset.cellTypeValue = type;
            // Only the detail tier can speak per class. Without it the row states
            // nothing rather than borrowing the mixed region value, which belongs to
            // all classes at once.
            value.textContent = filterable ? formatValue(entry && entry.value) : "";
            meta.appendChild(value);
            if (filterable) {
                // Isolating one class is the gene layer's most common question ("is this
                // microglial?"), and ticking 30 boxes off to ask it is not a workflow.
                const solo = doc.createElement("button");
                solo.type = "button";
                solo.className = "cell-type-solo";
                solo.dataset.cellTypeSolo = type;
                solo.textContent = "only";
                solo.title = `Show ${type} alone`;
                meta.appendChild(solo);
            }
            row.appendChild(meta);

            const bar = doc.createElement("span");
            bar.className = "cell-type-bar";
            const fill = doc.createElement("i");
            // Relative to the strongest class, so the column ranks classes for this
            // gene. An absolute scale would make most genes a row of empty bars.
            const share = entry && peak > 0 ? Math.max(0.03, entry.value / peak) : 0;
            fill.style.width = `${(share * 100).toFixed(1)}%`;
            bar.appendChild(fill);
            // A region-only gene has nothing to rank, so the track would be 31 empty
            // grooves suggesting a measurement of zero.
            if (filterable) row.appendChild(bar);

            if (filterable && !entry) {
                // Measured nowhere for this gene: ticking it can only remove regions, so
                // say so instead of showing a confident 0.
                row.classList.add("empty");
                row.title = `No cells of this class carry data for ${state.active}`;
            }
            row.classList.toggle("active", box.checked);
            row.classList.toggle("locked", !filterable);
            return row;
        }

        function renderCellTypes() {
            if (!dom.cellTypeList) return;
            const types = data.cellTypes();
            const filterable = canFilter(state.active);
            const summary =
                filterable && state.active && typeof data.cellTypeSummary === "function"
                    ? data.cellTypeSummary(state.active)
                    : {};
            const peak = Object.keys(summary).reduce(
                (max, type) => Math.max(max, summary[type].value),
                0,
            );
            dom.cellTypeList.textContent = "";
            dom.cellTypeList.appendChild(buildAllRow(types.length));
            types.forEach((type) => {
                dom.cellTypeList.appendChild(
                    buildClassRow(type, summary[type], peak, filterable),
                );
            });
            syncSelectionCount();
            syncValueNote(filterable);
            syncDetailNote(filterable);
        }

        // The host collapses this list to five rows, so the selection size cannot live
        // inside it: with 31 classes the ticked ones are usually below the fold. The
        // heading is the one part of the section that is always on screen.
        function syncSelectionCount() {
            if (!dom.cellTypeCount) return;
            if (!state.filter) {
                dom.cellTypeCount.hidden = true;
                dom.cellTypeCount.textContent = "";
                return;
            }
            dom.cellTypeCount.hidden = false;
            dom.cellTypeCount.textContent = `${state.filter.length} of ${data.cellTypes().length}`;
        }

        // Ticking a box changes which classes are selected, not what each class is
        // worth, so the rows are updated in place. Rebuilding them would drop the
        // keyboard focus that just did the ticking.
        function syncCellTypeStates() {
            if (!dom.cellTypeList) return;
            dom.cellTypeList.querySelectorAll("[data-cell-type-box]").forEach((box) => {
                const ticked = !state.filter || state.filter.indexOf(box.dataset.cellTypeBox) !== -1;
                box.checked = ticked;
                const row = box.closest("[data-cell-type]");
                if (row) row.classList.toggle("active", ticked);
            });
            const all = dom.cellTypeList.querySelector("[data-cell-type-all]");
            if (all) {
                all.classList.toggle("active", !state.filter);
                all.setAttribute("aria-pressed", state.filter ? "false" : "true");
            }
            syncSelectionCount();
        }

        // The numbers are metric- and rule-dependent, and a bare column of figures
        // invites the reader to guess which. Name them, and name the gene they belong
        // to, or say why the column is empty.
        function syncValueNote(filterable) {
            if (!dom.valueNote) return;
            if (!state.active || !filterable) {
                dom.valueNote.hidden = true;
                dom.valueNote.textContent = "";
                return;
            }
            dom.valueNote.hidden = false;
            dom.valueNote.textContent = `Values are ${state.active} across the whole brain per class (${
                data.metric() === "detection" ? "detection rate" : "mean expression"
            }, ${
                data.rule() === "cell_weighted" ? "cell-weighted" : "donor-balanced"
            }); bars are relative to the strongest class.`;
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
            // The note exists to explain a choice. With one rule on offer there is no
            // choice to explain, and naming a rule the reader cannot select would only
            // raise a question the row cannot answer. The comparison is skipped rather
            // than computed and discarded, because it borrows the shared rule to make it.
            if (!state.active || OFFERED_RULES.length < 2) {
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
            refreshCompare();
        }

        // What the comparison panels need: the selection, its colours and the class
        // filter. Everything else they read from the data layer themselves, so a metric or
        // rule change needs no extra plumbing.
        function refreshCompare() {
            if (!compare || typeof compare.render !== "function") return;
            compare.render({
                genes: state.genes.map((symbol) => ({
                    symbol,
                    colour: colourFor(symbol),
                })),
                active: state.active,
                filter: selectedCellTypes(),
            });
        }

        // Rendered twice on the first query: once immediately from the payload index, so
        // typing never waits on a request, and again once the search index lands and the
        // id/name/locus tiers become available. An index that never arrives simply leaves
        // the symbol-prefix list standing.
        function search(query) {
            const text = String(query || "").trim();
            state.query = text;
            renderResults(text ? data.search(text) : [], text);
            state.metaReady = text && typeof data.loadSearchIndex === "function"
                ? data.loadSearchIndex().then((index) => {
                    // Keystrokes outrun requests; only the list the box is still showing
                    // may be replaced.
                    if (index && state.query === text) renderResults(data.search(text), text);
                    return index;
                })
                : Promise.resolve(null);
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
            // An empty selection is not a request to leave the layer: repaint with
            // no genes and let the overlay go empty, exactly like the metric and
            // rule clicks above. Routing this through clearGeneValues() ejected the
            // user to Cell profiles and left the removed gene in the legend.
            repaint();
        }

        // An explicit list, possibly empty. Passing every known class collapses to
        // "no filter" because the precomputed region table is the authoritative
        // answer for that case and the two must not disagree.
        function setCellTypes(list) {
            const known = data.cellTypes();
            const wanted = (list || []).filter((type) => known.indexOf(type) !== -1);
            state.filter = wanted.length === known.length ? null : wanted;
            syncCellTypeStates();
            syncRuleNote();
            // Ticking a class does not go through render() -- the rows are updated in
            // place to keep focus -- so the panels have to be told separately, or they
            // would keep showing the unfiltered numbers the map has just left behind.
            refreshCompare();
            repaint();
        }

        function resetCellTypes() {
            state.filter = null;
            syncCellTypeStates();
            syncRuleNote();
            refreshCompare();
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
            // "All classes" and "only" are clicks, not ticks. Both sit inside or beside a
            // label, so the default label activation is cancelled: letting it through
            // would toggle a box on top of the selection just set.
            dom.cellTypeList.addEventListener("click", (event) => {
                const solo = event.target.closest("[data-cell-type-solo]");
                if (solo) {
                    event.preventDefault();
                    setCellTypes([solo.dataset.cellTypeSolo]);
                    return;
                }
                if (event.target.closest("[data-cell-type-all]")) {
                    event.preventDefault();
                    resetCellTypes();
                }
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

        // Hides the buttons for rules that are not on offer and settles the data layer on
        // the default. Driven by OFFERED_RULES rather than by markup so the decision lives
        // in one place; the buttons stay in the DOM, wired and clickable, so nothing about
        // the mechanism has to be rebuilt to offer them again.
        function applyOfferedRules() {
            if (dom.ruleTabs) {
                dom.ruleTabs.querySelectorAll("[data-rule]").forEach((button) => {
                    button.hidden = OFFERED_RULES.indexOf(button.dataset.rule) === -1;
                });
            }
            if (OFFERED_RULES.indexOf(data.rule()) === -1) data.setRule(DEFAULT_RULE);
        }

        if (host && typeof host.addEventListener === "function") {
            host.addEventListener("digitalbrain-atlas-layer", (event) => {
                const detail = event && event.detail;
                setLayer(detail ? detail.layer : null);
            });
            // The detail panel lists every selected gene and lets the reader promote one
            // of them. Only this module can grant that -- it owns the chips -- so the
            // atlas asks by event and the answer travels back as a normal repaint.
            host.addEventListener("digitalbrain-gene-select", (event) => {
                const symbol = event && event.detail && event.detail.symbol;
                if (symbol) setActive(symbol);
            });
        }

        renderCellTypes();
        // Before the first render, so the tabs and every value below them agree from the
        // start rather than after a repaint.
        applyOfferedRules();
        render();
        setLayer(null);
        installDetailProvider();

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
            searchIndexReady: () => state.metaReady,
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
            compare,
            setDataAvailable,
            attachAtlas,
        };
    }

    // Wires the row and pulls in the gene index. `ready` resolves once that fetch has
    // settled either way, so callers (and tests) can wait for a settled UI.
    function bootstrap(options) {
        const view = init(options);
        if (!view) return null;
        const settings = options || {};
        const data = settings.data || global.GeneAtlasData;
        const doc = settings.document || global.document;
        // The payload directory differs between the dev tree and the published
        // bundle, so index.html states it rather than the data layer hard-coding it.
        const base =
            settings.base ||
            (doc && doc.body && doc.body.dataset && doc.body.dataset.geneAtlasBase) ||
            undefined;
        const ready = data
            .loadIndex(base)
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
