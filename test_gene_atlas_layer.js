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

function main() {
  const cases = [
    ['testGeneLayerIsAcceptedByTheLayerWhitelist', testGeneLayerIsAcceptedByTheLayerWhitelist],
    ['testGeneValuesDriveRegionColouring', testGeneValuesDriveRegionColouring],
    ['testRangeUsesGeneValuesInGeneLayer', testRangeUsesGeneValuesInGeneLayer],
    ['testAllMissingGeneValuesDoesNotThrow', testAllMissingGeneValuesDoesNotThrow],
    ['testMissingRegionsAreNotRenderedAsZero', testMissingRegionsAreNotRenderedAsZero],
    ['testLeavingTheGeneLayerRestoresTheCellsLayer', testLeavingTheGeneLayerRestoresTheCellsLayer],
  ];
  cases.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });
}

main();
