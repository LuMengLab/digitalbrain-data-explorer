# DigitalBrain Gene Atlas Handoff Guide

This package connects the production equal-study summary and available
individual-study summaries to the interactive atlas without asking a browser
to open any H5AD directly.

## Current release

Source:

```text
overall.equal_study.summary.h5ad
```

Runtime release:

```text
public/data/atlas_source.json
public/data/equal_study_v2/
├── manifest.json
├── gene_index.json.gz
└── chunks/chunk_0000.bin.gz ... chunk_1562.bin.gz
public/data/dataset_hbca_v1/
public/data/dataset_hippocampus_su_2022/
public/data/dataset_hippocampus_yizhou_2022/
```

The runtime represents 86 input datasets, 44,482,717 cells, 174 region IDs, 14
broad cell types, 1,636 summary rows and 400,085 features. It occupies about
209.5 MB in total, but a user initially downloads only the 11.6 MB
manifest/index and then the block or blocks containing the requested genes.
`atlas_source.json` is the UI's dataset catalog. It names the default bundle
and the three selectable source-study bundles. The combined bundle is packaged
with the app. Production stores the three source-study directories on the
public read-only data host and reaches them through that host's CORS-enabled
`/api/data/…` route.

## What to give another developer

Give them the entire atlas source package, including:

- `app/`, configuration files and `package*.json`;
- `scripts/build_equal_study_gene_chunks.py`;
- `scripts/validate_equal_study_gene_chunks.py`;
- `data/region_names.equal_study.json`;
- `public/data/allen_3d_geometry.js`;
- all documentation;
- either the generated `public/data/equal_study_v2/` runtime directory or
  access to the source H5AD so they can regenerate it.

The current hosted source includes the large `chunks/` directory so a checkout
is a complete data deployment. For long-term releases, moving immutable blocks
to object storage may keep the code repository smaller; in that design the
chunks must be copied from a release artifact or regenerated from the source
H5AD before local use.

Do not send only the old A23/A32 `.f32` files. They belong to the earlier UI
demonstration and are not read by the v2 equal-study viewer.

## Build the browser data

Install Python dependencies with an environment containing `h5py` and `numpy`.
From the atlas directory, run:

```bash
python scripts/build_equal_study_gene_chunks.py \
  --input /path/to/overall.equal_study.summary.h5ad \
  --output public/data/equal_study_v2 \
  --geometry public/data/allen_3d_geometry.js \
  --region-names data/region_names.equal_study.json \
  --chunk-genes 256
```

The output directory must be absent or empty. This guard prevents a partial new
release from being mixed with old blocks. Build into a new versioned directory,
validate it, then add or update its entry in the `datasets` array of
`public/data/atlas_source.json`. No TypeScript edit is required for a
schema-compatible matrix release.

The converter reads HDF5 datasets directly. Do not replace it with
`anndata.read_h5ad()` for this file unless memory behavior is explicitly
tested: dense H5AD layers can be materialized and exhaust memory.

## Validate before use or deployment

```bash
python scripts/validate_equal_study_gene_chunks.py \
  --input /path/to/overall.equal_study.summary.h5ad \
  --bundle public/data/equal_study_v2 \
  --verify-all-hashes

npm install
npm run lint
npm test
```

The parity validator checks the source H5AD checksum, all generated block
hashes, bounded quantization error for deterministic sampled mean/detection
values, and exact dataset coverage. `npm test` validates the browser contract
and production build. The audited maxima were 0.0000382 expression units and
0.00000766 detection fraction.

## Run locally

```bash
npm run dev
```

Open the local URL printed by the server.

## Deploy economically

The UI is static-data-first. Keep the code and small metadata with the web app.
The block files may be:

1. packaged with the static deployment, as in the current hosted release; or
2. placed in public read-only object storage/CDN with cross-origin GET access.

Object storage is preferable when releases grow or change frequently. Keep
block paths immutable within a version, use long cache lifetimes for hashed
releases, and publish the manifest only after every block is uploaded and
validated. Never expose a private bucket credential in browser code.

For a remote bundle, register its absolute HTTPS base URL in
`atlas_source.json`. Keep the host public and read-only, enable CORS, and verify
`manifest.json`, `gene_index.json.gz` and at least one chunk from the deployed
atlas before publishing the catalog change.

## Dataset selection model

`overall.equal_study.summary.h5ad` has already collapsed the dataset axis into
an equal-study statistic. It has per-value dataset coverage, but it cannot
recover values for study A versus study B. The UI therefore treats that file as
one combined choice and loads separate pre-merge summaries for study-specific
choices.

The current catalog contains Human Brain Cell Atlas whole-brain sampling and
two hippocampus-specific studies. To add more choices, retain and publish each
donor-balanced `*.dataset_summary.h5ad` before the equal-study merge, convert
it into its own compact directory, and register that directory in
`atlas_source.json`. The converter automatically uses donor coverage for these
individual-study summaries.

For much larger catalogs, use either:

- one chunk family per dataset plus an overall family; or
- a small API accepting dataset ID, gene ID, region and cell type.

Do not label an equal-study value as dataset-specific. Switching datasets must
replace the manifest, gene registry, regions, cell types and cached chunks as
one unit.

## Excel export behavior

The **Download Excel** control creates a workbook from the user's current gene
and region selection after the needed compact gene blocks have loaded. It is
client-side only and does not require a server job.

The export has three sheets:

- `regional_abundance`: selected region × selected query/reference gene rows;
- `cell_type_abundance`: selected region × broad cell type × selected
  query/reference gene rows;
- `selection_metadata`: source file, SHA-256, normalization, selected region
  scope and scope caveats.

Both mean `log1p(CP10K)` and detection fraction are exported regardless of the
metric currently displayed on screen. Donor/sample counts are exported from
the manifest, and `selection_metadata` records the selected dataset label,
dataset ID, source file, summary scope and coverage unit. Individual donor IDs
are blank when a compact manifest does not include them; future manifests can
add `donorIds`, `sampleIds` and `datasetIds` row fields without changing the
export columns.

## Anatomy behavior

All 174 regions are quantitative. Only the 89 regions with a curated
`geometryKey` appear on the 3D atlas. An unmapped region must remain marked
“no 3D mapping”; do not place it by approximate string matching. Review the
crosswalk before publication-level anatomical claims.

The region filter supports all-region mode and multi-region subsets. A subset
limits the 3D expression layer, quantitative histogram and region sidebar to
the same IDs. Mapped selected parcels receive cyan sampled-boundary borders;
the focused region used for cell-type detail is amber. Quantitative-only
regions still filter normally but cannot receive a 3D border.

## UI behavior to preserve

- Each added gene receives its own color and numerical series.
- Dataset-coverage zero is shown as unavailable, never zero expression.
- Manual rotation remains the default; Spin is opt-in.
- Region names remain in the sidebar rather than covering the brain canvas.
- Region subset filtering controls the atlas, histogram and sidebar together.
- The last selected region cannot be deselected; use **All** to restore the
  whole atlas or select another region before removing it.
- The reference gene stays separate from query genes.
- The Excel export uses the current selected query genes, reference gene and
  region subset, and it preserves query versus reference gene roles.
- Regional aggregation is labeled as an equal mean across represented broad
  cell types.

## Scientific scope

The viewer is descriptive. It does not perform differential expression,
multiple-testing correction, batch correction, causal inference or external
validation. Coverage counts and donor/sample metadata are context, not
uncertainty estimates.
