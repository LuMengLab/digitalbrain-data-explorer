// Tests for the gene comparison panels (gene-compare-view.js).
//
// The panels are the quantitative half of the gene layer, so what matters here is not
// that bars appear but that they mean what the caption says: the right regions, the
// right scale, missing data marked rather than zeroed, and a control gene visibly
// separated from the selection at every point where the two could be confused.
//
// Fixtures are deliberately lop-sided: ACTB is ~4x the level of GFAP, which is what
// makes the two scale modes distinguishable, and SNAP25 ships no cell-class tier, which
// is what makes the class panel's "cannot break this down" path reachable. The two
// controls differ on purpose too: ACTB carries no class tier here and so exercises the
// all-classes fallback, GAPDH carries one and so exercises the per-class baseline.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const WEB_DIR = __dirname;

// EC and SWM are in the region catalogue; "CB" stands for a coarse payload label the
// anatomy has no parcel for, which is the 57-of-163 case in the real build.
const FIXTURE_GFAP = {
  symbol: 'GFAP',
  ensembl: 'ENSG00000131095',
  hasDetail: true,
  support: {
    EC: { datasets: 12, donors: 43, cells: 40 },
    SWM: { datasets: 3, donors: 8, cells: 20 },
    CB: { datasets: 2, donors: 5, cells: 10 },
  },
  donor_balanced: {
    regions: {
      mean: { EC: 1.2, SWM: 0.4, CB: 0.9 },
      detection: { EC: 0.5, SWM: 0.2, CB: 0.3 },
    },
  },
  cell_weighted: {
    regions: {
      mean: { EC: 1.0, SWM: 0.3, CB: 0.8 },
      detection: { EC: 0.4, SWM: 0.1, CB: 0.2 },
    },
  },
};

const FIXTURE_GFAP_DETAIL = {
  symbol: 'GFAP',
  donor_balanced: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.9, detection: 0.81, cells: 30 },
        Microglia: { mean: 0.4, detection: 0.1, cells: 10 },
      },
      SWM: {
        Astrocyte: { mean: 0.4, detection: 0.2, cells: 20 },
      },
      CB: {
        Astrocyte: { mean: 0.9, detection: 0.3, cells: 10 },
      },
    },
  },
  cell_weighted: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 1.6, detection: 0.7, cells: 30 },
        Microglia: { mean: 0.3, detection: 0.08, cells: 10 },
      },
      SWM: { Astrocyte: { mean: 0.3, detection: 0.15, cells: 20 } },
      CB: { Astrocyte: { mean: 0.8, detection: 0.25, cells: 10 } },
    },
  },
};

// Region-level only, like the ~19.2k genes outside the curated detail list. Also has no
// value in SWM, so "missing is not zero" is observable.
const FIXTURE_SNAP25 = {
  symbol: 'SNAP25',
  ensembl: 'ENSG00000132639',
  hasDetail: false,
  support: { EC: { datasets: 5, donors: 9, cells: 10 } },
  donor_balanced: { regions: { mean: { EC: 0.6 }, detection: { EC: 0.3 } } },
  cell_weighted: { regions: { mean: { EC: 0.5 }, detection: { EC: 0.25 } } },
};

// The housekeeping control: several times the level of GFAP, which is the whole reason
// the per-gene scale mode exists.
const FIXTURE_ACTB = {
  symbol: 'ACTB',
  ensembl: 'ENSG00000075624',
  hasDetail: false,
  support: {
    EC: { datasets: 20, donors: 60, cells: 100 },
    SWM: { datasets: 20, donors: 60, cells: 100 },
    CB: { datasets: 20, donors: 60, cells: 100 },
  },
  donor_balanced: {
    regions: {
      mean: { EC: 4.0, SWM: 3.0, CB: 2.0 },
      detection: { EC: 0.99, SWM: 0.98, CB: 0.97 },
    },
  },
  cell_weighted: {
    regions: {
      mean: { EC: 3.9, SWM: 2.9, CB: 1.9 },
      detection: { EC: 0.98, SWM: 0.97, CB: 0.96 },
    },
  },
};

// The second control, and the one that ships a cell-type tier: its level differs by type
// (3.8 in astrocytes, 1.9 in microglia) because that difference is the whole reason a
// baseline is read per type rather than as one brain-wide line. Its oligodendrocyte value
// is deliberately the highest number in the fixture and belongs to a type no selected gene
// carries, so "a control must not widen or rescale the comparison" is observable.
const FIXTURE_GAPDH = {
  symbol: 'GAPDH',
  ensembl: 'ENSG00000111640',
  hasDetail: true,
  support: {
    EC: { datasets: 20, donors: 60, cells: 55 },
    SWM: { datasets: 20, donors: 60, cells: 30 },
    CB: { datasets: 20, donors: 60, cells: 15 },
  },
  donor_balanced: {
    regions: {
      mean: { EC: 4.2, SWM: 2.4, CB: 1.7 },
      detection: { EC: 0.95, SWM: 0.9, CB: 0.85 },
    },
  },
  cell_weighted: {
    regions: {
      mean: { EC: 4.0, SWM: 2.2, CB: 1.6 },
      detection: { EC: 0.94, SWM: 0.89, CB: 0.84 },
    },
  },
};

const FIXTURE_GAPDH_DETAIL = {
  symbol: 'GAPDH',
  donor_balanced: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 3.8, detection: 0.9, cells: 30 },
        Microglia: { mean: 1.9, detection: 0.7, cells: 10 },
        Oligodendrocyte: { mean: 7.6, detection: 0.95, cells: 15 },
      },
      SWM: { Astrocyte: { mean: 2.2, detection: 0.8, cells: 20 } },
      CB: { Astrocyte: { mean: 1.5, detection: 0.75, cells: 10 } },
    },
  },
  cell_weighted: {
    cellTypes: {
      EC: {
        Astrocyte: { mean: 3.6, detection: 0.88, cells: 30 },
        Microglia: { mean: 1.8, detection: 0.68, cells: 10 },
        Oligodendrocyte: { mean: 7.2, detection: 0.93, cells: 15 },
      },
      SWM: { Astrocyte: { mean: 2.0, detection: 0.78, cells: 20 } },
      CB: { Astrocyte: { mean: 1.4, detection: 0.73, cells: 10 } },
    },
  },
};

// A second gene with a cell-class tier, so a block can contain one gene that was measured
// in that class and one that was not. That pairing is the only place the "missing is not
// zero" invariant is visible inside a block rather than by the block's absence.
const FIXTURE_AQP4 = {
  symbol: 'AQP4',
  ensembl: 'ENSG00000171885',
  hasDetail: true,
  support: { EC: { datasets: 8, donors: 20, cells: 25 } },
  donor_balanced: { regions: { mean: { EC: 0.8 }, detection: { EC: 0.4 } } },
  cell_weighted: { regions: { mean: { EC: 0.7 }, detection: { EC: 0.35 } } },
};

const FIXTURE_AQP4_DETAIL = {
  symbol: 'AQP4',
  donor_balanced: {
    // Astrocytes only: EC's microglial block therefore has a GFAP bar and an AQP4 gap.
    cellTypes: { EC: { Astrocyte: { mean: 0.8, detection: 0.4, cells: 25 } } },
  },
  cell_weighted: {
    cellTypes: { EC: { Astrocyte: { mean: 0.7, detection: 0.35, cells: 25 } } },
  },
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
  densityScale: {
    cell_weighted: { mean: SCALE, detection: { ...SCALE, reference: 1 } },
    donor_balanced: { mean: { ...SCALE, reference: 2.9077 }, detection: { ...SCALE, reference: 1 } },
  },
  // GAPDH is listed so the control picker has a second offerable gene; RAB7A is
  // deliberately absent so the "this build does not ship it" path is exercised.
  genes: {
    GFAP: 'genes/GFAP.json',
    SNAP25: 'genes/SNAP25.json',
    AQP4: 'genes/AQP4.json',
    ACTB: 'genes/ACTB.json',
    GAPDH: 'genes/GAPDH.json',
  },
  detailGenes: ['GFAP', 'AQP4', 'GAPDH'],
};

const CATALOGUE = [
  { acronym: 'EC', name: 'entorhinal cortex', group: 'Cerebral cortex', hasAnatomy: true },
  { acronym: 'SWM', name: 'superficial white matter', group: 'Other subcortical', hasAnatomy: true },
  // Compound, like a third of the real catalogue. Nothing carries it unless a test
  // ingests a payload that does, which is how the axis-label arithmetic gets a long word
  // to reckon with.
  { acronym: 'CA1C CA2C CA3C', name: 'caudal CA1 to CA3', group: 'Hippocampus', hasAnatomy: true },
];

const FILES = {
  'genes/GFAP.json': FIXTURE_GFAP,
  'genes/GFAP.detail.json': FIXTURE_GFAP_DETAIL,
  'genes/SNAP25.json': FIXTURE_SNAP25,
  'genes/AQP4.json': FIXTURE_AQP4,
  'genes/AQP4.detail.json': FIXTURE_AQP4_DETAIL,
  'genes/ACTB.json': FIXTURE_ACTB,
  'genes/GAPDH.json': FIXTURE_GAPDH,
  'genes/GAPDH.detail.json': FIXTURE_GAPDH_DETAIL,
  'index.json': FIXTURE_INDEX,
};

function runIn(context, file) {
  vm.runInContext(fs.readFileSync(path.join(WEB_DIR, file), 'utf8'), context, {
    filename: file,
  });
}

function stubAtlas() {
  const calls = [];
  return {
    calls,
    cellTypeColour(cellType) {
      return { Astrocyte: '#f3c86f', Microglia: '#ef8e70' }[cellType] || '#9fb4bb';
    },
    regionCatalogue() {
      return CATALOGUE.map((region) => ({ ...region }));
    },
    selectRegion(acronym) {
      calls.push({ kind: 'selectRegion', acronym });
      return true;
    },
    applyGeneValues() {
      return { layer: 'genes' };
    },
    clearGeneValues() {
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
  const context = dom.getInternalVMContext();

  const requests = [];
  window.fetch = (url) => {
    requests.push(url);
    const key = Object.keys(FILES)
      .filter((name) => String(url).endsWith(name))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(FILES[key]) });
  };

  runIn(context, 'gene-atlas-data.js');
  const data = window.GeneAtlasData;
  data.reset();
  data.ingestIndex(FIXTURE_INDEX);
  data.setRule('donor_balanced');
  data.ingestGene(FIXTURE_GFAP);
  data.ingestGeneDetail(FIXTURE_GFAP_DETAIL);
  data.ingestGene(FIXTURE_SNAP25);
  data.ingestGene(FIXTURE_AQP4);
  data.ingestGeneDetail(FIXTURE_AQP4_DETAIL);
  if (settings.preloadControl !== false) data.ingestGene(FIXTURE_ACTB);

  runIn(context, 'gene-compare-view.js');
  assert.ok(window.GeneCompareView, 'gene-compare-view.js should expose GeneCompareView');

  const atlas = stubAtlas();
  const compare = window.GeneCompareView.init({
    document: window.document,
    window,
    data,
    atlas,
  });
  assert.ok(compare, 'the panels should initialise against the real markup');
  // The panels only exist inside the gene layer, so every test starts there.
  compare.setLayer('genes');
  return { window, document: window.document, data, atlas, compare, requests };
}

// One selection snapshot, in the shape gene-atlas-view.js pushes.
function selection(symbols, extra) {
  const colours = { GFAP: '#4cc9f0', SNAP25: '#f7b267', AQP4: '#b5e48c' };
  return Object.assign(
    {
      genes: symbols.map((symbol) => ({ symbol, colour: colours[symbol] || '#b5e48c' })),
      active: symbols[symbols.length - 1] || null,
      filter: null,
    },
    extra || {},
  );
}

function groups(document) {
  return [...document.querySelectorAll('#geneRegionCompareTrack [data-region]')].map(
    (node) => node.dataset.region,
  );
}

function barsIn(document, acronym) {
  const group = document.querySelector(
    `#geneRegionCompareTrack [data-region="${acronym}"]`,
  );
  if (!group) return null;
  return [...group.querySelectorAll('[data-series]')].map((node) => ({
    series: node.dataset.series,
    control: Object.prototype.hasOwnProperty.call(node.dataset, 'control'),
    missing: node.classList.contains('missing'),
    colour: node.style.getPropertyValue('--series-colour').trim(),
    height: node.querySelector('i') ? node.querySelector('i').style.height : null,
  }));
}

// The figures are in the readout, not on the bars, so reading one means hovering it.
function hoverGroup(window, acronym) {
  const document = window.document;
  const group = document.querySelector(
    `#geneRegionCompareTrack [data-region="${acronym}"]`,
  );
  assert.ok(group, `there should be a group for ${acronym} to hover`);
  group.dispatchEvent(
    new window.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 200 }),
  );
  const tip = document.getElementById('geneRegionCompareTip');
  return {
    hidden: tip.hidden,
    head: tip.querySelector('.gene-compare-tip-head').textContent,
    scope: tip.querySelector('.gene-compare-tip-scope').textContent,
    foot: tip.querySelector('.gene-compare-tip-foot').textContent,
    rows: [...tip.querySelectorAll('.gene-compare-tip-row')].map((row) => ({
      series: row.dataset.series,
      control: Object.prototype.hasOwnProperty.call(row.dataset, 'control'),
      missing: row.classList.contains('missing'),
      value: row.querySelector('strong').textContent,
      colour: row.querySelector('i').style.getPropertyValue('--series-colour').trim(),
    })),
  };
}

// Both pickers build their lists only while open, so a test that inspects one has to
// open it the way a reader would.
function openPicker(document, which) {
  const id = which === 'regions' ? 'geneRegionPickerToggle' : 'geneControlPickerToggle';
  document.getElementById(id).click();
}

function classBlocks(document) {
  return [...document.querySelectorAll('#geneClassCompareGrid [data-cell-type]')].map(
    (node) => node.dataset.cellType,
  );
}

function classRows(document, cellType) {
  const block = document.querySelector(
    `#geneClassCompareGrid [data-cell-type="${cellType}"]`,
  );
  if (!block) return null;
  return [...block.querySelectorAll('[data-series]')].map((node) => ({
    series: node.dataset.series,
    control: Object.prototype.hasOwnProperty.call(node.dataset, 'control'),
    missing: node.classList.contains("missing"),
    value: node.querySelector('strong').textContent,
    width: node.querySelector('i') ? node.querySelector('i').style.width : null,
  }));
}

// The panels belong to the gene layer. Leaving it must hide them rather than leave a
// stale chart under a map that is no longer showing genes.
function testThePanelsOnlyExistInTheGeneLayer() {
  const { document, compare } = boot();
  const root = document.getElementById('geneCompare');
  assert.equal(root.hidden, false, 'the gene layer shows them');

  compare.setLayer('cells');
  assert.equal(root.hidden, true, 'leaving the layer hides them');

  compare.setLayer('genes');
  assert.equal(root.hidden, false, 'and returning brings them back');
}

// Default: every region the selection carries that the atlas can place. CB carries data
// but has no parcel, so it is off the axis until asked for -- putting a whole lobe beside
// one of its own areas on a shared scale is not a comparison.
function testDefaultAxisIsEveryMappedRegionWithData() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));

  assert.deepEqual(groups(document), ['EC', 'SWM'], 'sorted by the active gene, highest first');
  const caption = document.getElementById('geneRegionCompareCaption').textContent;
  assert.match(caption, /2 of 3 regions with data/, 'the caption counts what is hidden');
  assert.match(caption, /1 coarse labels off the axis/);
  assert.match(caption, /mean expression, donor-balanced/, 'and names the numbers');
}

function testCoarseLabelsCanBeBroughtOntoTheAxis() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setIncludeUnmapped(true);

  assert.deepEqual(groups(document), ['EC', 'CB', 'SWM'], 'CB joins, in value order');
  const label = document.querySelector('#geneRegionCompareTrack [data-region="CB"]');
  assert.ok(label.classList.contains('unmapped'), 'and is marked as unplaceable');
  assert.equal(
    label.querySelector('button[data-select-region]'),
    null,
    'a region the atlas cannot place must not offer to show it in 3D',
  );
}

// The invariant the whole layer rests on. SNAP25 has no value in SWM; that bar must be
// absent and marked, never a zero-height bar reading as "measured, silent".
function testARegionWithoutDataIsMarkedNotZeroed() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));

  const swm = barsIn(document, 'SWM');
  const snap = swm.find((bar) => bar.series === 'SNAP25');
  assert.equal(snap.missing, true, 'the missing bar is marked');
  assert.equal(snap.height, null, 'and has no fill at all');
  const gfap = swm.find((bar) => bar.series === 'GFAP');
  assert.equal(gfap.missing, false, 'while the measured one is drawn');
}

// Shared scale is the honest default: one maximum, so bar heights are comparable across
// genes. GFAP's 1.2 against ACTB's 4.0 is 30%.
function testSharedScaleMeasuresEveryGeneAgainstOneMaximum() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setControls(['ACTB']);

  const ec = barsIn(document, 'EC');
  assert.equal(ec.find((bar) => bar.series === 'ACTB').height, '100%', 'the control is the peak');
  assert.equal(ec.find((bar) => bar.series === 'GFAP').height, '30%', '1.2 of 4.0');
}

// With a control four times the level of the gene, a shared scale squashes the gene.
// Per-gene scaling is the way back to a readable shape, and the caption has to say so
// because the bars no longer share a unit.
function testPerGeneScaleMeasuresEachSeriesAgainstItsOwnPeak() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setControls(['ACTB']);
  compare.setScale('series');

  const ec = barsIn(document, 'EC');
  assert.equal(ec.find((bar) => bar.series === 'GFAP').height, '100%', 'GFAP peaks in EC');
  assert.equal(ec.find((bar) => bar.series === 'ACTB').height, '100%', 'so does ACTB');
  const swm = barsIn(document, 'SWM');
  assert.equal(swm.find((bar) => bar.series === 'GFAP').height, '33.3%', '0.4 of GFAP\u2019s own 1.2');
  assert.match(
    document.getElementById('geneRegionCompareCaption').textContent,
    /each gene against its own peak/,
  );
  assert.equal(
    document.querySelector('#geneRegionCompareAxis [data-tick="1"]').textContent,
    '100%',
    'the axis switches to a share, because there is no single unit left to label',
  );
}

function testTheAxisLabelsTheSharedMaximumInMetricUnits() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));

  const ticks = [...document.querySelectorAll('#geneRegionCompareAxis [data-tick]')].map(
    (node) => node.textContent,
  );
  // Exact zero reads as "0", not "0.00": two decimals is for levels, and a padded zero
  // on an axis invites the reader to look for precision that is not there.
  assert.deepEqual(ticks, ['1.20', '0.90', '0.60', '0.30', '0'], 'GFAP peaks at 1.20');
  assert.equal(
    document.querySelector('#geneRegionCompareAxis .gene-compare-axis-unit').textContent,
    'mean expression',
  );
}

// A control is a yardstick. It must never widen the axis, or asking "how does this
// compare to ACTB" would silently change which regions are being compared.
function testAControlDoesNotAddRegionsToTheAxis() {
  const { document, compare } = boot();
  compare.render(selection(['SNAP25']));
  assert.deepEqual(groups(document), ['EC'], 'SNAP25 only carries EC');

  compare.setControls(['ACTB']);
  assert.deepEqual(groups(document), ['EC'], 'ACTB carries SWM too, but does not bring it along');
  const ec = barsIn(document, 'EC');
  assert.deepEqual(ec.map((bar) => bar.series), ['SNAP25', 'ACTB'], 'it is drawn, after the selection');
  assert.equal(ec.find((bar) => bar.series === 'ACTB').control, true, 'and marked as a control');
}

function testControlsAreLoadedOnDemandAndRedrawWhenTheyLand() {
  const { document, compare, requests } = boot({ preloadControl: false });
  compare.render(selection(['GFAP']));

  return compare.setControls(['ACTB']).then(() => {
    assert.ok(
      requests.some((url) => String(url).endsWith('genes/ACTB.json')),
      'a control not in the payload cache is fetched',
    );
    const ec = barsIn(document, 'EC');
    assert.equal(ec.find((bar) => bar.series === 'ACTB').height, '100%',
      'and the panel is redrawn once it lands');
  });
}

// The picker offers exactly what the build ships. RAB7A is in the curated list but absent
// from this index, so offering it could only produce a 404 with nothing to explain it.
function testTheControlPickerOnlyOffersGenesThisBuildShips() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  openPicker(document, 'controls');

  const offered = [...document.querySelectorAll('#geneControlPickerList [data-control-box]')].map(
    (node) => node.dataset.controlBox,
  );
  assert.deepEqual(offered, ['ACTB', 'GAPDH'], 'only the two the index lists');
  const families = [...document.querySelectorAll('#geneControlPickerList .gene-compare-picker-family')]
    .map((node) => node.textContent);
  assert.deepEqual(families, ['Classic controls'], 'grouped by family, empty families omitted');
}

// The atlas owns the selection. Clicking a bar's label asks it to select, and the
// highlight follows from the announcement, not from a second copy of the state here.
function testClickingARegionAsksTheAtlasToSelectIt() {
  const { document, atlas, compare } = boot();
  compare.render(selection(['GFAP']));

  document.querySelector('[data-select-region="SWM"]').click();
  assert.deepEqual(atlas.last(), { kind: 'selectRegion', acronym: 'SWM' });
}

function testTheSelectedRegionIsHighlightedOnTheAxis() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  assert.equal(document.querySelector('.gene-compare-group.selected'), null);

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'SWM', name: 'superficial white matter', isGroup: false, members: ['SWM'] },
    }),
  );
  const highlighted = [...document.querySelectorAll('.gene-compare-group.selected')].map(
    (node) => node.dataset.region,
  );
  assert.deepEqual(highlighted, ['SWM'], 'highlighted in place, not filtered to');
  assert.deepEqual(groups(document), ['EC', 'SWM'],
    'the region keeps its place in the distribution');
}

// Selecting a group in the atlas stands for its members, so all of them light up.
function testAGroupSelectionHighlightsEveryMember() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: null, name: 'Cerebral cortex', isGroup: true, members: ['EC', 'SWM'] },
    }),
  );
  const highlighted = [...document.querySelectorAll('.gene-compare-group.selected')].map(
    (node) => node.dataset.region,
  );
  assert.deepEqual(highlighted, ['EC', 'SWM']);
  // A group has no per-class breakdown of its own, so the class panel stays whole-brain.
  assert.match(document.getElementById('geneClassCompareTitle').textContent, /whole brain/);
}

function testSortingByAcronymAndByGroup() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setIncludeUnmapped(true);

  compare.setSort('name');
  assert.deepEqual(groups(document), ['CB', 'EC', 'SWM']);

  compare.setSort('group');
  // Cerebral cortex, then the coarse-label bucket, then Other subcortical.
  assert.deepEqual(groups(document), ['EC', 'CB', 'SWM']);
}

// Sorting has to put regions the active gene does not carry last: they have nothing to
// rank on, and sorting them as zero would assert a measurement.
function testRegionsWithoutAnActiveValueSortLast() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));

  assert.deepEqual(groups(document), ['EC', 'SWM'],
    'SNAP25 is active and carries only EC, so SWM goes last on name order');
  const swm = barsIn(document, 'SWM');
  assert.equal(swm.find((bar) => bar.series === 'SNAP25').missing, true);
}

function testTheRegionPickerNarrowsTheAxis() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  openPicker(document, 'regions');

  const box = document.querySelector('#geneRegionPickerList [data-region-box="EC"]');
  box.checked = false;
  box.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.deepEqual(groups(document), ['SWM'], 'unticking a region drops it');
  assert.deepEqual(compare.selectedRegions(), ['SWM']);
}

// The convenience the picker exists for: 163 regions become nine groups, and one click
// takes or drops a whole one.
function testAGroupHeaderTakesTheWholeGroup() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  openPicker(document, 'regions');

  document.querySelector('[data-region-group="Cerebral cortex"]').click();
  assert.deepEqual(compare.selectedRegions(), ['SWM'], 'a full group toggles off');

  document.querySelector('[data-region-group="Cerebral cortex"]').click();
  assert.equal(compare.selectedRegions(), null, 'and back to every region, not a set of all');
}

function testTheRegionPickerFiltersByAcronymNameAndGroup() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  openPicker(document, 'regions');

  const search = document.getElementById('geneRegionPickerSearch');
  search.value = 'entorhinal';
  search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  let offered = [...document.querySelectorAll('#geneRegionPickerList [data-region-box]')].map(
    (node) => node.dataset.regionBox,
  );
  assert.deepEqual(offered, ['EC'], 'the name matches even though the acronym does not');
  assert.deepEqual(groups(document), ['EC', 'SWM'],
    'filtering the picker must not filter the chart');

  // The group is part of how a region is found: the real catalogue spells several
  // structures differently from the way anyone types them, and the familiar word is
  // usually the group's.
  search.value = 'subcortical';
  search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  offered = [...document.querySelectorAll('#geneRegionPickerList [data-region-box]')].map(
    (node) => node.dataset.regionBox,
  );
  assert.deepEqual(offered, ['SWM'], 'matched on its group name alone');
}

// A value too small for two decimals still gets a visible floor bar, so it must not be
// printed as a zero beside it.
function testAValueBelowThePrintedPrecisionSaysSoRatherThanRoundingToZero() {
  const { window, document, compare, data } = boot();
  data.ingestGene({
    symbol: 'TRACE',
    hasDetail: false,
    support: { EC: { datasets: 1, donors: 1, cells: 5 } },
    donor_balanced: { regions: { mean: { EC: 0.0004 }, detection: { EC: 0.0004 } } },
    cell_weighted: { regions: { mean: { EC: 0.0004 }, detection: { EC: 0.0004 } } },
  });
  compare.render({
    genes: [{ symbol: 'GFAP', colour: '#4cc9f0' }, { symbol: 'TRACE', colour: '#f7b267' }],
    active: 'GFAP',
    filter: null,
  });
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  const bar = barsIn(document, 'EC').find((entry) => entry.series === 'TRACE');
  assert.equal(bar.missing, false, 'it was measured, so it is drawn');
  assert.equal(bar.height, '2%', 'at the floor, or it would be invisible and read as absent');
  const row = hoverGroup(window, 'EC').rows.find((entry) => entry.series === 'TRACE');
  assert.match(row.value, /<0\.01/,
    'and the figure says it is below the printed precision rather than \u201c0.00\u201d');
}

// A closed picker is not built at all -- it is a third of the panel's nodes and would be
// rebuilt on every metric, rule and class change for nothing. The badge on the toggle is
// what has to stay current, because it is the only thing saying the axis was narrowed.
function testAClosedPickerIsNotBuiltButItsBadgeStaysCurrent() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));

  assert.equal(document.getElementById('geneRegionPickerPanel').hidden, true);
  assert.equal(
    document.querySelectorAll('#geneRegionPickerList [data-region-box]').length,
    0,
    'nothing is built while it is closed',
  );
  assert.equal(document.getElementById('geneRegionPickerCount').textContent, 'all');

  compare.setRegions(['SWM']);
  assert.equal(document.getElementById('geneRegionPickerCount').textContent, '1',
    'the badge follows the axis even with the list unbuilt');

  openPicker(document, 'regions');
  assert.equal(
    document.querySelectorAll('#geneRegionPickerList [data-region-box]').length,
    2,
    'opening builds it, from the full candidate set rather than the narrowed one',
  );
}

function testThePresetsResetAndCapTheAxis() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));

  document.querySelector('[data-region-preset="none"]').click();
  assert.deepEqual(compare.selectedRegions(), []);
  assert.equal(document.getElementById('geneRegionCompareEmpty').hidden, false,
    'an empty axis says why it is empty');

  document.querySelector('[data-region-preset="all"]').click();
  assert.equal(compare.selectedRegions(), null, 'all with data is the default, not a set');
  assert.deepEqual(groups(document), ['EC', 'SWM']);

  // "Top 20" offers the strongest regions in the build, so it has to reach past a
  // narrowing: ranking only the one region left on the axis would return that region
  // and look like the preset did nothing.
  compare.setRegions(['SWM']);
  assert.deepEqual(groups(document), ['SWM'], 'narrowed first');
  document.querySelector('[data-region-preset="top"]').click();
  assert.deepEqual(groups(document), ['EC', 'SWM'],
    'the preset re-reads every region with data, ordered by value');
}

// ---- axis labels and readout ----

// A group is only as wide as its bars, so the room for an upright label is bought by the
// number of genes on screen. The whole axis switches together: two reading directions on
// one axis is worse than one inconvenient direction.
function testTheAxisTurnsItsLabelsUprightOnceTheGroupsAreWideEnough() {
  const { document, compare, data } = boot();
  const track = document.getElementById('geneRegionCompareTrack');

  // One 6px bar against "SWM", the longest word here at about 14px.
  compare.render(selection(['GFAP']));
  assert.equal(track.dataset.labels, 'vertical', 'nothing fits beside a single bar');

  // Two bars is 14px, which is the width of that word.
  compare.render(selection(['GFAP', 'SNAP25']));
  assert.equal(track.dataset.labels, 'horizontal', 'two bars buy the room for it');

  // Now put a compound acronym on the axis. Its longest *word* is "CA1C", wider than two
  // bars, so the axis lies back down -- and it is the word that decides, not the label:
  // the label itself is 14 characters and would never fit any group, but it wraps at its
  // spaces once its words do.
  data.ingestGene({
    symbol: 'LONG',
    hasDetail: false,
    support: { 'CA1C CA2C CA3C': { datasets: 2, donors: 4, cells: 9 } },
    donor_balanced: { regions: { mean: { 'CA1C CA2C CA3C': 0.9 }, detection: { 'CA1C CA2C CA3C': 0.4 } } },
    cell_weighted: { regions: { mean: { 'CA1C CA2C CA3C': 0.8 }, detection: { 'CA1C CA2C CA3C': 0.3 } } },
  });
  compare.render(selection(['GFAP', 'LONG']));
  assert.ok(groups(document).indexOf('CA1C CA2C CA3C') !== -1, 'the long label is on the axis');
  assert.equal(track.dataset.labels, 'vertical', '"CA1C" is wider than two bars');

  compare.render(selection(['GFAP', 'LONG', 'AQP4']));
  assert.equal(track.dataset.labels, 'horizontal', 'three bars hold it, wrapped at the spaces');

  // Controls are bars in the same group, so they buy the same room.
  compare.render(selection(['GFAP', 'LONG']));
  compare.setControls(['ACTB']);
  assert.equal(track.dataset.labels, 'horizontal', 'a control widens the group too');
}

// Six pixels of bar has nowhere to print a number, so hovering a group is how the figures
// are read. It has to describe that group and no other, name what is missing rather than
// leaving a gap, and keep the control visibly a control.
function testHoveringAGroupReadsOutThatRegionsFigures() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));
  compare.setControls(['ACTB']);

  const tip = document.getElementById('geneRegionCompareTip');
  assert.equal(tip.hidden, true, 'nothing is hovered yet');

  const readout = hoverGroup(window, 'EC');
  assert.equal(readout.hidden, false);
  assert.match(readout.head, /EC/);
  assert.match(readout.head, /entorhinal cortex/, 'the full name, which the axis cannot fit');
  assert.equal(readout.scope, 'Cerebral cortex');
  assert.deepEqual(
    readout.rows.map((row) => `${row.series}=${row.value}`),
    ['GFAP=1.20', 'SNAP25=0.60', 'ACTB=4.00'],
    'every series in the group, in draw order, at its own value',
  );
  assert.deepEqual(readout.rows.map((row) => row.control), [false, false, true],
    'and the control is still marked as one');
  assert.match(readout.foot, /5 datasets/,
    'evidence for the active gene, which is SNAP25 here');
  // SNAP25 has no evidence entry for SWM. The footer names the unit instead of borrowing
  // GFAP's counts, which would attribute one gene's sampling to another.
  assert.match(hoverGroup(window, 'SWM').foot, /mean expression/);

  // SWM carries GFAP but not SNAP25. The row stays and says so: an absent row would read
  // as a gene that was never selected.
  const swm = hoverGroup(window, 'SWM');
  const snap = swm.rows.find((row) => row.series === 'SNAP25');
  assert.equal(snap.missing, true);
  assert.equal(snap.value, 'not measured');
  assert.equal(swm.rows.find((row) => row.series === 'GFAP').value, '0.40',
    'the readout followed the group under the pointer');

  document.getElementById('geneRegionCompareTrack').dispatchEvent(
    new window.MouseEvent('mouseleave', { bubbles: false }),
  );
  assert.equal(tip.hidden, true, 'and it closes when the pointer leaves the axis');
}

// A shelf of identically grey hatched bars is unreadable the moment there are two of
// them, and the tint has to belong to the gene rather than to its position, so it does not
// move when another control is added or dropped.
async function testEachControlCarriesItsOwnTint() {
  const { window, document, compare } = boot();
  const declared = window.GeneCompareView.CONTROL_GENES;
  const tintOf = (symbol) =>
    declared.find((control) => control.symbol === symbol).tint.toLowerCase();

  compare.render(selection(['GFAP']));
  await compare.setControls(['ACTB', 'GAPDH']);

  let bars = barsIn(document, 'EC');
  const actb = bars.find((bar) => bar.series === 'ACTB');
  const gapdh = bars.find((bar) => bar.series === 'GAPDH');
  assert.notEqual(actb.colour.toLowerCase(), gapdh.colour.toLowerCase(),
    'two controls must not be the same colour');
  assert.equal(actb.colour.toLowerCase(), tintOf('ACTB'));
  assert.equal(gapdh.colour.toLowerCase(), tintOf('GAPDH'));
  const gfap = bars.find((bar) => bar.series === 'GFAP');
  assert.notEqual(gfap.colour.toLowerCase(), actb.colour.toLowerCase(),
    'and neither is the colour of a selected gene');

  // Drop the first one: the second keeps its own tint instead of sliding into the freed
  // slot, which is what a position-based palette would do.
  await compare.setControls(['GAPDH']);
  bars = barsIn(document, 'EC');
  assert.equal(
    bars.find((bar) => bar.series === 'GAPDH').colour.toLowerCase(),
    tintOf('GAPDH'),
  );

  // The key says the same thing, so the axis and its legend cannot disagree.
  const swatch = document.querySelector(
    '#geneCompareKey [data-series="GAPDH"][data-control] i',
  );
  assert.equal(swatch.style.getPropertyValue('--series-colour').trim().toLowerCase(),
    tintOf('GAPDH'));
}

// ---- class panel ----

function testTheClassPanelShowsWholeBrainUntilARegionIsSelected() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));

  assert.match(document.getElementById('geneClassCompareTitle').textContent, /whole brain/);
  assert.deepEqual(classBlocks(document), ['Astrocyte', 'Microglia'],
    'ordered by the active gene, and only classes with data');
  // Donor-balanced across the three regions GFAP covers: (1.9 + 0.4 + 0.9) / 3 = 1.07.
  assert.equal(classRows(document, 'Astrocyte')[0].value, '1.07');
}

function testTheClassPanelFollowsTheSelectedRegion() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));

  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );
  assert.match(document.getElementById('geneClassCompareTitle').textContent, /EC$/);
  assert.match(document.getElementById('geneClassCompareCaption').textContent, /entorhinal cortex/);
  const astro = classRows(document, 'Astrocyte');
  assert.equal(astro[0].value, '1.90', 'the region figure, not the whole-brain one');
  assert.equal(astro[0].width, '100%', 'and it is the tallest thing on the shared scale');
  assert.equal(classRows(document, 'Microglia')[0].value, '0.40');
}

// A gene with no cell-class tier cannot be broken down. Saying so once beats a column of
// gaps the reader has to interpret.
function testAGeneWithoutADetailTierIsNamedNotSilentlyDropped() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));

  const rows = classRows(document, 'Astrocyte');
  assert.deepEqual(rows.map((row) => row.series), ['GFAP'],
    'only the gene that has a breakdown gets a bar');
  const note = document.getElementById('geneClassCompareNote');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /SNAP25 ships region-level values only/);
}

// The honest treatment of a control in this panel: no build ships a cell-class tier for
// housekeeping genes, so it appears once, as an all-classes reference, and the note says
// exactly that rather than letting it pass as a per-class value.
function testAControlAppearsAsAnExplicitAllClassesReference() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setControls(['ACTB']);
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  const rows = classRows(document, 'Astrocyte');
  const control = rows.find((row) => row.series === 'ACTB');
  assert.equal(control.control, true, 'marked as a control');
  assert.equal(control.value, '4.00', "EC's all-classes ACTB level");
  assert.ok(
    document.querySelector('#geneClassCompareGrid .gene-compare-class-reference'),
    'and sits under a heading naming the aggregation it belongs to',
  );
  assert.match(
    document.getElementById('geneClassCompareNote').textContent,
    /ACTB carries no cell-type tier, so it is drawn as one all-types reference for EC/,
  );
}

// The class panel shares one scale, so a reference taller than every bar has to take
// part in the maximum or it would be clipped and read as equal to the tallest bar.
function testTheReferenceTakesPartInTheSharedMaximum() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setControls(['ACTB']);
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  const rows = classRows(document, 'Astrocyte');
  assert.equal(rows.find((row) => row.series === 'ACTB').width, '100%', 'ACTB at 4.00 is the peak');
  assert.equal(rows.find((row) => row.series === 'GFAP').width, '47.5%', '1.9 of 4.00');
}

// The point of a baseline in this dataset: astrocyte, microglial and OPC nuclei carry fewer
// counts than neurons, so a control sits lower in those classes for reasons that have
// nothing to do with the gene being looked at. One brain-wide line cannot show that, and a
// reader comparing a gene's astrocyte bar against a whole-brain control would be reading
// the depth difference as biology.
async function testAControlWithAClassTierIsReadPerClass() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  await compare.setControls(['GAPDH']);
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  const astrocyte = classRows(document, 'Astrocyte');
  const microglia = classRows(document, 'Microglia');
  assert.equal(astrocyte.find((row) => row.series === 'GAPDH').value, '3.80');
  assert.equal(microglia.find((row) => row.series === 'GAPDH').value, '1.90',
    'the same control, half the level: that is the class its own floor, not the gene moving');
  assert.equal(
    document.querySelector('#geneClassCompareGrid .gene-compare-class-reference').textContent,
    'Baseline in this type',
    'and it is labelled as this type figure, not as an aggregate',
  );
  // GFAP 1.9 against the on-screen peak 3.8. If GAPDH's 7.6 in the oligodendrocyte class --
  // a class no selected gene carries -- had entered the maximum, this would read 25%.
  assert.equal(astrocyte.find((row) => row.series === 'GFAP').width, '50%');
  assert.doesNotMatch(
    document.getElementById('geneClassCompareNote').textContent,
    /no cell-type tier/,
    'the note must not claim a tier is missing once the build ships one',
  );
}

// A control is there to be compared against, not to widen the comparison -- the same rule
// the region axis follows.
async function testAControlDoesNotAddAClassBlock() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  await compare.setControls(['GAPDH']);
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  assert.ok(classRows(document, 'Astrocyte'), 'the classes GFAP carries are there');
  assert.equal(classRows(document, 'Oligodendrocyte'), null,
    'GAPDH is measured in that class, but the class list belongs to the selection');
}

// The counterpart of testAClassFilterMovesTheSelectionButNotTheControls: once the build
// does ship a class tier for the control, holding it at its all-classes value would mean
// measuring a filtered gene against a yardstick from a different population.
async function testAClassFilterAlsoMovesAControlThatShipsATier() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  await compare.setControls(['GAPDH']);

  compare.render(selection(['GFAP'], { filter: ['Astrocyte'] }));
  const ec = barsIn(document, 'EC');
  // Astrocytes only: GFAP 1.9 against GAPDH's astrocyte 3.8. Had the control stayed at its
  // all-classes 4.2, this would read 45.2%.
  assert.equal(ec.find((bar) => bar.series === 'GFAP').height, '50%');
  assert.equal(ec.find((bar) => bar.series === 'GAPDH').height, '100%');
  assert.match(
    document.getElementById('geneRegionCompareCaption').textContent,
    /selection restricted to 1 cell type; controls follow the same types/,
  );
}

function testAClassWithoutDataForAGeneIsMarkedNotZeroed() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP']));
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'SWM', name: 'superficial white matter', isGroup: false, members: ['SWM'] },
    }),
  );

  assert.deepEqual(classBlocks(document), ['Astrocyte'],
    'SWM has no microglial measurement, so there is no block claiming one');
}

// Inside a block, a gene that does have a class tier but was not measured in this class
// keeps its row and shows a dash. That gap is a finding -- AQP4 really is astrocytic here
// -- and a zero-length bar would instead assert a measured silence.
function testAMeasuredGapInsideABlockKeepsItsRow() {
  const { window, document, compare } = boot();
  compare.render(selection(['GFAP', 'AQP4']));
  window.dispatchEvent(
    new window.CustomEvent('digitalbrain-region-select', {
      detail: { acronym: 'EC', name: 'entorhinal cortex', isGroup: false, members: ['EC'] },
    }),
  );

  const microglia = classRows(document, 'Microglia');
  assert.deepEqual(microglia.map((row) => row.series), ['GFAP', 'AQP4'],
    'both genes have a tier, so both keep a row');
  const aqp4 = microglia.find((row) => row.series === 'AQP4');
  assert.equal(aqp4.missing, true);
  assert.equal(aqp4.value, '\u2014', 'a dash, not a zero');
  assert.equal(aqp4.width, null, 'and no bar at all');
}

// ---- metric, rule and the class filter ----

function testBothPanelsFollowTheMetric() {
  const { document, data, compare } = boot();
  compare.render(selection(['GFAP']));
  data.setMetric('detection');
  compare.render(selection(['GFAP']));

  const ticks = [...document.querySelectorAll('#geneRegionCompareAxis [data-tick]')].map(
    (node) => node.textContent,
  );
  assert.equal(ticks[0], '50%', 'a rate reads as a percentage');
  assert.match(document.getElementById('geneRegionCompareCaption').textContent, /detection rate/);
  // No region is selected, so this is the whole-brain figure: donor-balanced over the
  // three regions GFAP covers, (0.81 + 0.2 + 0.3) / 3 = 0.437.
  assert.equal(classRows(document, 'Astrocyte')[0].value, '44%');
}

// The panels sit under the map and must not disagree with it. A class filter recolours
// the map, so it has to move these numbers too -- but it cannot be applied to a control,
// which has no class tier to filter, and the caption says so.
function testAClassFilterMovesTheSelectionButNotTheControls() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP']));
  compare.setControls(['ACTB']);
  // Unfiltered, GFAP in EC is the all-classes 1.2 against ACTB's 4.0.
  assert.equal(barsIn(document, 'EC').find((bar) => bar.series === 'GFAP').height, '30%');

  compare.render(selection(['GFAP'], { filter: ['Astrocyte'] }));
  const ec = barsIn(document, 'EC');
  // Recomputed from the astrocyte row, 1.9, exactly as the map recolours: 1.9 of 4.0.
  assert.equal(ec.find((bar) => bar.series === 'GFAP').height, '47.5%',
    'the filter has to move these numbers, or the panel disagrees with the map above it');
  assert.equal(ec.find((bar) => bar.series === 'ACTB').height, '100%',
    'the control has no class tier to filter, so it stays where it was');
  assert.match(
    document.getElementById('geneRegionCompareCaption').textContent,
    /selection restricted to 1 cell type; controls stay all-types/,
  );
}

function testAnEmptyClassSelectionDrawsNothingRatherThanEverything() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP'], { filter: [] }));

  assert.deepEqual(groups(document), [], 'no class contributes, so no region has a value');
  assert.equal(document.getElementById('geneRegionCompareEmpty').hidden, false);
}

function testNoSelectionSaysWhatToDo() {
  const { document, compare } = boot();
  compare.render(selection([]));

  assert.equal(document.getElementById('geneRegionCompareEmpty').hidden, false);
  assert.match(
    document.getElementById('geneRegionCompareEmpty').textContent,
    /Search for a gene above/,
  );
  assert.equal(document.getElementById('geneClassCompareEmpty').hidden, false);
}

function testTheKeyNamesEverySeriesAndFlagsTheControls() {
  const { document, compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));
  compare.setControls(['ACTB']);

  const items = [...document.querySelectorAll('#geneCompareKey [data-series]')].map((node) => ({
    series: node.dataset.series,
    control: Object.prototype.hasOwnProperty.call(node.dataset, 'control'),
    text: node.textContent,
    active: node.classList.contains('active'),
  }));
  assert.deepEqual(items.map((item) => item.series), ['GFAP', 'SNAP25', 'ACTB']);
  assert.equal(items[1].active, true, 'the active gene is marked');
  assert.equal(items[2].control, true);
  assert.match(items[2].text, /ACTB \(control\)/);
}

// The row pushes its selection down; without that seam the panels would need a second
// copy of the chip list, which is exactly how the two drift apart.
function testTheGeneRowDrivesThePanels() {
  const html = fs
    .readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  window.fetch = () => Promise.resolve({ ok: false, status: 404 });

  runIn(context, 'gene-atlas-data.js');
  const data = window.GeneAtlasData;
  data.reset();
  data.ingestIndex(FIXTURE_INDEX);
  data.setRule('donor_balanced');
  data.ingestGene(FIXTURE_GFAP);
  data.ingestGeneDetail(FIXTURE_GFAP_DETAIL);

  runIn(context, 'gene-compare-view.js');
  runIn(context, 'gene-atlas-view.js');
  const atlas = stubAtlas();
  const view = window.GeneAtlasView.init({
    document: window.document,
    window,
    data,
    atlas,
  });
  assert.ok(view.compare, 'the row wires the panels when the module is present');
  view.compare.setLayer('genes');

  return view.addGene('GFAP').then(() => {
    assert.deepEqual(groups(window.document), ['EC', 'SWM'],
      'adding a chip fills the panels');
    const key = [...window.document.querySelectorAll('#geneCompareKey [data-series]')];
    assert.equal(key.length, 1);
    assert.equal(
      key[0].querySelector('i').style.getPropertyValue('--series-colour'),
      view.colourFor('GFAP'),
      'and the bars carry the chip colour, so the two cannot drift apart',
    );

    // Ticking a class updates the rows in place rather than re-rendering, so this is the
    // path where the panels could silently keep the unfiltered numbers.
    view.setCellTypes(['Astrocyte']);
    assert.match(
      window.document.getElementById('geneRegionCompareCaption').textContent,
      /selection restricted to 1 cell type/,
    );
  });
}

// The export carries the numbers on screen: the selected genes by exactly the
// regions the picker allows, in axis order, with missing left empty.
function testExportWritesTheOnScreenNumbers() {
  const { compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));
  const lines = compare.buildRegionCsv().trim().split('\n');
  assert.equal(lines[0], 'region_acronym,region_name,anatomical_group,GFAP,SNAP25');
  // donor_balanced mean, as booted: GFAP EC 1.2 / SWM 0.4, SNAP25 has EC only, and
  // the coarse CB label stays off the axis (and out of the file) by default.
  assert.deepEqual(lines.slice(1), [
    'EC,entorhinal cortex,Cerebral cortex,1.2,0.6',
    'SWM,superficial white matter,Other subcortical,0.4,',
  ]);
}

function testExportFollowsTheRegionPicker() {
  const { compare } = boot();
  compare.render(selection(['GFAP', 'SNAP25']));
  compare.setRegions(['SWM']);
  const lines = compare.buildRegionCsv().trim().split('\n');
  assert.deepEqual(lines.slice(1), [
    'SWM,superficial white matter,Other subcortical,0.4,',
  ], 'narrowing the picker narrows the export, not just the axis');
}

function testExportAvailabilityFollowsTheAxis() {
  const { compare, document, window } = boot();
  const button = document.getElementById('geneRegionExportBtn');
  compare.render(selection([]));
  assert.equal(compare.buildRegionCsv(), null, 'no genes means no file');
  assert.equal(button.disabled, true, 'and the button says so');

  compare.render(selection(['GFAP']));
  assert.equal(button.disabled, false, 'a drawable axis enables the export');

  const created = [];
  window.URL.createObjectURL = (blob) => { created.push(blob); return 'blob:mock'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {};
  const name = compare.exportRegionsCsv();
  assert.equal(name, 'gene-expression-regions-donor_balanced-mean.csv',
    'the download names its metric and rule');
  assert.equal(created.length, 1, 'exactly one blob is offered');
}

async function main() {
  const cases = [
    ['testThePanelsOnlyExistInTheGeneLayer', testThePanelsOnlyExistInTheGeneLayer],
    ['testDefaultAxisIsEveryMappedRegionWithData', testDefaultAxisIsEveryMappedRegionWithData],
    ['testCoarseLabelsCanBeBroughtOntoTheAxis', testCoarseLabelsCanBeBroughtOntoTheAxis],
    ['testARegionWithoutDataIsMarkedNotZeroed', testARegionWithoutDataIsMarkedNotZeroed],
    ['testSharedScaleMeasuresEveryGeneAgainstOneMaximum', testSharedScaleMeasuresEveryGeneAgainstOneMaximum],
    ['testPerGeneScaleMeasuresEachSeriesAgainstItsOwnPeak', testPerGeneScaleMeasuresEachSeriesAgainstItsOwnPeak],
    ['testTheAxisLabelsTheSharedMaximumInMetricUnits', testTheAxisLabelsTheSharedMaximumInMetricUnits],
    ['testAControlDoesNotAddRegionsToTheAxis', testAControlDoesNotAddRegionsToTheAxis],
    ['testControlsAreLoadedOnDemandAndRedrawWhenTheyLand', testControlsAreLoadedOnDemandAndRedrawWhenTheyLand],
    ['testTheControlPickerOnlyOffersGenesThisBuildShips', testTheControlPickerOnlyOffersGenesThisBuildShips],
    ['testClickingARegionAsksTheAtlasToSelectIt', testClickingARegionAsksTheAtlasToSelectIt],
    ['testTheSelectedRegionIsHighlightedOnTheAxis', testTheSelectedRegionIsHighlightedOnTheAxis],
    ['testAGroupSelectionHighlightsEveryMember', testAGroupSelectionHighlightsEveryMember],
    ['testSortingByAcronymAndByGroup', testSortingByAcronymAndByGroup],
    ['testRegionsWithoutAnActiveValueSortLast', testRegionsWithoutAnActiveValueSortLast],
    ['testTheRegionPickerNarrowsTheAxis', testTheRegionPickerNarrowsTheAxis],
    ['testAGroupHeaderTakesTheWholeGroup', testAGroupHeaderTakesTheWholeGroup],
    ['testTheRegionPickerFiltersByAcronymNameAndGroup', testTheRegionPickerFiltersByAcronymNameAndGroup],
    ['testAValueBelowThePrintedPrecisionSaysSoRatherThanRoundingToZero', testAValueBelowThePrintedPrecisionSaysSoRatherThanRoundingToZero],
    ['testAClosedPickerIsNotBuiltButItsBadgeStaysCurrent', testAClosedPickerIsNotBuiltButItsBadgeStaysCurrent],
    ['testThePresetsResetAndCapTheAxis', testThePresetsResetAndCapTheAxis],
    ['testTheAxisTurnsItsLabelsUprightOnceTheGroupsAreWideEnough', testTheAxisTurnsItsLabelsUprightOnceTheGroupsAreWideEnough],
    ['testHoveringAGroupReadsOutThatRegionsFigures', testHoveringAGroupReadsOutThatRegionsFigures],
    ['testEachControlCarriesItsOwnTint', testEachControlCarriesItsOwnTint],
    ['testTheClassPanelShowsWholeBrainUntilARegionIsSelected', testTheClassPanelShowsWholeBrainUntilARegionIsSelected],
    ['testTheClassPanelFollowsTheSelectedRegion', testTheClassPanelFollowsTheSelectedRegion],
    ['testAGeneWithoutADetailTierIsNamedNotSilentlyDropped', testAGeneWithoutADetailTierIsNamedNotSilentlyDropped],
    ['testAControlAppearsAsAnExplicitAllClassesReference', testAControlAppearsAsAnExplicitAllClassesReference],
    ['testTheReferenceTakesPartInTheSharedMaximum', testTheReferenceTakesPartInTheSharedMaximum],
    ['testAControlWithAClassTierIsReadPerClass', testAControlWithAClassTierIsReadPerClass],
    ['testAControlDoesNotAddAClassBlock', testAControlDoesNotAddAClassBlock],
    ['testAClassFilterAlsoMovesAControlThatShipsATier', testAClassFilterAlsoMovesAControlThatShipsATier],
    ['testAClassWithoutDataForAGeneIsMarkedNotZeroed', testAClassWithoutDataForAGeneIsMarkedNotZeroed],
    ['testAMeasuredGapInsideABlockKeepsItsRow', testAMeasuredGapInsideABlockKeepsItsRow],
    ['testBothPanelsFollowTheMetric', testBothPanelsFollowTheMetric],
    ['testAClassFilterMovesTheSelectionButNotTheControls', testAClassFilterMovesTheSelectionButNotTheControls],
    ['testAnEmptyClassSelectionDrawsNothingRatherThanEverything', testAnEmptyClassSelectionDrawsNothingRatherThanEverything],
    ['testNoSelectionSaysWhatToDo', testNoSelectionSaysWhatToDo],
    ['testTheKeyNamesEverySeriesAndFlagsTheControls', testTheKeyNamesEverySeriesAndFlagsTheControls],
    ['testTheGeneRowDrivesThePanels', testTheGeneRowDrivesThePanels],
    ['testExportWritesTheOnScreenNumbers', testExportWritesTheOnScreenNumbers],
    ['testExportFollowsTheRegionPicker', testExportFollowsTheRegionPicker],
    ['testExportAvailabilityFollowsTheAxis', testExportAvailabilityFollowsTheAxis],
  ];
  for (const [name, run] of cases) {
    await run();
    console.log(`PASS ${name}`);
  }
}

main();
