# DigitalBrain Gene Atlas File Inventory

Use this inventory when packaging or transferring the atlas.

## Main Atlas App

Required source and configuration:

- `.openai/hosting.json`
- `.gitignore`
- `package.json`
- `package-lock.json`
- `next.config.ts`
- `vite.config.ts`
- `tsconfig.json`
- `postcss.config.mjs`
- `eslint.config.mjs`
- `drizzle.config.ts`
- `worker/index.ts`
- `build/sites-vite-plugin.ts`
- `db/index.ts`
- `db/schema.ts`
- `app/page.tsx`
- `app/layout.tsx`
- `app/GeneAtlasExplorer.tsx`
- `app/globals.css`
- `app/chatgpt-auth.ts`

Required compact data and assets:

- `public/data/atlas_source.json`
- `public/data/equal_study_v2/`
- `public/data/dataset_hbca_v1/`
- `public/data/dataset_hippocampus_su_2022/`
- `public/data/dataset_hippocampus_yizhou_2022/`
- `public/data/allen_3d_geometry.js`
- `public/favicon.svg`
- `public/og.png`

Required source metadata and scripts:

- `data/region_names.equal_study.json`
- `data/datasets.example.json`
- `data/collections.production.template.json`
- `scripts/build_equal_study_gene_chunks.py`
- `scripts/validate_equal_study_gene_chunks.py`
- `scripts/summarize_h5ad_collection.py`
- `scripts/build_h5ad_atlas_bundle.py`
- `scripts/validate_h5ad_summary_bundle.py`
- `requirements-summarizer.txt`

Required documentation:

- `README.md`
- `docs/DATA_CONTRACT.md`
- `docs/HANDOFF_GUIDE.md`
- `docs/STUDENT_INTEGRATION_README.md`
- `docs/MULTI_DATASET_SUMMARIZATION_STRATEGY.md`
- `docs/COLLABORATOR_SUMMARIZER_README.md`
- `docs/FILE_INVENTORY.md`

Tests:

- `tests/rendered-html.test.mjs`

## Data Host

The separate data-host package is required when individual-study matrix bundles
are too large to ship inside the main site deployment.

Required data-host files:

- `.openai/hosting.json`
- `.gitignore`
- `README.md`
- `package.json`
- `public/_headers`
- `public/data/dataset_hbca_v1/`
- `public/data/dataset_hippocampus_su_2022/`
- `public/data/dataset_hippocampus_yizhou_2022/`
- `scripts/build.mjs`
- `worker/index.js`

The main atlas currently points to the hosted data bundles through absolute
`https://digitalbrain-gene-atlas-data.lumeng2025pku.chatgpt.site/api/data/...`
paths in `public/data/atlas_source.json`.

## Exclude From Transfer

Exclude local generated or cache folders:

- `node_modules/`
- `dist/`
- `.next/`
- `.wrangler/`
- `.git/`
- `.DS_Store`
- Python `__pycache__/`

The excluded folders are local build or system artifacts. A new user can
recreate dependencies with `npm install` and regenerate a deployable build with
`npm run build`.
