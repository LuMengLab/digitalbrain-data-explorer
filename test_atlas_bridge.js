const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(file, sandboxExtras = {}) {
  const filePath = path.join(__dirname, file);
  assert.ok(fs.existsSync(filePath), `Missing module under test: ${filePath}`);
  const code = fs.readFileSync(filePath, 'utf8');
  const sandbox = Object.assign(
    {
      console,
      module: { exports: {} },
      exports: {},
    },
    sandboxExtras,
  );
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: filePath });
  return { api: sandbox.module.exports, sandbox };
}

function testBuildPayload() {
  const { api } = loadModule('atlas-bridge.js');

  const scope = {
    scopeKey: 'dataset',
    scopeLabel: 'Dataset One',
    // Includes a non-atlas region; the bridge forwards it verbatim and the
    // atlas intersects with its known acronyms.
    brodCounts: { A23: 100, EC: 50, NOT_AN_ATLAS_REGION: 7 },
    // Original Data Explorer taxonomy, no folding into broad classes.
    cellTypeCounts: { 'Amygdala excitatory': 8, Microglia: 2, 'Empty type': 0 },
    metrics: { cells: 157 },
  };
  const rawPayload = api.buildPayload(scope, { collectionId: 'c', datasetId: 'd', donorId: '' });
  // buildPayload runs inside a vm realm; JSON round-trip re-homes the object's
  // prototype into this realm so deepEqual can compare it.
  const payload = JSON.parse(JSON.stringify(rawPayload));

  assert.equal(payload.type, 'digitalbrain-scope');
  assert.equal(payload.scopeKey, 'dataset');
  assert.equal(payload.scopeLabel, 'Dataset One');
  assert.deepEqual(payload.selection, { collectionId: 'c', datasetId: 'd', donorId: '' });

  // Region counts are forwarded verbatim (identity Brodmann crosswalk).
  assert.deepEqual(payload.regionCells, { A23: 100, EC: 50, NOT_AN_ATLAS_REGION: 7 });
  assert.deepEqual(
    [...payload.activeRegions].sort(),
    ['A23', 'EC', 'NOT_AN_ATLAS_REGION'].sort(),
  );

  // Original cell types, sorted by count descending, zero counts dropped.
  assert.deepEqual(payload.cellTypes, ['Amygdala excitatory', 'Microglia']);
  assert.ok(!('Empty type' in payload.composition), 'zero-count types are excluded');

  // Composition is normalized over the retained original types.
  assert.equal(Math.round(payload.composition['Amygdala excitatory'] * 100) / 100, 0.8);
  assert.equal(Math.round(payload.composition.Microglia * 100) / 100, 0.2);
  const sum = payload.cellTypes.reduce((total, type) => total + payload.composition[type], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'composition should normalize to 1');

  assert.equal(payload.cellStats.totalCount, 10);
  assert.equal(payload.totalCells, 157);

  // No donor records in this scope, so there is nothing to resolve per region and
  // the payload has to say so rather than imply a regional measurement.
  assert.deepEqual(payload.regionComposition, {});
  assert.equal(payload.compositionResolution, 'scope');
}

// The source carries two marginals per donor and no joint matrix, which is why the
// atlas used to repeat one scope average across every parcel. Most donors sampled a
// single region, so mixing donors per region recovers a real per-region breakdown.
function testPerRegionCompositionFromTheDonorMix() {
  const { api } = loadModule('atlas-bridge.js');

  const donors = [
    // Single-region donor: its class profile *is* A23's profile.
    { cell_type_count: { Astrocyte: 90, Microglia: 10 }, brod_count: { A23: 100 } },
    // Single-region donor for a different region, with the opposite profile.
    { cell_type_count: { Astrocyte: 10, Microglia: 90 }, brod_count: { EC: 100 } },
    // Multi-region donor: contributes its profile to both, weighted by cells there.
    { cell_type_count: { Astrocyte: 50, Microglia: 50 }, brod_count: { A23: 100, EC: 300 } },
    // No class counts at all: cannot contribute a profile, must not divide by zero.
    { cell_type_count: {}, brod_count: { A23: 500 } },
  ];
  const scope = {
    scopeKey: 'collection',
    scopeLabel: 'Collection One',
    brodCounts: { A23: 200, EC: 400 },
    cellTypeCounts: { Astrocyte: 150, Microglia: 150 },
    donors,
    metrics: { cells: 600 },
  };
  const payload = JSON.parse(JSON.stringify(api.buildPayload(scope, {})));

  assert.equal(payload.compositionResolution, 'donor-mix');
  const a23 = payload.regionComposition.A23;
  const ec = payload.regionComposition.EC;
  assert.ok(a23 && ec, 'both sampled regions should get a breakdown');

  // A23: 100 cells at 90/10 plus 100 cells at 50/50 -> 70/30.
  assert.equal(Math.round(a23.Astrocyte * 100), 70);
  assert.equal(Math.round(a23.Microglia * 100), 30);
  // EC: 100 cells at 10/90 plus 300 cells at 50/50 -> 40/60.
  assert.equal(Math.round(ec.Astrocyte * 100), 40);
  assert.equal(Math.round(ec.Microglia * 100), 60);

  [a23, ec].forEach((fractions) => {
    const sum = Object.values(fractions).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'each region breakdown normalizes to 1');
  });

  // The scope marginal is still sent as the fallback for regions the mix cannot reach.
  assert.equal(Math.round(payload.composition.Astrocyte * 100), 50);
}

// A region nobody sampled must be absent from the map, not present with zeros: the
// atlas reads an absent key as "fall back to the scope average".
function testUnsampledRegionsAreAbsentNotZeroed() {
  const { api } = loadModule('atlas-bridge.js');
  // Re-home the cross-realm results before comparing, as elsewhere in this file.
  const mixed = JSON.parse(JSON.stringify(api.buildRegionComposition([
    { cell_type_count: { Astrocyte: 5 }, brod_count: { A23: 10, EC: 0 } },
  ])));

  assert.deepEqual(Object.keys(mixed.regionComposition), ['A23']);
  assert.equal(mixed.resolved, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.buildRegionComposition(undefined))),
    { regionComposition: {}, resolved: 0 },
  );
}

function testEmptyScope() {
  const { api } = loadModule('atlas-bridge.js');
  const rawPayload = api.buildPayload(null, undefined);
  const payload = JSON.parse(JSON.stringify(rawPayload));

  assert.equal(payload.scopeKey, 'global');
  assert.equal(payload.scopeLabel, 'All Collections');
  assert.deepEqual(payload.selection, {});
  assert.deepEqual(payload.activeRegions, []);
  assert.deepEqual(payload.regionCells, {});
  assert.deepEqual(payload.cellTypes, []);
  assert.deepEqual(payload.composition, {});
  assert.deepEqual(payload.regionComposition, {});
  assert.equal(payload.compositionResolution, 'scope');
  assert.equal(payload.cellStats.totalCount, 0);
}

function testSyncCallsAtlas() {
  const { api, sandbox } = loadModule('atlas-bridge.js');
  let received = null;
  sandbox.DigitalBrainAtlas = {
    applyScope(payload) {
      received = payload;
    },
  };

  const scope = {
    scopeKey: 'dataset',
    scopeLabel: 'Dataset One',
    brodCounts: { A23: 4 },
    cellTypeCounts: { 'Amygdala excitatory': 4 },
    metrics: { cells: 4 },
  };
  api.sync(scope, { collectionId: 'c', datasetId: 'd', donorId: '' });

  assert.ok(received, 'applyScope should be called with a payload');
  // Re-home the cross-realm payload before comparing.
  const payload = JSON.parse(JSON.stringify(received));
  assert.equal(payload.scopeLabel, 'Dataset One');
  assert.deepEqual(payload.cellTypes, ['Amygdala excitatory']);

  // A null scope is a no-op (no atlas call).
  received = null;
  api.sync(null, {});
  assert.equal(received, null, 'null scope should not call the atlas');
}

function main() {
  testBuildPayload();
  console.log('PASS testBuildPayload');
  testPerRegionCompositionFromTheDonorMix();
  console.log('PASS testPerRegionCompositionFromTheDonorMix');
  testUnsampledRegionsAreAbsentNotZeroed();
  console.log('PASS testUnsampledRegionsAreAbsentNotZeroed');
  testEmptyScope();
  console.log('PASS testEmptyScope');
  testSyncCallsAtlas();
  console.log('PASS testSyncCallsAtlas');
}

main();
