// Gene comparison panels: the quantitative half of the gene expression layer.
//
// The 3D cloud answers "roughly where is this gene". It cannot answer "how much more,
// and compared to what" -- densities are read against a calibrated ramp, not a number,
// and 57 of the 163 regions the payload covers have no place in the anatomy at all.
// These two panels answer that, from the same values the map is drawn from:
//
//   1. Across regions   -- one group per region, one bar per gene, vertical bars.
//   2. Within classes   -- one block per cell class, one bar per gene, horizontal bars.
//
// Three decisions worth stating, because they are the ones a reader would otherwise
// have to reverse-engineer:
//
//   * The region axis scrolls sideways and does not wrap. A grouped bar chart is only
//     comparable while every group shares one baseline and one axis; wrapping starts a
//     new baseline per row, and the eye cannot carry a scale across rows. The axis sits
//     outside the scrolling box, so the scale stays on screen for all 163 groups. The
//     class panel does wrap, because each class block is read on its own terms.
//   * Sorting is not decoration. 163 unordered groups is a wall; ordered by the active
//     gene it is a distribution with a head worth looking at.
//   * Housekeeping genes are references, not selection. They never enter the chip list,
//     never reach the 3D view, and are drawn as pale hatched bars so a control can never
//     be mistaken for a result. Where the build ships a cell-class tier for a control --
//     which it does for every control offered here -- the class panel draws it per class,
//     because capture depth differs by class and one brain-wide line hides exactly that.
//     A control without a tier falls back to a labelled all-classes bar -- see
//     CONTROL_GENES, classModel() and describeControlScope().
//   * Axis labels turn upright as soon as the groups are wide enough to hold the longest
//     word in the catalogue, and the whole axis switches together: one reading direction
//     per axis is what lets the eye scan it, so a single long acronym does not get to
//     leave the other 105 sideways -- see labelsFitUpright().
//   * A group is 6px-wide bars with no room for a number, so the figures live in a
//     hover/focus readout instead of in native title tooltips, which would otherwise
//     pop up a second, slower copy of the same thing on top of it.
//
// The invariant the whole gene layer rests on holds here too: a region or class with no
// data is absent, or marked absent. It is never drawn as a zero.
(function (global) {
    // Curated housekeeping references, in two families because the distinction matters
    // for brain tissue and the picker is the only place to say so.
    //
    // ACTB and GAPDH are what most readers expect to see, but both are genuinely variable
    // across neural cell classes -- 2.75x and 2.47x between their highest and lowest class
    // in this payload -- so a gene that "beats GAPDH" in one class may not in another. The
    // stable set is the flattest thing this dataset actually contains (1.40-1.66x), which
    // is the better yardstick when the comparison is about level rather than familiarity.
    //
    // Every candidate was measured with scripts/gene_flatness_probe.py before being offered
    // here, and a yardstick has to earn the name. The rejected ones and their numbers are
    // in docs/gene-atlas-housekeeping-panel.md; three reasons, all disqualifying:
    //   * B2M varies 34.8x between classes -- in brain tissue it is a vascular/immune
    //     marker, so drawing it as a baseline inverts the comparison.
    //   * PPIA 6.3x, GPI 5.4x, PSMB4 4.3x, CHMP2A 3.6x move more than the genes a reader
    //     would be measuring against them.
    //   * CHMP2A, PSMB4, VPS29 and VCP are also detected in only a fifth to a half of
    //     nuclei, so in the low-depth classes their bar reports dropout, not a level.
    //
    // Every symbol here ships a cell-class tier, which is what lets the class panel draw a
    // per-class baseline instead of one brain-wide line.
    //
    // Each carries its own pale tint. Pale, because a control is a yardstick and must stay
    // quieter than the selection's saturated chip colours; its own, because a shelf of
    // identically grey hatched bars cannot be told apart. The tints are ordered so that
    // the first controls anyone picks land far apart on the colour wheel rather than in
    // the same corner of it.
    const CONTROL_GENES = [
        { symbol: "ACTB", family: "Classic controls", tint: "#cfe4f7" },
        { symbol: "GAPDH", family: "Classic controls", tint: "#f7dfc0" },
        { symbol: "TBL1XR1", family: "Stable reference set", tint: "#d3f0d6" },
        { symbol: "ARID4B", family: "Stable reference set", tint: "#f2cfe0" },
        { symbol: "BPTF", family: "Stable reference set", tint: "#d8d6f5" },
        { symbol: "RAB7A", family: "Stable reference set", tint: "#c6eff2" },
    ];

    // Every control gene keeps its tint whatever else is on screen, so the colour is an
    // identity rather than a position in whatever happens to be selected.
    function controlTint(symbol) {
        const entry = CONTROL_GENES.filter((control) => control.symbol === symbol)[0];
        return (entry && entry.tint) || "#cfe4f7";
    }

    // How many regions "Top 20" keeps. Small enough to read without scrolling, which is
    // the point of the preset.
    const TOP_PRESET_SIZE = 20;

    // Mirrors .gene-compare-bar (width) and .gene-compare-bars (gap) in the stylesheet,
    // and the measured average glyph width of a 7px acronym in the label face. Used only
    // to decide whether upright labels fit; a few pixels out costs a slightly wider group,
    // never a clipped label, because the label wraps rather than being cut.
    const BAR_WIDTH = 6;
    const BAR_GAP = 2;
    const LABEL_CHAR_WIDTH = 4.6;

    // A bar this short is still visibly a bar. Without a floor, a real but small value
    // renders as nothing and reads as missing data -- the one thing this layer must
    // never say by accident.
    const MIN_BAR_SHARE = 0.02;

    function init(options) {
        const settings = options || {};
        const doc = settings.document || global.document;
        const host = settings.window || global;
        const data = settings.data || global.GeneAtlasData;
        let atlas = settings.atlas || global.DigitalBrainAtlas;
        if (!doc || !data) return null;

        const dom = {
            root: doc.getElementById("geneCompare"),
            regionCaption: doc.getElementById("geneRegionCompareCaption"),
            regionAxis: doc.getElementById("geneRegionCompareAxis"),
            regionTrack: doc.getElementById("geneRegionCompareTrack"),
            regionEmpty: doc.getElementById("geneRegionCompareEmpty"),
            regionSort: doc.getElementById("geneRegionCompareSort"),
            regionExport: doc.getElementById("geneRegionExportBtn"),
            scaleTabs: doc.getElementById("geneCompareScaleTabs"),
            key: doc.getElementById("geneCompareKey"),
            regionPicker: doc.getElementById("geneRegionPicker"),
            regionPickerToggle: doc.getElementById("geneRegionPickerToggle"),
            regionPickerPanel: doc.getElementById("geneRegionPickerPanel"),
            regionPickerSearch: doc.getElementById("geneRegionPickerSearch"),
            regionPickerList: doc.getElementById("geneRegionPickerList"),
            regionPickerCount: doc.getElementById("geneRegionPickerCount"),
            regionPickerNote: doc.getElementById("geneRegionPickerNote"),
            regionPresets: doc.getElementById("geneRegionPickerPresets"),
            controlPicker: doc.getElementById("geneControlPicker"),
            controlPickerToggle: doc.getElementById("geneControlPickerToggle"),
            controlPickerPanel: doc.getElementById("geneControlPickerPanel"),
            controlPickerList: doc.getElementById("geneControlPickerList"),
            controlPickerCount: doc.getElementById("geneControlPickerCount"),
            classTitle: doc.getElementById("geneClassCompareTitle"),
            classCaption: doc.getElementById("geneClassCompareCaption"),
            classGrid: doc.getElementById("geneClassCompareGrid"),
            classEmpty: doc.getElementById("geneClassCompareEmpty"),
            classNote: doc.getElementById("geneClassCompareNote"),
            // The readout lives on the panel, not inside the track: the track is a scroll
            // container, and anything positioned inside it is clipped by it.
            regionPanel: doc.getElementById("geneRegionComparePanel"),
            regionTip: doc.getElementById("geneRegionCompareTip"),
        };
        if (!dom.root) return null;

        const state = {
            layer: null,
            // Last selection handed over by the gene row: { genes: [{symbol, colour}],
            // active, filter }. Read on every render, never cached in pieces.
            selection: { genes: [], active: null, filter: null },
            // null means "every region the selected genes carry", which is the default
            // and is deliberately not the same as an empty set (nothing chosen).
            regions: null,
            // Coarse payload labels with no parcel in the anatomy -- CB, Cx, "CA2 CA3
            // CA4". They are real measurements the 3D view silently cannot place, so
            // they are offered, but off by default: mixing a whole lobe with one of its
            // areas in the same axis invites a comparison that is not one.
            includeUnmapped: false,
            controls: [],
            sort: "value",
            scale: "shared",
            // The atlas's current selection, as announced. acronym is null for a group.
            selected: null,
            selectedMembers: [],
            filterText: "",
            // The model the region track was last painted from. The readout reads it
            // instead of recomputing: it has to describe what is on screen, and a
            // recomputation could answer from a metric changed since the paint.
            painted: null,
            hovered: null,
        };

        // ---- region identity -------------------------------------------------------

        // acronym -> { name, group, hasAnatomy }. The gene payloads identify regions by
        // acronym only, so names and groups come from the atlas, which owns them.
        let catalogueCache = null;
        function catalogue() {
            if (catalogueCache) return catalogueCache;
            const list =
                (atlas && typeof atlas.regionCatalogue === "function" && atlas.regionCatalogue())
                || [];
            catalogueCache = {};
            list.forEach((region) => {
                if (region && region.acronym) catalogueCache[region.acronym] = region;
            });
            return catalogueCache;
        }

        function regionName(acronym) {
            const entry = catalogue()[acronym];
            return (entry && entry.name) || acronym;
        }

        function regionGroup(acronym) {
            const entry = catalogue()[acronym];
            // Not in the catalogue at all: a coarse payload label the anatomy has no
            // parcel for. Named as such rather than left blank.
            return (entry && entry.group) || "Coarse label (off the map)";
        }

        function isMapped(acronym) {
            return Object.prototype.hasOwnProperty.call(catalogue(), acronym);
        }

        // ---- series ----------------------------------------------------------------

        // Everything drawn, in draw order: the selection first (chip order, chip colour),
        // then the controls. `control: true` is what every renderer keys its muted
        // treatment off, so the two can never be styled alike by accident.
        function series() {
            const rows = state.selection.genes.map((gene) => ({
                symbol: gene.symbol,
                colour: gene.colour,
                control: false,
                active: gene.symbol === state.selection.active,
            }));
            state.controls.forEach((symbol) => {
                if (rows.some((row) => row.symbol === symbol)) return;
                rows.push({
                    symbol,
                    colour: controlTint(symbol),
                    control: true,
                    active: false,
                });
            });
            return rows;
        }

        // Whether this build can break a gene down by cell class right now. A control the
        // reader just switched on answers false until its detail tier lands, so every
        // caller has to be able to fall back rather than assume.
        function canBreakDown(symbol) {
            return typeof data.canFilterByCellType !== "function"
                || data.canFilterByCellType(symbol);
        }

        // A class filter narrows the selection by recomputing it from the detail tier, and
        // a control follows it -- comparing a filtered gene against an unfiltered control
        // would measure the filter, not the gene. The exception is a control the build has
        // no class tier for: filtering that one would silently return its unfiltered value
        // under a filtered label, so it stays all-classes and the caption says so.
        function valuesFor(row) {
            const filter = state.selection.filter;
            if (row.control && !canBreakDown(row.symbol)) {
                return data.regionValues(row.symbol, { cellTypes: [] });
            }
            if (filter && !filter.length) return {};
            return data.regionValues(row.symbol, { cellTypes: filter || [] });
        }

        // Two decimals is the right precision for reading a level, but it turns every
        // value below 0.005 into "0.00" -- and those values still get a visible floor bar,
        // so the row would show a bar next to a zero. Below the resolution of the format,
        // say that instead of rounding to a claim.
        function formatValue(value) {
            if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
            if (data.metric() === "detection") {
                if (value > 0 && value < 0.005) return "<1%";
                return `${Math.round(value * 100)}%`;
            }
            if (value === 0) return "0";
            if (value < 0.01) return "<0.01";
            return value.toFixed(2);
        }

        function metricLabel() {
            return data.metric() === "detection" ? "detection rate" : "mean expression";
        }

        // ---- region panel ----------------------------------------------------------

        // Which regions the panel draws, and the table behind them. Built once per
        // render: every later step (sorting, scaling, the picker's counts) reads it.
        function regionModel() {
            const rows = series();
            const tables = {};
            rows.forEach((row) => {
                tables[row.symbol] = valuesFor(row);
            });

            // The candidate set comes from the selection only. A control must not add a
            // region to the axis -- it is there to be compared against, not to widen the
            // comparison.
            const carried = new Set();
            rows.forEach((row) => {
                if (row.control) return;
                Object.keys(tables[row.symbol]).forEach((acronym) => carried.add(acronym));
            });

            let acronyms = [...carried].filter(
                (acronym) => state.includeUnmapped || isMapped(acronym),
            );
            const available = acronyms.slice();
            if (state.regions) {
                acronyms = acronyms.filter((acronym) => state.regions.has(acronym));
            }
            return { rows, tables, acronyms: sortRegions(acronyms, tables), available, carried };
        }

        function sortRegions(acronyms, tables) {
            const active = state.selection.active;
            const activeTable = (active && tables[active]) || {};
            const byName = (a, b) => a.localeCompare(b);
            if (state.sort === "name") return acronyms.slice().sort(byName);
            if (state.sort === "group") {
                return acronyms.slice().sort((a, b) => {
                    const left = regionGroup(a);
                    const right = regionGroup(b);
                    return left === right ? byName(a, b) : left.localeCompare(right);
                });
            }
            // By value: regions the active gene does not carry have nothing to rank on,
            // so they go last in name order rather than being dropped or sorted as zero.
            return acronyms.slice().sort((a, b) => {
                const left = activeTable[a];
                const right = activeTable[b];
                const hasLeft = typeof left === "number";
                const hasRight = typeof right === "number";
                if (hasLeft && hasRight) return right - left || byName(a, b);
                if (hasLeft !== hasRight) return hasLeft ? -1 : 1;
                return byName(a, b);
            });
        }

        // The number every bar is drawn against. Shared: one maximum over everything on
        // screen, so bars are comparable across genes and regions -- the honest default.
        // Per gene: each series against its own peak, which is the only way a gene with a
        // 70x smaller dynamic range than a housekeeping control stays visible at all.
        function scaleFor(model) {
            if (state.scale === "series") {
                const peaks = {};
                model.rows.forEach((row) => {
                    const table = model.tables[row.symbol];
                    let peak = 0;
                    model.acronyms.forEach((acronym) => {
                        const value = table[acronym];
                        if (typeof value === "number" && value > peak) peak = value;
                    });
                    peaks[row.symbol] = peak;
                });
                return (row) => peaks[row.symbol] || 0;
            }
            let peak = 0;
            model.rows.forEach((row) => {
                const table = model.tables[row.symbol];
                model.acronyms.forEach((acronym) => {
                    const value = table[acronym];
                    if (typeof value === "number" && value > peak) peak = value;
                });
            });
            return () => peak;
        }

        function share(value, peak) {
            if (typeof value !== "number" || !Number.isFinite(value) || peak <= 0) return null;
            if (value <= 0) return 0;
            return Math.max(MIN_BAR_SHARE, Math.min(1, value / peak));
        }

        function buildRegionGroup(acronym, model, peakOf) {
            const group = doc.createElement("div");
            group.className = "gene-compare-group";
            group.dataset.region = acronym;
            if (state.selectedMembers.indexOf(acronym) !== -1) {
                group.classList.add("selected");
            }
            if (!isMapped(acronym)) group.classList.add("unmapped");

            const bars = doc.createElement("div");
            bars.className = "gene-compare-bars";
            model.rows.forEach((row) => {
                const value = model.tables[row.symbol][acronym];
                const slot = doc.createElement("span");
                slot.className = "gene-compare-bar";
                slot.dataset.series = row.symbol;
                if (row.control) slot.dataset.control = "";
                slot.style.setProperty("--series-colour", row.colour);
                const height = share(value, peakOf(row));
                if (height === null) {
                    // Not measured here. No fill at all, and marked, so it cannot read
                    // as a measured zero.
                    slot.classList.add("missing");
                } else {
                    const fill = doc.createElement("i");
                    fill.style.height = `${(height * 100).toFixed(1)}%`;
                    slot.appendChild(fill);
                }
                bars.appendChild(slot);
            });
            group.appendChild(bars);

            // The axis label doubles as the click target for selecting the region in 3D,
            // so it is a button whenever the atlas can actually place it.
            const label = isMapped(acronym)
                ? doc.createElement("button")
                : doc.createElement("span");
            label.className = "gene-compare-group-label";
            if (label.tagName === "BUTTON") {
                label.type = "button";
                label.dataset.selectRegion = acronym;
                label.title = `${regionName(acronym)} — show in the 3D atlas`;
            } else {
                label.title = `${regionName(acronym)} — a coarse payload label with no parcel in the anatomy, so it cannot be shown in 3D`;
            }
            label.textContent = acronym;
            group.appendChild(label);
            return group;
        }

        // Four gridlines with their values, sticky at the left edge so the scale survives
        // scrolling. In per-gene mode the axis is a percentage of each gene's own peak,
        // because there is no single unit left to label.
        function renderAxis(model, peakOf) {
            if (!dom.regionAxis) return;
            dom.regionAxis.textContent = "";
            const relative = state.scale === "series";
            const peak = relative ? 1 : peakOf(model.rows[0] || { symbol: "" });
            const ticks = [1, 0.75, 0.5, 0.25, 0];
            ticks.forEach((fraction) => {
                const tick = doc.createElement("span");
                tick.className = "gene-compare-tick";
                tick.dataset.tick = String(fraction);
                tick.textContent = relative
                    ? `${Math.round(fraction * 100)}%`
                    : formatValue(peak * fraction);
                dom.regionAxis.appendChild(tick);
            });
            const unit = doc.createElement("small");
            unit.className = "gene-compare-axis-unit";
            unit.textContent = relative ? "of each peak" : metricLabel();
            dom.regionAxis.appendChild(unit);
        }

        // Upright or sideways, for the whole axis at once. A group is only as wide as its
        // bars, so the room for a label is bought by the number of genes on screen: at one
        // gene there are 6px and nothing fits, at five there are 38px and most acronyms do.
        //
        // The test is the longest *word*, not the longest label, because upright labels
        // wrap at spaces -- and the catalogue's compound acronyms ("CA1C CA2C CA3C") are
        // exactly the ones that would otherwise hold the whole axis sideways for the sake
        // of four entries out of 106.
        function labelsFitUpright(model) {
            if (!model.acronyms.length || !model.rows.length) return false;
            const width = model.rows.length * BAR_WIDTH + (model.rows.length - 1) * BAR_GAP;
            let longest = 0;
            model.acronyms.forEach((acronym) => {
                acronym.split(/\s+/).forEach((word) => {
                    if (word.length > longest) longest = word.length;
                });
            });
            return longest * LABEL_CHAR_WIDTH <= width;
        }

        function renderRegionPanel(model) {
            if (!dom.regionTrack) return;
            const peakOf = scaleFor(model);
            renderAxis(model, peakOf);
            dom.regionTrack.dataset.labels = labelsFitUpright(model)
                ? "horizontal"
                : "vertical";
            // Assembled off-document: 106 groups is over a thousand nodes, and appending
            // them one at a time to the live track makes the browser walk the axis after
            // every one of them.
            const fragment = doc.createDocumentFragment();
            model.acronyms.forEach((acronym) => {
                fragment.appendChild(buildRegionGroup(acronym, model, peakOf));
            });
            dom.regionTrack.textContent = "";
            dom.regionTrack.appendChild(fragment);
            // The readout describes a group that no longer exists once the track is rebuilt.
            state.painted = model;
            hideTip();
            syncRegionEmpty(model);
            syncRegionCaption(model);
            syncExportButton(model);
        }

        // ---- region readout --------------------------------------------------------

        // What the bars cannot say. Six pixels of width has no room for a number, and the
        // group carries one bar per gene, so the figures, the region's full name and the
        // evidence behind the active gene all arrive together on hover or focus.
        function buildTip(acronym, model) {
            const tip = dom.regionTip;
            tip.textContent = "";

            const head = doc.createElement("div");
            head.className = "gene-compare-tip-head";
            const code = doc.createElement("strong");
            code.textContent = acronym;
            head.appendChild(code);
            const name = regionName(acronym);
            if (name !== acronym) {
                const full = doc.createElement("span");
                full.textContent = name;
                head.appendChild(full);
            }
            tip.appendChild(head);

            const scope = doc.createElement("p");
            scope.className = "gene-compare-tip-scope";
            scope.textContent = isMapped(acronym)
                ? regionGroup(acronym)
                : "Coarse payload label \u2014 no parcel in the anatomy";
            tip.appendChild(scope);

            model.rows.forEach((row) => {
                const value = model.tables[row.symbol][acronym];
                const line = doc.createElement("div");
                line.className = "gene-compare-tip-row";
                line.dataset.series = row.symbol;
                if (row.control) line.dataset.control = "";
                if (row.active) line.classList.add("active");
                const swatch = doc.createElement("i");
                swatch.style.setProperty("--series-colour", row.colour);
                line.appendChild(swatch);
                const symbol = doc.createElement("span");
                symbol.textContent = row.control ? `${row.symbol} (control)` : row.symbol;
                line.appendChild(symbol);
                const figure = doc.createElement("strong");
                if (typeof value === "number" && Number.isFinite(value)) {
                    figure.textContent = formatValue(value);
                } else {
                    // Says the same thing the empty bar says, in words.
                    figure.textContent = "not measured";
                    line.classList.add("missing");
                }
                line.appendChild(figure);
                tip.appendChild(line);
            });

            // Evidence for the active gene only. It is per gene and per region, and four
            // rows of dataset counts would bury the values the readout exists for.
            const active = state.selection.active;
            const support = active && data.regionSupport(active, acronym);
            const foot = doc.createElement("p");
            foot.className = "gene-compare-tip-foot";
            if (support) {
                const parts = [];
                if (support.datasets) parts.push(plural(support.datasets, "dataset"));
                if (support.donors) parts.push(plural(support.donors, "donor"));
                if (support.cells) parts.push(`${formatCount(support.cells)} cells`);
                foot.textContent = parts.length ? `${active}: ${parts.join(" \u00b7 ")}` : "";
            }
            if (!foot.textContent) foot.textContent = `${metricLabel()} per gene`;
            tip.appendChild(foot);
        }

        function plural(count, noun) {
            return `${count} ${noun}${count === 1 ? "" : "s"}`;
        }

        function formatCount(value) {
            if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
            if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
            return String(value);
        }

        // Follows the pointer, clamped inside the panel: the track scrolls sideways, so a
        // readout anchored to the group would be the one thing on screen that has to be
        // chased. Rects are all zero without a layout engine, so every branch here has to
        // survive that rather than assume a measurement.
        function positionTip(clientX, clientY) {
            const tip = dom.regionTip;
            if (!dom.regionPanel || typeof dom.regionPanel.getBoundingClientRect !== "function") {
                return;
            }
            const panel = dom.regionPanel.getBoundingClientRect();
            const box = tip.getBoundingClientRect();
            let left = clientX - panel.left + 13;
            let top = clientY - panel.top + 13;
            if (panel.width && left + box.width > panel.width - 8) {
                left = clientX - panel.left - box.width - 13;
            }
            if (panel.height && top + box.height > panel.height - 8) {
                top = clientY - panel.top - box.height - 13;
            }
            tip.style.left = `${Math.max(6, left)}px`;
            tip.style.top = `${Math.max(6, top)}px`;
        }

        function showTip(acronym, clientX, clientY) {
            if (!dom.regionTip || !state.painted) return;
            if (state.hovered !== acronym) {
                buildTip(acronym, state.painted);
                state.hovered = acronym;
            }
            dom.regionTip.hidden = false;
            positionTip(clientX, clientY);
        }

        function hideTip() {
            if (!dom.regionTip) return;
            dom.regionTip.hidden = true;
            state.hovered = null;
        }

        function syncRegionEmpty(model) {
            if (!dom.regionEmpty) return;
            const reason = !state.selection.genes.length
                ? "Search for a gene above to compare it across regions."
                : !model.available.length
                    ? "None of the selected genes carry data in a region the atlas can place."
                    : !model.acronyms.length
                        ? "No region is selected. Use the Regions picker to choose some, or reset it to all with data."
                        : "";
            dom.regionEmpty.hidden = !reason;
            dom.regionEmpty.textContent = reason;
            if (dom.regionTrack) dom.regionTrack.hidden = Boolean(reason);
            if (dom.regionAxis) dom.regionAxis.hidden = Boolean(reason);
        }

        // Says what the bars are, how many regions are on screen out of how many carry
        // data, and -- when they apply -- the two things that silently change the
        // reading: a class filter, and coarse labels being off the axis.
        function syncRegionCaption(model) {
            if (!dom.regionCaption) return;
            if (!state.selection.genes.length) {
                dom.regionCaption.textContent = "";
                return;
            }
            const parts = [];
            parts.push(
                `${metricLabel()}, ${
                    data.rule() === "cell_weighted" ? "cell-weighted" : "donor-balanced"
                }`,
            );
            parts.push(`${model.acronyms.length} of ${model.carried.size} regions with data`);
            const hidden = [...model.carried].filter((acronym) => !isMapped(acronym)).length;
            if (hidden && !state.includeUnmapped) {
                parts.push(`${hidden} coarse labels off the axis`);
            }
            const filter = state.selection.filter;
            if (filter && filter.length) {
                // Which controls the filter reached is the reader's business: a control
                // stuck at all-classes is not comparable to a filtered selection, and
                // saying "controls stay all-classes" when they did follow would be worse
                // than saying nothing.
                const stuck = model.rows.filter(
                    (row) => row.control && !canBreakDown(row.symbol),
                );
                parts.push(
                    `selection restricted to ${filter.length} cell ${
                        filter.length === 1 ? "type" : "types"
                    }${
                        stuck.length
                            ? "; controls stay all-types"
                            : model.rows.some((row) => row.control)
                                ? "; controls follow the same types"
                                : ""
                    }`,
                );
            }
            if (state.scale === "series") parts.push("each gene against its own peak");
            dom.regionCaption.textContent = parts.join(" · ");
        }

        // ---- CSV export ------------------------------------------------------------

        // The on-screen numbers, as a file: the selected genes by exactly the regions
        // the picker currently allows, in the order the axis shows. Controls are
        // reference, not selection, so they stay out; missing data stays empty, never
        // zero.
        function csvCell(text) {
            const value = String(text);
            return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        }

        function buildRegionCsv() {
            const model = regionModel();
            const genes = model.rows.filter((row) => !row.control).map((row) => row.symbol);
            if (!genes.length || !model.acronyms.length) return null;
            const lines = [
                ["region_acronym", "region_name", "anatomical_group", ...genes].map(csvCell).join(","),
            ];
            model.acronyms.forEach((acronym) => {
                lines.push(
                    [
                        acronym,
                        regionName(acronym),
                        regionGroup(acronym),
                        ...genes.map((symbol) => {
                            const value = model.tables[symbol][acronym];
                            return typeof value === "number" && Number.isFinite(value)
                                ? String(value)
                                : "";
                        }),
                    ].map(csvCell).join(","),
                );
            });
            return `${lines.join("\n")}\n`;
        }

        function exportRegionsCsv() {
            const csv = buildRegionCsv();
            if (!csv) return null;
            // Metric and rule in the name, because the same click after a switch can
            // legitimately carry different numbers.
            const name = `gene-expression-regions-${data.rule()}-${data.metric()}.csv`;
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = doc.createElement("a");
            link.href = url;
            link.download = name;
            doc.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            return name;
        }

        function syncExportButton(model) {
            if (!dom.regionExport) return;
            const genes = model.rows.filter((row) => !row.control);
            dom.regionExport.disabled = !genes.length || !model.acronyms.length;
        }

        function renderKey(model) {
            if (!dom.key) return;
            dom.key.textContent = "";
            model.rows.forEach((row) => {
                const item = doc.createElement("span");
                item.className = "gene-compare-key-item";
                item.dataset.series = row.symbol;
                if (row.control) item.dataset.control = "";
                if (row.active) item.classList.add("active");
                const swatch = doc.createElement("i");
                swatch.style.setProperty("--series-colour", row.colour);
                item.appendChild(swatch);
                item.appendChild(
                    doc.createTextNode(row.control ? `${row.symbol} (control)` : row.symbol),
                );
                dom.key.appendChild(item);
            });
        }

        // ---- class panel -----------------------------------------------------------

        // Per-class values for one gene, normalised to { cellType, value, cells } whether
        // they come from a single region or from the whole-brain summary, which the data
        // layer reports in two different shapes.
        function classRowsFor(symbol) {
            const region = state.selected;
            if (region) {
                return data.cellTypeDetail(symbol, region).map((row) => ({
                    cellType: row.cellType,
                    value: row[data.metric()],
                    cells: row.cells,
                }));
            }
            const summary = data.cellTypeSummary(symbol);
            return Object.keys(summary).map((cellType) => ({
                cellType,
                value: summary[cellType].value,
                cells: summary[cellType].cells,
            }));
        }

        // The fallback for a control this build has no cell-class tier for: one
        // all-classes figure for the same scope, computed with the same rule. Controls that
        // do ship a tier are read per class instead -- see classModel().
        function controlReference(symbol) {
            if (state.selected) {
                const value = data.regionValues(symbol, { cellTypes: [] })[state.selected];
                return typeof value === "number" ? value : null;
            }
            return typeof data.wholeBrainValue === "function"
                ? data.wholeBrainValue(symbol)
                : null;
        }

        function classTableFor(symbol) {
            const table = {};
            classRowsFor(symbol).forEach((entry) => {
                if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) return;
                table[entry.cellType] = entry;
            });
            return table;
        }

        function classModel() {
            const rows = series();
            const perGene = {};
            const withoutDetail = [];
            const references = {};
            // Controls are kept in their own table rather than in perGene, because the
            // class list and the sort are the selection's business: a control is there to
            // be compared against, not to add a class block or reorder them.
            const controlClasses = {};
            rows.forEach((row) => {
                if (row.control) {
                    if (canBreakDown(row.symbol)) {
                        controlClasses[row.symbol] = classTableFor(row.symbol);
                    } else {
                        references[row.symbol] = controlReference(row.symbol);
                    }
                    return;
                }
                if (!canBreakDown(row.symbol)) {
                    withoutDetail.push(row.symbol);
                    perGene[row.symbol] = {};
                    return;
                }
                perGene[row.symbol] = classTableFor(row.symbol);
            });

            const classes = new Set();
            Object.keys(perGene).forEach((symbol) => {
                Object.keys(perGene[symbol]).forEach((cellType) => classes.add(cellType));
            });

            let peak = 0;
            Object.keys(perGene).forEach((symbol) => {
                Object.keys(perGene[symbol]).forEach((cellType) => {
                    peak = Math.max(peak, perGene[symbol][cellType].value);
                });
            });
            // A control bar the selection cannot reach would be drawn clipped and read as
            // equal to the tallest bar, so it takes part in the maximum -- but only for the
            // classes actually on screen, or a control's peak in some class nobody is
            // looking at would flatten every bar that is.
            Object.keys(controlClasses).forEach((symbol) => {
                classes.forEach((cellType) => {
                    const entry = controlClasses[symbol][cellType];
                    if (entry) peak = Math.max(peak, entry.value);
                });
            });
            Object.keys(references).forEach((symbol) => {
                if (typeof references[symbol] === "number") {
                    peak = Math.max(peak, references[symbol]);
                }
            });

            const active = state.selection.active;
            const activeTable = (active && perGene[active]) || {};
            const ordered = [...classes].sort((a, b) => {
                const left = activeTable[a] ? activeTable[a].value : -1;
                const right = activeTable[b] ? activeTable[b].value : -1;
                return right - left || a.localeCompare(b);
            });
            return {
                rows,
                perGene,
                references,
                controlClasses,
                classes: ordered,
                peak,
                withoutDetail,
            };
        }

        function classColour(cellType) {
            if (atlas && typeof atlas.cellTypeColour === "function") {
                return atlas.cellTypeColour(cellType) || "#8ea6ad";
            }
            return "#8ea6ad";
        }

        function buildClassBar(row, value, peak, note) {
            const line = doc.createElement("div");
            line.className = "gene-compare-class-row";
            line.dataset.series = row.symbol;
            if (row.control) line.dataset.control = "";
            line.style.setProperty("--series-colour", row.colour);

            const label = doc.createElement("span");
            label.className = "gene-compare-class-symbol";
            label.textContent = note ? `${row.symbol} ${note}` : row.symbol;
            line.appendChild(label);

            const track = doc.createElement("span");
            track.className = "gene-compare-class-track";
            const width = share(value, peak);
            if (width === null) {
                line.classList.add("missing");
            } else {
                const fill = doc.createElement("i");
                fill.style.width = `${(width * 100).toFixed(1)}%`;
                track.appendChild(fill);
            }
            line.appendChild(track);

            const readout = doc.createElement("strong");
            readout.dataset.value = row.symbol;
            readout.textContent = formatValue(value);
            line.appendChild(readout);
            return line;
        }

        function buildClassBlock(cellType, model) {
            const block = doc.createElement("section");
            block.className = "gene-compare-class";
            block.dataset.cellType = cellType;
            block.style.setProperty("--class-colour", classColour(cellType));

            const head = doc.createElement("header");
            const dot = doc.createElement("span");
            dot.className = "gene-compare-class-dot";
            head.appendChild(dot);
            const name = doc.createElement("strong");
            name.textContent = cellType;
            head.appendChild(name);
            const cells = model.rows.reduce((most, row) => {
                const entry = model.perGene[row.symbol] && model.perGene[row.symbol][cellType];
                return entry ? Math.max(most, Number(entry.cells) || 0) : most;
            }, 0);
            if (cells > 0) {
                const count = doc.createElement("small");
                count.textContent = `${cells.toLocaleString()} cells`;
                head.appendChild(count);
            }
            block.appendChild(head);

            model.rows.forEach((row) => {
                if (row.control) return;
                // A gene with no cell-class tier at all is left out rather than given a
                // dash in every block: that is one structural fact, said once in the note
                // below the grid, not thirty apparent measurement gaps. A gene that does
                // have a tier but no entry for this class keeps its row, because there the
                // gap is the finding.
                if (model.withoutDetail.indexOf(row.symbol) !== -1) return;
                const entry = model.perGene[row.symbol] && model.perGene[row.symbol][cellType];
                block.appendChild(
                    buildClassBar(row, entry ? entry.value : null, model.peak, ""),
                );
            });

            const controls = model.rows.filter((row) => row.control);
            const perClass = controls.filter((row) => model.controlClasses[row.symbol]);
            const allClasses = controls.filter((row) => !model.controlClasses[row.symbol]);
            if (perClass.length) {
                const rule = doc.createElement("p");
                rule.className = "gene-compare-class-reference";
                // Named for what it is: this type's own baseline. Astrocyte, Microglia and
                // OPC nuclei carry fewer counts than neurons, so their baseline sits lower
                // for reasons that have nothing to do with the gene being looked at.
                rule.textContent = "Baseline in this type";
                block.appendChild(rule);
                perClass.forEach((row) => {
                    const entry = model.controlClasses[row.symbol][cellType];
                    block.appendChild(
                        buildClassBar(row, entry ? entry.value : null, model.peak, ""),
                    );
                });
            }
            if (allClasses.length) {
                const rule = doc.createElement("p");
                rule.className = "gene-compare-class-reference";
                rule.textContent = "Reference, all classes";
                block.appendChild(rule);
                allClasses.forEach((row) => {
                    block.appendChild(
                        buildClassBar(row, model.references[row.symbol], model.peak, ""),
                    );
                });
            }
            return block;
        }

        function renderClassPanel(model) {
            if (!dom.classGrid) return;
            const fragment = doc.createDocumentFragment();
            model.classes.forEach((cellType) => {
                fragment.appendChild(buildClassBlock(cellType, model));
            });
            dom.classGrid.textContent = "";
            dom.classGrid.appendChild(fragment);
            syncClassHead(model);
            syncClassEmpty(model);
            syncClassNote(model);
        }

        function syncClassHead(model) {
            if (dom.classTitle) {
                dom.classTitle.textContent = state.selected
                    ? `Within cell types · ${state.selected}`
                    : "Within cell types · whole brain";
            }
            if (!dom.classCaption) return;
            if (!model.classes.length) {
                dom.classCaption.textContent = "";
                return;
            }
            const where = state.selected
                ? `${regionName(state.selected)}`
                : "every region the detail tier covers";
            dom.classCaption.textContent = `${metricLabel()} in ${where} · ${
                model.classes.length
            } ${model.classes.length === 1 ? "class" : "classes"} with data · bars share one scale`;
        }

        function syncClassEmpty(model) {
            if (!dom.classEmpty) return;
            const reason = !state.selection.genes.length
                ? "Search for a gene above to see its cell-class breakdown."
                : !model.classes.length
                    ? state.selected
                        ? `No selected gene has a cell-class breakdown in ${state.selected}.`
                        : "No selected gene ships a cell-class breakdown."
                    : "";
            dom.classEmpty.hidden = !reason;
            dom.classEmpty.textContent = reason;
            if (dom.classGrid) dom.classGrid.hidden = Boolean(reason);
        }

        // Two things the panel cannot show, said once here rather than repeated as a gap
        // in every block: genes that ship no per-class tier, and the scope a control bar
        // actually belongs to.
        function syncClassNote(model) {
            if (!dom.classNote) return;
            const notes = [];
            if (model.withoutDetail.length) {
                notes.push(
                    `${model.withoutDetail.join(", ")} ship${
                        model.withoutDetail.length === 1 ? "s" : ""
                    } region-level values only, so ${
                        model.withoutDetail.length === 1 ? "it has" : "they have"
                    } no cell-class breakdown.`,
                );
            }
            const controls = model.rows.filter(
                (row) => row.control && !model.controlClasses[row.symbol],
            );
            if (controls.length) notes.push(describeControlScope(controls));
            dom.classNote.hidden = !notes.length;
            dom.classNote.textContent = notes.join(" ");
        }

        function describeControlScope(controls) {
            const names = controls.map((row) => row.symbol).join(", ");
            const where = state.selected ? state.selected : "the whole brain";
            return `${names} ${controls.length === 1 ? "carries" : "carry"} no cell-type tier, so ${
                controls.length === 1 ? "it is" : "they are"
            } drawn as one all-types reference for ${where}, not as a per-type value.`;
        }

        // ---- pickers ---------------------------------------------------------------

        // Grouped by anatomy, because that is how 163 regions become a handful of
        // decisions: one click takes a whole group, and the group header carries the
        // count so the reader knows what they are taking.
        //
        // Only built while the popover is open. It is a third of the panel's nodes, and
        // rebuilding a closed list on every metric, rule or class change was the single
        // most expensive thing a redraw did.
        function renderRegionPicker(model) {
            if (!dom.regionPickerList || !dom.regionPickerPanel) return;
            if (dom.regionPickerPanel.hidden) return;
            dom.regionPickerList.textContent = "";
            const needle = state.filterText.trim().toLowerCase();
            const matches = model.available.filter((acronym) => {
                if (!needle) return true;
                // The group name counts as part of a region's identity here: several
                // catalogue names spell the structure differently from the way anyone
                // types it ("CA1 region of Hipp" for a query of "hippocampus"), and the
                // group is where the familiar word lives.
                return (
                    acronym.toLowerCase().indexOf(needle) !== -1
                    || regionName(acronym).toLowerCase().indexOf(needle) !== -1
                    || regionGroup(acronym).toLowerCase().indexOf(needle) !== -1
                );
            });

            const groups = {};
            matches.forEach((acronym) => {
                const group = regionGroup(acronym);
                (groups[group] || (groups[group] = [])).push(acronym);
            });

            Object.keys(groups)
                .sort()
                .forEach((group) => {
                    const acronyms = groups[group].sort();
                    const block = doc.createElement("div");
                    block.className = "gene-compare-picker-group";

                    const header = doc.createElement("button");
                    header.type = "button";
                    header.className = "gene-compare-picker-group-head";
                    header.dataset.regionGroup = group;
                    const chosen = acronyms.filter((acronym) => isChosen(acronym)).length;
                    header.textContent = `${group} · ${chosen}/${acronyms.length}`;
                    if (chosen === acronyms.length) header.classList.add("active");
                    block.appendChild(header);

                    acronyms.forEach((acronym) => {
                        const row = doc.createElement("label");
                        row.className = "gene-compare-picker-row";
                        row.dataset.regionOption = acronym;
                        const box = doc.createElement("input");
                        box.type = "checkbox";
                        box.dataset.regionBox = acronym;
                        box.checked = isChosen(acronym);
                        row.appendChild(box);
                        const code = doc.createElement("span");
                        code.className = "gene-compare-picker-code";
                        code.textContent = acronym;
                        row.appendChild(code);
                        const name = doc.createElement("small");
                        name.textContent = regionName(acronym);
                        row.appendChild(name);
                        block.appendChild(row);
                    });
                    dom.regionPickerList.appendChild(block);
                });

            if (!matches.length) {
                const empty = doc.createElement("p");
                empty.className = "gene-compare-popover-empty";
                empty.textContent = needle
                    ? `No region with data matches “${state.filterText.trim()}”.`
                    : "No region carries the selected genes yet.";
                dom.regionPickerList.appendChild(empty);
            }

            if (dom.regionPickerNote) {
                const coarse = [...model.carried].filter((acronym) => !isMapped(acronym)).length;
                dom.regionPickerNote.textContent = coarse
                    ? `${coarse} coarse labels (whole lobes, merged parcels) carry data but have no place in the anatomy. ${
                        state.includeUnmapped ? "They are on the axis." : "They are off the axis."
                    }`
                    : "";
            }
        }

        // The two toggle badges, which have to stay current whether or not their lists are
        // built: they are the only thing on screen saying the axis has been narrowed.
        function syncPickerBadges(model) {
            if (dom.regionPickerCount) {
                dom.regionPickerCount.textContent = state.regions
                    ? `${model.acronyms.length}`
                    : "all";
            }
            if (dom.controlPickerCount) {
                dom.controlPickerCount.textContent = state.controls.length
                    ? `${state.controls.length}`
                    : "";
            }
        }

        function isChosen(acronym) {
            return state.regions ? state.regions.has(acronym) : true;
        }

        function renderControlPicker() {
            if (!dom.controlPickerList || !dom.controlPickerPanel) return;
            if (dom.controlPickerPanel.hidden) return;
            dom.controlPickerList.textContent = "";
            let family = null;
            CONTROL_GENES.forEach((control) => {
                // A build that does not carry the gene cannot draw it, and offering it
                // would fail on click with nothing on screen to explain why.
                if (!carriesGene(control.symbol)) return;
                if (control.family !== family) {
                    family = control.family;
                    const head = doc.createElement("p");
                    head.className = "gene-compare-picker-family";
                    head.textContent = family;
                    dom.controlPickerList.appendChild(head);
                }
                const row = doc.createElement("label");
                row.className = "gene-compare-picker-row";
                row.dataset.controlOption = control.symbol;
                const box = doc.createElement("input");
                box.type = "checkbox";
                box.dataset.controlBox = control.symbol;
                box.checked = state.controls.indexOf(control.symbol) !== -1;
                row.appendChild(box);
                // The tint the bars will carry, shown before the choice is made rather than
                // discovered afterwards on a 6px bar.
                const swatch = doc.createElement("i");
                swatch.className = "gene-compare-picker-swatch";
                swatch.style.setProperty("--series-colour", control.tint);
                row.appendChild(swatch);
                const code = doc.createElement("span");
                code.className = "gene-compare-picker-code";
                code.textContent = control.symbol;
                row.appendChild(code);
                dom.controlPickerList.appendChild(row);
            });
        }

        // The payload index is the authority on what this build ships. An older data layer
        // with no accessor for it gets the benefit of the doubt: the gene is offered, and a
        // failed fetch shows up as a bar with no data, which is already handled.
        function carriesGene(symbol) {
            if (typeof data.hasGene === "function") return data.hasGene(symbol);
            return true;
        }

        // ---- render ----------------------------------------------------------------

        function render(selection) {
            if (selection) {
                state.selection = {
                    genes: (selection.genes || []).slice(),
                    active: selection.active || null,
                    filter: selection.filter || null,
                };
            }
            syncVisibility();
            if (dom.root.hidden) return;
            const model = regionModel();
            renderRegionPanel(model);
            renderKey(model);
            syncPickerBadges(model);
            renderRegionPicker(model);
            renderControlPicker();
            renderClassPanel(classModel());
        }

        function syncVisibility() {
            dom.root.hidden = state.layer !== "genes";
        }

        function setLayer(layer) {
            state.layer = layer;
            syncVisibility();
            if (!dom.root.hidden) render();
        }

        function attachAtlas(next) {
            atlas = next || atlas;
            catalogueCache = null;
            render();
            return atlas;
        }

        // ---- interaction -----------------------------------------------------------

        function setSort(sort) {
            state.sort = sort;
            render();
        }

        function setScale(scale) {
            state.scale = scale === "series" ? "series" : "shared";
            if (dom.scaleTabs) {
                dom.scaleTabs.querySelectorAll("[data-scale]").forEach((button) => {
                    button.classList.toggle("active", button.dataset.scale === state.scale);
                });
            }
            render();
        }

        function setRegions(list) {
            state.regions = list ? new Set(list) : null;
            render();
        }

        function toggleRegion(acronym, on) {
            const model = regionModel();
            const next = new Set(state.regions || model.available);
            if (on) next.add(acronym);
            else next.delete(acronym);
            // Back to every available region is the default state, not a set that happens
            // to contain all of them: a later gene change should widen it again.
            state.regions = next.size === model.available.length ? null : next;
            render();
        }

        function toggleGroup(group) {
            const model = regionModel();
            const members = model.available.filter((acronym) => regionGroup(acronym) === group);
            const chosen = members.filter((acronym) => isChosen(acronym)).length;
            const next = new Set(state.regions || model.available);
            if (chosen === members.length) members.forEach((acronym) => next.delete(acronym));
            else members.forEach((acronym) => next.add(acronym));
            state.regions = next.size === model.available.length ? null : next;
            render();
        }

        function applyPreset(preset) {
            if (preset === "all") {
                state.regions = null;
                render();
                return;
            }
            if (preset === "none") {
                setRegions([]);
                return;
            }
            if (preset === "top") {
                // Taken from every region with data, not from whatever is currently on the
                // axis: after a narrowing, "Top 20" of the visible three would just be the
                // three, which is not what the preset offers to do.
                const model = regionModel();
                setRegions(
                    sortRegions(model.available, model.tables).slice(0, TOP_PRESET_SIZE),
                );
            }
        }

        function setControls(list) {
            const wanted = (list || []).filter((symbol) =>
                CONTROL_GENES.some((control) => control.symbol === symbol),
            );
            state.controls = wanted;
            render();
            // A control the build has not fetched yet draws as missing until it lands,
            // so pull it and redraw. Failures are left to the region panel's own
            // "no data" treatment rather than a second error surface.
            //
            // The class panel reads a control per class, which needs its detail tier as
            // well -- a few hundred KB each, fetched only for controls the reader actually
            // switched on, and never at page load. Without it the panel would silently fall
            // back to the all-classes reference for the rest of the session.
            const pending = [];
            wanted.forEach((symbol) => {
                if (!data.isLoaded(symbol)) {
                    pending.push(data.loadGene(symbol).catch(() => null));
                }
                if (typeof data.loadGeneDetail !== "function") return;
                if (typeof data.hasDetail === "function" && !data.hasDetail(symbol)) return;
                if (canBreakDown(symbol)) return;
                pending.push(data.loadGeneDetail(symbol).catch(() => null));
            });
            if (!pending.length) return Promise.resolve(null);
            return Promise.all(pending).then(() => {
                render();
                return null;
            });
        }

        function setIncludeUnmapped(include) {
            state.includeUnmapped = Boolean(include);
            render();
        }

        function openPopover(picker, open) {
            const panel = picker === "regions" ? dom.regionPickerPanel : dom.controlPickerPanel;
            const toggle = picker === "regions" ? dom.regionPickerToggle : dom.controlPickerToggle;
            if (!panel || !toggle) return;
            panel.hidden = !open;
            toggle.setAttribute("aria-expanded", open ? "true" : "false");
            // Built on opening rather than kept in sync while closed.
            if (!open) return;
            if (picker === "regions") renderRegionPicker(regionModel());
            else renderControlPicker();
        }

        if (dom.regionPickerToggle) {
            dom.regionPickerToggle.addEventListener("click", () => {
                const open = dom.regionPickerPanel.hidden;
                openPopover("regions", open);
                openPopover("controls", false);
            });
        }
        if (dom.controlPickerToggle) {
            dom.controlPickerToggle.addEventListener("click", () => {
                const open = dom.controlPickerPanel.hidden;
                openPopover("controls", open);
                openPopover("regions", false);
            });
        }
        if (dom.regionPickerSearch) {
            dom.regionPickerSearch.addEventListener("input", (event) => {
                state.filterText = event.target.value || "";
                renderRegionPicker(regionModel());
            });
        }
        if (dom.regionPresets) {
            dom.regionPresets.addEventListener("click", (event) => {
                const button = event.target.closest("[data-region-preset]");
                if (button) applyPreset(button.dataset.regionPreset);
            });
        }
        if (dom.regionPickerList) {
            dom.regionPickerList.addEventListener("change", (event) => {
                const box = event.target.closest("[data-region-box]");
                if (box) toggleRegion(box.dataset.regionBox, box.checked);
            });
            dom.regionPickerList.addEventListener("click", (event) => {
                const group = event.target.closest("[data-region-group]");
                if (group) {
                    event.preventDefault();
                    toggleGroup(group.dataset.regionGroup);
                }
            });
        }
        if (dom.controlPickerList) {
            dom.controlPickerList.addEventListener("change", (event) => {
                const box = event.target.closest("[data-control-box]");
                if (!box) return;
                const ticked = [...dom.controlPickerList.querySelectorAll("[data-control-box]")]
                    .filter((node) => node.checked)
                    .map((node) => node.dataset.controlBox);
                setControls(ticked);
            });
        }
        if (dom.regionSort) {
            dom.regionSort.addEventListener("change", (event) => setSort(event.target.value));
        }
        if (dom.regionExport) {
            dom.regionExport.addEventListener("click", exportRegionsCsv);
        }
        if (dom.scaleTabs) {
            dom.scaleTabs.addEventListener("click", (event) => {
                const button = event.target.closest("[data-scale]");
                if (button) setScale(button.dataset.scale);
            });
        }
        if (dom.regionTrack) {
            // Clicking a region's label opens it in the 3D view. The atlas then announces
            // the selection, which is what highlights the group here -- the selection has
            // one owner, and it is not this panel.
            dom.regionTrack.addEventListener("click", (event) => {
                const label = event.target.closest("[data-select-region]");
                if (!label) return;
                if (atlas && typeof atlas.selectRegion === "function") {
                    atlas.selectRegion(label.dataset.selectRegion);
                }
            });

            // Mouse events rather than pointer events: the readout needs the coordinates,
            // and this is the pair every environment the panel runs in agrees on.
            dom.regionTrack.addEventListener("mousemove", (event) => {
                const group = event.target.closest("[data-region]");
                if (!group) {
                    hideTip();
                    return;
                }
                showTip(group.dataset.region, event.clientX, event.clientY);
            });
            dom.regionTrack.addEventListener("mouseleave", hideTip);
            // Keyboard reaches the axis through the region labels, so the readout opens on
            // focus too -- otherwise the figures would be mouse-only.
            dom.regionTrack.addEventListener("focusin", (event) => {
                const group = event.target.closest("[data-region]");
                if (!group) return;
                const box = group.getBoundingClientRect();
                showTip(group.dataset.region, box.left + box.width / 2, box.bottom);
            });
            dom.regionTrack.addEventListener("focusout", hideTip);
            // A readout placed against the pointer is wrong the moment the track moves
            // under it, and it cannot follow a scroll it does not receive.
            dom.regionTrack.addEventListener("scroll", hideTip);
        }

        if (host && typeof host.addEventListener === "function") {
            host.addEventListener("digitalbrain-region-select", (event) => {
                const detail = event && event.detail;
                state.selected = (detail && detail.acronym) || null;
                state.selectedMembers = (detail && detail.members) || [];
                if (!dom.root.hidden) render();
            });
            host.addEventListener("digitalbrain-atlas-layer", (event) => {
                const detail = event && event.detail;
                setLayer(detail ? detail.layer : null);
            });
        }

        syncVisibility();

        return {
            render,
            setLayer,
            attachAtlas,
            setSort,
            setScale,
            setRegions,
            setControls,
            setIncludeUnmapped,
            applyPreset,
            buildRegionCsv,
            exportRegionsCsv,
            selectedRegions: () => (state.regions ? [...state.regions] : null),
            controls: () => state.controls.slice(),
            selectedRegion: () => state.selected,
            controlTint,
            CONTROL_GENES,
        };
    }

    const api = { init, controlTint, CONTROL_GENES };
    global.GeneCompareView = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
