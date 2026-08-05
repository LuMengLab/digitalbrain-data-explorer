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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// jsdom 不实现 IntersectionObserver。图层引导靠它判断「atlas 区是否真的进入了
// 视野」，所以给个可手动触发的桩；不触发时引导就不起，其余测试不受干扰。
function installIntersectionObserverStub(window) {
  window.__intersectionObservers = [];
  window.IntersectionObserver = class IntersectionObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.disconnected = false;
      window.__intersectionObservers.push(this);
    }

    observe(node) {
      this.target = node;
    }

    unobserve() {
      this.disconnected = true;
    }

    disconnect() {
      this.disconnected = true;
    }

    fire(isIntersecting) {
      this.callback([{ isIntersecting, target: this.target }], this);
    }
  };
}

// jsdom implements no media queries either, and the capsule marquee asks about
// prefers-reduced-motion. Same failure mode as the missing rAF above: the throw
// aborted initializeApp. The stub reports "no preference" and lets a test flip it.
function installMatchMediaStub(window) {
  const lists = [];
  window.__mediaQueries = lists;
  window.matchMedia = (media) => {
    const listeners = [];
    const list = {
      media,
      matches: false,
      addEventListener(_type, listener) { listeners.push(listener); },
      removeEventListener(_type, listener) {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
      set(matches) {
        list.matches = matches;
        listeners.forEach((listener) => listener(list));
      },
    };
    lists.push(list);
    return list;
  };
}

// jsdom does no layout, so the measurements the marquee depends on are faked. Both
// content metrics matter: with no track the code reads the label's scrollWidth, and
// once a track is injected it reads the track's own offsetWidth instead -- a
// transformed child counts towards its parent's scrollable overflow, so scrollWidth
// would drift with the animation.
function fakeTextMetrics(window, content, room) {
  for (const metric of ['scrollWidth', 'offsetWidth']) {
    Object.defineProperty(window.HTMLElement.prototype, metric, {
      configurable: true,
      get() { return content(); },
    });
  }
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return room(); },
  });
}

async function loadUiHarness() {
  const dom = new JSDOM(loadHtmlSkeleton(), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const { window } = dom;

  window.console = console;
  // jsdom has no rAF. Without it initializeAtlasListCollapse threw synchronously
  // inside initializeApp, silently skipping every initializer after it -- the list
  // collapse, the status capsule, the view switch and the gene layer were all
  // untested as a result.
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  window.__rafCount = 0;
  const rawRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    window.__rafCount += 1;
    return rawRaf(callback);
  };
  installIntersectionObserverStub(window);
  installMatchMediaStub(window);
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

async function testAtlasLayerTabsSitInTheHeaderRow() {
  const window = await loadUiHarness();
  const document = window.document;

  const tabs = document.getElementById('dataLayerTabs');
  assert.ok(tabs, 'the layer switch must still exist');

  // atlas 运行时用 getElementById("dataLayerTabs") 绑定，所以只能存一份——
  // 搬到顶栏意味着抽屉里不能再留副本，否则两套选中态会失同步。
  const meta = document.querySelector('.atlas-embed-meta');
  assert.equal(tabs.parentElement, meta,
    'the layer switch belongs in the header meta row, not the settings drawer');
  assert.equal(document.querySelector('#atlasControlPanel #dataLayerTabs'), null,
    'the drawer must not keep a second copy of the layer switch');

  // 顺序：图层分段 -> 状态胶囊 -> Atlas settings / About
  const order = Array.from(meta.children);
  const status = meta.querySelector('.dataset-status');
  const actions = meta.querySelector('.atlas-embed-actions');
  assert.ok(order.indexOf(tabs) < order.indexOf(status),
    'the layer switch comes before the status capsule');
  assert.ok(order.indexOf(tabs) < order.indexOf(actions),
    'the layer switch comes before the Atlas settings button');

  // 四个图层一个都不能丢，且须同属一个分组（互斥单选的语义）。
  const layers = Array.from(tabs.querySelectorAll('button')).map((node) => node.dataset.layer);
  assert.deepEqual(layers, ['cells', 'functional', 'structural', 'genes']);

  // 抽屉里不能留下只剩标题的空外壳。
  const headings = Array.from(
    document.querySelectorAll('#atlasControlPanel .section-heading span')
  ).map((node) => node.textContent.trim());
  assert.ok(!headings.includes('Atlas layer'),
    'the drawer must not keep an empty "Atlas layer" section behind');
}

async function testLayerTourWaitsForTheAtlasToComeIntoView() {
  const window = await loadUiHarness();
  const document = window.document;
  const toggle = document.getElementById('atlasSettingsToggle');

  // 图层开关已常驻可见，不再需要脉冲去勾引用户打开抽屉。
  assert.ok(!toggle.classList.contains('atlas-settings-pulse'),
    'the settings button no longer hides the layer switch, so it must not pulse');

  // atlas 区在首屏之下；对着看不见的控件弹气泡毫无意义。
  assert.equal(document.querySelector('.atlas-tour-pop'), null,
    'the tour must not fire before the atlas is on screen');

  // 打开设置抽屉不再是触发条件——抽屉里已经没有被讲解的对象了。
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  assert.equal(document.querySelector('.atlas-tour-pop'), null,
    'opening the drawer must not start the tour any more');

  const observers = window.__intersectionObservers;
  assert.equal(observers.length, 1, 'exactly one observer is needed');
  assert.equal(observers[0].target, document.getElementById('atlasSection'),
    'the observer watches the atlas section');

  observers[0].fire(true);
  await sleep(400);

  const pop = document.querySelector('.atlas-tour-pop');
  assert.ok(pop && !pop.hidden, 'the tour opens once the atlas scrolls into view');
  assert.match(pop.querySelector('.atlas-tour-step').textContent, /Step 1 of 4/,
    'a 3-step tour means the gene layer was forgotten again');
  assert.ok(tabsButton(document, 'cells').classList.contains('atlas-tour-target'),
    'step 1 highlights the Cell profiles button');

  const next = pop.querySelector('.atlas-tour-next');
  for (let i = 0; i < 3; i += 1) {
    next.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.match(pop.querySelector('.atlas-tour-title').textContent, /gene expression/i,
    'the last step introduces the gene layer');
  assert.ok(tabsButton(document, 'genes').classList.contains('atlas-tour-target'),
    'the last step highlights the Gene expression button');
  assert.equal(next.textContent, 'Done', 'the fourth step is the last one');
}

function tabsButton(document, layer) {
  return document.querySelector(`#dataLayerTabs [data-layer="${layer}"]`);
}

function ruleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    return null;
  }
  return css.slice(start, css.indexOf('}', start));
}

// jsdom does no layout, so "all four on one row" cannot be asserted from the DOM.
// What can be asserted is the rule that guarantees it. The atlas base is a grid
// with a hard-coded three-column template written when there were three layers,
// and the gene layer's fourth button silently wrapped onto a second row. Pin the
// override rather than the pixel result.
async function testHeaderLayerSwitchCannotWrapToASecondRow() {
  const css = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');

  const container = ruleBody(css, '#atlasSection .atlas-embed-layer-tabs');
  assert.ok(container, 'the header layer switch needs its own rule to escape the drawer styling');
  assert.match(container, /display:\s*flex/,
    'a flex row drops the grid column count, so a fifth layer cannot wrap again');
  assert.match(container, /flex-wrap:\s*nowrap/,
    'nowrap is what actually forbids the second row');

  const button = ruleBody(css, '#atlasSection .atlas-embed-layer-tabs button');
  assert.ok(button, 'the header buttons need their own type size');
  const size = Number(/font-size:\s*(\d+)px/.exec(button)?.[1]);
  assert.ok(size >= 12,
    `header buttons must not inherit the 8px drawer type, got ${size}px`);
}

// The atlas rewrites the capsule with innerHTML on every scope change (see its
// updateDatasetStatus branches), so the marquee cannot lean on a wrapper element
// placed in the static HTML -- but it can inject one and re-inject it after each
// rewrite, which is what the same observer that re-measures is for. jsdom does no
// layout, so the one measurement it depends on is faked here.
async function testStatusCapsuleScrollsInsteadOfWrappingTheHeaderRow() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  let fakeScrollWidth = 0;
  fakeTextMetrics(window, () => fakeScrollWidth, () => 120);

  const longLabel = 'Linked \u00b7 Collection-1 \u00b7 DatasetOne \u00b7 DonorA';
  fakeScrollWidth = 420;
  capsule.innerHTML =
    `<span class="status-dot"></span><span>${longLabel}</span>` +
    '<strong>12 regions \u00b7 scope-level</strong>';
  await sleep(20);

  const label = capsule.querySelector('span:not(.status-dot)');
  const track = label.querySelector('.marquee-track');
  assert.ok(track, 'the moving element is an injected track, not the label itself');
  assert.equal(track.textContent, longLabel,
    'the track carries the text; the label is only the clip');
  assert.ok(track.classList.contains('is-marquee'),
    'a label too long for the capped capsule must scroll, not widen the row');
  assert.equal(track.style.getPropertyValue('--marquee-shift'), '-300px',
    'the shift is exactly the hidden overflow (420 - 120)');
  assert.match(track.style.getPropertyValue('--marquee-duration'), /^[\d.]+s$/,
    'duration is derived from the shift so the speed does not depend on label length');
  assert.equal(label.title, longLabel,
    'the full label must be readable on hover rather than only mid-scroll');

  // A label that fits must sit still: constant motion in a status readout is noise.
  // It must also be left as plain text, so the CSS ellipsis still has something to
  // truncate -- an inline-block track would be replaced by a bare ellipsis instead.
  fakeScrollWidth = 100;
  capsule.innerHTML =
    '<span class="status-dot"></span><span>Linked \u00b7 All</span>' +
    '<strong>106 regions</strong>';
  await sleep(20);

  const short = capsule.querySelector('span:not(.status-dot)');
  assert.equal(short.querySelector('.marquee-track'), null,
    'no track when nothing is hidden');
  assert.equal(short.title, '', 'no tooltip when nothing is hidden');
}

// The whole point of the rewrite: transform runs on the compositor, so it cannot
// relayout the row or perturb the dot. Animating text-indent -- the first attempt --
// is a layout property, so every frame re-ran the flex layout of the capsule. That
// is what the trembling was.
async function testTheScrollAnimatesTransformAndNotALayoutProperty() {
  const css = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');

  const frames = /@keyframes\s+capsuleMarquee\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(frames, 'the scroll keyframes must exist');
  const body = frames[1];

  assert.match(body, /transform:\s*translateX/,
    'the scroll must move the track with a transform');
  for (const layoutProperty of ['text-indent', 'left', 'margin-left', 'width']) {
    assert.ok(!new RegExp(`(^|[^-])${layoutProperty}\\s*:`, 'm').test(body),
      `${layoutProperty} forces a relayout every frame and must not be animated`);
  }

  const track = ruleBody(css, '#atlasSection .atlas-embed-meta .marquee-track.is-marquee');
  assert.ok(track, 'the animation belongs on the track');
  assert.match(track, /linear/,
    'constant speed reads as scrolling; easing reads as a jump through the middle');
}

// Injecting the track is a childList mutation inside the very node the observer
// watches, so the observer sees its own work. Without a "nothing to do" check that
// is an endless loop. Same discipline as the collapse pass above.
async function testInjectingTheTrackDoesNotFeedTheObserverForever() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  fakeTextMetrics(window, () => 420, () => 120);

  capsule.innerHTML =
    '<span class="status-dot"></span><span>Linked \u00b7 Collection-19</span>' +
    '<strong>12 regions</strong>';
  await sleep(30);

  let mutations = 0;
  new window.MutationObserver((records) => { mutations += records.length; })
    .observe(capsule, { childList: true, attributes: true, subtree: true });
  await sleep(120);

  assert.equal(mutations, 0,
    `the capsule must reach a fixed point, saw ${mutations} further mutations`);
}

// resize fires dozens of times during a window drag and each one re-runs the sync.
// Re-adding the class restarts the CSS animation, which would hold the text near the
// start of its travel for the whole drag. A sync that finds nothing changed has to
// write nothing at all.
async function testResizeDoesNotRestartTheRunningScroll() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  fakeTextMetrics(window, () => 420, () => 120);

  capsule.innerHTML =
    '<span class="status-dot"></span><span>Linked \u00b7 Collection-19 \u00b7 DonorA</span>' +
    '<strong>12 regions</strong>';
  await sleep(20);

  const track = capsule.querySelector('.marquee-track');
  assert.ok(track && track.classList.contains('is-marquee'), 'the scroll should be on');

  let writes = 0;
  new window.MutationObserver((records) => { writes += records.length; })
    .observe(track, { attributes: true });
  for (let i = 0; i < 12; i += 1) {
    window.dispatchEvent(new window.Event('resize'));
  }
  await sleep(20);

  assert.equal(writes, 0,
    `a resize that changes nothing must not write to the track, got ${writes} writes`);
  assert.equal(track.style.getPropertyValue('--marquee-shift'), '-300px',
    'and the shift must be unchanged');
}

// The list-collapse pass reacts to mutations inside #atlasSection and also mutates
// inside it, so every write has to be conditional or the two feed each other frame
// after frame, forever. One unguarded classList.add did exactly that; the loop is
// invisible in a browser (it just burns a frame's worth of work indefinitely) and
// only showed up here as a starved event loop.
async function testAtlasListCollapseSettlesInsteadOfLoopingEveryFrame() {
  const window = await loadUiHarness();

  const before = window.__rafCount;
  await sleep(150);
  const grew = window.__rafCount - before;

  assert.ok(grew <= 2,
    `the collapse pass must reach a fixed point; it requested ${grew} more frames ` +
    'while nothing changed on the page'
  );
}

// A 7px status indicator shipped with the default flex-shrink: 1 and min-width: auto
// (0 for an empty element), so once the capsule was capped the dot joined the shrink
// pool and was squeezed -- measured rendering at 4.1px, deformed into an ellipse by
// its own border-radius. This holds independently of the scroll: the dot was the wrong
// size even standing still, as long as the label was long enough to hit the cap.
async function testStatusDotIsNotInTheShrinkPool() {
  const css = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');

  const dot = ruleBody(css, '#atlasSection .atlas-embed-meta .dataset-status > .status-dot');
  assert.ok(dot, 'the dot needs a rule pulling it out of the flex shrink pool');
  assert.match(dot, /flex:\s*0\s+0\s+auto/,
    'a status indicator must keep its size no matter how long the label is');

  const count = ruleBody(css, '#atlasSection .atlas-embed-meta .dataset-status > strong');
  assert.ok(count, 'the region count needs the same protection');
  assert.match(count, /flex:\s*0\s+0\s+auto/,
    'the label has to be the only shrinkable item, or its base size leaks into layout');
}

// A very long label needs a ceiling on the cycle time, or it crawls so slowly that
// it reads as broken: at 45 px/s a 2000px overflow would travel for 44s, and the
// pauses at each end stretch in proportion.
async function testMarqueeDurationHasACeiling() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  fakeTextMetrics(window, () => 2120, () => 120);

  capsule.innerHTML =
    '<span class="status-dot"></span><span>a very long linked scope label</span>' +
    '<strong>12 regions</strong>';
  await sleep(20);

  const label = capsule.querySelector('span:not(.status-dot)');
  const seconds = Number(
    capsule.querySelector('.marquee-track').style
      .getPropertyValue('--marquee-duration').replace('s', '')
  );
  assert.ok(label, 'the label is still there, it just does not move on its own');
  assert.ok(seconds > 0, 'a duration must be set');
  assert.ok(seconds <= 20,
    `a cycle slower than 20s reads as broken rather than slow, got ${seconds}s`);
}

// Capping the capsule is what keeps the header on one row, and the cap comes off the
// label alone because the dot and the count are unshrinkable. Widening the label to
// guarantee a readable window was tried and reverted: it grew the capsule past the
// width the row was measured to fit, which brings the wrapping back.
async function testStatusCapsuleWidthIsCapped() {
  const css = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');
  const rule = ruleBody(css, '#atlasSection .atlas-embed-meta .dataset-status');
  assert.ok(rule, 'the capsule needs a header-row specific rule');
  assert.match(rule, /max-width:/,
    'without a cap the capsule grows with the scope label and wraps the row');

  const label = ruleBody(
    css, '#atlasSection .atlas-embed-meta .dataset-status > span:not(.status-dot)'
  );
  assert.ok(label, 'the label needs its own clipping rule');
  assert.match(label, /overflow:\s*hidden/,
    'the label is the clip; the injected track slides inside it');

  const cramped = ruleBody(
    css, '#atlasSection .atlas-embed-meta .dataset-status > span.is-too-narrow'
  );
  assert.ok(cramped, 'there has to be a rule that drops an unreadably narrow label');
  assert.match(cramped, /display:\s*none/,
    'hiding is the only degradation that cannot widen the row');
}

// A narrow viewport leaves the label a sliver, and scrolling a long string through a
// sliver is worse than not showing it: the capsule still carries the dot and the
// region count, and the tooltip carries the text. Hiding is safe because it can only
// make the row narrower -- widening the label to fit the text cannot make that claim.
async function testAnUnreadablyNarrowLabelIsHiddenRatherThanScrolled() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  fakeTextMetrics(window, () => 320, () => 24);

  capsule.innerHTML =
    '<span class="status-dot"></span><span>Linked \u00b7 Collection-18 \u00b7 DonorA</span>' +
    '<strong>106 regions</strong>';
  await sleep(20);

  const label = capsule.querySelector('span:not(.status-dot)');
  assert.ok(label.classList.contains('is-too-narrow'),
    'a 24px window is not worth scrolling through');
  assert.equal(label.querySelector('.marquee-track'), null,
    'a hidden label must not carry a running track either');
  assert.equal(capsule.title, 'Linked \u00b7 Collection-18 \u00b7 DonorA',
    'the text has to stay reachable, so the tooltip moves to the capsule');
}

// Honouring prefers-reduced-motion means not injecting the track at all, so the label
// falls back to the CSS ellipsis with the full text on hover. Doing it in JS rather
// than as a CSS override keeps the stylesheet free of a rule that could never match.
async function testReducedMotionTruncatesInsteadOfScrolling() {
  const window = await loadUiHarness();
  const document = window.document;
  const capsule = document.getElementById('datasetStatus');

  fakeTextMetrics(window, () => 420, () => 120);
  const stillness = window.__mediaQueries.find(
    (query) => query.media.includes('prefers-reduced-motion')
  );
  assert.ok(stillness, 'the marquee has to ask about the motion preference');

  const text = 'Linked \u00b7 Collection-19 \u00b7 DonorA';
  stillness.set(true);
  capsule.innerHTML =
    `<span class="status-dot"></span><span>${text}</span><strong>12 regions</strong>`;
  await sleep(20);

  const label = capsule.querySelector('span:not(.status-dot)');
  assert.equal(label.querySelector('.marquee-track'), null,
    'no track, so nothing animates');
  assert.equal(label.title, text, 'the text still has to be reachable');

  // Turning the preference back off has to start the scroll without another rewrite.
  stillness.set(false);
  await sleep(20);
  assert.ok(capsule.querySelector('.marquee-track.is-marquee'),
    'clearing the preference should let it scroll again');
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
  await testAtlasLayerTabsSitInTheHeaderRow();
  console.log('PASS testAtlasLayerTabsSitInTheHeaderRow');
  await testLayerTourWaitsForTheAtlasToComeIntoView();
  console.log('PASS testLayerTourWaitsForTheAtlasToComeIntoView');
  await testHeaderLayerSwitchCannotWrapToASecondRow();
  console.log('PASS testHeaderLayerSwitchCannotWrapToASecondRow');
  await testStatusCapsuleWidthIsCapped();
  console.log('PASS testStatusCapsuleWidthIsCapped');
  await testAnUnreadablyNarrowLabelIsHiddenRatherThanScrolled();
  console.log('PASS testAnUnreadablyNarrowLabelIsHiddenRatherThanScrolled');
  await testStatusDotIsNotInTheShrinkPool();
  console.log('PASS testStatusDotIsNotInTheShrinkPool');
  await testAtlasListCollapseSettlesInsteadOfLoopingEveryFrame();
  console.log('PASS testAtlasListCollapseSettlesInsteadOfLoopingEveryFrame');
  await testStatusCapsuleScrollsInsteadOfWrappingTheHeaderRow();
  console.log('PASS testStatusCapsuleScrollsInsteadOfWrappingTheHeaderRow');
  await testTheScrollAnimatesTransformAndNotALayoutProperty();
  console.log('PASS testTheScrollAnimatesTransformAndNotALayoutProperty');
  await testInjectingTheTrackDoesNotFeedTheObserverForever();
  console.log('PASS testInjectingTheTrackDoesNotFeedTheObserverForever');
  await testResizeDoesNotRestartTheRunningScroll();
  console.log('PASS testResizeDoesNotRestartTheRunningScroll');
  await testMarqueeDurationHasACeiling();
  console.log('PASS testMarqueeDurationHasACeiling');
  await testReducedMotionTruncatesInsteadOfScrolling();
  console.log('PASS testReducedMotionTruncatesInsteadOfScrolling');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
