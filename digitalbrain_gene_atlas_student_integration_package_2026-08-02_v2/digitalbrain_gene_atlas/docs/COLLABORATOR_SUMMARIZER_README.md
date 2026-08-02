# DigitalBrain-Atlas Raw H5AD Summarizer

## What to send

Send the complete `digitalbrain_atlas_raw_summarizer_handoff_2026-07-31.zip`
file. Do not send only a browser `.f32` matrix or only the older
`build_h5ad_atlas_bundle.py` demonstration converter.

The collaborator should keep raw H5AD files on their own machine and return
only the generated summary directory.

## Install

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Windows:

```text
.venv\Scripts\python -m pip install -r requirements.txt
```

## Configure

Copy `configs/collection.template.json` once per dataset/study collection.

- List all H5AD shards for that dataset under one dataset entry.
- Give the dataset/study a stable ID.
- Do not use a brain region as the dataset ID.
- Point the field candidates to the actual `obs` and `var` columns.
- Declare the matrix source: `X`, `raw.X`, or `layer:<name>`.
- The current summarizer accepts only raw non-negative counts.

One H5AD may contain many regions. Region identity is read from cell metadata.

## Audit first

```bash
.venv/bin/python scripts/summarize_h5ad_collection.py \
  --config configs/my_collection.json \
  --output outputs/my_collection_audit \
  --audit-only
```

Review `audit_manifest.json`. Confirm dataset identity, file count, donor count,
sample count, region count, cell-type count, resolved metadata fields, raw-count
scale, cell-ID uniqueness, and source checksums.

## Build summaries

```bash
.venv/bin/python scripts/summarize_h5ad_collection.py \
  --config configs/my_collection.json \
  --output outputs/my_collection_summary \
  --chunk-size 512
```

If memory is limited, reduce `--chunk-size`. The output contains:

- `summary_manifest.json`;
- one `*.summary.h5ad` per raw input H5AD;
- donor/sample/region/cell-type metadata in `obs`;
- mean log1p(CP10K) in `X`;
- detection fraction in `layers["detection_fraction"]`;
- pseudobulk raw counts in `layers["pseudobulk_counts"]`.

Use `--omit-pseudobulk` only if the central team confirms that later
donor-level count analysis is unnecessary.

## Validate

```bash
.venv/bin/python scripts/validate_h5ad_summary_bundle.py \
  --bundle outputs/my_collection_summary
```

The validator checks file hashes, matrix shapes, required metadata, finite
values, detection bounds, and cell-count totals.

## Return

Compress and return the entire generated summary directory. Do not rename or
remove individual summary files because the manifest records their relative
paths and SHA-256 checksums.

Before sharing donor/sample metadata, follow the data-use agreement and apply a
stable within-dataset pseudonymization if required. The same donor must retain
the same pseudonym across all H5AD shards and regions of that dataset.

## Scientific interpretation

These are descriptive, donor-aware intermediate summaries. They are not
differential-expression results, batch-corrected integration, causal evidence,
or independent validation.

