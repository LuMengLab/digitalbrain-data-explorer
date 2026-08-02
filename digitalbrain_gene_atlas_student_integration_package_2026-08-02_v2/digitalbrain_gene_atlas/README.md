# DigitalBrain Gene Atlas

Interactive web atlas for searching genes or gene sets across the complete
DigitalBrain equal-study expression summary or an available source-study
summary. The default release is generated from `overall.equal_study.summary.h5ad`,
which represents 86 input datasets,
44,482,717 cells, 174 brain-region identifiers, 14 harmonized broad cell types,
1,636 region × cell-type rows and 400,085 gene features.

## What the interface does

- Searches gene symbols or stable IDs with a compressed 400,085-feature index.
- Switches between the combined 86-study atlas, the Human Brain Cell Atlas
  whole-brain summary and two hippocampus-specific 2022 studies. Each choice
  loads its own gene registry, regions, cell types and compact expression blocks.
- Keeps every selected gene separate in the 3D atlas, regional chart and
  cell-type table; gene-set values are not blended into one displayed profile.
- Switches between the equal-study mean of donor-balanced mean
  `log1p(CP10K)` and the corresponding detection fraction.
- Displays all 174 regions quantitatively. The current anatomy crosswalk places
  89 regions on the Allen-derived 3D brain; the remaining 85 are clearly marked
  as quantitative-only rather than assigned an invented location.
- Provides a searchable multi-region display filter. A subset controls the 3D
  expression layer, regional histogram and sidebar together; selected mapped
  parcels receive cyan borders and the focused cell-detail parcel is amber.
- Uses manual rotation by default, with optional Spin mode, visible regional
  boundaries and region names in a separate sidebar.
- Expands a selected region into its represented broad cell types and compares
  each query gene with a selected housekeeping or marker gene.
- Downloads the current gene and region selection as an Excel workbook with
  regional abundance, cell-type abundance and source-selection metadata.
- Treats zero dataset coverage as missing, not biological zero.

The combined H5AD does not contain an individual-dataset axis, so it cannot be
filtered back into all 86 component studies. Study selection is implemented by
registering separate pre-merge `*.dataset_summary.h5ad` derivatives. This
release includes the three such summaries currently available; adding another
study requires building and registering one more compact bundle, not changing
the UI code.

## Why gene-major chunks

The browser never opens the 1.3 GB H5AD. The build step converts it into:

- `manifest.json` — 0.6 MB of row, region and chunk metadata;
- `gene_index.json.gz` — 10.7 MB searchable symbol/ID registry;
- 1,563 independent gzip blocks, each containing at most 256 features across
  all 1,636 summary rows.

The default combined bundle occupies 209,501,374 bytes, or 14.95% of the
1,401,445,482-byte source H5AD (6.69× smaller; 85.05% reduction). A search
downloads only its required block. The median block is about 10 KB; dense,
widely covered blocks containing genes such as ASIC2 or GAPDH are about 1.3 MB.
The three selectable source-study bundles add about 101 MB on the host, but are
not downloaded unless a user selects one of those studies. In production they
live on the public read-only data host and are served from its CORS-enabled
`/api/data/…` route; this keeps the application deployment under its package
limit while allowing direct, cacheable browser reads.

The delivery blocks use bounded 16-bit quantization. Mean expression has a
per-block scale; detection has 1/65,535 resolution; coverage counts remain
exact. The audited maximum absolute errors were 0.0000382 expression units and
0.00000766 detection fraction, both finer than the UI display precision.

Each block carries mean expression, detection fraction and a coverage count.
Coverage means represented datasets for the combined atlas and represented
donors for an individual-study bundle; the manifest records this unit.
The blocks are derived delivery data, not a replacement for the scientific
source H5AD.

## Excel export

The **Download Excel** button writes an `.xlsx` file directly in the browser
from the already loaded compact matrix blocks. The workbook contains:

- `regional_abundance`: one row per selected region × selected query/reference
  gene, with cell-type-balanced mean `log1p(CP10K)`, detection fraction,
  dataset coverage, region cell count, dataset count and donor count;
- `cell_type_abundance`: one row per selected region × represented broad cell
  type × selected query/reference gene, with row-level cell, dataset, donor and
  sample counts;
- `selection_metadata`: source H5AD filename and SHA-256, normalization labels,
  active UI metric, selected genes, selected region scope and scientific scope.

The current equal-study browser bundle contains donor/sample counts per
summary stratum, but not individual donor IDs. If a future compact bundle adds
`donorIds`, `sampleIds` or `datasetIds` to each manifest row, the same export
columns will include those identifiers automatically.

## Local development

```bash
npm install
npm run dev
```

Open the local address printed by the server, normally
`http://localhost:3000/`.

## Important files

- `app/GeneAtlasExplorer.tsx` — search, on-demand block loader and atlas UI.
  It also contains the dependency-free browser-side `.xlsx` export.
- `app/globals.css` — layout and visual styling.
- `scripts/build_equal_study_gene_chunks.py` — direct HDF5-to-browser chunk
  converter; it avoids AnnData materialization of dense layers.
- `scripts/validate_equal_study_gene_chunks.py` — source-H5AD parity and hash
  validator.
- `public/data/equal_study_v2/manifest.json` — runtime schema and metadata.
- `public/data/atlas_source.json` — the runtime dataset catalog read by the UI;
  add a labeled bundle entry here after a new matrix bundle passes validation.
- `public/data/atlas_source.json` also records the public data-host URL for the
  externally hosted individual-study bundles.
- `public/data/equal_study_v2/gene_index.json.gz` — runtime search registry.
- `public/data/equal_study_v2/chunks/` — bounded-precision generated blocks
  totaling about 189 MB; kept with the release so source-only hosting can
  reproduce the site.
- `public/data/allen_3d_geometry.js` — Allen-derived brain geometry and region
  crosswalk.
- `docs/DATA_CONTRACT.md` — exact binary format.
- `docs/HANDOFF_GUIDE.md` — practical rebuild, validation and deployment steps.
- `docs/MULTI_DATASET_SUMMARIZATION_STRATEGY.md` — donor/study-aware upstream
  aggregation rules.

## Rebuild from a summary H5AD

Run from this directory. The output directory must be absent or empty because
the converter refuses to overwrite a prior release.

```bash
../../.venv-cellxgene311/bin/python \
  scripts/build_equal_study_gene_chunks.py \
  --input /path/to/overall.equal_study.summary.h5ad \
  --output public/data/equal_study_v2 \
  --geometry public/data/allen_3d_geometry.js \
  --region-names data/region_names.equal_study.json \
  --chunk-genes 256
```

The same command accepts an individual `*.dataset_summary.h5ad` that contains
`layers["donor_coverage"]`. Build each study into its own directory and add it
to the `datasets` array in `public/data/atlas_source.json`.

If `data/region_names.equal_study.json` is not suitable for another atlas, provide an
equivalent JSON object mapping region IDs to display names. Do not infer
geometry from names; 3D placement is controlled only by the curated geometry
crosswalk.

## Validate source parity

```bash
../../.venv-cellxgene311/bin/python \
  scripts/validate_equal_study_gene_chunks.py \
  --input /path/to/overall.equal_study.summary.h5ad \
  --bundle public/data/equal_study_v2 \
  --verify-all-hashes

npm run lint
npm test
```

The Python validator verifies the source checksum, every block checksum,
bounded numerical error for a deterministic sample from `X` and
`layers["detection_fraction"]`, and exact
`layers["dataset_coverage"]` values.

## Connect another summarized atlas

Use the same summary schema or adapt the converter explicitly. Required H5AD
elements are:

- dense `X` with summary-row × feature mean values;
- `layers["detection_fraction"]` with the same shape;
- either `layers["dataset_coverage"]` for a combined equal-study summary or
  `layers["donor_coverage"]` for an individual-study summary;
- `obs` fields used by the converter: `summary_row`, `region_id`,
  `region_gyral`, `broad_cell_type`, `n_cells`, `n_donors`, `n_samples`, and
  either `low_dataset_coverage` or `low_coverage`; `n_datasets` is optional for
  individual-study summaries;
- `var` fields: `canonical_gene_id`, `gene_symbol`, `id_kind`,
  `source_occurrences`;
- `uns["digitalbrain_stage2"]` aggregation provenance.

For collections starting from raw H5AD shards, use
`scripts/summarize_h5ad_collection.py` and the multi-dataset strategy first.
One H5AD is a storage shard, not automatically a dataset, donor or region.

Build each addition into a new versioned folder, for example
`public/data/my_study_v1/`. After validation and browser tests pass, add it to
`public/data/atlas_source.json`:

```json
{
  "id": "my_study_v1",
  "label": "My study · display label",
  "bundlePath": "/data/my_study_v1",
  "description": "Short sampling and aggregation description."
}
```

For a remotely hosted bundle, set `bundlePath` to its absolute HTTPS URL. The
remote endpoint must allow browser GET requests from the atlas origin; do not
put storage credentials in the catalog or browser code.

Do not point the UI at a folder containing raw H5AD files. The browser path
must contain the generated `manifest.json`, `gene_index.json.gz` and complete
`chunks/` directory described in `docs/DATA_CONTRACT.md`.

## Scientific scope

The interface reports descriptive abundance summaries. Regional values are an
equal mean across represented broad cell types, because the source contains no
precomputed all-cell row. It does not perform differential expression,
multiple-testing correction, causal inference or external validation. The 3D
locations are curated display crosswalks and are not exact cytoarchitectonic
segmentations.
