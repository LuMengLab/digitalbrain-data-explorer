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

function selectValue(window, id, value) {
  const element = window.document.getElementById(id);
  element.value = value;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function waitForDomReady(window) {
  if (window.document.readyState !== 'loading') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.document.addEventListener('DOMContentLoaded', () => {
      setTimeout(resolve, 0);
    }, { once: true });
  });
}

async function main() {
  const dom = new JSDOM(loadHtmlSkeleton(), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const { window } = dom;

  window.console = console;
  window.Chart = class ChartStub {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
    }
    destroy() {}
  };

  ['digitalneuron_data.js', 'data-model.js', 'charts.js', 'ui.js', 'app.js'].forEach((fileName) => {
    runScript(dom, fileName);
  });

  await waitForDomReady(window);

  const collectionSelect = window.document.getElementById('collectionSelect');
  assert.ok(collectionSelect.options.length > 1, 'collection options should populate on init');
  assert.equal(window.document.getElementById('scopeTitle').textContent, 'All Collections');

  const collectionValue = collectionSelect.options[1].value;
  selectValue(window, 'collectionSelect', collectionValue);

  const datasetSelect = window.document.getElementById('datasetSelect');
  assert.ok(datasetSelect.options.length > 1, 'dataset options should populate after collection selection');

  const datasetValue = datasetSelect.options[1].value;
  selectValue(window, 'datasetSelect', datasetValue);

  const donorSelect = window.document.getElementById('donorSelect');
  assert.ok(donorSelect.options.length > 1, 'donor options should populate after dataset selection');

  const donorValue = donorSelect.options[1].value;
  selectValue(window, 'donorSelect', donorValue);

  assert.match(window.document.getElementById('scopeEyebrow').textContent, /DONOR/);
  assert.notEqual(window.document.getElementById('donorName').textContent, '-');
  assert.ok(
    window.document.getElementById('collectionOverview').classList.contains('hidden') === false,
    'collection overview should be visible'
  );
  assert.ok(
    window.document.getElementById('brainRegionsSection').classList.contains('hidden') === false,
    'brain regions section should be visible'
  );

  console.log('PASS test_smoke');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
