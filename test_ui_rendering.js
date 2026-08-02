const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WEB_DIR = __dirname;

function loadHtmlSkeleton() {
  const html = fs.readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8');
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

function runScript(dom, fileName) {
  const code = fs.readFileSync(path.join(WEB_DIR, fileName), 'utf8');
  vm.runInContext(code, dom.getInternalVMContext(), { filename: fileName });
}

function buildFixture() {
  return {
    'Collection-1': {
      name: 'DigitaiBrain-Data',
      datasets: {
        DatasetOne: {
          name: 'Dataset One',
          donors: {
            DonorA: {
              name: 'DonorA',
              age: ['adult'],
              gender: ['female'],
              status: [
                'Healthy Control',
                "Alzheimer's Disease",
                "Parkinson's Disease",
                'Glioblastoma (GBM)',
                'Multiple Sclerosis',
                'Autism Spectrum Disorder',
              ],
              cells: 60,
              cell_type_count: {
                Astrocyte: 12,
                Neuron: 9,
                OPC: 7,
                Microglia: 6,
                Oligodendrocyte: 5,
                Ependymal: 4,
                Endothelial: 4,
                Interneuron: 3,
                Pericyte: 3,
                Fibroblast: 3,
                Progenitor: 2,
                Immune: 2,
              },
              brod_count: { BA1: 2, BA2: 1, BA3: 1, BA4: 1 },
              gyral_count: { G1: 2, G2: 1, G3: 1, G4: 1, G5: 1 },
              brain_regions_brod: ['BA1', 'BA2', 'BA3', 'BA4', 'BA5', 'BA6'],
              brain_regions_gyral: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'],
            },
          },
        },
        DatasetTwo: {
          name: 'Dataset Two',
          donors: {
            DonorB: {
              name: 'DonorB',
              age: ['adult'],
              gender: ['male'],
              status: ['Parkinson\'s Disease'],
              cells: 4,
              cell_type_count: { OPC: 2, Neuron: 1, Microglia: 1 },
              brod_count: { BA7: 2, BA8: 2 },
              gyral_count: { G7: 2, G8: 2 },
              brain_regions_brod: ['BA7', 'BA8'],
              brain_regions_gyral: ['G7', 'G8'],
            },
          },
        },
      },
    },
  };
}

async function waitForDomReady(window) {
  if (window.document.readyState !== 'loading') {
    return;
  }

  await new Promise((resolve) => {
    window.document.addEventListener('DOMContentLoaded', () => {
      setTimeout(resolve, 0);
    }, { once: true });
  });
}

async function loadUiHarness() {
  const dom = new JSDOM(loadHtmlSkeleton(), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const { window } = dom;

  window.console = console;
  window.__chartConfigs = [];
  window.Chart = class ChartStub {
    constructor(ctx, config) {
      window.__chartConfigs.push({
        canvasId: ctx?.id || 'unknown',
        config,
      });
    }
    destroy() {}
  };
  window.currentData = buildFixture();
  window.currentRegionType = 'brodmann';
  window.currentCellView = 'chart';
  window.validateDataStructure = () => true;

  ['data-model.js', 'charts.js', 'ui.js', 'app.js'].forEach((fileName) => {
    runScript(dom, fileName);
  });

  await waitForDomReady(window);
  return window;
}

function latestChartConfig(window, canvasId) {
  const matches = window.__chartConfigs.filter((entry) => entry.canvasId === canvasId);
  return matches[matches.length - 1]?.config || null;
}

async function testHeaderCopy() {
  const html = fs.readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8');
  assert.match(html, /DigitalBrain Data Explorer/);
}

async function testOverviewSummaryIsCondensed() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', '', '');
  assert.match(
    window.document.getElementById('collectionOverviewTitle').textContent,
    /DigitalBrain Data/,
    'collection overview should use the normalized display name'
  );

  const statuses = window.document.querySelectorAll('#collectionStatuses .status-badge');
  assert.equal(statuses.length, 3, 'overview should show a condensed set of disease badges');
  assert.match(
    window.document.querySelector('#collectionStatuses .overview-toggle').textContent,
    /show \d+ more/i
  );

  const summaryText = window.document.getElementById('collectionRegionsSummary').textContent.replace(/\s+/g, ' ').trim();
  assert.match(summaryText, /show \d+ more/i, 'region summary should condense long region lists');
  assert.doesNotMatch(summaryText, /BA6/, 'collapsed region summary should hide the full Brodmann list');
  assert.doesNotMatch(summaryText, /G6/, 'collapsed region summary should hide the full gyral list');
}

async function testOverviewSummaryExpandsInline() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', '', '');

  const statusToggle = window.document.querySelector('#collectionStatuses .overview-toggle');
  assert.ok(statusToggle, 'status overflow should render as a toggle button');
  statusToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const expandedStatuses = window.document.querySelectorAll('#collectionStatuses .overview-expanded .status-badge');
  assert.equal(expandedStatuses.length, 6, 'expanding status overflow should reveal the full disease list');
  assert.match(
    window.document.querySelector('#collectionStatuses .overview-toggle').textContent,
    /hide details/i,
    'expanded status toggle should switch to a hide action'
  );

  const regionToggle = window.document.querySelector('#collectionRegionsSummary .overview-toggle');
  assert.ok(regionToggle, 'region overflow should render as a toggle button');
  regionToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const expandedRegionText = window.document
    .querySelector('#collectionRegionsSummary .overview-expanded')
    .textContent.replace(/\s+/g, ' ')
    .trim();
  assert.match(expandedRegionText, /BA1/);
  assert.match(expandedRegionText, /BA6/);
  assert.match(
    window.document.querySelector('#collectionRegionsSummary .overview-toggle').textContent,
    /hide details/i,
    'expanded region toggle should switch to a hide action'
  );
}

async function testCardsExposeModularDetails() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', '', '');

  const collectionText = window.document.getElementById('collectionOverview').textContent.replace(/\s+/g, ' ').trim();
  assert.match(collectionText, /Disease Snapshot/);
  assert.match(collectionText, /Region Snapshot/);
  assert.match(collectionText, /Top Brodmann/);

  window.updateView('Collection-1', 'DatasetOne', 'DonorA');
  const donorText = window.document.getElementById('donorDetails').textContent.replace(/\s+/g, ' ').trim();
  assert.match(donorText, /Clinical Snapshot/);
  assert.match(donorText, /Composition Highlights/);
  assert.match(donorText, /Top Cell Type/);
  assert.match(donorText, /Top Gyral Region/);
}

async function testChartModesAdaptToScope() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', '', '');

  assert.equal(window.document.getElementById('cellRangeTopBtn').textContent, 'Top 10');
  assert.equal(window.document.getElementById('cellRangeOtherBtn').textContent, 'Top 10 + Other');
  assert.equal(window.document.getElementById('cellRangeAllBtn').textContent, 'All');
  assert.match(window.document.getElementById('cellMetricSecondaryBtn').textContent, /Dataset Diversity/);
  assert.match(window.document.getElementById('cellMetricTertiaryBtn').textContent, /Dataset Comparison/);
  assert.match(window.document.getElementById('regionMetricSecondaryBtn').textContent, /Dataset Coverage/);

  window.document.getElementById('cellMetricTertiaryBtn')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.match(window.document.getElementById('cellTypeSubtitle').textContent, /dataset/i);
  const cellChartConfig = latestChartConfig(window, 'cellTypeChart');
  assert.ok(cellChartConfig, 'cell type chart should render after switching metric');
  assert.ok(
    cellChartConfig.data.datasets.length > 1,
    'collection comparison mode should render multiple datasets in the chart config'
  );

  window.updateView('Collection-1', 'DatasetOne', 'DonorA');
  assert.match(window.document.getElementById('cellTypeTitle').textContent, /Distribution/);
  assert.equal(window.document.getElementById('cellMetricPrimaryBtn').classList.contains('active'), true);
  assert.equal(window.document.getElementById('regionMetricPrimaryBtn').classList.contains('active'), true);
  assert.equal(window.document.getElementById('cellRangeTopBtn').classList.contains('active'), true);
  assert.equal(window.document.getElementById('regionRangeTopBtn').classList.contains('active'), true);
  assert.match(window.document.getElementById('cellMetricSecondaryBtn').textContent, /Balance/);
  assert.match(window.document.getElementById('cellMetricTertiaryBtn').textContent, /Cumulative/);
  assert.match(window.document.getElementById('regionMetricSecondaryBtn').textContent, /Balance/);
  assert.match(window.document.getElementById('regionMetricTertiaryBtn').textContent, /Coverage/);
}

async function testSingleDonorDatasetFallsBackToComposition() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', 'DatasetOne', '');

  assert.equal(
    window.document.getElementById('cellMetricSecondaryBtn').disabled,
    true,
    'dataset diversity should be disabled when only one donor is available'
  );
  assert.equal(
    window.document.getElementById('cellMetricTertiaryBtn').disabled,
    true,
    'dataset comparison should be disabled when only one donor is available'
  );
  assert.equal(
    window.document.getElementById('regionMetricSecondaryBtn').disabled,
    true,
    'dataset region coverage should be disabled when only one donor is available'
  );
  assert.equal(
    window.document.getElementById('regionMetricTertiaryBtn').disabled,
    true,
    'dataset region comparison should be disabled when only one donor is available'
  );
  assert.match(
    window.document.getElementById('cellTypeTitle').textContent,
    /Distribution/,
    'single-donor dataset should stay on the primary composition chart'
  );
}

async function testCompositionRangeSupportsAllLabels() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', 'DatasetOne', 'DonorA');

  window.document.getElementById('regionRangeAllBtn')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const regionChartConfig = latestChartConfig(window, 'regionChart');
  assert.ok(regionChartConfig, 'region chart should render after switching range');
  assert.equal(
    regionChartConfig.data.labels.length,
    4,
    'all-range region composition should include every counted region label for the donor'
  );

  window.document.getElementById('cellRangeOtherBtn')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const cellChartConfig = latestChartConfig(window, 'cellTypeChart');
  assert.ok(cellChartConfig, 'cell chart should render after switching range');
  assert.ok(
    cellChartConfig.data.labels.includes('Other') || cellChartConfig.data.datasets[0].data.length <= 10,
    'top-plus-other mode should summarize the long tail when needed'
  );
}

async function testDonorAllModeShowsChartAndReadableTable() {
  const window = await loadUiHarness();
  window.updateView('Collection-1', 'DatasetOne', 'DonorA');

  window.document.getElementById('cellRangeAllBtn')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const cellChartConfig = latestChartConfig(window, 'cellTypeChart');
  assert.ok(cellChartConfig, 'cell chart should render in donor all mode');
  assert.equal(cellChartConfig.data.labels.length, 12, 'donor all mode should include every cell label');
  assert.equal(
    window.document.getElementById('cellChartView').classList.contains('hidden'),
    false,
    'donor all mode should keep the chart visible'
  );
  assert.equal(
    window.document.getElementById('cellTableView').classList.contains('hidden'),
    false,
    'donor all mode should reveal the compact table alongside the chart'
  );
  assert.equal(
    window.document.querySelectorAll('#cellTableView .cell-row').length,
    12,
    'donor all mode should render a full compact table for scanability'
  );
}

async function main() {
  await testHeaderCopy();
  console.log('PASS testHeaderCopy');
  await testOverviewSummaryIsCondensed();
  console.log('PASS testOverviewSummaryIsCondensed');
  await testOverviewSummaryExpandsInline();
  console.log('PASS testOverviewSummaryExpandsInline');
  await testCardsExposeModularDetails();
  console.log('PASS testCardsExposeModularDetails');
  await testChartModesAdaptToScope();
  console.log('PASS testChartModesAdaptToScope');
  await testSingleDonorDatasetFallsBackToComposition();
  console.log('PASS testSingleDonorDatasetFallsBackToComposition');
  await testCompositionRangeSupportsAllLabels();
  console.log('PASS testCompositionRangeSupportsAllLabels');
  await testDonorAllModeShowsChartAndReadableTable();
  console.log('PASS testDonorAllModeShowsChartAndReadableTable');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
