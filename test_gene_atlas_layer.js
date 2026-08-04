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

function bootAtlas() {
  const html = fs
    .readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = () => stubContext();
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
  ['data/regions.js', 'data/allen_3d_geometry.js', 'data/connectivity.js', 'data/atlas_knowledge.js', 'app.js']
    .forEach((file) => {
      const code = fs.readFileSync(path.join(ATLAS_DIR, file), 'utf8');
      vm.runInContext(code, context, { filename: file });
    });

  assert.ok(window.DigitalBrainAtlas, 'the atlas should expose its host API');
  // Drain the frames queued during boot so later assertions see a settled state.
  const drawOneFrame = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((callback) => callback(0));
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
  const summary = window.DigitalBrainAtlas.applyGeneValues({ values: {}, metric: 'mean' });
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
  atlas.applyGeneValues({ values, metric: 'mean' });
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

  atlas.applyGeneValues({ values, metric: 'mean' });
  drawOneFrame();

  const summary = atlas.geneSummary();
  assert.equal(summary.min, 0.25, 'range must come from gene values, not composition');
  assert.equal(summary.max, 1.75);
}

function testAllMissingGeneValuesDoesNotThrow() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  atlas.applyGeneValues({ values: {}, metric: 'mean' });
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
  atlas.applyGeneValues({ values, metric: 'mean' });
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  assert.ok(visible.includes(picked[0]), 'an explicit zero is data and must render');
  assert.ok(!visible.includes(picked[2]), 'an absent region must not be treated as zero');
  assert.equal(atlas.geneSummary().min, 0);
}

function testLeavingTheGeneLayerRestoresTheCellsLayer() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  atlas.applyGeneValues({ values: {}, metric: 'mean' });
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
  atlas.applyGeneValues({ values, metric: 'mean' });
  drawOneFrame();

  const visible = atlas.geneSummary().regions;
  // Without the bypass the Explorer scope would silently crop the gene layer down
  // to picked[0], which reads as "the gene is not expressed in the other regions".
  assert.deepEqual([...visible].sort(), [...picked].sort(),
    'the Explorer scope must not crop the gene layer');
}

function testScopeFiltersAreDisabledInGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  window.DigitalBrainAtlas.applyGeneValues({ values: {}, metric: 'mean' });
  drawOneFrame();

  ['collectionSelect', 'datasetSelect', 'donorSelect'].forEach((id) => {
    const element = window.document.getElementById(id);
    assert.ok(element, `${id} should exist`);
    assert.equal(element.disabled, true, `${id} must be disabled in the gene layer`);
  });
  const note = window.document.getElementById('geneScopeNote');
  assert.ok(note, 'a scope note element should exist');
  assert.equal(note.hidden, false, 'the global-scope note must be visible');
}

function testLeavingGeneLayerRestoresTheScopeFilters() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const collection = window.document.getElementById('collectionSelect');

  atlas.applyGeneValues({ values: {}, metric: 'mean' });
  drawOneFrame();
  assert.equal(collection.disabled, true);

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(collection.disabled, false, 'leaving the gene layer must re-enable the scope');
  assert.equal(window.document.getElementById('geneScopeNote').hidden, true);
}

function testConnectivityChromeStaysHiddenInGeneLayer() {
  const { window, drawOneFrame } = bootAtlas();
  window.DigitalBrainAtlas.applyGeneValues({ values: {}, metric: 'mean' });
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

  atlas.applyGeneValues({ values: {}, metric: 'mean' });
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

  atlas.applyGeneValues({ values: {}, metric: 'mean' });
  drawOneFrame();
  assert.equal(dataset.disabled, true, 'the gene layer locks every scope filter');

  atlas.clearGeneValues();
  drawOneFrame();
  assert.equal(dataset.disabled, false, 'leaving restores the state the host had set');
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
    ['testLeavingGeneLayerRestoresTheScopeFilters', testLeavingGeneLayerRestoresTheScopeFilters],
    ['testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked', testLeavingGeneLayerKeepsAlreadyLockedFiltersLocked],
    ['testGeneLayerRestoresFiltersUnlockedByTheHost', testGeneLayerRestoresFiltersUnlockedByTheHost],
    ['testConnectivityChromeStaysHiddenInGeneLayer', testConnectivityChromeStaysHiddenInGeneLayer],
  ];
  cases.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });
}

main();
