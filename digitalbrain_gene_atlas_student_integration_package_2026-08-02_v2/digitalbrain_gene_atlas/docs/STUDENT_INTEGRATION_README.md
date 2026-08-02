# DigitalBrain Gene Atlas Integration README

This package contains the source code, compact browser matrices and data-host
scaffold needed to integrate the DigitalBrain Gene Atlas into another website.

## What This Atlas Is

The atlas is a React/Next/Vinext web app that lets users search genes or gene
sets and view descriptive abundance across brain regions and broad cell types.
It includes:

- 3D Allen-derived brain anatomy with curated region mappings;
- a searchable multi-region selector with highlighted mapped parcels;
- manual atlas rotation with optional spin mode;
- per-gene regional histograms and cell-type detail tables;
- separate query-gene and reference-gene display, without mixing gene values;
- a dataset selector that swaps the whole compact matrix bundle;
- an Excel export of the current gene/reference-gene/region/dataset selection.

The browser does not read raw H5AD files. It reads generated compact files:

```text
public/data/atlas_source.json
public/data/equal_study_v2/
public/data/dataset_hbca_v1/
public/data/dataset_hippocampus_su_2022/
public/data/dataset_hippocampus_yizhou_2022/
```

In the current hosted deployment, the combined equal-study bundle is served
with the main atlas app and the three individual-study bundles are served from
the public read-only data host through `/api/data/...` URLs.

## Current Dataset Choices

The UI currently exposes four choices:

- `Combined atlas - 86 datasets (equal study)`
- `Human Brain Cell Atlas - whole brain`
- `Hippocampus - Su 2022`
- `Hippocampus - Yizhou 2022`

Changing the selector replaces the manifest, gene registry, region list, cell
type list and cached expression chunks together. This is why the selector now
behaves as a real dataset switch rather than a label-only dropdown.

## Contents To Keep Together

Keep these files and directories together when integrating:

- `app/GeneAtlasExplorer.tsx`: main atlas component, data loader, 3D viewer and
  Excel export.
- `app/globals.css`: atlas layout and styling.
- `app/page.tsx`, `app/layout.tsx`, `app/chatgpt-auth.ts`: app shell.
- `public/data/atlas_source.json`: runtime dataset catalog.
- `public/data/equal_study_v2/`: compact combined-atlas matrix bundle.
- `public/data/dataset_*`: compact source-study bundles, or the matching
  folders in the separate data-host package.
- `public/data/allen_3d_geometry.js`: anatomy geometry and region crosswalk.
- `public/og.png`, `public/favicon.svg`: site metadata assets.
- `data/region_names.equal_study.json`: region display names used by rebuilds.
- `scripts/build_equal_study_gene_chunks.py`: H5AD-to-browser-data converter.
- `scripts/validate_equal_study_gene_chunks.py`: compact-bundle parity
  validator.
- `scripts/summarize_h5ad_collection.py`: raw-H5AD collection summarizer for
  new datasets.
- `docs/DATA_CONTRACT.md`: exact runtime file format.
- `docs/HANDOFF_GUIDE.md`: rebuild, validation and deployment notes.
- `docs/MULTI_DATASET_SUMMARIZATION_STRATEGY.md`: donor/study-aware upstream
  aggregation strategy.
- `package.json`, `package-lock.json`, `vite.config.ts`, `next.config.ts`,
  `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs`: build config.

Do not transfer `node_modules`. Recreate dependencies with:

```bash
npm install
```

## Recommended Integration Paths

### Option 1: Keep It As A Standalone Atlas App

This is the least risky option. Deploy this atlas as its own app or subdomain,
then link to it from the existing website.

Local check:

```bash
npm install
npm run lint
npm test
npm run dev
```

The public version is:

```text
https://digitalbrain-gene-atlas.lumeng2025pku.chatgpt.site
```

### Option 2: Embed The Public Atlas

Add an iframe to the existing website:

```html
<iframe
  src="https://digitalbrain-gene-atlas.lumeng2025pku.chatgpt.site"
  title="DigitalBrain Gene Atlas"
  style="width: 100%; height: 900px; border: 0;"
></iframe>
```

This keeps the compact data and app updates centralized.

### Option 3: Port The React Component Into The Existing Website

Copy `GeneAtlasExplorer.tsx`, the needed CSS and the `public/data/` files into
the host website.

Important path rule: the current component expects these static files at the
website root:

```text
/data/atlas_source.json
/data/allen_3d_geometry.js
/data/equal_study_v2/manifest.json
/data/equal_study_v2/gene_index.json.gz
/data/equal_study_v2/chunks/*.bin.gz
```

If the host website serves the atlas under a subpath, either expose the data
files at root `/data/...` or edit these fetch paths in
`app/GeneAtlasExplorer.tsx`:

```ts
fetch("/data/atlas_source.json")
script.src = "/data/allen_3d_geometry.js"
```

The per-dataset matrix locations are controlled by
`public/data/atlas_source.json`. A `bundlePath` can be a root-relative path:

```json
{
  "id": "all_equal_study",
  "label": "Combined atlas - 86 datasets (equal study)",
  "bundlePath": "/data/equal_study_v2"
}
```

or an absolute public HTTPS path with CORS enabled:

```json
{
  "id": "hbca_v1",
  "label": "Human Brain Cell Atlas - whole brain",
  "bundlePath": "https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site/api/data/dataset_hbca_v1"
}
```

## Adding A New Dataset

Do not point the browser at a raw H5AD. Add a dataset by creating one more
compact matrix bundle.

1. Summarize the raw H5AD files into one donor-aware `*.dataset_summary.h5ad`.
   One dataset may contain multiple H5AD files, donors, cell types and brain
   regions. Keep donor, sample, region and broad-cell-type metadata during this
   step.
2. Convert the summary H5AD into compact browser chunks:

```bash
python scripts/build_equal_study_gene_chunks.py \
  --input /path/to/my_dataset.dataset_summary.h5ad \
  --output public/data/my_dataset_v1 \
  --geometry public/data/allen_3d_geometry.js \
  --region-names data/region_names.equal_study.json \
  --chunk-genes 256
```

3. Validate the generated bundle:

```bash
python scripts/validate_equal_study_gene_chunks.py \
  --input /path/to/my_dataset.dataset_summary.h5ad \
  --bundle public/data/my_dataset_v1 \
  --verify-all-hashes
```

4. Host the generated folder either inside the main website under
   `/data/my_dataset_v1` or on a public read-only data host that permits browser
   GET requests.
5. Register it in `public/data/atlas_source.json`:

```json
{
  "id": "my_dataset_v1",
  "label": "My dataset - display label",
  "bundlePath": "/data/my_dataset_v1",
  "description": "Short donor, region and sampling description."
}
```

6. Run `npm test`, open the UI, switch to the new dataset and search at least
   one high-expression gene plus one low-expression gene.

Use a new versioned output folder for every release. Do not overwrite an old
bundle in place, because a partially replaced `chunks/` directory can make the
browser mix old and new values.

## Excel Export Behavior

The `Download Excel` button creates an `.xlsx` file in the browser. It does not
call a server and does not open the raw H5AD.

The workbook has three sheets:

- `regional_abundance`: selected region x selected query/reference gene rows.
- `cell_type_abundance`: selected region x broad cell type x selected
  query/reference gene rows.
- `selection_metadata`: source file, SHA-256, selected genes, selected region
  scope, selected dataset, normalization and scientific caveats.

Both mean `log1p(CP10K)` and detection fraction are exported, regardless of
which metric is currently displayed in the UI.

The current compact manifests include cell, dataset, donor and sample counts.
They do not include individual donor IDs. If a future manifest includes row
fields named `donorIds`, `sampleIds` or `datasetIds`, the existing export
columns will populate automatically.

## Data Scope

The default data release is:

```text
overall.equal_study.summary.h5ad
```

It represents:

- 86 input datasets;
- 44,482,717 cells;
- 174 brain-region identifiers;
- 14 broad cell types;
- 1,636 region x cell-type rows;
- 400,085 searchable gene features.

The combined source H5AD has already collapsed the individual-dataset axis into
an equal-study statistic. Dataset-specific filtering therefore requires
separate pre-merge dataset-level summaries; it cannot be reconstructed from the
combined equal-study bundle alone.

## Scientific Caution

Values are descriptive abundance and coverage summaries. They are not
differential expression, multiple-testing corrected statistics, causal evidence
or external validation. The 3D region locations are curated display crosswalks,
not exact cytoarchitectonic segmentations.
