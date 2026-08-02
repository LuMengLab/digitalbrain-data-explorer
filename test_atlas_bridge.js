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
  testEmptyScope();
  console.log('PASS testEmptyScope');
  testSyncCallsAtlas();
  console.log('PASS testSyncCallsAtlas');
}

main();
