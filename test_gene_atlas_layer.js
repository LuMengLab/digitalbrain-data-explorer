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
      label: row.querySelector('span').textContent,
      value: row.querySelector('strong') ? row.querySelector('strong').textContent : '',
    }),
  );
}

function geneDetailFixture() {
  return {
    symbol: 'GFAP',
    metric: 'mean',
    value: 2.68,
    support: { datasets: 13, donors: 246, cells: 1204913 },
    detailAvailable: true,
    rows: [
      { cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 },
      { cellType: 'Microglia', mean: 0.4, detection: 0.1, cells: 10 },
    ],
  };
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

  atlas.setGeneDetailProvider(() => ({
    symbol: 'GFAP',
    metric: 'mean',
    value: 3.25,
    support: { datasets: 1, donors: 1, cells: 40 },
    detailAvailable: true,
    // Only one class carries data; every other class in the vocabulary is absent.
    rows: [{ cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 }],
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
      : {
          symbol: 'GFAP',
          metric: 'mean',
          value: null,
          support: null,
          detailAvailable: true,
          rows: [],
        },
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

  atlas.setGeneDetailProvider(() => ({
    symbol: 'SNAP25',
    metric: 'mean',
    value: 3.1,
    support: { datasets: 5, donors: 9, cells: 10 },
    detailAvailable: false,
    rows: [],
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
  atlas.setGeneDetailProvider(() => ({
    symbol: 'GFAP',
    metric,
    value: metric === 'mean' ? 2.68 : 0.42,
    support: { datasets: 13, donors: 246, cells: 1204913 },
    detailAvailable: true,
    rows: [{ cellType: 'Astrocyte', mean: 3.25, detection: 0.88, cells: 40 }],
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

function main() {
  const cases = [
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
    ['testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked', testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked],
    ['testGeneLayerRestoresFiltersUnlockedByTheHost', testGeneLayerRestoresFiltersUnlockedByTheHost],
    ['testConnectivityChromeStaysHiddenInGeneLayer', testConnectivityChromeStaysHiddenInGeneLayer],
    ['testGeneLayerDetailShowsTheGeneNotConnectivity', testGeneLayerDetailShowsTheGeneNotConnectivity],
    ['testGeneLayerDetailListsCellClassValues', testGeneLayerDetailListsCellClassValues],
    ['testCellClassesWithoutDataSaySoInsteadOfZero', testCellClassesWithoutDataSaySoInsteadOfZero],
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
  ];
  cases.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });
}

main();
