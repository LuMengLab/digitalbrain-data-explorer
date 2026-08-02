# DigitalBrain Gene Atlas Data Contract

The browser reads compact combined-atlas or individual-study summaries, never
an H5AD directly.

## Runtime files

The app first reads `public/data/atlas_source.json`, then loads the default or
user-selected versioned bundle named by a `bundlePath` entry:

```text
public/data/atlas_source.json
public/data/equal_study_v2/
├── manifest.json
├── gene_index.json.gz
└── chunks/
    ├── chunk_0000.bin.gz
    ├── chunk_0001.bin.gz
    └── ...
public/data/dataset_hbca_v1/
public/data/dataset_hippocampus_su_2022/
public/data/dataset_hippocampus_yizhou_2022/
```

It also loads `public/data/allen_3d_geometry.js` for anatomy.

Every `bundlePath` must be either a root-relative site path or an absolute HTTPS
URL without a trailing slash. Remote endpoints must permit cross-origin browser
GET requests. The production source-study bundles use the public data host's
`/api/data/…` route.
The catalog also supplies a stable dataset `id`, display `label`, optional
`description`, and `defaultDatasetId`. A new matrix release should be built and
validated in a new directory before its catalog entry is published. The UI
never opens raw H5AD files.

## Manifest schema v3

`manifest.json` contains:

- `source`: source filename, SHA-256, input-dataset count and aggregation
  provenance copied from `uns["digitalbrain_stage2"]`; individual-study
  bundles also identify their dataset ID, summary scope and donor coverage unit;
- `normalization`: human-readable metric and regional aggregation labels;
- `matrix`: row count, feature count, chunk width and metric layout;
- `genes`: compressed search-index filename and encoding;
- `rows`: ordered summary-row registry with region, broad cell type, cells,
  datasets, donors, samples and coverage flag;
- `regions`: display metadata, 3D mapping key and row indices per region;
- `cellTypes`: harmonized broad cell-type vocabulary;
- `chunks`: ordered feature ranges, paths, byte sizes and SHA-256 hashes;
- `summary`: headline counts and deployed byte totals.

Rows preserve the source H5AD order. Region `rowIndices` point into that order.
Chunk descriptor `index` must equal its position in `chunks`.

## Search index

`gene_index.json.gz` is gzip-compressed JSON containing aligned arrays:

- `symbols`
- `ids`
- `idKinds`
- `sourceOccurrences`
- sorted `searchTokens`
- `searchIndices`, mapping each token to a feature-array index

Stable IDs and gene symbols are exact, case-insensitive search keys. When a
symbol maps to multiple feature records, the converter chooses a deterministic
preferred record for that search alias while preserving every feature in the
feature arrays and stable-ID search.

## Binary block layout

Each block covers all summary rows and at most 256 consecutive features. After
gzip decompression its bytes are metric-major:

```text
uint16 little-endian meanEncoded[row, geneWithinChunk]
uint16 little-endian detectionEncoded[row, geneWithinChunk]
uint8                coverageCount[row, geneWithinChunk]
```

Every metric is row-major. With `R = matrix.rowCount` and `G = chunk.count`:

```text
valueCount = R * G
decodedBytes = valueCount * (2 + 2 + 1)
offset(row, localGene) = row * G + localGene
```

The mean array starts at byte 0, detection starts at `valueCount * 2`, and
coverage starts at `valueCount * 4`. Decode with the scales in each chunk
descriptor:

```text
mean = meanEncoded * chunk.meanScale
detection = detectionEncoded * chunk.detectionScale
```

`detectionScale` is 1/65,535. `meanScale` is the block maximum divided by
65,535. Rounding guarantees a maximum absolute error of half the relevant
scale (apart from negligible floating-point arithmetic). Coverage is lossless.

To find a feature block:

```text
chunkIndex = floor(geneIndex / matrix.chunkGeneCount)
localGene = geneIndex - chunks[chunkIndex].start
```

The schema-v3 matrix id remains `datasetCoverage` for compatibility, while the
manifest records whether its unit is represented datasets (combined atlas) or
represented donors (individual study). A coverage count of zero means the value
is unavailable. The stored zero in the
mean/detection array must not be interpreted as biological zero.

## Aggregation shown by the UI

Each source row is already a donor-balanced summary for one region × broad
cell-type source stratum; the combined atlas then averages studies equally.
When multiple source strata share a region and broad cell type, the UI first
averages those rows within cell type. It then takes an equal mean across
represented cell types. It does not cell-weight this mean. Each query gene
remains a separate profile; any mean across selected genes is used only for
sorting or compact context.

The combined v2 source has no individual-dataset axis. Dataset-specific values
come only from separately registered pre-merge dataset summaries and are not
reconstructed from the combined file.

## Anatomy contract

`allen_3d_geometry.js` defines `window.ALLEN_3D_ATLAS` with labels, sampled outer
and boundary points, and `regionMappings`. A region is rendered in 3D only when
its `geometryKey` maps to a curated geometry entry. Unmapped regions remain in
the sidebar and quantitative chart.

Region selection is a display filter, not a re-aggregation. The browser
filters the already-computed regional profiles by exact region ID. Selected
mapped regions are outlined using their sampled atlas boundary points; no
boundary is inferred for an unmapped region.

## Excel selection export

The browser-side `.xlsx` export is generated from the same compact chunks that
drive the UI. It does not query raw H5AD files or recompute upstream
statistics. An export covers the current selected query genes, the current
reference gene when available, and the current region selection:

- `regional_abundance` reports one region × gene row with equal-cell-type
  regional mean expression, detection fraction, maximum dataset coverage and
  region-level cell/dataset/donor counts.
- `cell_type_abundance` reports one region × broad-cell-type × gene row with
  row-level mean expression, detection fraction, dataset coverage, cell count,
  dataset count, donor count, sample count and coverage flag.
- `selection_metadata` records the source H5AD filename, source SHA-256,
  selected genes, region scope, normalization labels and the scientific-scope
  warning.

The v2 manifest contains donor and sample counts but not individual donor,
sample or dataset identifiers. Optional row fields named `donorIds`,
`sampleIds` and `datasetIds` are passed through by the exporter when future
bundles provide them.

## Scientific scope

Values are descriptive abundance and coverage summaries. They are not
differential-expression results, corrected statistical tests, causal evidence,
independent validation or exact cytoarchitectonic segmentations.
