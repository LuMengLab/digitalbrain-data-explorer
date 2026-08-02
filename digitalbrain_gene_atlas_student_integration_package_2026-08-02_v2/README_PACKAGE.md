# DigitalBrain Gene Atlas Integration Package

Created: 2026-08-02

This package contains the current fixed DigitalBrain Gene Atlas app and the
separate public data-host scaffold used for large individual-study matrix
bundles.

## Open These First

1. `digitalbrain_gene_atlas/README.md`
2. `digitalbrain_gene_atlas/docs/STUDENT_INTEGRATION_README.md`
3. `digitalbrain_gene_atlas/docs/HANDOFF_GUIDE.md`
4. `digitalbrain_gene_atlas/docs/DATA_CONTRACT.md`
5. `digitalbrain_gene_atlas/docs/FILE_INVENTORY.md`

## What Is Included

- `digitalbrain_gene_atlas/`: main interactive web atlas.
- `digitalbrain_gene_atlas/public/data/equal_study_v2/`: compact combined
  86-dataset equal-study matrices.
- `digitalbrain_gene_atlas/public/data/atlas_source.json`: dataset catalog read
  by the UI.
- `digitalbrain_gene_atlas_data_host/`: public read-only data-host project for
  the individual-study compact matrices.
- `digitalbrain_gene_atlas_data_host/public/data/dataset_hbca_v1/`
- `digitalbrain_gene_atlas_data_host/public/data/dataset_hippocampus_su_2022/`
- `digitalbrain_gene_atlas_data_host/public/data/dataset_hippocampus_yizhou_2022/`

The three individual-study bundles are intentionally kept in the data-host
folder instead of being duplicated inside the main app folder.

## Public URLs

Current atlas:

```text
https://digitalbrain-gene-atlas.lumeng2025pku.chatgpt.site
```

Current public data host:

```text
https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site
```

## What Was Fixed In This Version

The dataset selector now performs a full asynchronous dataset swap. When a user
selects a source study, the UI replaces the manifest, searchable gene registry,
region metadata, cell-type metadata and cached chunks together. This fixes the
previous behavior where clicking the selector could appear to do nothing or
reuse stale matrix state.

The production atlas reads individual-study bundles from the data host through
absolute CORS-enabled `/api/data/...` URLs. That avoids asking the main app
deployment to carry every large source-study matrix.

## Adding A New Dataset

Do not connect a raw H5AD directly to the browser. The expected workflow is:

1. Summarize raw H5AD files into one donor-aware `*.dataset_summary.h5ad`.
2. Convert that summary into compact chunks with
   `digitalbrain_gene_atlas/scripts/build_equal_study_gene_chunks.py`.
3. Validate the compact bundle with
   `digitalbrain_gene_atlas/scripts/validate_equal_study_gene_chunks.py`.
4. Host the generated versioned folder under `/data/...` in the main app or in
   the data host.
5. Add a new entry to
   `digitalbrain_gene_atlas/public/data/atlas_source.json`.
6. Test dataset switching, gene search, region filtering and Excel export.

Use a new versioned folder name for each release, for example
`dataset_my_study_v1`. Do not overwrite an old `chunks/` folder in place.
