const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDataModel() {
  const filePath = path.join(__dirname, 'data-model.js');
  assert.ok(fs.existsSync(filePath), `Missing module under test: ${filePath}`);
  const code = fs.readFileSync(filePath, 'utf8');
  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    globalThis: {},
  };
  vm.runInNewContext(code, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

function buildFixture() {
  return {
    'Collection-1': {
      name: 'Collection A',
      datasets: {
        DatasetOne: {
          name: 'Dataset One',
          donors: {
            DonorA: {
              name: 'DonorA',
              age: ['adult'],
              gender: ['female'],
              status: ['Healthy Control'],
              cells: 3,
              cell_type_count: { Neuron: 2, Astrocyte: 1 },
              brod_count: { BA1: 2, BA2: 1 },
              gyral_count: { G1: 3 },
              brain_regions_brod: ['BA1', 'BA2'],
              brain_regions_gyral: ['G1'],
            },
            DonorB: {
              name: 'DonorB',
              age: ['adult'],
              gender: ['male'],
              status: ["Alzheimer's Disease"],
              cells: 2,
              cell_type_count: { Neuron: 1, OPC: 1 },
              brod_count: { BA2: 2 },
              gyral_count: { G2: 2 },
              brain_regions_brod: ['BA2'],
              brain_regions_gyral: ['G2'],
            },
          },
        },
      },
    },
    'Collection-2': {
      name: 'Collection B',
      datasets: {
        DatasetTwo: {
          name: 'Dataset Two',
          donors: {
            DonorC: {
              name: 'DonorC',
              age: ['prenatal'],
              gender: ['unknown'],
              status: ['Glioblastoma (GBM)'],
              cells: 4,
              cell_type_count: { Neuron: 4 },
              brod_count: { BA3: 4 },
              gyral_count: { G3: 4 },
              brain_regions_brod: ['BA3'],
              brain_regions_gyral: ['G3'],
            },
          },
        },
      },
    },
  };
}

function testGlobalScope(model) {
  const state = model.computeScopeState(buildFixture(), '', '', '');
  assert.equal(state.scopeKey, 'global');
  assert.equal(state.metrics.datasets, 2);
  assert.equal(state.metrics.donors, 3);
  assert.equal(state.metrics.cells, 9);
  assert.deepEqual(Array.from(state.statuses), [
    "Alzheimer's Disease",
    'Glioblastoma (GBM)',
    'Healthy Control',
  ]);
}

function testDatasetScope(model) {
  const state = model.computeScopeState(buildFixture(), 'Collection-1', 'DatasetOne', '');
  assert.equal(state.scopeKey, 'dataset');
  assert.equal(state.scopeLabel, 'Dataset One');
  assert.equal(state.metrics.donors, 2);
  assert.equal(state.metrics.cells, 5);
  assert.deepEqual({ ...state.cellTypeCounts }, { Astrocyte: 1, Neuron: 3, OPC: 1 });
  assert.deepEqual({ ...state.brodCounts }, { BA1: 2, BA2: 3 });
}

function testDonorOptions(model) {
  const options = model.getDonorOptions(buildFixture(), 'Collection-1', 'DatasetOne');
  assert.equal(options.length, 2);
  assert.equal(options[0].id, 'DonorA');
  assert.match(options[0].label, /DonorA/);
  assert.match(options[0].label, /3 cells/);
}

function main() {
  const model = loadDataModel();
  testGlobalScope(model);
  console.log('PASS testGlobalScope');
  testDatasetScope(model);
  console.log('PASS testDatasetScope');
  testDonorOptions(model);
  console.log('PASS testDonorOptions');
}

main();
