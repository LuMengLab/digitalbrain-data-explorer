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

// 两层契约（见 scripts/export_gene_atlas_web.py）：
//   区域级文件带 support 与双规则的 regions，全部蛋白编码基因都有；
//   .detail.json 带 cellTypes，仅精选基因有。
// EC 区有 Astrocyte(30 细胞) 与 Microglia(10 细胞)；SWM 区只有 Astrocyte；
// Pn 区完全无数据（验证缺失 != 零）。
const FIXTURE_GFAP = {
  symbol: 'GFAP',
  ensembl: 'ENSG00000131095',
  hasDetail: true,
  // support 与聚合规则无关，只存一份在顶层。
  support: {
    EC: { datasets: 12, donors: 43, cells: 40 },
    SWM: { datasets: 3, donors: 8, cells: 20 },
  },
  cell_weighted: {
    regions: {
      mean: { EC: 0.637, SWM: 1.266 },
      detection: { EC: 0.297, SWM: 0.42 },
    },
  },
  donor_balanced: {
    regions: {
      mean: { EC: 1.15, SWM: 1.266 },
      detection: { EC: 0.455, SWM: 0.42 },
    },
  },
};

const FIXTURE_GFAP_DETAIL = {
  symbol: 'GFAP',
  cell_weighted: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.9, detection: 0.81, cells: 30 },
        Microglia: { mean: 0.4, detection: 0.1, cells: 10 },
      },
      SWM: {
        Astrocyte: { mean: 1.266, detection: 0.42, cells: 20 },
      },
    },
  },
  donor_balanced: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.9, detection: 0.81, cells: 30 },
        Microglia: { mean: 0.4, detection: 0.1, cells: 10 },
      },
      SWM: {
        Astrocyte: { mean: 1.266, detection: 0.42, cells: 20 },
      },
    },
  },
};

const FIXTURE_INDEX = {
  scope: { datasets: 99, cells: 16247724, excludedDatasets: 10, excludedCells: 104399 },
  metrics: ['mean', 'detection'],
  rules: ['cell_weighted', 'donor_balanced'],
  cellTypes: ['Astrocyte', 'Microglia'],
  genes: { GFAP: 'genes/GFAP.json', SNAP25: 'genes/SNAP25.json' },
  // 只有 GFAP 有 cellType 明细；SNAP25 只能看区域级。
  detailGenes: ['GFAP'],
};

function freshApi(options) {
  const withDetail = !options || options.withDetail !== false;
  const { api } = loadModule('gene-atlas-data.js');
  api.ingestIndex(FIXTURE_INDEX);
  api.ingestGene(FIXTURE_GFAP);
  if (withDetail) api.ingestGeneDetail(FIXTURE_GFAP_DETAIL);
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

// --- 两层契约 ---

function testHasDetailReflectsTheIndexSubset() {
  const api = freshApi();
  assert.equal(api.hasDetail('GFAP'), true);
  // 全编码基因里绝大多数只有区域级；UI 必须能在取数前就知道。
  assert.equal(api.hasDetail('SNAP25'), false);
  assert.equal(api.hasDetail('NOT_A_GENE'), false);
}

function testCellTypeDetailIsEmptyUntilTheDetailFileArrives() {
  const api = freshApi({ withDetail: false });
  assert.deepEqual(rehome(api.cellTypeDetail('GFAP', 'EC')), []);
  assert.equal(api.isDetailLoaded('GFAP'), false);
  api.ingestGeneDetail(FIXTURE_GFAP_DETAIL);
  assert.equal(api.isDetailLoaded('GFAP'), true);
  assert.equal(api.cellTypeDetail('GFAP', 'EC').length, 2);
}

// 详情缺席时按细胞类型过滤无从计算。回落到区域级全类混合值是唯一诚实的选择，
// 但绝不能静默假装过滤生效了——UI 要先问 canFilterByCellType 再决定是否开放勾选。
function testCellTypeFilterFallsBackToRegionLevelWithoutDetail() {
  const api = freshApi({ withDetail: false });
  assert.equal(api.canFilterByCellType('GFAP'), false);
  const values = api.regionValues('GFAP', { cellTypes: ['Astrocyte'] });
  assert.deepEqual(rehome(values), { EC: 0.637, SWM: 1.266 });
}

function testCanFilterOnlyOnceDetailIsActuallyLoaded() {
  const api = freshApi();
  assert.equal(api.canFilterByCellType('GFAP'), true);
  assert.equal(api.canFilterByCellType('SNAP25'), false);
}

function testDetailFileIsFetchedOnDemandAndCachedOnce() {
  let detailCalls = 0;
  const { api } = loadModule('gene-atlas-data.js', {
    fetch: (url) => {
      let body = FIXTURE_GFAP;
      if (url.endsWith('index.json')) {
        body = FIXTURE_INDEX;
      } else if (url.endsWith('.detail.json')) {
        detailCalls += 1;
        body = FIXTURE_GFAP_DETAIL;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    },
  });

  return api
    .loadIndex('gene_atlas_web')
    .then(() => api.loadGene('GFAP'))
    .then(() => api.loadGeneDetail('GFAP'))
    .then(() => {
      assert.equal(detailCalls, 1);
      assert.equal(api.isDetailLoaded('GFAP'), true);
      return api.loadGeneDetail('GFAP');
    })
    .then(() => {
      assert.equal(detailCalls, 1, 'a cached detail file must not be refetched');
    });
}

// 对 19,203 个无详情基因发请求只会换来一片 404，浪费往返还污染控制台。
function testLoadGeneDetailSkipsGenesWithoutDetail() {
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
    .then(() => api.loadGeneDetail('SNAP25'))
    .then((result) => {
      assert.equal(result, null);
      assert.equal(calls, 1, 'index only; no detail request for a gene without detail');
    });
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
    ['testHasDetailReflectsTheIndexSubset', testHasDetailReflectsTheIndexSubset],
    ['testCellTypeDetailIsEmptyUntilTheDetailFileArrives', testCellTypeDetailIsEmptyUntilTheDetailFileArrives],
    ['testCellTypeFilterFallsBackToRegionLevelWithoutDetail', testCellTypeFilterFallsBackToRegionLevelWithoutDetail],
    ['testCanFilterOnlyOnceDetailIsActuallyLoaded', testCanFilterOnlyOnceDetailIsActuallyLoaded],
  ];
  sync.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });

  return testGeneFilesAreFetchedOnceAndCached()
    .then(() => {
      console.log('PASS testGeneFilesAreFetchedOnceAndCached');
      return testDetailFileIsFetchedOnDemandAndCachedOnce();
    })
    .then(() => {
      console.log('PASS testDetailFileIsFetchedOnDemandAndCachedOnce');
      return testLoadGeneDetailSkipsGenesWithoutDetail();
    })
    .then(() => {
      console.log('PASS testLoadGeneDetailSkipsGenesWithoutDetail');
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
