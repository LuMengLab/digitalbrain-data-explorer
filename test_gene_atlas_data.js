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

// 搜索索引（见 scripts/export_gene_search_index.py）：列式 + 字典编码，symbols 排序后
// 即为所有列的位置键。这里三个基因足以覆盖全部匹配层。
const FIXTURE_SEARCH_INDEX = {
  version: 1,
  ensemblPrefix: 'ENSG00000',
  biotypes: ['protein-coding'],
  classes: ['Astrocyte', 'Excitatory neuron'],
  symbols: ['GFAP', 'MAPT', 'SNAP25'],
  ensembl: ['131095', '186868', '132639'],
  names: [
    'glial fibrillary acidic protein',
    'microtubule associated protein tau',
    'synaptosome associated protein 25',
  ],
  locations: ['17q21.31', '17q21.31', '20p12.2'],
  biotype: [0, 0, 0],
  peak: [0, 1, 1],
  regions: [163, 160, 163],
  detail: [0],
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

// The same api with the search index in place, which is what unlocks the id/name/locus
// tiers. MAPT is in the search index but not in the payload index on purpose.
function searchApi() {
  const api = freshApi();
  api.ingestSearchIndex(FIXTURE_SEARCH_INDEX);
  return api;
}

function symbolsOf(matches) {
  return rehome(matches).map((match) => match.symbol);
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
  assert.deepEqual(symbolsOf(api.search('gfap')), ['GFAP']);
  assert.deepEqual(symbolsOf(api.search('NOT_A_GENE')), []);
  // 索引未到时只做符号前缀检索，命中多个按字母序返回。
  assert.deepEqual(symbolsOf(api.search('s')), ['SNAP25']);
  // 每条结果都说明自己因何入选，符号命中是 field: 'symbol'。
  assert.deepEqual(rehome(api.search('gfap'))[0], {
    symbol: 'GFAP',
    tier: 0,
    field: 'symbol',
    text: 'GFAP',
  });
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

// 列表右侧那一列数字：把 detail 层按当前 metric/rule 跨区域聚合成"每个细胞类别一个值"，
// 用来回答"这个基因由哪一类细胞携带"。Astrocyte 出现在 EC(1.9, 30 细胞) 与 SWM(1.266, 20 细胞)：
// 细胞加权 (1.9*30 + 1.266*20) / 50 = 1.6464。
function testCellTypeSummaryAggregatesAcrossRegionsByCellCount() {
  const api = freshApi();
  const summary = api.cellTypeSummary('GFAP');
  assert.equal(Number(summary.Astrocyte.value.toFixed(4)), 1.6464);
  assert.equal(summary.Astrocyte.cells, 50);
  assert.equal(summary.Astrocyte.regions, 2);
  // Microglia 只在 EC 有数据，聚合结果就是那一个值。
  assert.equal(summary.Microglia.value, 0.4);
  assert.equal(summary.Microglia.regions, 1);
}

// 与 regionValues 的子集重算同一套算术，否则某一类的行与筛选后的地图会各说一套。
function testCellTypeSummaryFollowsTheRuleAndMetric() {
  const api = freshApi();
  api.setRule('donor_balanced');
  // 等权：(1.9 + 1.266) / 2 = 1.583，与 30 vs 20 的细胞数无关。
  assert.equal(Number(api.cellTypeSummary('GFAP').Astrocyte.value.toFixed(4)), 1.583);
  api.setMetric('detection');
  // 换 metric 后读的是 detection：(0.81 + 0.42) / 2 = 0.615。
  assert.equal(Number(api.cellTypeSummary('GFAP').Astrocyte.value.toFixed(4)), 0.615);
}

// 没有 detail 层就无法按细胞类别发言；借区域级数字充数会把"所有类别混合"说成某一类。
function testCellTypeSummaryIsEmptyWithoutADetailTier() {
  const api = freshApi();
  assert.deepEqual(rehome(api.cellTypeSummary('SNAP25')), {});
}

// 全脑"所有类别混合"的单一数值，刻意与 cellTypeSummary 用同一套跨区域算术：
// housekeeping 基因没有 cellType 层，它唯一能与某个类别行并排的位置就是这个全类别参照，
// 若两边聚合方式不同，比出来的差异就成了算术的产物而非数据的。
// 细胞加权：(0.637*40 + 1.266*20) / 60 = 0.846667。
function testWholeBrainValueMirrorsTheCrossRegionArithmetic() {
  const api = freshApi();
  assert.equal(Number(api.wholeBrainValue('GFAP').toFixed(6)), 0.846667);
  api.setRule('donor_balanced');
  // 等权：(1.15 + 1.266) / 2 = 1.208，与 40 vs 20 的细胞数无关。
  assert.equal(Number(api.wholeBrainValue('GFAP').toFixed(6)), 1.208);
  api.setMetric('detection');
  // 换 metric 后读 detection：(0.455 + 0.42) / 2 = 0.4375。
  assert.equal(Number(api.wholeBrainValue('GFAP').toFixed(6)), 0.4375);
}

// 没有区域级数据可聚合时返回 null 而不是 0：0 是"测过且为零"。
function testWholeBrainValueIsNullWithoutAPayload() {
  const api = freshApi();
  assert.equal(api.wholeBrainValue('MAPT'), null);
}

// 固定清单（如 housekeeping 对照）需要在提供选项之前知道这个 build 到底带不带这个基因，
// 否则点下去只会 404，而界面上没有任何东西能解释为什么。
function testHasGeneAnswersFromTheIndexWithoutFetching() {
  const api = freshApi();
  assert.equal(api.hasGene('GFAP'), true);
  assert.equal(api.hasGene('ACTB'), false, 'index.json 没列的基因就是这个 build 没有');
  api.reset();
  assert.equal(api.hasGene('GFAP'), false, '连 index 都没有时不能假装有');
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

// --- 搜索索引与分层匹配 ---

// 用户要的优先级：先符号，再 ENSG 号，最后才是其余元信息。tier 就是这个顺序，
// 排序在层内按字母，所以一个前缀查询的顶部与加入元信息前完全一致。
function testSymbolMatchesOutrankIdentifierAndNameMatches() {
  const api = searchApi();
  // "SNAP25" 既是符号，也出现在自己的全名里；符号层先命中就不再降级。
  const snap = rehome(api.search('SNAP25'));
  assert.equal(snap[0].symbol, 'SNAP25');
  assert.equal(snap[0].field, 'symbol');
  assert.equal(snap[0].tier, 0, '完全相等是最高优先级');

  // "protein" 只能在全名里命中；两个基因同层，按字母序。
  const named = rehome(api.search('protein'));
  assert.deepEqual(named.map((match) => match.symbol), ['GFAP', 'SNAP25']);
  assert.ok(named.every((match) => match.field === 'name'));
  // 命中的原文一并返回，否则候选行无法解释自己为何在列表里。
  assert.match(named[0].text, /glial fibrillary/);

  // 一个基因可能同时因符号和自己的全名命中（SNAP25 的全名里也有 25）：只能出一行，
  // 而且必须算在符号层。
  const digits = rehome(api.search('25'));
  assert.deepEqual(digits.map((match) => match.symbol), ['SNAP25']);
  assert.equal(digits[0].field, 'symbol');
  assert.equal(digits[0].tier, 3, '符号中段命中仍高于任何元信息命中');
}

// 全名匹配卡在词首，不是裸子串：真实词表里搜 "astro" 会撞上 gastrokine、
// 搜 "protein" 会撞上 glycoprotein，把真正想要的那几个埋在几千条巧合下面。
function testNameMatchingSticksToWordStarts() {
  const api = freshApi();
  api.ingestSearchIndex({
    version: 1,
    ensemblPrefix: 'ENSG00000',
    biotypes: ['protein-coding'],
    classes: [],
    symbols: ['GFAP', 'SNAP25'],
    ensembl: ['131095', '132639'],
    // GFAP 的全名里有独立的 "acidic"；SNAP25 的全名里只有词中的 "acid"。
    names: ['glial fibrillary acidic protein', 'gastroacid synthase 25'],
    locations: ['17q21.31', '20p12.2'],
    biotype: [0, 0],
    peak: [-1, -1],
    regions: [163, 163],
    detail: [],
  });

  assert.deepEqual(symbolsOf(api.search('acid')), ['GFAP'], '词首命中，词中不命中');
  // 多词查询仍然可用：只要短语的开头落在词边界上。
  assert.deepEqual(symbolsOf(api.search('acidic protein')), ['GFAP']);
}

// 本次需求的正事：能用 ENSG 号搜到基因。存储上去掉了共同前缀，所以两种写法
// 都必须能用：完整 id 与只打后几位数字。
function testEnsemblIdsAreSearchableWholeOrPacked() {
  const api = searchApi();

  const full = rehome(api.search('ENSG00000131095'));
  assert.equal(full.length, 1);
  assert.equal(full[0].symbol, 'GFAP');
  assert.equal(full[0].field, 'ensembl');
  // 展示用的是还原后的完整 id，不是存储里的残段。
  assert.equal(full[0].text, 'ENSG00000131095');

  assert.deepEqual(symbolsOf(api.search('ensg00000131095')), ['GFAP'], '大小写不敏感');
  assert.deepEqual(symbolsOf(api.search('131095')), ['GFAP'], '只打后几位也能命中');
  // 前缀命中全部（MAPT 不在本次构建的载荷里，不会被提供）。
  assert.deepEqual(symbolsOf(api.search('ENSG000001')), ['GFAP', 'SNAP25']);
}

// 一两个字符在 1.9 万条 HGNC 全名里几乎处处命中，会把符号命中埋掉。
function testShortQueriesStayASymbolSearch() {
  const api = searchApi();
  // "ac" 在 GFAP 的全名（...acidic protein）里有，但太短，不该拉进来。
  assert.deepEqual(symbolsOf(api.search('ac')), []);
  // 三个字符起才开启全名/位置/类别匹配。
  assert.deepEqual(symbolsOf(api.search('acidic')), ['GFAP']);
}

// 细胞位置与峰值类别也在索引里，顺手可搜；但只做前缀匹配，且排在最后一层。
function testLocusAndPeakClassAreSearchableAtTheLowestRank() {
  const api = searchApi();

  const locus = rehome(api.search('17q21'));
  assert.deepEqual(locus.map((match) => match.symbol), ['GFAP']);
  assert.equal(locus[0].field, 'location');
  assert.equal(locus[0].text, '17q21.31');

  const peak = rehome(api.search('Astro'));
  assert.deepEqual(peak.map((match) => match.symbol), ['GFAP']);
  assert.equal(peak[0].field, 'class');
  assert.equal(peak[0].text, 'Astrocyte');
}

// 搜索索引与基因载荷是两次导出，可能不同步。索引里有、载荷里没的基因不能出现在
// 候选里：点下去只会 404。
function testGenesAbsentFromThePayloadAreNotOffered() {
  const api = searchApi();
  assert.deepEqual(symbolsOf(api.search('MAPT')), [], 'MAPT 不在本次构建的载荷里');
  assert.deepEqual(symbolsOf(api.search('microtubule')), []);
}

// 候选行要展示的字段从列式索引里重组：字典编码的两列要能还原成字符串，
// ensembl 要补回前缀，detail 要从位置表里认出来。
function testSearchMetaIsRebuiltFromTheColumns() {
  const api = searchApi();
  const meta = rehome(api.searchMeta('GFAP'));
  assert.deepEqual(meta, {
    ensembl: 'ENSG00000131095',
    name: 'glial fibrillary acidic protein',
    location: '17q21.31',
    biotype: 'protein-coding',
    peakClass: 'Astrocyte',
    regions: 163,
    detail: true,
  });
  // detail 只标在真有明细的基因上，不是每行都写。
  assert.equal(rehome(api.searchMeta('SNAP25')).detail, undefined);
  // 索引里没有的基因返回 null，而不是一个空记录。
  assert.equal(api.searchMeta('NOT_A_GENE'), null);
}

// 一个搜索框一次请求：既不是每次击键一次，也不是每行一次。分片时代是每个首字母一次，
// 而按全名/ENSG 号匹配跳字母，根本无法分片。
function testTheSearchIndexIsFetchedOnce() {
  const urls = [];
  const { api } = loadModule('gene-atlas-data.js', {
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURE_SEARCH_INDEX) });
    },
  });
  api.ingestIndex(FIXTURE_INDEX);

  return api
    .loadSearchIndex()
    .then(() => api.loadSearchIndex())
    .then(() => {
      assert.equal(urls.length, 1, `只请求一次，实际 ${JSON.stringify(urls)}`);
      assert.match(String(urls[0]), /search-index\.json$/);
      assert.equal(api.searchMeta('GFAP').peakClass, 'Astrocyte');
      assert.deepEqual(symbolsOf(api.search('131095')), ['GFAP'], '索引到位后 ENSG 可搜');
    });
}

// 旧的导出没有 search-index.json：搜索必须退回符号前缀照常工作，且不能每次击键都再
// 撞一次 404。
function testAMissingSearchIndexIsRememberedInsteadOfRetried() {
  let calls = 0;
  const { api } = loadModule('gene-atlas-data.js', {
    fetch: () => {
      calls += 1;
      return Promise.resolve({ ok: false, status: 404 });
    },
  });
  api.ingestIndex(FIXTURE_INDEX);

  return api
    .loadSearchIndex()
    .then((result) => {
      assert.equal(result, null, '缺索引解析为 null，而不是抛错');
      return api.loadSearchIndex();
    })
    .then(() => {
      assert.equal(calls, 1, '已知缺失的索引不再请求');
      assert.equal(api.searchMeta('GFAP'), null);
      assert.deepEqual(symbolsOf(api.search('GF')), ['GFAP'], '符号前缀检索仍然可用');
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
    ['testCellTypeSummaryAggregatesAcrossRegionsByCellCount', testCellTypeSummaryAggregatesAcrossRegionsByCellCount],
    ['testCellTypeSummaryFollowsTheRuleAndMetric', testCellTypeSummaryFollowsTheRuleAndMetric],
    ['testCellTypeSummaryIsEmptyWithoutADetailTier', testCellTypeSummaryIsEmptyWithoutADetailTier],
    ['testWholeBrainValueMirrorsTheCrossRegionArithmetic', testWholeBrainValueMirrorsTheCrossRegionArithmetic],
    ['testWholeBrainValueIsNullWithoutAPayload', testWholeBrainValueIsNullWithoutAPayload],
    ['testHasGeneAnswersFromTheIndexWithoutFetching', testHasGeneAnswersFromTheIndexWithoutFetching],
    ['testCellWeightedSubsetRecomputesByCellCount', testCellWeightedSubsetRecomputesByCellCount],
    ['testDonorBalancedSubsetRecomputesByEqualWeight', testDonorBalancedSubsetRecomputesByEqualWeight],
    ['testSubsetWithNoDataInARegionDropsThatRegion', testSubsetWithNoDataInARegionDropsThatRegion],
    ['testSupportIsExposedForTheDetailPanel', testSupportIsExposedForTheDetailPanel],
    ['testHasDetailReflectsTheIndexSubset', testHasDetailReflectsTheIndexSubset],
    ['testCellTypeDetailIsEmptyUntilTheDetailFileArrives', testCellTypeDetailIsEmptyUntilTheDetailFileArrives],
    ['testCellTypeFilterFallsBackToRegionLevelWithoutDetail', testCellTypeFilterFallsBackToRegionLevelWithoutDetail],
    ['testCanFilterOnlyOnceDetailIsActuallyLoaded', testCanFilterOnlyOnceDetailIsActuallyLoaded],
    ['testSymbolMatchesOutrankIdentifierAndNameMatches', testSymbolMatchesOutrankIdentifierAndNameMatches],
    ['testNameMatchingSticksToWordStarts', testNameMatchingSticksToWordStarts],
    ['testEnsemblIdsAreSearchableWholeOrPacked', testEnsemblIdsAreSearchableWholeOrPacked],
    ['testShortQueriesStayASymbolSearch', testShortQueriesStayASymbolSearch],
    ['testLocusAndPeakClassAreSearchableAtTheLowestRank', testLocusAndPeakClassAreSearchableAtTheLowestRank],
    ['testGenesAbsentFromThePayloadAreNotOffered', testGenesAbsentFromThePayloadAreNotOffered],
    ['testSearchMetaIsRebuiltFromTheColumns', testSearchMetaIsRebuiltFromTheColumns],
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
      return testTheSearchIndexIsFetchedOnce();
    })
    .then(() => {
      console.log('PASS testTheSearchIndexIsFetchedOnce');
      return testAMissingSearchIndexIsRememberedInsteadOfRetried();
    })
    .then(() => {
      console.log('PASS testAMissingSearchIndexIsRememberedInsteadOfRetried');
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
