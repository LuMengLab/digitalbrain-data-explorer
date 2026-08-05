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

const SCALE = {
  breakpoint: 0.5201,
  reference: 3.5091,
  lowKnots: [0, 0.0008, 0.003, 0.0085, 0.0196, 0.0372, 0.0602,
             0.0889, 0.1253, 0.1729, 0.2382, 0.3379, 0.5201],
};

const FIXTURE_INDEX = {
  scope: { datasets: 109, donors: 2143, cells: 16352123 },
  cellTypes: ['Astrocyte', 'Microglia', 'Oligodendrocyte'],
  // Four groups, as the export ships them: the two rules disagree by 21% on the mean
  // anchor, so the row has to pick the pair matching the current rule and metric.
  densityScale: {
    cell_weighted: { mean: SCALE, detection: { ...SCALE, reference: 1 } },
    donor_balanced: { mean: { ...SCALE, reference: 2.9077 }, detection: { ...SCALE, reference: 1 } },
  },
  genes: {
    GFAP: 'genes/GFAP.json',
    SNAP25: 'genes/SNAP25.json',
    GAD1: 'genes/GAD1.json',
  },
  detailGenes: ['GFAP'],
};

// The search index (see scripts/export_gene_search_index.py): columnar, so every list
// is positional on the sorted symbols. GAD1 is annotated but has no cell-class detail.
const FIXTURE_SEARCH_INDEX = {
  version: 1,
  ensemblPrefix: 'ENSG00000',
  biotypes: ['protein-coding'],
  classes: ['Astrocyte', 'MGE interneuron', 'Excitatory neuron'],
  symbols: ['GAD1', 'GFAP', 'SNAP25'],
  ensembl: ['128683', '131095', '132639'],
  names: [
    'glutamate decarboxylase 1',
    'glial fibrillary acidic protein',
    'synaptosome associated protein 25',
  ],
  locations: ['2q31.1', '17q21.31', '20p12.2'],
  biotype: [0, 0, 0],
  peak: [1, 0, 2],
  regions: [163, 163, 163],
  detail: [1],
};

const FILES = {
  'genes/GFAP.json': FIXTURE_GFAP,
  'genes/GFAP.detail.json': FIXTURE_GFAP_DETAIL,
  'genes/SNAP25.json': FIXTURE_SNAP25,
  'genes/GAD1.json': FIXTURE_GAD1,
  'index.json': FIXTURE_INDEX,
  'search-index.json': FIXTURE_SEARCH_INDEX,
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
    // The class palette belongs to the atlas, so the list has to ask for it. Fixed
    // answers here make "the swatch is the atlas colour" assertable.
    cellTypeColour(cellType) {
      return { Astrocyte: '#f3c86f', Microglia: '#ef8e70' }[cellType] || '#9fb4bb';
    },
    applyGeneValues(payload) {
      calls.push({
        kind: 'apply',
        metric: payload.metric,
        rule: payload.rule,
        active: payload.active,
        scale: payload.scale,
        genes: payload.genes,
        // Convenience for the single-gene tests: the first gene in selection order
        // carries exactly what the old single-gene payload used to. No gene selected
        // means an empty overlay, which is a legitimate state of the gene layer.
        values: payload.genes && payload.genes.length ? payload.genes[0].values : {},
      });
      return {
        layer: 'genes',
        metric: payload.metric,
        genes: (payload.genes || []).map((gene) => ({ symbol: gene.symbol, colour: gene.colour })),
      };
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
  // Both indexes are overridable so a test can widen the catalogue (the result cap only
  // shows itself past 40 matches) without every other test paying for the extra genes.
  const payloadIndex = settings.payloadIndex || FIXTURE_INDEX;
  const files = Object.assign({}, FILES, {
    'index.json': payloadIndex,
    'search-index.json': settings.searchIndex || FIXTURE_SEARCH_INDEX,
  });
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
    // Longest suffix wins: "search-index.json" also ends with "index.json", and a
    // first-match lookup would quietly serve the payload index for both.
    const key = Object.keys(files)
      .filter((name) => String(url).endsWith(name))
      .sort((a, b) => b.length - a.length)[0];
    if (!key || (settings.missing || []).indexOf(key) !== -1) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(files[key]) });
  };

  runIn(context, 'gene-atlas-data.js');
  const data = window.GeneAtlasData;
  data.reset();
  data.ingestIndex(payloadIndex);
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

function classRow(document, type) {
  return document.querySelector(`#geneCellTypeList [data-cell-type="${type}"]`);
}

function classValue(document, type) {
  const node = document.querySelector(`#geneCellTypeList [data-cell-type-value="${type}"]`);
  return node ? node.textContent : null;
}

// The panel's first job is to say which classes carry the gene; without a number per
// row all 31 look equally plausible and the only way to find the carrier is to tick
// them one at a time. Donor-balanced averages the regional readings instead of weighting
// them by cell count, so Astrocyte is (1.9 + 1.266) / 2 = 1.58 (2 dp).
function testEachClassRowShowsTheGeneValueForThatClass() {
  const { document, view } = boot();
  view.addGene('GFAP');
  assert.equal(classValue(document, 'Astrocyte'), '1.58');
  assert.equal(classValue(document, 'Microglia'), '0.40');
  // The note names the metric and rule the column was computed under, because the
  // same class reads differently across the four combinations.
  const note = document.getElementById('geneCellTypeValueNote');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /GFAP/);
  assert.match(note.textContent, /mean expression/i);

  document.querySelector('#geneMetricTabs [data-metric="detection"]').click();
  // detection, donor-balanced: (0.81 + 0.42) / 2 = 0.615 -> 62%
  assert.equal(classValue(document, 'Astrocyte'), '62%');
}

// Oligodendrocyte is in the vocabulary but carries no cells for GFAP. A 0 there would
// claim the gene was measured in that class and found silent.
function testAClassWithoutDataForTheGeneIsMarkedNotZeroed() {
  const { document, view } = boot();
  view.addGene('GFAP');
  const row = classRow(document, 'Oligodendrocyte');
  assert.equal(classValue(document, 'Oligodendrocyte'), '\u2014');
  assert.ok(row.classList.contains('empty'), 'a class with no data must be marked as such');
}

// Reusing the cell-profiles pill only helps if the swatches agree with the canvas,
// so the colour comes from the atlas rather than a second palette in the row.
function testClassSwatchesUseTheAtlasPalette() {
  const { document, view } = boot();
  view.addGene('GFAP');
  const dot = classRow(document, 'Astrocyte').querySelector('.cell-type-dot');
  assert.equal(dot.style.color, 'rgb(243, 200, 111)', 'the swatch must be the atlas colour');
}

// The list opens on "All cell classes" exactly as the cell-profiles list opens on
// "All cell types", and that row is the one click back to the unfiltered table.
function testTheAllClassesRowClearsTheFilter() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.setCellTypes(['Astrocyte']);
  assert.equal(atlas.last().values.EC, 1.9);

  const all = document.querySelector('#geneCellTypeList [data-cell-type-all]');
  assert.ok(all, 'the list must offer an explicit all-classes row');
  all.click();
  assert.equal(view.selectedCellTypes(), null, 'the all row means no filter, not 31 ticks');
  assert.equal(atlas.last().values.EC, 1.15, 'and the map goes back to the region table');
  assert.ok(all.classList.contains('active'), 'the row shows that it is the current state');
}

// "Is this gene microglial?" is the layer's most common question and unticking 30
// boxes is not a workflow. The button sits inside the label, so the default tick
// must not fire on top of the selection it just set.
function testTheOnlyButtonIsolatesOneClass() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');

  document.querySelector('#geneCellTypeList [data-cell-type-solo="Microglia"]').click();
  assert.deepEqual([...view.selectedCellTypes()], ['Microglia']);
  assert.deepEqual(Object.keys(atlas.last().values), ['EC'], 'SWM has no microglia to show');
  assert.equal(atlas.last().values.EC, 0.4);
  assert.equal(
    classRow(document, 'Astrocyte').classList.contains('active'),
    false,
    'the other rows must show that they are out',
  );
}

// A tick changes which classes are selected, not what each is worth, so the rows are
// updated in place: rebuilding them would drop the focus that just did the ticking.
function testTickingAClassKeepsTheRowsAndFocusInPlace() {
  const { document, view } = boot();
  view.addGene('GFAP');
  const box = document.querySelector('#geneCellTypeList [data-cell-type-box="Microglia"]');
  box.focus();
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

  assert.deepEqual([...view.selectedCellTypes()], ['Astrocyte', 'Oligodendrocyte']);
  assert.equal(
    document.querySelector('#geneCellTypeList [data-cell-type-box="Microglia"]'),
    box,
    'the row must survive the tick rather than be rebuilt',
  );
  assert.equal(document.activeElement, box, 'the keyboard focus must stay where it was');
  assert.equal(
    classRow(document, 'Microglia').classList.contains('active'),
    false,
    'the pill must follow the box it contains',
  );
}

// The host collapses this list to five rows, so with 31 classes the ticked ones are
// usually below the fold. The heading is the only part that is always on screen.
function testTheHeadingReportsHowManyClassesAreTicked() {
  const { document, view } = boot();
  view.addGene('GFAP');
  const count = document.getElementById('geneCellTypeCount');
  assert.equal(count.hidden, true, 'no filter needs no count; the all-classes row says it');

  view.setCellTypes(['Astrocyte']);
  assert.equal(count.hidden, false);
  assert.match(count.textContent, /1 of 3/);

  document.querySelector('#geneCellTypeList [data-cell-type-all]').click();
  assert.equal(count.hidden, true, 'back to no filter, so back to no count');
}

// A dropdown of bare acronyms cannot be chosen from: 19k symbols all look alike.
// The search index arrives after the list is already on screen, so the row is
// rendered twice -- typing must never wait on a request.
async function testResultRowsGainTheirMetadataWhenTheIndexArrives() {
  const { document, view, requests } = boot();
  view.search('GF');
  // First pass, straight from the index: the symbol is there and nothing waited.
  assert.deepEqual(resultLabels(document), ['GFAP']);

  await view.searchIndexReady();
  assert.ok(
    requests.some((url) => String(url).endsWith('search-index.json')),
    `the search index must be fetched, got ${JSON.stringify(requests)}`,
  );

  const option = document.querySelector('#geneSearchResults [data-gene="GFAP"]');
  assert.match(option.textContent, /glial fibrillary acidic protein/, 'the HGNC name');
  assert.match(option.textContent, /ENSG00000131095/, 'the Ensembl id');
  assert.match(option.textContent, /17q21\.31/, 'the cytoband');
  assert.match(option.textContent, /163 regions/, 'how much of the brain it covers');
  assert.equal(
    option.querySelector('[data-peak-class]').dataset.peakClass,
    'Astrocyte',
    'the class carrying it, which is the functional hint',
  );
  assert.ok(
    option.querySelector('[data-detail-badge]'),
    'GFAP ships a cell-class tier, and that decides what can be done after picking it',
  );
  assert.equal(
    option.querySelector('[data-match-field]'),
    null,
    'a symbol match needs no explanation of why it is in the list',
  );
}

// The badge is a promise about the next step, so it must not appear for the ~19.2k
// genes whose Cell class filter will be greyed out.
async function testOnlyGenesWithACellClassTierGetTheBadge() {
  const { document, view } = boot();
  view.search('GA');
  await view.searchIndexReady();

  const option = document.querySelector('#geneSearchResults [data-gene="GAD1"]');
  assert.match(option.textContent, /glutamate decarboxylase 1/);
  assert.equal(option.querySelector('[data-detail-badge]'), null,
    'GAD1 is region-level only in this fixture');
}

// One request for the whole box, not per keystroke: matching names and ids crosses
// every letter, so there is nothing to shard by and nothing to re-fetch.
async function testTheSearchIndexIsFetchedOncePerSession() {
  const { view, requests } = boot();
  view.search('G');
  await view.searchIndexReady();
  view.search('GF');
  await view.searchIndexReady();
  view.search('SNAP');
  await view.searchIndexReady();

  assert.equal(
    requests.filter((url) => String(url).endsWith('search-index.json')).length,
    1,
    'three queries across two letters must cost one request',
  );
}

// An older export ships no search index at all. The dropdown must keep working with
// the symbols it has, and must not re-request the missing file on every keystroke.
async function testAMissingSearchIndexLeavesTheSymbolListStanding() {
  const { document, view, requests } = boot({ missing: ['search-index.json'] });
  view.search('SN');
  await view.searchIndexReady();
  assert.deepEqual(resultLabels(document), ['SNAP25'], 'the list still lists');

  view.search('SNA');
  await view.searchIndexReady();
  assert.equal(
    requests.filter((url) => String(url).endsWith('search-index.json')).length,
    1,
    'a known-missing index must not be asked for again',
  );
}

// The point of the whole index: a gene is reachable by its Ensembl id and by its HGNC
// name, not only by guessing its symbol. A row that did not match on its symbol has to
// say what it did match, or it reads as an unrelated gene the search threw in.
async function testGenesAreReachableByIdAndByName() {
  const { document, view } = boot();

  view.search('ENSG00000131095');
  await view.searchIndexReady();
  assert.deepEqual(resultLabels(document), ['GFAP'], 'the full Ensembl id finds the gene');
  const byId = document.querySelector('#geneSearchResults [data-gene="GFAP"] [data-match-field]');
  assert.ok(byId, 'an id match must explain itself');
  assert.equal(byId.dataset.matchField, 'ensembl');
  assert.match(byId.textContent, /ENSG00000131095/);

  view.search('decarboxylase');
  await view.searchIndexReady();
  assert.deepEqual(resultLabels(document), ['GAD1'], 'the HGNC name finds the gene');
  const byName = document.querySelector('#geneSearchResults [data-gene="GAD1"] [data-match-field]');
  assert.equal(byName.dataset.matchField, 'name');
  assert.match(byName.textContent, /glutamate decarboxylase 1/);
}

// The priority the whole ranking exists for: symbol matches first, then identifier
// matches, and metadata matches last -- so widening the search never costs the user
// the row they were actually typing towards.
async function testSymbolMatchesAreListedBeforeMetadataMatches() {
  const { document, view } = boot();
  // "GA" is a prefix of GAD1 and appears inside no symbol; "protein" is in two names.
  view.search('protein');
  await view.searchIndexReady();
  assert.deepEqual(
    resultLabels(document),
    ['GFAP', 'SNAP25'],
    'a name-only query still lists, alphabetically within its tier',
  );

  // A query that hits one symbol and another gene's name: the symbol comes first.
  view.search('GAD1');
  await view.searchIndexReady();
  assert.equal(resultLabels(document)[0], 'GAD1');
}

// Matching names as well as symbols means a broad query can hit thousands of genes.
// Rendering all of them is useless and cutting them silently is worse.
async function testALongResultListIsCappedAndSaysSo() {
  // 60 genes whose names all contain "protein", so one query matches every one of them.
  const symbols = Array.from({ length: 60 }, (_, i) => `PRO${String(i).padStart(3, '0')}`);
  const { document, view } = boot({
    payloadIndex: Object.assign({}, FIXTURE_INDEX, {
      genes: Object.fromEntries(symbols.map((symbol) => [symbol, `genes/${symbol}.json`])),
    }),
    searchIndex: {
      version: 1,
      ensemblPrefix: 'ENSG00000',
      biotypes: ['protein-coding'],
      classes: ['Astrocyte'],
      symbols,
      ensembl: symbols.map((_, i) => String(100000 + i)),
      names: symbols.map((_, i) => `some protein ${i}`),
      locations: symbols.map(() => '1p36.33'),
      biotype: symbols.map(() => 0),
      peak: symbols.map(() => 0),
      regions: symbols.map(() => 163),
      detail: [],
    },
    preload: false,
  });

  view.search('protein');
  await view.searchIndexReady();

  const rows = resultLabels(document);
  assert.equal(rows.length, 40, 'the list is capped');
  assert.deepEqual(rows, symbols.slice(0, 40), 'and it keeps the top of the ranking');
  const overflow = document.querySelector('#geneSearchResults [data-result-overflow]');
  assert.ok(overflow, 'the cut must be reported, not silent');
  assert.match(overflow.textContent, /40/, 'how many are shown');
  assert.match(overflow.textContent, /60/, 'out of how many');

  // A real prefix query is well under the cap, so it is never truncated.
  view.search('PRO001');
  await view.searchIndexReady();
  assert.equal(document.querySelector('#geneSearchResults [data-result-overflow]'), null);
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

// Reported bug: on the gene layer with no gene picked yet, clicking a metric or
// rule tab threw the atlas back to Cell profiles. repaint() was routing "nothing to
// draw" through the atlas's teardown call (clearGeneValues -> selectDataLayer
// "cells"), conflating an empty overlay with leaving the layer. Configuring the
// layer you just entered must not eject you from it.
function testConfiguringTheLayerWithNoGeneKeepsIt() {
  const { document, atlas, view } = boot();
  assert.equal(view.activeGene(), null, 'this test is about the no-gene state');

  document.querySelector('#geneMetricTabs [data-metric="detection"]').click();
  let last = atlas.last();
  assert.equal(last.kind, 'apply',
    'switching metric must repaint the gene layer, not tear it down');
  assert.equal(last.metric, 'detection');
  assert.equal(Object.keys(last.values).length, 0,
    'with no gene selected the overlay is empty rather than absent');

  document.querySelector('#geneRuleTabs [data-rule="donor_balanced"]').click();
  last = atlas.last();
  assert.equal(last.kind, 'apply', 'same for the aggregation rule');

  view.resetCellTypes();
  assert.equal(atlas.last().kind, 'apply', 'and for the cell-class filter');
}

// Reported bug: removing the last chip tore the layer down (clearGeneValues ->
// selectDataLayer "cells") and the gene legend kept the removed gene's rows. An
// empty selection is a legitimate state of the layer, not a request to leave it
// -- the same rule the metric and rule tabs already follow.
function testRemovingTheLastChipKeepsTheGeneLayer() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.removeGene('GFAP');

  assert.deepEqual(chipLabels(document), []);
  assert.equal(view.activeGene(), null);
  const last = atlas.last();
  assert.equal(last.kind, 'apply', 'an empty selection repaints, it does not leave');
  assert.equal(last.genes.length, 0, 'the repaint carries no genes, so the overlay empties');
  assert.equal(atlas.calls.every((call) => call.kind !== 'clear'), true,
    'tearing the layer down is never part of chip removal');
}

function testMetricSwitchRepaintsWithDetectionValues() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 1.15);

  document.querySelector('#geneMetricTabs [data-metric="detection"]').click();
  const painted = atlas.last();
  assert.equal(painted.metric, 'detection');
  assert.equal(painted.values.EC, 0.455, 'the 3D values follow the metric');
}

function testRuleSwitchRepaintsWithTheOtherAggregation() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 1.15, 'donor-balanced is the default');

  // Cell-weighted is not offered in the UI any more, but the button stays wired and the
  // whole path behind it intact -- so driving it must still repaint with that rule.
  document.querySelector('#geneRuleTabs [data-rule="cell_weighted"]').click();
  assert.equal(atlas.last().values.EC, 0.637, 'the 3D values follow the rule');
}

// Only donor-balanced is on offer: it gives every donor equal say, whereas
// cell-weighted lets the largest study dominate a cross-study mean. The control for the
// rule that is not offered is hidden rather than deleted, and the note that compares the
// two goes with it -- naming a rule the reader cannot pick only raises a question.
function testOnlyTheOfferedAggregationRuleIsShown() {
  const { document, atlas, view } = boot();
  const cellWeighted = document.querySelector('#geneRuleTabs [data-rule="cell_weighted"]');
  const donorBalanced = document.querySelector('#geneRuleTabs [data-rule="donor_balanced"]');

  assert.equal(cellWeighted.hidden, true, 'the cell-weighted button is withheld');
  assert.equal(donorBalanced.hidden, false, 'donor-balanced is the one on offer');
  assert.ok(donorBalanced.classList.contains('active'), 'and it is the one in effect');

  // GFAP's two rules differ by 44% in this fixture, which used to raise the note.
  view.addGene('GFAP');
  assert.equal(atlas.last().rule, 'donor_balanced', 'the atlas is told which rule it drew');
  assert.equal(document.getElementById('geneRuleNote').hidden, true,
    'with one rule on offer there is no choice left to explain');

  // And the per-class caption still names the rule actually in force, so the numbers
  // below it are never unattributed.
  view.setCellTypes(['Astrocyte']);
  assert.match(document.getElementById('geneCellTypeValueNote').textContent, /donor-balanced/);
}

function testCellTypeFilterRepaintsTheThreeDeeView() {
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().values.EC, 1.15);

  // Astrocyte only: EC must fall back to the astrocyte value, not the mixed one.
  // A filter that only redrew the detail panel would leave 1.15 here.
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
  assert.equal(atlas.last().values.EC, 1.15, 'reset goes back to the unfiltered table');
  // null, not []: an empty array is an explicit "no class selected".
  assert.equal(view.selectedCellTypes(), null, 'reset clears the filter');
}

function testTickingEveryCellClassMatchesTheUnfilteredTable() {
  const { atlas, view, data } = boot();
  view.addGene('GFAP');
  view.setCellTypes(data.cellTypes());
  // All ticked is the same view as no filter, and the precomputed region table is
  // the authoritative one, so the two must not disagree.
  assert.equal(atlas.last().values.EC, 1.15);
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

// --- region detail provider ---

// The snapshot always describes the whole selection, so every test here reads the
// entry it cares about rather than a bare top-level value.
function entryFor(snapshot, symbol) {
  return [...snapshot.genes].find((gene) => gene.symbol === symbol);
}

// The atlas cannot reach the gene payloads, so the view hands it a lookup. Without
// this the detail panel would have nothing to show when a region is clicked.
async function testTheViewInstallsAGeneDetailProviderOnTheAtlas() {
  const installed = [];
  const { view, data } = boot();
  view.attachAtlas({
    applyGeneValues: () => ({}),
    clearGeneValues: () => ({}),
    setGeneDetailProvider: (fn) => installed.push(fn),
  });
  await view.addGene('GFAP');
  assert.equal(installed.length, 1, 'the provider is installed once');

  const snapshot = installed[0]('EC');
  assert.equal(snapshot.active, 'GFAP');
  assert.equal(snapshot.metric, data.metric());
  const gfap = entryFor(snapshot, 'GFAP');
  assert.equal(gfap.detailAvailable, true);
  assert.equal(gfap.value, 1.15, 'the region value under the active rule');
  assert.equal(gfap.support.donors, 43);
  const astro = gfap.rows.find((row) => row.cellType === 'Astrocyte');
  assert.equal(astro.mean, 1.9);
}

// The point of the panel in a multi-gene selection: one region, every gene's value,
// each with the chip colour it is drawn with. Per-class rows travel for the active
// gene only -- 31 rows per gene would be paid for and never rendered.
async function testTheSnapshotCarriesEverySelectedGeneWithItsChipColour() {
  const installed = [];
  const { view } = boot();
  view.attachAtlas({
    applyGeneValues: () => ({}),
    clearGeneValues: () => ({}),
    setGeneDetailProvider: (fn) => installed.push(fn),
  });
  await view.addGene('GFAP');
  await view.addGene('SNAP25');

  const snapshot = installed[0]('EC');
  assert.deepEqual([...snapshot.genes].map((gene) => gene.symbol), ['GFAP', 'SNAP25'],
    'chip order, which is also the cloud order');
  assert.equal(snapshot.active, 'SNAP25', 'the last one added is the active one');
  assert.equal(entryFor(snapshot, 'GFAP').value, 1.15);
  assert.equal(entryFor(snapshot, 'SNAP25').value, 3.1);
  assert.equal(entryFor(snapshot, 'GFAP').colour, view.colourFor('GFAP'),
    'the panel row and the cloud must use one colour');
  assert.equal(entryFor(snapshot, 'GFAP').rows.length, 0,
    'GFAP is no longer active, so its per-class rows are not paid for');
}

// The panel lists every gene and lets the reader promote one. Only this module can
// grant that, so it has to answer the atlas's request.
async function testAGeneSelectRequestFromTheAtlasSwitchesTheActiveGene() {
  const { window, atlas, view } = boot();
  await view.addGene('GFAP');
  await view.addGene('SNAP25');
  assert.equal(view.activeGene(), 'SNAP25');

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-gene-select', { detail: { symbol: 'GFAP' } }),
  );
  assert.equal(view.activeGene(), 'GFAP', 'the request must move the active gene');
  assert.equal(atlas.last().active, 'GFAP', 'and the repaint must tell the atlas');
}

// The atlas needs the active symbol to know which gene its markers, legend range and
// headline speak for; without it the first chip silently spoke for all of them.
function testThePaintedPayloadNamesTheActiveGene() {
  const { atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().active, 'GFAP');
  view.addGene('SNAP25');
  assert.equal(atlas.last().active, 'SNAP25');
}

// The panel must reflect the metric and rule the map is drawn with, otherwise the
// detail contradicts the colours.
async function testTheProviderFollowsTheActiveMetricAndRule() {
  const installed = [];
  const { view } = boot();
  view.attachAtlas({
    applyGeneValues: () => ({}),
    clearGeneValues: () => ({}),
    setGeneDetailProvider: (fn) => installed.push(fn),
  });
  await view.addGene('GFAP');
  const provider = installed[0];

  view.setRule('donor_balanced');
  assert.equal(entryFor(provider('EC'), 'GFAP').value, 1.15, 'the other aggregation');

  view.setMetric('detection');
  assert.equal(entryFor(provider('EC'), 'GFAP').value, 0.455);
  assert.equal(provider('EC').metric, 'detection');
}

async function testTheProviderReportsAMissingDetailTier() {
  const installed = [];
  const { view } = boot();
  view.attachAtlas({
    applyGeneValues: () => ({}),
    clearGeneValues: () => ({}),
    setGeneDetailProvider: (fn) => installed.push(fn),
  });
  await view.addGene('SNAP25');

  const snap = entryFor(installed[0]('EC'), 'SNAP25');
  assert.equal(snap.detailAvailable, false, 'SNAP25 is region-level only');
  assert.equal(snap.rows.length, 0, 'no per-class rows to show');
  assert.equal(snap.value, 3.1, 'but the region value is still there');
}

async function testTheProviderReturnsNoDataForAnUncoveredRegion() {
  const installed = [];
  const { view } = boot();
  view.attachAtlas({
    applyGeneValues: () => ({}),
    clearGeneValues: () => ({}),
    setGeneDetailProvider: (fn) => installed.push(fn),
  });
  await view.addGene('GFAP');

  // GFAP has no data in Pn: the value must be absent, never 0.
  const gfap = entryFor(installed[0]('Pn'), 'GFAP');
  assert.equal(gfap.value, null);
  assert.equal(gfap.support, null);
  assert.equal(gfap.rows.length, 0);
}

function testEverySelectedGeneReachesTheAtlasInOrder() {
  // The cloud draws every selected gene at once, and the array order fixes each
  // gene's offset angle -- so "in order" is load-bearing, not cosmetic.
  const { atlas, view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  const painted = atlas.last();
  // Spread into a local array: the payload is built in the vm realm, so a bare
  // deepEqual on the mapped result trips over the foreign Array prototype.
  assert.deepEqual([...painted.genes].map((gene) => gene.symbol), ['GFAP', 'SNAP25'],
    'both genes must go over, in selection order');
  assert.equal(painted.genes[1].values.EC, 3.1, "the second gene's own values must travel with it");
}

function testEachGeneCarriesItsChipColour() {
  // One source of truth for colour: the chips already own it, so the cloud has to be
  // told rather than deriving its own and drifting apart from the row.
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  view.addGene('SNAP25');
  const painted = atlas.last();
  const chips = [...document.querySelectorAll('#geneChips [data-gene-colour]')];
  assert.deepEqual([...painted.genes].map((gene) => gene.colour),
    chips.map((chip) => chip.dataset.geneColour),
    'the payload colours must be the chip colours');
}

function testGeneSupportTravelsWithEachGene() {
  // The atlas merges the several DigitalBrain regions that share one Allen label, and
  // it can only weight that merge by cell counts if they arrive with the values.
  //
  // Numbers, not the { datasets, donors, cells } record the data layer stores: the
  // aggregation ignores a non-numeric weight, so handing the record over would leave
  // every label dark and the cloud blank without raising anything.
  const { atlas, view } = boot();
  view.addGene('GFAP');
  const gene = atlas.last().genes[0];
  assert.ok(gene.support && Object.keys(gene.support).length,
    'support must not be dropped on the way to the atlas');
  Object.keys(gene.support).forEach((acronym) => {
    assert.equal(typeof gene.support[acronym], 'number',
      `support for ${acronym} must be reduced to a cell count`);
    assert.ok(gene.support[acronym] > 0, `support for ${acronym} must be a positive cell count`);
  });
}

function testThePaintedCalibrationFollowsTheRuleAndMetric() {
  // Four groups exist because the two rules disagree by 21% on the mean anchor. Sending
  // the wrong pair would mislabel the range without any visible symptom.
  const { document, atlas, view } = boot();
  view.addGene('GFAP');
  assert.equal(atlas.last().scale.reference, 2.9077, 'donor-balanced/mean is the default');

  document.querySelector('#geneRuleTabs [data-rule="cell_weighted"]').click();
  assert.equal(atlas.last().scale.reference, 3.5091, 'the calibration must follow the rule');

  document.querySelector('#geneMetricTabs [data-metric="detection"]').click();
  assert.equal(atlas.last().scale.reference, 1,
    'detection is a ratio, so its anchor is the natural bound');
}

async function main() {
  const cases = [
    ['testSearchListsMatchingSymbols', testSearchListsMatchingSymbols],
    ['testResultRowsGainTheirMetadataWhenTheIndexArrives', testResultRowsGainTheirMetadataWhenTheIndexArrives],
    ['testOnlyGenesWithACellClassTierGetTheBadge', testOnlyGenesWithACellClassTierGetTheBadge],
    ['testTheSearchIndexIsFetchedOncePerSession', testTheSearchIndexIsFetchedOncePerSession],
    ['testAMissingSearchIndexLeavesTheSymbolListStanding', testAMissingSearchIndexLeavesTheSymbolListStanding],
    ['testGenesAreReachableByIdAndByName', testGenesAreReachableByIdAndByName],
    ['testSymbolMatchesAreListedBeforeMetadataMatches', testSymbolMatchesAreListedBeforeMetadataMatches],
    ['testALongResultListIsCappedAndSaysSo', testALongResultListIsCappedAndSaysSo],
    ['testSearchMissRendersAnExplicitEmptyState', testSearchMissRendersAnExplicitEmptyState],
    ['testSelectingAResultAddsAChipAndPaints', testSelectingAResultAddsAChipAndPaints],
    ['testTheSameGeneIsNotAddedTwice', testTheSameGeneIsNotAddedTwice],
    ['testClickingAChipSwitchesTheActiveGene', testClickingAChipSwitchesTheActiveGene],
    ['testEachChipCarriesItsOwnColour', testEachChipCarriesItsOwnColour],
    ['testRemovingTheActiveChipPromotesANeighbour', testRemovingTheActiveChipPromotesANeighbour],
    ['testRemovingAnInactiveChipKeepsTheActiveGene', testRemovingAnInactiveChipKeepsTheActiveGene],
    ['testConfiguringTheLayerWithNoGeneKeepsIt', testConfiguringTheLayerWithNoGeneKeepsIt],
    ['testEverySelectedGeneReachesTheAtlasInOrder', testEverySelectedGeneReachesTheAtlasInOrder],
    ['testEachGeneCarriesItsChipColour', testEachGeneCarriesItsChipColour],
    ['testGeneSupportTravelsWithEachGene', testGeneSupportTravelsWithEachGene],
    ['testThePaintedCalibrationFollowsTheRuleAndMetric', testThePaintedCalibrationFollowsTheRuleAndMetric],
    ['testRemovingTheLastChipKeepsTheGeneLayer', testRemovingTheLastChipKeepsTheGeneLayer],
    ['testMetricSwitchRepaintsWithDetectionValues', testMetricSwitchRepaintsWithDetectionValues],
    ['testRuleSwitchRepaintsWithTheOtherAggregation', testRuleSwitchRepaintsWithTheOtherAggregation],
    ['testOnlyTheOfferedAggregationRuleIsShown', testOnlyTheOfferedAggregationRuleIsShown],
    ['testCellTypeFilterRepaintsTheThreeDeeView', testCellTypeFilterRepaintsTheThreeDeeView],
    ['testCellTypeFilterWithNoDataDropsTheRegion', testCellTypeFilterWithNoDataDropsTheRegion],
    ['testUntickingEveryCellClassLeavesNothingToColour', testUntickingEveryCellClassLeavesNothingToColour],
    ['testResetRestoresTheUnfilteredView', testResetRestoresTheUnfilteredView],
    ['testTickingEveryCellClassMatchesTheUnfilteredTable', testTickingEveryCellClassMatchesTheUnfilteredTable],
    ['testCellTypeListUsesTheThirtyOneClassVocabulary', testCellTypeListUsesTheThirtyOneClassVocabulary],
    ['testEachClassRowShowsTheGeneValueForThatClass', testEachClassRowShowsTheGeneValueForThatClass],
    ['testAClassWithoutDataForTheGeneIsMarkedNotZeroed', testAClassWithoutDataForTheGeneIsMarkedNotZeroed],
    ['testClassSwatchesUseTheAtlasPalette', testClassSwatchesUseTheAtlasPalette],
    ['testTheAllClassesRowClearsTheFilter', testTheAllClassesRowClearsTheFilter],
    ['testTheOnlyButtonIsolatesOneClass', testTheOnlyButtonIsolatesOneClass],
    ['testTickingAClassKeepsTheRowsAndFocusInPlace', testTickingAClassKeepsTheRowsAndFocusInPlace],
    ['testTheHeadingReportsHowManyClassesAreTicked', testTheHeadingReportsHowManyClassesAreTicked],
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
    ['testTheViewInstallsAGeneDetailProviderOnTheAtlas', testTheViewInstallsAGeneDetailProviderOnTheAtlas],
    ['testTheProviderFollowsTheActiveMetricAndRule', testTheProviderFollowsTheActiveMetricAndRule],
    ['testTheProviderReportsAMissingDetailTier', testTheProviderReportsAMissingDetailTier],
    ['testTheProviderReturnsNoDataForAnUncoveredRegion', testTheProviderReturnsNoDataForAnUncoveredRegion],
    ['testTheSnapshotCarriesEverySelectedGeneWithItsChipColour', testTheSnapshotCarriesEverySelectedGeneWithItsChipColour],
    ['testAGeneSelectRequestFromTheAtlasSwitchesTheActiveGene', testAGeneSelectRequestFromTheAtlasSwitchesTheActiveGene],
    ['testThePaintedPayloadNamesTheActiveGene', testThePaintedPayloadNamesTheActiveGene],
  ];
  for (const [name, fn] of cases) {
    await fn();
    console.log(`PASS ${name}`);
  }
}

main();
