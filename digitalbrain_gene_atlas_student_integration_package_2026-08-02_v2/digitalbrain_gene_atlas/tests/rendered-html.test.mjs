import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the DigitalBrain Gene Atlas shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>DigitalBrain Gene Atlas(?: · DigitalBrain)?<\/title>/i);
  assert.match(html, /DigitalBrain/);
  assert.match(html, /Gene Atlas/);
  assert.match(html, /Map expression across anatomy/);
  assert.match(html, /3D expression atlas/);
  assert.match(html, /Choose regions to display/);
  assert.match(html, /3D mapped/);
  assert.match(html, /Motion/);
  assert.match(html, /Regions/);
  assert.match(html, /Per-gene/i);
  assert.match(html, /Download Excel/);
  assert.match(html, /Expression across cell classes/);
  assert.doesNotMatch(html, /Auto-rotate/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("ships internally consistent H5AD-derived gene chunks", async () => {
  const sourceConfig = JSON.parse(
    await readFile(new URL("../public/data/atlas_source.json", import.meta.url)),
  );
  assert.equal(sourceConfig.bundlePath, "/data/equal_study_v2");
  assert.equal(sourceConfig.defaultDatasetId, "all_equal_study");
  assert.deepEqual(
    sourceConfig.datasets.map((dataset) => dataset.id),
    [
      "all_equal_study",
      "hbca_v1",
      "hippocampus_su_2022",
      "hippocampus_yizhou_2022",
    ],
  );
  assert.deepEqual(
    sourceConfig.datasets.slice(1).map((dataset) => dataset.bundlePath),
    [
      "https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site/api/data/dataset_hbca_v1",
      "https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site/api/data/dataset_hippocampus_su_2022",
      "https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site/api/data/dataset_hippocampus_yizhou_2022",
    ],
  );

  const manifest = JSON.parse(
    await readFile(
      new URL("../public/data/equal_study_v2/manifest.json", import.meta.url),
    ),
  );
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.summary.datasetCount, 86);
  assert.equal(manifest.summary.cellCount, 44_482_717);
  assert.equal(manifest.summary.geneCount, 400_085);
  assert.equal(manifest.summary.regionCount, 174);
  assert.equal(manifest.summary.mappedRegionCount, 89);
  assert.equal(manifest.summary.cellTypeCount, 14);
  assert.equal(manifest.matrix.rowCount, 1_636);
  assert.equal(manifest.matrix.chunkGeneCount, 256);
  assert.equal(manifest.chunks.length, manifest.summary.chunkCount);

  const geneIndex = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("../public/data/equal_study_v2/gene_index.json.gz", import.meta.url),
      ),
    ),
  );
  assert.equal(geneIndex.symbols.length, manifest.summary.geneCount);
  assert.ok(geneIndex.searchTokens.includes("ASIC2"));
  assert.ok(geneIndex.searchTokens.includes("GAPDH"));

  const asicToken = geneIndex.searchTokens.indexOf("ASIC2");
  const asicIndex = geneIndex.searchIndices[asicToken];
  const asicChunk = manifest.chunks[Math.floor(asicIndex / manifest.matrix.chunkGeneCount)];
  const compressed = await readFile(
    new URL(`../public/data/equal_study_v2/${asicChunk.file}`, import.meta.url),
  );
  assert.equal(compressed.byteLength, asicChunk.compressedBytes);
  const decoded = gunzipSync(compressed);
  assert.equal(
    decoded.byteLength,
    manifest.matrix.rowCount * asicChunk.count * asicChunk.bytesPerValue,
  );

  const chunkFiles = await readdir(
    new URL("../public/data/equal_study_v2/chunks/", import.meta.url),
  );
  assert.equal(chunkFiles.length, manifest.summary.chunkCount);

  const [geometry, socialCard] = await Promise.all([
    stat(new URL("../public/data/allen_3d_geometry.js", import.meta.url)),
    stat(new URL("../public/og.png", import.meta.url)),
  ]);
  assert.ok(geometry.size > 300_000);
  assert.ok(socialCard.size > 100_000);
});

test("ships selectable source-study bundles with donor-aware provenance", async () => {
  const expected = {
    dataset_hbca_v1: { cells: 3_345_029, genes: 58_232, regions: 103 },
    dataset_hippocampus_su_2022: { cells: 219_616, genes: 28_723, regions: 1 },
    dataset_hippocampus_yizhou_2022: { cells: 148_021, genes: 54_482, regions: 1 },
  };

  for (const [directory, values] of Object.entries(expected)) {
    const manifest = JSON.parse(
      await readFile(new URL(`../public/data/${directory}/manifest.json`, import.meta.url)),
    );
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.source.scope, "individual-dataset");
    assert.equal(manifest.source.coverageUnit, "donors");
    assert.equal(manifest.summary.datasetCount, 1);
    assert.equal(manifest.summary.cellCount, values.cells);
    assert.equal(manifest.summary.geneCount, values.genes);
    assert.equal(manifest.summary.regionCount, values.regions);
    assert.equal(manifest.normalization.label, "Equal-donor mean log1p(CP10K)");
    assert.equal(manifest.chunks.length, manifest.summary.chunkCount);

    const geneIndex = JSON.parse(
      gunzipSync(
        await readFile(
          new URL(`../public/data/${directory}/gene_index.json.gz`, import.meta.url),
        ),
      ),
    );
    assert.equal(geneIndex.symbols.length, manifest.summary.geneCount);
    assert.ok(geneIndex.searchTokens.includes("ASIC2"));
    assert.ok(geneIndex.searchTokens.includes("GAPDH"));

    const firstChunk = manifest.chunks[0];
    const compressed = await readFile(
      new URL(`../public/data/${directory}/${firstChunk.file}`, import.meta.url),
    );
    assert.equal(compressed.byteLength, firstChunk.compressedBytes);
    assert.equal(
      gunzipSync(compressed).byteLength,
      manifest.matrix.rowCount * firstChunk.count * firstChunk.bytesPerValue,
    );
  }
});
