// Genes layer wiring inside interactive_brain_atlas/app.js.
//
// The atlas is a self-invoking IIFE bound to fixed DOM ids, so it is exercised in
// jsdom against the real data files (about 500 KB total) rather than synthetic
// fixtures: the value provider depends on region.hasAnatomy and geometryMapping,
// which only the real catalogue carries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WEB_DIR = __dirname;
const ATLAS_DIR = path.join(WEB_DIR, 'interactive_brain_atlas');

// The real cell_weighted/mean calibration, as index.json ships it. The atlas refuses
// a payload without one, so every applyGeneValues call in this file has to carry it.
const SCALE = {
  breakpoint: 0.5201,
  reference: 3.5091,
  lowKnots: [0, 0.0008, 0.003, 0.0085, 0.0196, 0.0372, 0.0602,
             0.0889, 0.1253, 0.1729, 0.2382, 0.3379, 0.5201],
};

// Most tests here care about one gene's values, not about the multi-gene seam.
function oneGene(values, options) {
  const extra = options || {};
  return {
    metric: extra.metric || 'mean',
    rule: extra.rule || 'cell_weighted',
    scale: extra.scale === undefined ? SCALE : extra.scale,
    genes: [{
      symbol: extra.symbol || 'AIF1',
      colour: extra.colour || '#4cc9f0',
      values,
      support: extra.support || Object.fromEntries(Object.keys(values).map((key) => [key, 1000])),
    }],
  };
}

// Several genes at once, which is the state the region panel and the visible-region
// set have to survive: entries is [{ symbol, values, colour? }].
function severalGenes(entries, options) {
  const extra = options || {};
  return {
    metric: extra.metric || 'mean',
    rule: extra.rule || 'cell_weighted',
    active: extra.active || entries[0].symbol,
    scale: extra.scale === undefined ? SCALE : extra.scale,
    genes: entries.map((entry, index) => ({
      symbol: entry.symbol,
      colour: entry.colour || ['#4cc9f0', '#f7b267', '#b5e48c'][index % 3],
      values: entry.values,
      support: Object.fromEntries(Object.keys(entry.values).map((key) => [key, 1000])),
    })),
  };
}

function stubContext() {
  // The atlas only draws; nothing reads back from the context except measureText.
  const noop = () => {};
  return {
    arc: noop,
    beginPath: noop,
    clearRect: noop,
    closePath: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    fill: noop,
    fillRect: noop,
    fillText: noop,
    lineTo: noop,
    measureText: () => ({ width: 0 }),
    moveTo: noop,
    quadraticCurveTo: noop,
    restore: noop,
    save: noop,
    setLineDash: noop,
    setTransform: noop,
    stroke: noop,
    strokeRect: noop,
  };
}

function bootAtlas(options) {
  const settings = options || {};
  const html = fs
    .readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = settings.context || (() => stubContext());
  // jsdom exposes no structuredClone; the atlas uses it to deep-copy the catalogue.
  window.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  // Neither structuredClone nor ResizeObserver exist in jsdom; the observer only
  // drives canvas resizing, which the fixed getBoundingClientRect already covers.
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A real rAF would loop forever; record the frame callback and drive it by hand.
  const frames = [];
  window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  window.Element.prototype.getBoundingClientRect = () => ({
    width: 900,
    height: 600,
    top: 0,
    left: 0,
    right: 900,
    bottom: 600,
    x: 0,
    y: 0,
  });

  const context = dom.getInternalVMContext();
  // Same order as digitalneuron_main.html: the bridge installs the scope guard, so
  // it has to be listening before the atlas boots and announces its initial layer.
  vm.runInContext(fs.readFileSync(path.join(WEB_DIR, 'atlas-bridge.js'), 'utf8'), context, {
    filename: 'atlas-bridge.js',
  });
  ['data/regions.js', 'data/allen_3d_geometry.js', 'data/connectivity.js', 'data/atlas_knowledge.js', 'gene_point_cloud.js', 'app.js']
    .forEach((file) => {
      const code = fs.readFileSync(path.join(ATLAS_DIR, file), 'utf8');
      vm.runInContext(code, context, { filename: file });
    });

  assert.ok(window.DigitalBrainAtlas, 'the atlas should expose its host API');
  // Drain the frames queued during boot so later assertions see a settled state.
  // A single frame is not enough: render() throttles at 30 ms and lastFrame starts at
  // performance.now(), so a fixed timestamp lets only the first frame through and every
  // later drawOneFrame() short-circuits into a no-op. Advance a monotonic clock instead.
  let clock = 0;
  const drawOneFrame = () => {
    const pending = frames.splice(0, frames.length);
    clock += 100;
    pending.forEach((callback) => callback(clock));
  };
  drawOneFrame();
  return { window, drawOneFrame };
}

function testThresholdControlsCoverTheFullPercentageRange() {
  const { window } = bootAtlas();
  const document = window.document;
  const cases = [
    ['abundanceFilter', '0'],
    ['connectivityFilter', '96'],
  ];

  cases.forEach(([id, defaultValue]) => {
    const input = document.getElementById(id);
    assert.equal(input.min, '0', `${id} should start at 0%`);
    assert.equal(input.max, '100', `${id} should end at 100%`);
    assert.equal(input.step, '1', `${id} should move in whole percentage points`);
    assert.equal(input.defaultValue, defaultValue, `${id} should preserve its default`);
    assert.deepEqual(
      [...input.closest('.control-section').querySelectorAll('.range-labels span')]
        .map((label) => label.textContent.trim()),
      ['0%', '100%'],
      `${id} should label the full percentage interval`,
    );
  });
}

function testConnectionThresholdUsesDirectPercentileLabelsAndBoundaryFiltering() {
  const { window, drawOneFrame } = bootAtlas();
  const document = window.document;
  const input = document.getElementById('connectivityFilter');
  const output = document.getElementById('connectivityValue');
  const legend = document.getElementById('connectivityLegendThreshold');
  const visibleLinks = document.getElementById('cellTypeCount');
  const totalLinks = window.DIGITALBRAIN_CONNECTIVITY_DATA.metadata.edgeCount;

  document.querySelector('[data-layer="functional"]').click();

  input.value = '0';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  drawOneFrame();
  assert.equal(output.textContent, '0%', 'the control should display its percentile directly');
  assert.equal(legend.textContent, '0%', 'the legend should use the same direct percentile');
  assert.equal(Number(visibleLinks.textContent), totalLinks, '0% should make every link eligible');

  input.value = '100';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  drawOneFrame();
  assert.equal(output.textContent, '100%', 'the upper boundary should display 100%');
  assert.equal(legend.textContent, '100%', 'the legend should display the same upper boundary');
  assert.ok(Number(visibleLinks.textContent) > 0, '100% should retain the maximum-valued link');
  assert.ok(Number(visibleLinks.textContent) < totalLinks, '100% should remove lower-valued links');
}

// A panel outside the atlas -- the comparison charts under the 3D view -- has to follow
// the canvas selection, and polling for it is how two copies of one state drift apart.
// So the atlas announces it, and the announcement is the contract.
function testTheAtlasAnnouncesItsSelection() {
  const { window } = bootAtlas();
  const seen = [];
  window.addEventListener('digitalbrain-region-select', (event) => seen.push(event.detail));

  const [acronym] = someMappedAcronyms(window, 1);
  window.DigitalBrainAtlas.selectRegion(acronym);
  assert.equal(seen.length, 1, 'selecting announces once');
  assert.equal(seen[0].acronym, acronym);
  assert.equal(seen[0].isGroup, false);
  assert.deepEqual([...seen[0].members], [acronym],
    'a single region stands for itself, so a listener can treat both cases alike');
  assert.ok(seen[0].name && seen[0].group, 'named, because the acronym is all the payloads carry');

  // Escape clears the selection; the panel has to hear that too, or it would keep a
  // region highlighted that the atlas no longer has open.
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null, 'cleared is announced as null, not as an empty region');
}

// A group aggregate would travel as its member list rather than as an acronym, but that
// path is not reachable from either shipped page -- the schematic anatomy mode that
// selects groups is hidden in both -- so there is nothing here to drive it through. The
// consuming side of that shape is covered in test_gene_compare_view.js, which dispatches
// the event directly.

// The gene payloads identify regions by acronym only, so a host-side control needs the
// atlas to name them -- and to say which ones the canvas can actually place, because that
// is the difference between a bar the reader can click through to 3D and one they cannot.
function testTheRegionCatalogueIsReadableByTheHost() {
  const { window } = bootAtlas();
  const catalogue = window.DigitalBrainAtlas.regionCatalogue();

  assert.equal(catalogue.length, window.DIGITALBRAIN_REGION_DATA.regions.length);
  assert.ok(catalogue.every((region) => region.acronym && region.name && region.group),
    'every entry is named and grouped');
  assert.ok(catalogue.some((region) => region.hasAnatomy),
    'and says which ones the canvas can place');
  const [placeable] = someMappedAcronyms(window, 1);
  assert.equal(
    catalogue.find((region) => region.acronym === placeable).hasAnatomy,
    true,
    'hasAnatomy must agree with knowsRegion, or the two would disagree about the same parcel',
  );
}

function someMappedAcronyms(window, count) {
  return window.DIGITALBRAIN_REGION_DATA.regions
    .map((region) => region.acronym)
    .filter((acronym) => window.DigitalBrainAtlas.knowsRegion(acronym))
    .slice(0, count);
}

function testGeneLayerIsAcceptedByTheLayerWhitelist() {
  const { window, drawOneFrame } = bootAtlas();
  const summary = window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  assert.equal(summary.layer, 'genes', 'the layer whitelist must accept "genes"');
  assert.doesNotThrow(drawOneFrame, 'rendering the genes layer must not throw');
}

function testGeneValuesDriveRegionColouring() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 3);
  assert.equal(picked.length, 3, 'need three mapped regions for this test');

  const values = {};
  values[picked[0]] = 0.2;
  values[picked[1]] = 0.9;
  values[picked[2]] = 0.5;
  atlas.applyGeneValues(oneGene(values));
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  assert.deepEqual([...visible].sort(), [...picked].sort(),
    'only regions carrying a gene value may be visible');
}

function testRangeUsesGeneValuesInGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);
  const values = {};
  values[picked[0]] = 0.25;
  values[picked[1]] = 1.75;

  atlas.applyGeneValues(oneGene(values));
  drawOneFrame();

  const summary = atlas.geneSummary();
  assert.equal(summary.min, 0.25, 'range must come from gene values, not composition');
  assert.equal(summary.max, 1.75);
}

function testAllMissingGeneValuesDoesNotThrow() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  atlas.applyGeneValues(oneGene({}));
  assert.doesNotThrow(drawOneFrame, 'an all-missing gene layer must not divide by zero');

  const summary = atlas.geneSummary();
  assert.deepEqual(summary.regions, [], 'no region may be visible without data');
  assert.equal(summary.min, null, 'an empty range must be reported as null, not 0');
  assert.equal(summary.max, null);
}

function testMissingRegionsAreNotRenderedAsZero() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 4);
  const values = {};
  values[picked[0]] = 0.0;   // a real zero must stay visible
  values[picked[1]] = 0.8;
  atlas.applyGeneValues(oneGene(values));
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  assert.ok(visible.includes(picked[0]), 'an explicit zero is data and must render');
  assert.ok(!visible.includes(picked[2]), 'an absent region must not be treated as zero');
  assert.equal(atlas.geneSummary().min, 0);
}

function testLeavingTheGeneLayerRestoresTheCellsLayer() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  atlas.applyGeneValues(oneGene({}));
  assert.equal(atlas.geneSummary().layer, 'genes');

  atlas.clearGeneValues();
  assert.equal(atlas.geneSummary().layer, 'cells');
  assert.doesNotThrow(drawOneFrame, 'returning to the cells layer must not throw');
}

// ── Task 12: scope isolation ──

function applyExplorerScopeOfOneRegion(window, acronym) {
  // Mimic what AtlasBridge.sync sends when the Explorer has a dataset selected.
  const regionCells = {};
  regionCells[acronym] = 1234;
  window.DigitalBrainAtlas.applyScope({
    type: 'digitalbrain-scope',
    scopeKey: 'dataset',
    scopeLabel: 'Dataset One',
    selection: { collectionId: 'c', datasetId: 'd', donorId: '' },
    activeRegions: [acronym],
    regionCells,
    cellTypes: ['Astrocyte'],
    composition: { Astrocyte: 1 },
    cellStats: { totalCount: 1234 },
    totalCells: 1234,
  });
}

function testGeneLayerBypassesTheExplorerScopeFilter() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 3);

  applyExplorerScopeOfOneRegion(window, picked[0]);
  drawOneFrame();

  const values = {};
  picked.forEach((acronym, i) => {
    values[acronym] = 0.3 + i * 0.2;
  });
  atlas.applyGeneValues(oneGene(values));
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  // Without the bypass the Explorer scope would silently crop the gene layer down
  // to picked[0], which reads as "the gene is not expressed in the other regions".
  assert.deepEqual([...visible].sort(), [...picked].sort(),
    'the Explorer scope must not crop the gene layer');
}

function testScopeFiltersAreDisabledInGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  drawOneFrame();

  ['collectionSelect', 'datasetSelect', 'donorSelect'].forEach((id) => {
    const element = window.document.getElementById(id);
    assert.ok(element, `${id} should exist`);
    assert.equal(element.disabled, true, `${id} must be disabled in the gene layer`);
  });
  const note = window.document.getElementById('geneScopeNote');
  assert.ok(note, 'a scope note element should exist');
  // Armed, not inline: hidden=false means the tooltip is available on hover. It is
  // absolutely positioned by CSS so it no longer squeezes the filter row.
  assert.equal(note.hidden, false, 'the global-scope note must be armed');
}

function testScopeLockMarksTheFilterRowAsATooltipHost() {
  const { window, drawOneFrame } = bootAtlas();
  const controls = window.document.querySelector('.controls');
  assert.ok(controls, 'the filter row should exist');
  assert.equal(
    controls.classList.contains('is-scope-locked'),
    false,
    'the filter row is not locked outside the gene layer',
  );

  window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  drawOneFrame();
  // The class is the hook CSS uses to show the lock badge and turn the note into a
  // hover tooltip instead of an inline paragraph that squeezes the selects.
  assert.equal(
    controls.classList.contains('is-scope-locked'),
    true,
    'entering the gene layer marks the filter row as locked',
  );

  window.DigitalBrainAtlas.clearGeneValues();
  drawOneFrame();
  assert.equal(
    controls.classList.contains('is-scope-locked'),
    false,
    'leaving the gene layer clears the lock marker',
  );
}

function testLeavingGeneLayerRestoresTheScopeFilters() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const collection = window.document.getElementById('collectionSelect');

  atlas.applyGeneValues(oneGene({}));
  drawOneFrame();
  assert.equal(collection.disabled, true);

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(collection.disabled, false, 'leaving the gene layer must re-enable the scope');
  assert.equal(window.document.getElementById('geneScopeNote').hidden, true);
}

function testConnectivityChromeStaysHiddenInGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  drawOneFrame();

  const doc = window.document;
  // The genes layer draws region markers, so it keeps the marker legend and must
  // not expose the connectivity threshold controls.
  assert.equal(doc.getElementById('connectivitySection').hidden, true);
  assert.equal(doc.getElementById('visualKey').hidden, false);
  assert.equal(doc.getElementById('mappingKey').hidden, false);
  // The cell-class threshold belongs to the composition layer only.
  assert.equal(doc.getElementById('abundanceSection').hidden, true);
}

function testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  // The dataset and donor selects ship disabled until a collection is chosen, so
  // restoring them means putting each one back where it was - not enabling it.
  const dataset = window.document.getElementById('datasetSelect');
  assert.equal(dataset.disabled, true, 'datasetSelect is expected to start locked');

  atlas.applyGeneValues(oneGene({}));
  drawOneFrame();
  atlas.clearGeneValues();
  drawOneFrame();

  assert.equal(dataset.disabled, true, 'a filter locked before the gene layer stays locked after it');
}

function testGeneLayerRestoresFiltersUnlockedByTheHost() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const dataset = window.document.getElementById('datasetSelect');
  // Stand in for the host having unlocked the select after a collection was picked.
  dataset.disabled = false;

  atlas.applyGeneValues(oneGene({}));
  drawOneFrame();
  assert.equal(dataset.disabled, true, 'the gene layer locks every scope filter');

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(dataset.disabled, false, 'leaving restores the state the host had set');
}

// --- region detail panel in the genes layer ---

// Selects a region through the host API, so the assertions cover the same panel a
// canvas click fills in.
function selectRegion(window, acronym) {
  const region = window.DIGITALBRAIN_REGION_DATA.regions.find(
    (candidate) => candidate.acronym === acronym,
  );
  assert.ok(region, `${acronym} should be in the catalogue`);
  window.DigitalBrainAtlas.selectRegion(acronym);
  return region;
}

function detailRows(window) {
  return [...window.document.querySelectorAll('#compositionBars .composition-row')].map(
    (row) => ({
      label: row.querySelector('.composition-label').textContent,
      value: row.querySelector('strong') ? row.querySelector('strong').textContent : '',
      colour: row.style.getPropertyValue('--class-colour'),
      missing: row.classList.contains('composition-missing'),
    }),
  );
}

// The provider answers for the whole selection, so even a single gene arrives as a
// one-entry list with the active symbol named.
function geneDetailFixture(overrides) {
  const extra = overrides || {};
  return {
    metric: extra.metric || 'mean',
    rule: extra.rule || 'cell_weighted',
    active: extra.active || 'GFAP',
    genes: extra.genes || [
      {
        symbol: 'GFAP',
        colour: '#4cc9f0',
        value: 2.68,
        support: { datasets: 13, donors: 246, cells: 1204913 },
        detailAvailable: true,
        rows: [
          { cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 },
          { cellType: 'Microglia', mean: 0.4, detection: 0.1, cells: 10 },
        ],
      },
    ],
  };
}

function geneRegionRows(window) {
  return [...window.document.querySelectorAll('#geneRegionRows .gene-region-row')].map(
    (row) => ({
      symbol: row.dataset.gene,
      value: row.querySelector('.gene-region-value').textContent,
      rank: row.querySelector('.gene-region-rank').textContent,
      active: row.classList.contains('active'),
      missing: row.classList.contains('missing'),
    }),
  );
}

function testGeneLayerDetailShowsTheGeneNotConnectivity() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture());
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const label = window.document.getElementById('focusLabel').textContent;
  const value = window.document.getElementById('focusValue').textContent;
  // Without a genes branch this falls through to the connectivity wording, which
  // would label a gene expression value as a projection weight.
  assert.match(label, /GFAP/, `the focus should name the gene, got "${label}"`);
  assert.doesNotMatch(label, /weight|projection/i, 'connectivity wording must not leak in');
  assert.match(value, /2\.68/);
}

function testGeneLayerDetailListsCellClassValues() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture());
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const rows = detailRows(window);
  const astro = rows.find((row) => row.label === 'Astrocyte');
  assert.ok(astro, `Astrocyte should be listed, got ${JSON.stringify(rows.slice(0, 4))}`);
  assert.match(astro.value, /3\.25/, 'the gene value, not a composition percentage');
}

// 31% of (region, cellType) combinations have no cells at all. Rendering those as
// 0 would claim the gene was measured there and found silent.
function testCellClassesWithoutDataSaySoInsteadOfZero() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture({
    genes: [{
      symbol: 'GFAP',
      colour: '#4cc9f0',
      value: 3.25,
      support: { datasets: 1, donors: 1, cells: 40 },
      detailAvailable: true,
      // Only one class carries data; every other class in the vocabulary is absent.
      rows: [{ cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 }],
    }],
  }));
  atlas.applyGeneValues(oneGene({ [acronym]: 3.25 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const rows = detailRows(window);
  assert.ok(rows.length > 1, 'the whole class vocabulary is listed, not just the hits');
  const missing = rows.filter((row) => row.label !== 'Astrocyte');
  assert.ok(
    missing.every((row) => /no data/i.test(row.value)),
    `absent classes must read as no data, got ${JSON.stringify(missing.slice(0, 3))}`,
  );
  assert.ok(
    missing.every((row) => !/^0(\.0+)?%?$/.test(row.value.trim())),
    'absent classes must not render as 0',
  );
}

// The cloud draws every selected gene, so the panel has to report every selected
// gene. Showing only the active one meant six clouds and one number, and no way to
// read the comparison the multi-gene selection was made for.
function testEverySelectedGeneIsListedForTheRegion() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture({
    active: 'AQP4',
    genes: [
      { symbol: 'GFAP', colour: '#4cc9f0', value: 2.68, support: null, detailAvailable: true, rows: [] },
      {
        symbol: 'AQP4',
        colour: '#f7b267',
        value: 1.34,
        support: { datasets: 3, donors: 8, cells: 900 },
        detailAvailable: true,
        rows: [{ cellType: 'Astrocyte', mean: 1.34, detection: 0.5, cells: 40 }],
      },
      { symbol: 'MBP', colour: '#b5e48c', value: null, support: null, detailAvailable: true, rows: [] },
    ],
  }));
  atlas.applyGeneValues(severalGenes([
    { symbol: 'GFAP', values: { [acronym]: 2.68 } },
    { symbol: 'AQP4', values: { [acronym]: 1.34 } },
  ], { active: 'AQP4' }));
  drawOneFrame();
  selectRegion(window, acronym);

  const rows = geneRegionRows(window);
  assert.deepEqual(rows.map((row) => row.symbol), ['GFAP', 'AQP4', 'MBP'],
    'every selected gene must be listed, in chip order');
  assert.match(rows[0].value, /2\.68/);
  assert.match(rows[1].value, /1\.34/);
  // Never a zero: MBP was not measured in this region at all.
  assert.match(rows[2].value, /no data/i);
  assert.equal(rows[2].missing, true);
  assert.deepEqual(rows.map((row) => row.active), [false, true, false],
    'only the active gene is marked, and it is the one the host named');

  // The headline and the per-class breakdown belong to the active gene, not to the
  // first chip.
  assert.match(window.document.getElementById('focusLabel').textContent, /AQP4/);
  assert.match(window.document.getElementById('focusValue').textContent, /1\.34/);
}

// The panel is also the fastest way to switch genes: you are already looking at the
// region that made you want the other one. The atlas cannot promote a gene itself,
// so it must ask the host that owns the chips.
function testClickingAGeneRowAsksTheHostToPromoteIt() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture({
    active: 'GFAP',
    genes: [
      { symbol: 'GFAP', colour: '#4cc9f0', value: 2.68, support: null, detailAvailable: true, rows: [] },
      { symbol: 'AQP4', colour: '#f7b267', value: 1.34, support: null, detailAvailable: true, rows: [] },
    ],
  }));
  atlas.applyGeneValues(severalGenes([
    { symbol: 'GFAP', values: { [acronym]: 2.68 } },
    { symbol: 'AQP4', values: { [acronym]: 1.34 } },
  ]));
  drawOneFrame();
  selectRegion(window, acronym);

  const asked = [];
  window.addEventListener('digitalbrain-gene-select', (event) => asked.push(event.detail.symbol));
  window.document.querySelector('#geneRegionRows [data-gene="AQP4"]').click();
  assert.deepEqual(asked, ['AQP4'], 'the click must reach the host as a request');
}

// A parcel lit up for one gene but not for the active one used to be filtered out of
// the visible set entirely: the cloud showed it, the markers did not, and it could
// not be clicked -- so its panel, the only place the two genes are compared side by
// side, was unreachable.
function testARegionCarriedByAnotherGeneStaysReachable() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);

  atlas.applyGeneValues(severalGenes([
    { symbol: 'GFAP', values: { [picked[0]]: 2.68 } },
    { symbol: 'AQP4', values: { [picked[1]]: 1.34 } },
  ], { active: 'GFAP' }));
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  assert.ok(visible.includes(picked[0]), "the active gene's own region is visible");
  assert.ok(
    visible.includes(picked[1]),
    `a region carried only by another selected gene must stay on screen, got ${JSON.stringify(visible)}`,
  );
}

// renderGeneComposition writes the per-class values into #compositionBars, which
// lives in a section the layer switch used to hide outside the cells layer: the
// breakdown was computed, written, and never visible.
function testThePerClassSectionIsVisibleInTheGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture());
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);

  assert.equal(window.document.getElementById('compositionSection').hidden, false,
    'the per-class breakdown must be on screen in the gene layer');
  assert.equal(window.document.getElementById('geneRegionSection').hidden, false,
    'so must the list of selected genes');
  // And the heading has to say whose values these are.
  assert.match(window.document.getElementById('compositionTitle').textContent, /GFAP/);

  atlas.clearGeneValues();
  assert.equal(window.document.getElementById('geneRegionSection').hidden, true,
    'the gene list belongs to the gene layer only');
}

// Every class row carries its own colour, so the breakdown, the legend and the
// markers agree. A flat grey list made the panel look like it had no palette at all.
function testEveryClassRowCarriesItsClassColour() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture());
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const rows = detailRows(window);
  const astrocyte = rows.find((row) => row.label === 'Astrocyte');
  assert.ok(astrocyte, 'Astrocyte should be listed');
  assert.equal(
    astrocyte.colour,
    atlas.cellTypeColour('Astrocyte'),
    'the row must use the same palette entry the canvas paints that class with',
  );
  const measured = rows.filter((row) => !row.missing);
  assert.ok(measured.length >= 2, 'the fixture measures two classes');
  assert.equal(
    new Set(measured.map((row) => row.colour)).size,
    measured.length,
    'each measured class gets a distinct colour, not one shared grey',
  );
  // Absent classes keep the muted treatment; the colour is still declared so the
  // dot is dimmed rather than recoloured.
  assert.ok(
    rows.some((row) => row.missing),
    'the fixture leaves most classes without data',
  );
}

// support is the evidence behind the number: one donor and 963 cells does not
// deserve the same confidence as 246 donors and 1.2M cells.
function testDetailReportsTheSupportBehindTheValue() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture());
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const status = window.document.getElementById('detailDataStatus').textContent;
  assert.match(status, /13/, 'datasets');
  assert.match(status, /246/, 'donors');
  assert.match(status, /1,204,913|1204913/, 'cells');
}

function testARegionWithoutGeneDataSaysSo() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);

  atlas.setGeneDetailProvider((acronym) =>
    acronym === picked[0]
      ? geneDetailFixture()
      : geneDetailFixture({
          genes: [{
            symbol: 'GFAP',
            colour: '#4cc9f0',
            value: null,
            support: null,
            detailAvailable: true,
            rows: [],
          }],
        }),
  );
  atlas.applyGeneValues(oneGene({ [picked[0]]: 2.68 }));
  drawOneFrame();
  selectRegion(window, picked[1]);

  const value = window.document.getElementById('focusValue').textContent;
  assert.match(value, /—|no data/i, `a region with no data must say so, got "${value}"`);
}

// The ~19.2k region-only genes have no cellType tier; the panel must state that
// rather than showing an empty class list.
function testDetailStatesWhenTheCellClassTierIsUnavailable() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.setGeneDetailProvider(() => geneDetailFixture({
    active: 'SNAP25',
    genes: [{
      symbol: 'SNAP25',
      colour: '#4cc9f0',
      value: 3.1,
      support: { datasets: 5, donors: 9, cells: 10 },
      detailAvailable: false,
      rows: [],
    }],
  }));
  atlas.applyGeneValues(oneGene({ [acronym]: 3.1 }));
  drawOneFrame();
  selectRegion(window, acronym);

  const panel = window.document.getElementById('compositionBars').textContent;
  assert.match(
    panel,
    /region-level|not available|unavailable/i,
    `the missing tier must be explained, got "${panel.slice(0, 120)}"`,
  );
}

// Falling back to the cells-layer composition here would silently show cell
// percentages under a gene heading.
function testDetailWithoutAProviderDoesNotThrow() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  atlas.applyGeneValues(oneGene({ [acronym]: 1.5 }));
  drawOneFrame();
  assert.doesNotThrow(() => selectRegion(window, acronym));
}

// Regression guard, not new behaviour: applyGeneValues routes through
// selectDataLayer, which already refreshes an open panel. Short-circuiting that
// call when the layer has not changed would look like a harmless optimisation and
// would silently leave the panel showing the previous metric.
function testRepaintingRefreshesTheOpenDetailPanel() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const [acronym] = someMappedAcronyms(window, 1);

  let metric = 'mean';
  atlas.setGeneDetailProvider(() => geneDetailFixture({
    metric,
    genes: [{
      symbol: 'GFAP',
      colour: '#4cc9f0',
      value: metric === 'mean' ? 2.68 : 0.42,
      support: { datasets: 13, donors: 246, cells: 1204913 },
      detailAvailable: true,
      rows: [{ cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 }],
    }],
  }));
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  selectRegion(window, acronym);
  assert.match(window.document.getElementById('focusValue').textContent, /2\.68/);

  metric = 'detection';
  atlas.applyGeneValues(oneGene({ [acronym]: 0.42 }, { metric: 'detection' }));
  drawOneFrame();

  const value = window.document.getElementById('focusValue').textContent;
  assert.match(value, /42/, `the panel must follow the metric switch, got "${value}"`);
  assert.match(window.document.getElementById('focusLabel').textContent, /detection/i);
}

function testApplyGeneValuesRejectsAMissingCalibration() {
  // index.json lives outside git (gitignored), so a stale payload paired with new code
  // is a real deployment scenario. It must fail loudly, not silently pick a default
  // range: every density would be quietly wrong with nothing on screen to say so.
  const { window } = bootAtlas();
  assert.throws(
    () => window.DigitalBrainAtlas.applyGeneValues({
      metric: 'mean',
      rule: 'cell_weighted',
      genes: [{ symbol: 'AIF1', colour: '#61ddb2', values: {}, support: {} }],
    }),
    /densityScale|calibration/i,
    'a payload without a scale must be refused',
  );
}

function testApplyGeneValuesRejectsATruncatedCalibration() {
  // A 13-knot low segment is what normalise() indexes against; a short table would
  // read undefined knots as NaN and quietly blank the cloud instead of failing.
  const { window } = bootAtlas();
  assert.throws(
    () => window.DigitalBrainAtlas.applyGeneValues(oneGene({}, {
      scale: { breakpoint: 0.5201, reference: 3.5091, lowKnots: [0, 0.1, 0.5201] },
    })),
    /densityScale|calibration/i,
    'a calibration with the wrong knot count must be refused',
  );
}

function testApplyGeneValuesAcceptsSeveralGenes() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);
  const summary = atlas.applyGeneValues({
    metric: 'mean',
    rule: 'cell_weighted',
    scale: SCALE,
    genes: [
      { symbol: 'AIF1', colour: '#61ddb2', values: { [picked[0]]: 0.4 }, support: { [picked[0]]: 1000 } },
      { symbol: 'GFAP', colour: '#f0a36a', values: { [picked[1]]: 1.2 }, support: { [picked[1]]: 2000 } },
    ],
  });
  assert.equal(summary.layer, 'genes');
  assert.deepEqual(summary.genes.map((gene) => gene.symbol), ['AIF1', 'GFAP'],
    'the summary must report each gene in the order given');
  assert.deepEqual(summary.genes.map((gene) => gene.colour), ['#61ddb2', '#f0a36a'],
    'the host owns the colour, so the summary must echo it back unchanged');
  // Proves the label aggregation actually resolved: min/max are measured on the merged
  // label values, so a zero weight anywhere would leave these null and the cloud dark.
  assert.equal(summary.genes[0].max, 0.4, 'the aggregated label value must reach the summary');
  assert.equal(summary.genes[1].max, 1.2, 'each gene is aggregated on its own values');
  assert.doesNotThrow(drawOneFrame);
}

// Counts the point-cloud writes: the atlas draws voxels with fillRect and markers with
// arc/fill, so fillRect alone isolates the cloud.
function bootCountingVoxels() {
  const drawn = [];
  const booted = bootAtlas({
    context: () => {
      const stub = stubContext();
      stub.fillRect = () => drawn.push(1);
      return stub;
    },
  });
  return { ...booted, drawn };
}

function testGeneCloudLightsMorePointsForHigherValues() {
  const { window, drawOneFrame, drawn } = bootCountingVoxels();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  const paint = (value) => {
    atlas.applyGeneValues(oneGene({ [acronym]: value }));
    drawn.length = 0;
    drawOneFrame();
    return drawn.length;
  };
  assert.ok(paint(1.5) > paint(0.05), 'a higher value must light more voxels');
}

function testGeneCloudIgnoresTheContourToggle() {
  // 26 of the 90 claimed labels have no outer points at all, and 25 DigitalBrain regions
  // live entirely on those labels. If the boundary group stayed governed by
  // state.showContours, a gene expressed in one of them would draw nothing at all the
  // moment that cosmetic flag went false. In the genes layer the boundary group is the
  // data substrate -- it holds 56% of the voxels -- not contour decoration.
  const { window, drawOneFrame, drawn } = bootCountingVoxels();
  const atlas = window.DigitalBrainAtlas;
  const anatomy = window.ALLEN_3D_ATLAS;

  const outerCounts = new Map();
  for (let index = 0; index < anatomy.outerPoints.length; index += 4) {
    const label = anatomy.outerPoints[index + 3];
    outerCounts.set(label, (outerCounts.get(label) || 0) + 1);
  }
  const boundaryOnly = Object.keys(anatomy.regionMappings).find((acronym) => {
    const labels = anatomy.regionMappings[acronym].labelIndices || [];
    return labels.length && labels.every((label) => !outerCounts.get(label));
  });
  assert.ok(boundaryOnly, 'this test needs a region whose labels carry only boundary points');

  atlas.applyGeneValues(oneGene({ [boundaryOnly]: 1.5 }));
  drawn.length = 0;
  drawOneFrame();
  assert.ok(drawn.length > 0,
    `${boundaryOnly} lives only on boundary points, so it must still light up`);
}

function testGeneCloudPointCountGrowsSublinearly() {
  // One gene against four: total lit points must grow by about sqrt(4) = 2x, not 4x.
  const { window, drawOneFrame, drawn } = bootCountingVoxels();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 1)[0];
  const saturated = SCALE.reference;

  const paintGenes = (count) => {
    atlas.applyGeneValues({
      metric: 'mean',
      rule: 'cell_weighted',
      scale: SCALE,
      genes: Array.from({ length: count }, (unused, index) => ({
        symbol: `G${index}`,
        colour: '#4cc9f0',
        values: { [picked]: saturated },
        support: { [picked]: 1000 },
      })),
    });
    drawn.length = 0;
    drawOneFrame();
    return drawn.length;
  };

  const one = paintGenes(1);
  const four = paintGenes(4);
  const ratio = four / one;
  assert.ok(ratio > 1.6 && ratio < 2.4,
    `four saturated genes must cost about sqrt(4) = 2x one, got ${ratio.toFixed(2)}x`);
}

// A per-region 8-12px disc cannot cover a parcel whose projection spans over 100px, so
// the whole lit cloud has to be clickable. These exercise the screen grid that makes it
// so, through the same seam the tooltip and the click handler use.
function testGeneCloudIsHitTestableAcrossItsWholeExtent() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 1.5 }));
  drawOneFrame();

  const hits = atlas.geneHitReport();
  assert.ok(hits.filled > 0, 'the cloud must register cells in the hit grid');
  const sample = hits.sample;
  const found = atlas.geneHitAt(sample.x, sample.y);
  assert.ok(found, 'a lit screen position must resolve to a hit');
  assert.equal(found.geneIndex, 0, 'the single gene must be identified');
  assert.equal(found.symbol, 'AIF1', 'the hit must name the gene it belongs to');
  assert.ok(found.region, 'and it must resolve to a region for the detail panel');
}

function testEachGeneIsIdentifiedAtItsOwnOffset() {
  // The genes are drawn at different offset angles, so a pixel belongs to exactly one of
  // them. Without the gene index in the grid a tooltip could not say which.
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues({
    metric: 'mean',
    rule: 'cell_weighted',
    scale: SCALE,
    genes: [
      { symbol: 'AIF1', colour: '#61ddb2', values: { [picked]: 1.5 }, support: { [picked]: 1000 } },
      { symbol: 'GFAP', colour: '#f0a36a', values: { [picked]: 1.5 }, support: { [picked]: 1000 } },
    ],
  });
  drawOneFrame();

  const seen = new Set(atlas.geneHitReport().genesSeen);
  assert.deepEqual([...seen].sort(), [0, 1],
    'both genes must own cells of their own in the grid');
}

function testTheHitGridIsIgnoredOutsideTheGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 1.5 }));
  drawOneFrame();
  assert.ok(atlas.geneHitReport().filled > 0, 'this test needs a populated grid first');

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(atlas.geneHitReport().filled, 0,
    'leaving the layer must empty the grid so the cells layer keeps its disc path');
  const sample = { x: 450, y: 300 };
  assert.equal(atlas.geneHitAt(sample.x, sample.y), null,
    'and no hit may be reported from a stale grid');
}

function testTheGeneRangeWasComputedButInvisible() {
  // Regression guard for the bug this legend fixes. drawRegions() has always written the
  // range into legendRange, but that element sits inside legendSingle, which
  // syncCellTypeControls() hides outside the cells layer. Computed, written, unseeable.
  // Assert the content still lands AND that a visible element now carries it.
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();

  const document = window.document;
  // The precise statement of the bug: the content is right, and it is sitting in a
  // container the genes layer hides. Asserting legendSingle.hidden alone would not
  // discriminate, since it is also hidden at boot by the all-cell-types mode.
  assert.match(document.getElementById('legendRange').textContent, /2\.68/,
    'the range was always computed and written');
  assert.equal(document.getElementById('legendSingle').hidden, true,
    'but into a container the genes layer hides, which is why it was never seen');
  assert.equal(document.getElementById('legendGenes').hidden, false,
    'the genes legend must be the visible home for it');
  assert.match(document.getElementById('legendGenes').textContent, /2\.68/,
    'and it must actually show the number');
}

function testGeneLayerShowsALegendRowPerGene() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);
  atlas.applyGeneValues({
    metric: 'mean',
    rule: 'cell_weighted',
    scale: SCALE,
    genes: [
      { symbol: 'AIF1', colour: '#61ddb2', values: { [picked[0]]: 0.4 }, support: { [picked[0]]: 1000 } },
      { symbol: 'GFAP', colour: '#f0a36a', values: { [picked[1]]: 1.2 }, support: { [picked[1]]: 2000 } },
    ],
  });
  drawOneFrame();

  const legend = window.document.getElementById('legendGenes');
  assert.equal(legend.hidden, false, 'the genes legend must be visible in the genes layer');
  const rows = legend.querySelectorAll('.legend-gene-row');
  assert.equal(rows.length, 2, 'one row per gene');
  assert.match(rows[0].textContent, /AIF1/, 'the first row names the first gene');
  assert.match(rows[1].textContent, /GFAP/, 'the second row names the second gene');
  // Cross-gene comparison splits the channels: pattern by density, magnitude by the
  // abundance marker and the numbers. Each row must carry its own measured range.
  assert.match(rows[0].textContent, /0\.40/, "the row must show the gene's own range");
  assert.match(rows[1].textContent, /1\.20/, 'and each gene keeps its own, not a shared one');
  assert.equal(rows[0].querySelector('.legend-gene-swatch').style.background, 'rgb(97, 221, 178)',
    'the swatch must use the colour the host gave, so chips and cloud agree');
  assert.ok(rows[0].querySelector('.legend-gene-abundance'),
    'each row needs an abundance marker on the shared 0-reference axis');
}

function testDensityRampTicksSitWhereTheCalibrationPutsThem() {
  // A piecewise scale cannot be explained by a formula line, so it has to be shown with
  // ticks. Their positions must come from the same normalise() the cloud draws with,
  // otherwise the legend quietly lies about the density.
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();

  const ticks = [...window.document.querySelectorAll('#legendGenes .legend-density-tick')];
  assert.ok(ticks.length >= 4, 'the ramp needs several round-value ticks');
  ticks.forEach((tick) => {
    const value = Number(tick.dataset.value);
    const expected = window.GenePointCloud.normalise(value, SCALE) * 100;
    const placed = Number.parseFloat(tick.style.left);
    assert.ok(Math.abs(placed - expected) < 0.01,
      `tick ${value} sits at ${placed}% but the calibration puts it at ${expected}%`);
  });
  assert.ok(window.document.querySelector('#legendGenes .legend-density-breakpoint'),
    'the breakpoint needs a divider: the slope deliberately folds there');
}

function testTheDensityTicksFollowTheMetric() {
  // detection is a ratio, so its round values are percentages, not expression levels.
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 0.42 }, { metric: 'detection' }));
  drawOneFrame();
  const labels = [...window.document.querySelectorAll('#legendGenes .legend-density-tick')]
    .map((tick) => tick.textContent);
  assert.ok(labels.some((label) => label.includes('%')),
    'detection ticks must be labelled as percentages');
}

function testTheMappingKeyShowsThreeConfidenceTiers() {
  // Point size is the confidence channel now, so a two-entry line/dash key no longer
  // describes what is on screen.
  const { window } = bootAtlas();
  const entries = [...window.document.querySelectorAll('#mappingKey span')];
  assert.equal(entries.length, 3, 'three tiers are drawn, so three must be explained');
  assert.ok(window.document.querySelector('#mappingKey .exact'), 'exact anatomy tier');
  assert.ok(window.document.querySelector('#mappingKey .coarse'), 'coarse ontology proxy tier');
  assert.ok(window.document.querySelector('#mappingKey .proxy'), 'curated gyral proxy tier');
}

function testLeavingTheGeneLayerHidesTheGenesLegend() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  atlas.applyGeneValues(oneGene({ [acronym]: 2.68 }));
  drawOneFrame();
  assert.equal(window.document.getElementById('legendGenes').hidden, false);

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(window.document.getElementById('legendGenes').hidden, true,
    'the genes legend must go away with the layer');
  // Which cells legend returns depends on the cell-type mode, and the boot default is
  // all cell types, so legendAll is the one that must come back here.
  assert.equal(window.document.getElementById('legendAll').hidden, false,
    'and the cells legend must come back');
}

// The cells layer used to repeat one scope average across every sampled parcel, so
// clicking through regions never changed a bar. The bridge now derives a per-region
// breakdown from the donor mix, and the panel has to actually use it.
function testLinkedScopeCompositionFollowsTheSelectedRegion() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);

  const regionCells = {};
  regionCells[picked[0]] = 1000;
  regionCells[picked[1]] = 1000;
  atlas.applyScope({
    type: 'digitalbrain-scope',
    scopeKey: 'collection',
    scopeLabel: 'Collection One',
    selection: {},
    activeRegions: picked,
    regionCells,
    cellTypes: ['Astrocyte', 'Microglia'],
    composition: { Astrocyte: 0.5, Microglia: 0.5 },
    regionComposition: {
      [picked[0]]: { Astrocyte: 0.9, Microglia: 0.1 },
      [picked[1]]: { Astrocyte: 0.2, Microglia: 0.8 },
    },
    compositionResolution: 'donor-mix',
    cellStats: { totalCount: 2000 },
  });
  drawOneFrame();

  selectRegion(window, picked[0]);
  const first = detailRows(window);
  selectRegion(window, picked[1]);
  const second = detailRows(window);

  assert.notDeepEqual(
    first.map((row) => `${row.label}=${row.value}`),
    second.map((row) => `${row.label}=${row.value}`),
    'two regions with different donor mixes must not show the same bars',
  );
  assert.equal(first[0].label, 'Astrocyte', 'the dominant class leads in the first region');
  assert.equal(second[0].label, 'Microglia', 'and the other one leads in the second');
  assert.match(
    window.document.getElementById('detailDataStatus').textContent,
    /per-region/i,
    'the provenance line must say the breakdown is region-resolved',
  );
}

// Without a per-region breakdown the old behaviour is still the honest one -- but it
// has to be labelled as an average, not passed off as a regional measurement.
function testLinkedScopeWithoutPerRegionDataSaysItIsAnAverage() {
  const { window, drawOneFrame } = bootAtlas();
  const [acronym] = someMappedAcronyms(window, 1);

  applyExplorerScopeOfOneRegion(window, acronym);
  drawOneFrame();
  selectRegion(window, acronym);

  assert.match(
    window.document.getElementById('detailDataStatus').textContent,
    /scope-level/i,
    'a scope average must not claim to be region-resolved',
  );
}

// First entry into the genes layer drops the envelope overlay because its fill
// fights the expression cloud -- but only as a default the user can override.
function testFirstGeneApplicationDefaultsEnvelopesOff() {
  const { window } = bootAtlas();
  const toggle = window.document.getElementById('envelopeToggle');
  assert.ok(toggle, 'the drawer should carry the envelope toggle');
  assert.equal(toggle.checked, true, 'envelopes start on outside the genes layer');
  window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  assert.equal(toggle.checked, false,
    'the first gene application must default the envelope overlay off');
}

function testEnvelopeDefaultIsOneShot() {
  const { window } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const toggle = window.document.getElementById('envelopeToggle');
  atlas.applyGeneValues(oneGene({}));
  assert.equal(toggle.checked, false);
  // The user turns the envelopes back on; later gene applications must respect that.
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change'));
  atlas.applyGeneValues(oneGene({ A1BG: 1 }));
  assert.equal(toggle.checked, true,
    'once the user re-enables envelopes, later gene picks must not force them off');
  atlas.clearGeneValues();
  atlas.applyGeneValues(oneGene({}));
  assert.equal(toggle.checked, true,
    'clearing the genes must not re-arm the one-shot default');
}

// Reported bug: clearing the genes hid the gene legend but never emptied its
// rows, so the removed genes were still listed the next time the layer opened.
function testClearedGenesLeaveNoLegendRowsBehind() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  atlas.applyGeneValues(oneGene({ A1BG: 2.5 }));
  drawOneFrame();
  const rows = window.document.getElementById('legendGeneRows');
  assert.equal(rows.childElementCount, 1, 'the selected gene is listed');

  atlas.clearGeneValues();
  drawOneFrame();
  // Back on the cells layer the legend is hidden, but its rows must be empty too:
  // re-entering the genes layer shows it before any new gene is applied.
  window.document.querySelector('[data-layer="genes"]').click();
  drawOneFrame();
  assert.equal(rows.childElementCount, 0, 'no stale gene rows may survive the clear');
}

// The lock belongs to the on-screen gene layer: switching the top-level view to
// the overview must hand the scope selects back, and returning must re-arm it.
function testOverviewViewReleasesTheScopeLock() {
  const { window, drawOneFrame } = bootAtlas();
  window.DigitalBrainAtlas.applyGeneValues(oneGene({}));
  drawOneFrame();
  const select = window.document.getElementById('collectionSelect');
  assert.equal(select.disabled, true, 'the gene layer locks the scope selects');

  window.AtlasBridge.setAtlasViewVisible(false);
  assert.equal(select.disabled, false, 'leaving for the overview releases them');

  window.AtlasBridge.setAtlasViewVisible(true);
  assert.equal(select.disabled, true, 'returning to the atlas re-arms the lock');
}

function main() {
  const cases = [
    ['testThresholdControlsCoverTheFullPercentageRange', testThresholdControlsCoverTheFullPercentageRange],
    ['testConnectionThresholdUsesDirectPercentileLabelsAndBoundaryFiltering', testConnectionThresholdUsesDirectPercentileLabelsAndBoundaryFiltering],
    ['testGeneLayerIsAcceptedByTheLayerWhitelist', testGeneLayerIsAcceptedByTheLayerWhitelist],
    ['testGeneValuesDriveRegionColouring', testGeneValuesDriveRegionColouring],
    ['testRangeUsesGeneValuesInGeneLayer', testRangeUsesGeneValuesInGeneLayer],
    ['testAllMissingGeneValuesDoesNotThrow', testAllMissingGeneValuesDoesNotThrow],
    ['testMissingRegionsAreNotRenderedAsZero', testMissingRegionsAreNotRenderedAsZero],
    ['testLeavingTheGeneLayerRestoresTheCellsLayer', testLeavingTheGeneLayerRestoresTheCellsLayer],
    ['testGeneLayerBypassesTheExplorerScopeFilter', testGeneLayerBypassesTheExplorerScopeFilter],
    ['testScopeFiltersAreDisabledInGeneLayer', testScopeFiltersAreDisabledInGeneLayer],
    ['testScopeLockMarksTheFilterRowAsATooltipHost', testScopeLockMarksTheFilterRowAsATooltipHost],
    ['testLeavingGeneLayerRestoresTheScopeFilters', testLeavingGeneLayerRestoresTheScopeFilters],
    ['testOverviewViewReleasesTheScopeLock', testOverviewViewReleasesTheScopeLock],
    ['testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked', testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked],
    ['testGeneLayerRestoresFiltersUnlockedByTheHost', testGeneLayerRestoresFiltersUnlockedByTheHost],
    ['testConnectivityChromeStaysHiddenInGeneLayer', testConnectivityChromeStaysHiddenInGeneLayer],
    ['testGeneLayerDetailShowsTheGeneNotConnectivity', testGeneLayerDetailShowsTheGeneNotConnectivity],
    ['testGeneLayerDetailListsCellClassValues', testGeneLayerDetailListsCellClassValues],
    ['testEverySelectedGeneIsListedForTheRegion', testEverySelectedGeneIsListedForTheRegion],
    ['testClickingAGeneRowAsksTheHostToPromoteIt', testClickingAGeneRowAsksTheHostToPromoteIt],
    ['testARegionCarriedByAnotherGeneStaysReachable', testARegionCarriedByAnotherGeneStaysReachable],
    ['testThePerClassSectionIsVisibleInTheGeneLayer', testThePerClassSectionIsVisibleInTheGeneLayer],
    ['testCellClassesWithoutDataSaySoInsteadOfZero', testCellClassesWithoutDataSaySoInsteadOfZero],
    ['testEveryClassRowCarriesItsClassColour', testEveryClassRowCarriesItsClassColour],
    ['testDetailReportsTheSupportBehindTheValue', testDetailReportsTheSupportBehindTheValue],
    ['testARegionWithoutGeneDataSaysSo', testARegionWithoutGeneDataSaysSo],
    ['testDetailStatesWhenTheCellClassTierIsUnavailable', testDetailStatesWhenTheCellClassTierIsUnavailable],
    ['testDetailWithoutAProviderDoesNotThrow', testDetailWithoutAProviderDoesNotThrow],
    ['testRepaintingRefreshesTheOpenDetailPanel', testRepaintingRefreshesTheOpenDetailPanel],
    ['testApplyGeneValuesRejectsAMissingCalibration', testApplyGeneValuesRejectsAMissingCalibration],
    ['testApplyGeneValuesRejectsATruncatedCalibration', testApplyGeneValuesRejectsATruncatedCalibration],
    ['testApplyGeneValuesAcceptsSeveralGenes', testApplyGeneValuesAcceptsSeveralGenes],
    ['testGeneCloudLightsMorePointsForHigherValues', testGeneCloudLightsMorePointsForHigherValues],
    ['testGeneCloudIgnoresTheContourToggle', testGeneCloudIgnoresTheContourToggle],
    ['testGeneCloudPointCountGrowsSublinearly', testGeneCloudPointCountGrowsSublinearly],
    ['testGeneCloudIsHitTestableAcrossItsWholeExtent', testGeneCloudIsHitTestableAcrossItsWholeExtent],
    ['testEachGeneIsIdentifiedAtItsOwnOffset', testEachGeneIsIdentifiedAtItsOwnOffset],
    ['testTheHitGridIsIgnoredOutsideTheGeneLayer', testTheHitGridIsIgnoredOutsideTheGeneLayer],
    ['testTheGeneRangeWasComputedButInvisible', testTheGeneRangeWasComputedButInvisible],
    ['testGeneLayerShowsALegendRowPerGene', testGeneLayerShowsALegendRowPerGene],
    ['testDensityRampTicksSitWhereTheCalibrationPutsThem', testDensityRampTicksSitWhereTheCalibrationPutsThem],
    ['testTheDensityTicksFollowTheMetric', testTheDensityTicksFollowTheMetric],
    ['testTheMappingKeyShowsThreeConfidenceTiers', testTheMappingKeyShowsThreeConfidenceTiers],
    ['testLeavingTheGeneLayerHidesTheGenesLegend', testLeavingTheGeneLayerHidesTheGenesLegend],
    ['testLinkedScopeCompositionFollowsTheSelectedRegion', testLinkedScopeCompositionFollowsTheSelectedRegion],
    ['testLinkedScopeWithoutPerRegionDataSaysItIsAnAverage', testLinkedScopeWithoutPerRegionDataSaysItIsAnAverage],
    ['testFirstGeneApplicationDefaultsEnvelopesOff', testFirstGeneApplicationDefaultsEnvelopesOff],
    ['testEnvelopeDefaultIsOneShot', testEnvelopeDefaultIsOneShot],
    ['testClearedGenesLeaveNoLegendRowsBehind', testClearedGenesLeaveNoLegendRowsBehind],
    ['testTheAtlasAnnouncesItsSelection', testTheAtlasAnnouncesItsSelection],
    ['testTheRegionCatalogueIsReadableByTheHost', testTheRegionCatalogueIsReadableByTheHost],
  ];
  cases.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });
}

main();
