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

// Objects built inside the vm realm carry that realm's prototype; a JSON round-trip
// re-homes them so deepStrictEqual can compare them (same trick as test_atlas_bridge.js).
function rehome(value) {
  return JSON.parse(JSON.stringify(value));
}

// EC 区有 Astrocyte(30 细胞) 与 Microglia(10 细胞)；SWM 区只有 Astrocyte；
// Pn 区完全无数据（验证缺失 != 零）。
const FIXTURE_GFAP = {
  symbol: 'GFAP',
  ensembl: 'ENSG00000131095',
  cell_weighted: {
    regions: {
      mean: { EC: 0.637, SWM: 1.266 },
      detection: { EC: 0.297, SWM: 0.42 },
    },
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.9, detection: 0.81, cells: 30 },
        Microglia: { mean: 0.4, detection: 0.1, cells: 10 },
      },
      SWM: {
        Astrocyte: { mean: 1.266, detection: 0.42, cells: 20 },
      },
    },
    support: {
      EC: { datasets: 12, donors: 43, cells: 40 },
      SWM: { datasets: 3, donors: 8, cells: 20 },
    },
  },
  donor_balanced: {
    regions: {
      mean: { EC: 1.15, SWM: 1.266 },
      detection: { EC: 0.455, SWM: 0.42 },
    },
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.9, detection: 0.81, cells: 30 },
        Microglia: { mean: 0.4, detection: 0.1, cells: 10 },
      },
      SWM: {
        Astrocyte: { mean: 1.266, detection: 0.42, cells: 20 },
      },
    },
    support: {
      EC: { datasets: 12, donors: 43, cells: 40 },
      SWM: { datasets: 3, donors: 8, cells: 20 },
    },
  },
};

const FIXTURE_INDEX = {
  scope: { datasets: 99, cells: 16247724, excludedDatasets: 10, excludedCells: 104399 },
  metrics: ['mean', 'detection'],
  rules: ['cell_weighted', 'donor_balanced'],
  cellTypes: ['Astrocyte', 'Microglia'],
  genes: { GFAP: 'genes/GFAP.json', SNAP25: 'genes/SNAP25.json' },
};

function freshApi() {
  const { api } = loadModule('gene-atlas-data.js');
  api.ingestIndex(FIXTURE_INDEX);
  api.ingestGene(FIXTURE_GFAP);
  api.setRule('cell_weighted');
  api.setMetric('mean');
  return api;
}

function testRegionValuesForActiveGene() {
  const api = freshApi();
  assert.deepEqual(rehome(api.regionValues('GFAP')), { EC: 0.637, SWM: 1.266 });
}

function testDetectionMetricSwitch() {
  const api = freshApi();
  api.setMetric('detection');
  assert.deepEqual(rehome(api.regionValues('GFAP')), { EC: 0.297, SWM: 0.42 });
}

function testRuleSwitchChangesRegionValues() {
  const api = freshApi();
  api.setRule('donor_balanced');
  assert.deepEqual(rehome(api.regionValues('GFAP')), { EC: 1.15, SWM: 1.266 });
}

function testSearchIsCaseInsensitiveAndReportsMisses() {
  const api = freshApi();
  assert.deepEqual(rehome(api.search('gfap')), ['GFAP']);
  assert.deepEqual(rehome(api.search('NOT_A_GENE')), []);
  // 前缀检索命中多个时按字母序返回。
  assert.deepEqual(rehome(api.search('s')), ['SNAP25']);
}

function testMissingRegionIsAbsentNotZero() {
  const api = freshApi();
  const values = api.regionValues('GFAP');
  assert.equal('Pn' in values, false, 'missing region must be absent, not 0');
}

function testCellTypeDetailForARegion() {
  const api = freshApi();
  const rows = api.cellTypeDetail('GFAP', 'EC');
  assert.deepEqual(rehome(rows.map((r) => r.cellType)), ['Astrocyte', 'Microglia']);
  assert.equal(rows[0].mean, 1.9);
  assert.equal(rows[0].detection, 0.81);
  assert.equal(rows[0].cells, 30);
}

function testCellTypeDetailOmitsTypesWithoutDataInThatRegion() {
  const api = freshApi();
  const rows = api.cellTypeDetail('GFAP', 'SWM');
  assert.deepEqual(rehome(rows.map((r) => r.cellType)), ['Astrocyte']);
}

function testCellWeightedSubsetRecomputesByCellCount() {
  const api = freshApi();
  // 只选 Astrocyte + Microglia：(1.9*30 + 0.4*10) / 40 = 1.525
  const values = api.regionValues('GFAP', { cellTypes: ['Astrocyte', 'Microglia'] });
  assert.equal(Number(values.EC.toFixed(6)), 1.525);
}

function testDonorBalancedSubsetRecomputesByEqualWeight() {
  const api = freshApi();
  api.setRule('donor_balanced');
  // 等权：(1.9 + 0.4) / 2 = 1.15，与 30 vs 10 的细胞数无关
  const values = api.regionValues('GFAP', { cellTypes: ['Astrocyte', 'Microglia'] });
  assert.equal(Number(values.EC.toFixed(6)), 1.15);
}

function testSubsetWithNoDataInARegionDropsThatRegion() {
  const api = freshApi();
  // SWM 无 Microglia；只选 Microglia 时 SWM 必须缺失，不得为 0
  const values = api.regionValues('GFAP', { cellTypes: ['Microglia'] });
  assert.equal('SWM' in values, false);
  assert.equal(Number(values.EC.toFixed(6)), 0.4);
}

function testGeneFilesAreFetchedOnceAndCached() {
  let calls = 0;
  const { api } = loadModule('gene-atlas-data.js', {
    fetch: (url) => {
      calls += 1;
      const body = url.endsWith('index.json') ? FIXTURE_INDEX : FIXTURE_GFAP;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    },
  });

  return api
    .loadIndex('gene_atlas_web')
    .then(() => api.loadGene('GFAP'))
    .then(() => {
      assert.equal(calls, 2, 'index + one gene file');
      return api.loadGene('GFAP');
    })
    .then(() => {
      assert.equal(calls, 2, 'a cached gene must not be fetched again');
    });
}

function testSupportIsExposedForTheDetailPanel() {
  const api = freshApi();
  const support = api.regionSupport('GFAP', 'EC');
  assert.equal(support.datasets, 12);
  assert.equal(support.donors, 43);
  assert.equal(api.scope().excludedCells, 104399);
}

function main() {
  const sync = [
    ['testRegionValuesForActiveGene', testRegionValuesForActiveGene],
    ['testDetectionMetricSwitch', testDetectionMetricSwitch],
    ['testRuleSwitchChangesRegionValues', testRuleSwitchChangesRegionValues],
    ['testSearchIsCaseInsensitiveAndReportsMisses', testSearchIsCaseInsensitiveAndReportsMisses],
    ['testMissingRegionIsAbsentNotZero', testMissingRegionIsAbsentNotZero],
    ['testCellTypeDetailForARegion', testCellTypeDetailForARegion],
    ['testCellTypeDetailOmitsTypesWithoutDataInThatRegion', testCellTypeDetailOmitsTypesWithoutDataInThatRegion],
    ['testCellWeightedSubsetRecomputesByCellCount', testCellWeightedSubsetRecomputesByCellCount],
    ['testDonorBalancedSubsetRecomputesByEqualWeight', testDonorBalancedSubsetRecomputesByEqualWeight],
    ['testSubsetWithNoDataInARegionDropsThatRegion', testSubsetWithNoDataInARegionDropsThatRegion],
    ['testSupportIsExposedForTheDetailPanel', testSupportIsExposedForTheDetailPanel],
  ];
  sync.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });

  return testGeneFilesAreFetchedOnceAndCached().then(() => {
    console.log('PASS testGeneFilesAreFetchedOnceAndCached');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
