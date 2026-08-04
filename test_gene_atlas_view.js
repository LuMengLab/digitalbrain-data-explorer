// Gene search row wiring: gene-atlas-view.js.
//
// The view is the seam between the data layer and the atlas renderer, so it takes
// both by injection and the tests hand it a recording stub for the atlas. That
// keeps these cases about the wiring (which chip is active, what gets repainted)
// instead of about 3D geometry, which test_gene_atlas_layer.js already covers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WEB_DIR = __dirname;

// Two-tier payloads (see scripts/export_gene_atlas_web.py). GFAP ships a cellType
// breakdown, SNAP25 is region-level only, and the two rules disagree on GFAP's EC
// (0.637 cell-weighted vs 1.15 donor-balanced) so a rule switch is observable.
const FIXTURE_GFAP = {
  symbol: 'GFAP',
  ensembl: 'ENSG00000131095',
  hasDetail: true,
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

// Region-level only, like the ~19.2k genes outside the curated detail list.
const FIXTURE_SNAP25 = {
  symbol: 'SNAP25',
  ensembl: 'ENSG00000132639',
  hasDetail: false,
  support: { EC: { datasets: 5, donors: 9, cells: 10 } },
  cell_weighted: { regions: { mean: { EC: 3.1 }, detection: { EC: 0.95 } } },
  donor_balanced: { regions: { mean: { EC: 3.1 }, detection: { EC: 0.95 } } },
};

// Never pre-ingested: the tests use it to check that picking a gene actually
// fetches its file.
const FIXTURE_GAD1 = {
  symbol: 'GAD1',
  ensembl: 'ENSG00000128683',
  hasDetail: false,
  support: { Pn: { datasets: 2, donors: 4, cells: 88 } },
  cell_weighted: { regions: { mean: { Pn: 2.5 }, detection: { Pn: 0.7 } } },
  donor_balanced: { regions: { mean: { Pn: 2.5 }, detection: { Pn: 0.7 } } },
};

const FIXTURE_INDEX = {
  scope: { datasets: 109, donors: 2143, cells: 16352123 },
  cellTypes: ['Astrocyte', 'Microglia', 'Oligodendrocyte'],
  genes: {
    GFAP: 'genes/GFAP.json',
    SNAP25: 'genes/SNAP25.json',
    GAD1: 'genes/GAD1.json',
  },
  detailGenes: ['GFAP'],
};

const FILES = {
  'genes/GFAP.json': FIXTURE_GFAP,
  'genes/GFAP.detail.json': FIXTURE_GFAP_DETAIL,
  'genes/SNAP25.json': FIXTURE_SNAP25,
  'genes/GAD1.json': FIXTURE_GAD1,
  'index.json': FIXTURE_INDEX,
};

function runIn(context, file) {
  vm.runInContext(fs.readFileSync(path.join(WEB_DIR, file), 'utf8'), context, {
    filename: file,
  });
}

// Records what the renderer was asked to draw, so a test can assert on the values
// that reached the atlas rather than on pixels.
function stubAtlas() {
  const calls = [];
  return {
    calls,
    applyGeneValues(payload) {
      calls.push({ kind: 'apply', values: payload.values, metric: payload.metric });
      return { layer: 'genes', metric: payload.metric };
    },
    clearGeneValues() {
      calls.push({ kind: 'clear' });
      return { layer: 'cells' };
    },
    last() {
      return calls[calls.length - 1];
    },
  };
}

function boot(options) {
  const settings = options || {};
  const html = fs
    .readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  // Kept out of `window`: assigning it there hands back the contextified proxy
  // rather than the vm.Context itself.
  const context = dom.getInternalVMContext();

  // Serves the fixture tree so the view can be observed actually fetching.
  const requests = [];
  window.fetch = (url) => {
    requests.push(url);
    const key = Object.keys(FILES).find((name) => String(url).endsWith(name));
    if (!key || (settings.missing || []).indexOf(key) !== -1) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(FILES[key]) });
  };

  runIn(context, 'gene-atlas-data.js');
  const data = window.GeneAtlasData;
  data.reset();
  data.ingestIndex(FIXTURE_INDEX);
  if (settings.preload !== false) {
    data.ingestGene(FIXTURE_GFAP);
    data.ingestGeneDetail(FIXTURE_GFAP_DETAIL);
    data.ingestGene(FIXTURE_SNAP25);
  }

  runIn(context, 'gene-atlas-view.js');
  assert.ok(window.GeneAtlasView, 'gene-atlas-view.js should expose GeneAtlasView');

  const atlas = stubAtlas();
  const view = window.GeneAtlasView.init({
    document: window.document,
    window,
    data,
    atlas,
  });
  return { window, document: window.document, data, atlas, view, requests };
}

function chipLabels(document) {
  return [...document.querySelectorAll('#geneChips [data-gene]')].map((node) =>
    node.dataset.gene,
  );
}

function resultLabels(document) {
  return [...document.querySelectorAll('#geneSearchResults [data-gene]')].map((node) =>
    node.dataset.gene,
  );
}

function testSearchListsMatchingSymbols() {
  const { document, view } = boot();
  view.search('ga');
  assert.deepEqual(resultLabels(document), ['GAD1'], 'prefix search is case-insensitive');

  view.search('g');
  assert.deepEqual(resultLabels(document), ['GAD1', 'GFAP'], 'results are sorted');
}

function testSearchMissRendersAnExplicitEmptyState() {
  const { document, view } = boot();
  view.search('ZZZ');
  assert.deepEqual(resultLabels(document), [], 'a miss lists nothing');
  const box = document.getElementById('geneSearchResults');
  assert.equal(box.hidden, false, 'the result box stays open to show the empty state');
  assert.match(
    box.textContent,
    /no gene/i,
    'a miss must say so rather than render a blank panel',
  );
}

function testSelectingAResultAddsAChipAndPaints() {
  const { document, atlas, view } = boot();
  view.search('GF');
  document.querySelector('#geneSearchResults [data-gene="GFAP"]').click();

  assert.deepEqual(chipLabels(document), ['GFAP']);
  assert.equal(view.activeGene(), 'GFAP', 'a newly added gene becomes active');
  const painted = atlas.last();
  assert.equal(painted.kind, 'apply');
  assert.deepEqual(Object.keys(painted.values).sort(), ['EC', 'SWM']);
  assert.equal(painted.metric, 'mean');
  // Selecting a result closes the dropdown and clears the query.
  assert.equal(document.getElementById('geneSearchResults').hidden, true);
}

function testTheSameGeneIsNotAddedTwice() {
  const { document, view } = boot();
  view.addGene('GFAP');
  view.addGene('GFAP');
  assert.deepEqual(chipLabels(document), ['GFAP'], 'duplicates collapse to one chip');
}

function testClickingAChipSwitchesTheActiveGene() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  assert.equal(view.activeGene(), 'SNAP25', 'the last added gene is active');

  document.querySelector('#geneChips [data-gene="GFAP"]').click();
  assert.equal(view.activeGene(), 'GFAP');
  assert.deepEqual(Object.keys(atlas.last().values).sort(), ['EC', 'SWM']);

  const active = document.querySelector('#geneChips [data-gene="GFAP"]');
  assert.ok(active.classList.contains('active'), 'the active chip is marked');
  const other = document.querySelector('#geneChips [data-gene="SNAP25"]');
  assert.ok(!other.classList.contains('active'), 'only one chip is active');
}

function testEachChipCarriesItsOwnColour() {
  const { document, view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  const colours = chipLabels(document).map(
    (symbol) => document.querySelector(`#geneChips [data-gene="${symbol}"]`).dataset.geneColour,
  );
  assert.equal(colours.length, 2);
  assert.ok(colours.every(Boolean), 'every chip gets a colour');
  assert.notEqual(colours[0], colours[1], 'chips are distinguishable');
}

function testRemovingTheActiveChipPromotesANeighbour() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  assert.equal(view.activeGene(), 'SNAP25');

  view.removeGene('SNAP25');
  assert.deepEqual(chipLabels(document), ['GFAP']);
  assert.equal(view.activeGene(), 'GFAP', 'removing the active gene promotes a neighbour');
  assert.equal(atlas.last().kind, 'apply', 'the layer repaints with the new active gene');
}

function testRemovingAnInactiveChipKeepsTheActiveGene() {
  const { view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  view.removeGene('GFAP');
  assert.equal(view.activeGene(), 'SNAP25', 'removing another chip does not steal focus');
}

function testRemovingTheLastChipLeavesTheGeneLayer() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.removeGene('GFAP');

  assert.deepEqual(chipLabels(document), []);
  assert.equal(view.activeGene(), null);
  assert.equal(atlas.last().kind, 'clear', 'an empty selection leaves the gene layer');
}

function testMetricSwitchRepaintsWithDetectionValues() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 0.637);

  document.querySelector('#geneMetricTabs [data-metric="detection"]').click();
  const painted = atlas.last();
  assert.equal(painted.metric, 'detection');
  assert.equal(painted.values.EC, 0.297, 'the 3D values follow the metric');
}

function testRuleSwitchRepaintsWithTheOtherAggregation() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 0.637, 'cell-weighted is the default');

  document.querySelector('#geneRuleTabs [data-rule="donor_balanced"]').click();
  assert.equal(atlas.last().values.EC, 1.15, 'the 3D values follow the rule');
}

function testCellTypeFilterRepaintsTheThreeDeeView() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 0.637);

  // Astrocyte only: EC must fall back to the astrocyte value, not the mixed one.
  // A filter that only redrew the detail panel would leave 0.637 here.
  view.setCellTypes(['Astrocyte']);
  const painted = atlas.last();
  assert.equal(painted.values.EC, 1.9, 'unticking a cell class must recolour the atlas');
  assert.equal(painted.values.SWM, 1.266);
}

function testCellTypeFilterWithNoDataDropsTheRegion() {
  const { atlas, view } = boot();
  view.addGene('GFAP');
  // SWM has no Microglia, so it must vanish instead of being painted as zero.
  view.setCellTypes(['Microglia']);
  const painted = atlas.last();
  assert.deepEqual(Object.keys(painted.values), ['EC']);
  assert.equal(painted.values.EC, 0.4);
}

function testCellTypeListUsesTheThirtyOneClassVocabulary() {
  const { document } = boot();
  const types = [...document.querySelectorAll('#geneCellTypeList [data-cell-type]')].map(
    (node) => node.dataset.cellType,
  );
  // Sourced from the index, which carries the Explorer vocabulary verbatim.
  assert.deepEqual(types, ['Astrocyte', 'Microglia', 'Oligodendrocyte']);
}

function testUntickingEveryCellClassLeavesNothingToColour() {
  const { atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(Object.keys(atlas.last().values).length, 2);

  // An empty selection is not the same as no filter. No class contributing means
  // no region has a value, so the map must go blank rather than silently revert
  // to showing everything.
  view.setCellTypes([]);
  // Compared by keys: the table is built in the vm realm, so a bare deepEqual on
  // the object itself trips over the foreign prototype.
  assert.deepEqual(Object.keys(atlas.last().values), [], 'no class ticked means no data to draw');
}

function testResetRestoresTheUnfilteredView() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.setCellTypes(['Astrocyte']);
  assert.equal(atlas.last().values.EC, 1.9);

  document.getElementById('geneCellTypeReset').click();
  assert.equal(atlas.last().values.EC, 0.637, 'reset goes back to the unfiltered table');
  // null, not []: an empty array is an explicit "no class selected".
  assert.equal(view.selectedCellTypes(), null, 'reset clears the filter');
}

function testTickingEveryCellClassMatchesTheUnfilteredTable() {
  const { atlas, view, data } = boot();
  view.addGene('GFAP');
  view.setCellTypes(data.cellTypes());
  // All ticked is the same view as no filter, and the precomputed region table is
  // the authoritative one, so the two must not disagree.
  assert.equal(atlas.last().values.EC, 0.637);
}

function testSearchRowIsOnlyVisibleInTheGeneLayer() {
  const { document, window } = boot();
  const row = document.getElementById('geneSearchRow');
  assert.ok(row, 'the search row should exist');
  assert.equal(row.hidden, true, 'it is hidden outside the gene layer');

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-atlas-layer', { detail: { layer: 'genes' } }),
  );
  assert.equal(row.hidden, false, 'entering the gene layer reveals it');

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-atlas-layer', { detail: { layer: 'cells' } }),
  );
  assert.equal(row.hidden, true, 'leaving hides it again');
}

// bootstrap() fetches the index before the row can be useful. Both outcomes matter:
// a build without the gene export must say so instead of showing an empty search.
function bootForBootstrap(fetchImpl) {
  const html = fs
    .readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  window.fetch = fetchImpl;

  runIn(context, 'gene-atlas-data.js');
  runIn(context, 'gene-atlas-view.js');
  const data = window.GeneAtlasData;
  data.reset();

  const atlas = stubAtlas();
  const view = window.GeneAtlasView.bootstrap({
    document: window.document,
    window,
    data,
    atlas,
  });
  return { window, document: window.document, data, atlas, view };
}

async function testBootstrapLoadsTheIndexAndFillsTheCellClasses() {
  const { document, view } = bootForBootstrap(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURE_INDEX) }),
  );
  await view.ready;

  const types = [...document.querySelectorAll('#geneCellTypeList [data-cell-type]')].map(
    (node) => node.dataset.cellType,
  );
  assert.deepEqual(types, ['Astrocyte', 'Microglia', 'Oligodendrocyte']);
  assert.equal(document.getElementById('geneDataNote').hidden, true, 'no warning on success');
}

async function testBootstrapWithoutAGeneExportSaysSo() {
  const { document, view } = bootForBootstrap(() =>
    Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  );
  await view.ready;

  const note = document.getElementById('geneDataNote');
  assert.equal(note.hidden, false, 'a missing export must be announced');
  assert.match(note.textContent, /not available/i);
  // The search box is useless without an index, so it is disabled rather than
  // silently returning nothing for every query.
  assert.equal(document.getElementById('geneSearchInput').disabled, true);
}

async function testBootstrapWithoutAGeneExportHidesTheCellClassSection() {
  const { document, window, view } = bootForBootstrap(() =>
    Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  );
  await view.ready;

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-atlas-layer', { detail: { layer: 'genes' } }),
  );
  // There are no classes to tick without an index, and an empty panel reads as a
  // broken one, so the section stays away until the data is there.
  assert.equal(document.getElementById('geneCellTypeSection').hidden, true);
}

// --- on-demand loading (two-tier payload) ---

// The whole point of the per-gene file layout: 19k genes cannot be shipped up
// front, so picking one has to fetch it. Without this the map stays blank and
// the gene looks like it has no data anywhere.
async function testPickingAnUnloadedGeneFetchesItAndPaints() {
  const { document, atlas, view, requests } = boot();
  assert.equal(view.activeGene(), null);

  await view.addGene('GAD1');

  assert.ok(
    requests.some((url) => String(url).endsWith('genes/GAD1.json')),
    `the gene file must be fetched, got ${JSON.stringify(requests)}`,
  );
  assert.deepEqual(chipLabels(document), ['GAD1']);
  const painted = atlas.last();
  assert.equal(painted.kind, 'apply');
  assert.equal(painted.values.Pn, 2.5, 'the fetched values must reach the atlas');
}

async function testAnAlreadyLoadedGeneIsNotRefetched() {
  const { view, requests } = boot();
  await view.addGene('GFAP');
  assert.equal(
    requests.filter((url) => String(url).endsWith('genes/GFAP.json')).length,
    0,
    'a preloaded gene must not trigger a request',
  );
}

// The detail tier is what cell-type filtering computes from, so it has to arrive
// with the gene rather than on first tick of a checkbox.
async function testPickingAGeneWithDetailAlsoFetchesTheDetailTier() {
  const { view, requests, data } = boot({ preload: false });
  await view.addGene('GFAP');

  assert.ok(
    requests.some((url) => String(url).endsWith('genes/GFAP.detail.json')),
    `the detail file must be fetched, got ${JSON.stringify(requests)}`,
  );
  assert.equal(data.canFilterByCellType('GFAP'), true);
}

async function testPickingARegionOnlyGeneSkipsTheDetailRequest() {
  const { view, requests } = boot({ preload: false });
  await view.addGene('GAD1');

  assert.equal(
    requests.filter((url) => String(url).endsWith('.detail.json')).length,
    0,
    'a region-level gene has no detail file; requesting it would only 404',
  );
}

// A greyed-out control with no explanation reads as a bug. State plainly that
// this gene ships region level only.
async function testARegionOnlyGeneDisablesCellTypeFilteringAndSaysWhy() {
  const { document, view } = boot();
  await view.addGene('SNAP25');

  const boxes = [...document.querySelectorAll('#geneCellTypeList [data-cell-type-box]')];
  assert.ok(boxes.length, 'the classes are still listed');
  assert.ok(
    boxes.every((box) => box.disabled),
    'every checkbox must be disabled without a detail tier',
  );
  const note = document.getElementById('geneDetailNote');
  assert.ok(note, 'there must be a note element for the detail-unavailable state');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /SNAP25/);
  assert.match(note.textContent, /region/i);
}

async function testSwitchingToAGeneWithDetailReEnablesFiltering() {
  const { document, view } = boot();
  await view.addGene('SNAP25');
  await view.addGene('GFAP');

  const boxes = [...document.querySelectorAll('#geneCellTypeList [data-cell-type-box]')];
  assert.ok(
    boxes.every((box) => !box.disabled),
    'GFAP ships a detail tier, so the filter comes back',
  );
  assert.equal(document.getElementById('geneDetailNote').hidden, true);
}

// A failed fetch must not leave a chip that paints nothing: say what happened.
async function testAFailedGeneFetchIsReportedAndLeavesNoChip() {
  const { document, atlas, view } = boot({ missing: ['genes/GAD1.json'] });
  await view.addGene('GAD1');

  assert.deepEqual(chipLabels(document), [], 'a gene that failed to load gets no chip');
  const note = document.getElementById('geneDataNote');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /GAD1/);
  assert.ok(
    !atlas.calls.some((call) => call.kind === 'apply'),
    'nothing should be painted from a failed load',
  );
}

async function main() {
  const cases = [
    ['testSearchListsMatchingSymbols', testSearchListsMatchingSymbols],
    ['testSearchMissRendersAnExplicitEmptyState', testSearchMissRendersAnExplicitEmptyState],
    ['testSelectingAResultAddsAChipAndPaints', testSelectingAResultAddsAChipAndPaints],
    ['testTheSameGeneIsNotAddedTwice', testTheSameGeneIsNotAddedTwice],
    ['testClickingAChipSwitchesTheActiveGene', testClickingAChipSwitchesTheActiveGene],
    ['testEachChipCarriesItsOwnColour', testEachChipCarriesItsOwnColour],
    ['testRemovingTheActiveChipPromotesANeighbour', testRemovingTheActiveChipPromotesANeighbour],
    ['testRemovingAnInactiveChipKeepsTheActiveGene', testRemovingAnInactiveChipKeepsTheActiveGene],
    ['testRemovingTheLastChipLeavesTheGeneLayer', testRemovingTheLastChipLeavesTheGeneLayer],
    ['testMetricSwitchRepaintsWithDetectionValues', testMetricSwitchRepaintsWithDetectionValues],
    ['testRuleSwitchRepaintsWithTheOtherAggregation', testRuleSwitchRepaintsWithTheOtherAggregation],
    ['testCellTypeFilterRepaintsTheThreeDeeView', testCellTypeFilterRepaintsTheThreeDeeView],
    ['testCellTypeFilterWithNoDataDropsTheRegion', testCellTypeFilterWithNoDataDropsTheRegion],
    ['testUntickingEveryCellClassLeavesNothingToColour', testUntickingEveryCellClassLeavesNothingToColour],
    ['testResetRestoresTheUnfilteredView', testResetRestoresTheUnfilteredView],
    ['testTickingEveryCellClassMatchesTheUnfilteredTable', testTickingEveryCellClassMatchesTheUnfilteredTable],
    ['testCellTypeListUsesTheThirtyOneClassVocabulary', testCellTypeListUsesTheThirtyOneClassVocabulary],
    ['testSearchRowIsOnlyVisibleInTheGeneLayer', testSearchRowIsOnlyVisibleInTheGeneLayer],
    ['testBootstrapLoadsTheIndexAndFillsTheCellClasses', testBootstrapLoadsTheIndexAndFillsTheCellClasses],
    ['testBootstrapWithoutAGeneExportSaysSo', testBootstrapWithoutAGeneExportSaysSo],
    ['testBootstrapWithoutAGeneExportHidesTheCellClassSection', testBootstrapWithoutAGeneExportHidesTheCellClassSection],
    ['testPickingAnUnloadedGeneFetchesItAndPaints', testPickingAnUnloadedGeneFetchesItAndPaints],
    ['testAnAlreadyLoadedGeneIsNotRefetched', testAnAlreadyLoadedGeneIsNotRefetched],
    ['testPickingAGeneWithDetailAlsoFetchesTheDetailTier', testPickingAGeneWithDetailAlsoFetchesTheDetailTier],
    ['testPickingARegionOnlyGeneSkipsTheDetailRequest', testPickingARegionOnlyGeneSkipsTheDetailRequest],
    ['testARegionOnlyGeneDisablesCellTypeFilteringAndSaysWhy', testARegionOnlyGeneDisablesCellTypeFilteringAndSaysWhy],
    ['testSwitchingToAGeneWithDetailReEnablesFiltering', testSwitchingToAGeneWithDetailReEnablesFiltering],
    ['testAFailedGeneFetchIsReportedAndLeavesNoChip', testAFailedGeneFetchIsReportedAndLeavesNoChip],
  ];
  for (const [name, fn] of cases) {
    await fn();
    console.log(`PASS ${name}`);
  }
}

main();
