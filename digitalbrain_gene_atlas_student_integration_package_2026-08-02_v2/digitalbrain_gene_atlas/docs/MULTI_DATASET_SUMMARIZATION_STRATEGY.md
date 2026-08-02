# DigitalBrain-Atlas Multi-Dataset Summarization Strategy

## Purpose

This protocol defines how collaborators should reduce raw H5AD collections
without losing the donor, sample, brain-region, cell-type, and study structure
needed by the DigitalBrain Gene Atlas.

The A23/A32 browser prototype is a user-interface demonstration. Its original
converter treats each H5AD/config entry as one region and pools all nuclei in
that entry. That is not the production design for the whole atlas.

## Correct Data Hierarchy

Use the following hierarchy:

```text
atlas
└── dataset / study / publication collection
    └── donor
        └── sample / library / batch
            └── brain region
                └── broad cell type
                    └── gene
```

An H5AD file is only a storage shard. It is not automatically a dataset, donor,
or region. One H5AD may contain many regions and cell types, and one dataset may
be split across many H5AD files.

For the local example, A23 and A32 are two regions in the same
`5-6Human_Brain_Cell_Atlas_v1.0` collection. They share three donors and contain
multiple 10X samples. They must therefore remain under one dataset identity,
with region represented as a separate axis.

## What Collaborators Should Receive

Send the collaborator the dedicated raw-summarizer handoff ZIP, not only the
browser `.f32` files and not only the old demonstration converter. The
summarizer handoff contains:

- `scripts/summarize_h5ad_collection.py`
- `configs/collection.template.json`
- this protocol
- a README with the run command
- a pinned minimal requirements file

The collaborator keeps the raw H5AD files locally, edits the configuration,
runs the summarizer, and sends back the generated summary directory. Raw H5AD
files do not need to be transferred with the summary bundle.

## Required Metadata

Every cell must resolve to:

- `dataset_id`: fixed by the collection configuration;
- `donor_id`: biological replicate, namespaced within dataset;
- `sample_id`: library/sample/batch nested within donor;
- `region_id`: anatomical region from `obs`, not from the filename;
- `cell_type`: a harmonized broad cell-class vocabulary;
- stable gene ID and display gene symbol.

Strongly recommended metadata include:

- cell ID or `observation_joinid`;
- age or developmental stage;
- sex;
- disease/condition;
- assay/chemistry;
- source partition/file;
- ontology IDs for region and cell type.

If donor identity is unavailable, do not silently treat cells as replicates.
Mark the dataset as donor-unresolved. It may be displayed descriptively but
cannot contribute to donor-aware uncertainty or inferential comparisons.

## Atomic Summary Unit

The collaborator output should preserve one row per:

```text
dataset × donor × sample × region × cell type × relevant covariates
```

For every row and gene, retain:

1. number of cells;
2. mean `log1p(counts per 10,000)`;
3. transcript detection fraction;
4. pseudobulk raw count sum when raw counts are available.

These are sufficient to build the descriptive interface and to recompute
cell-weighted or donor-balanced views. The pseudobulk layer supports later
donor-level statistical work, but the atlas interface itself remains
descriptive.

Missing strata must remain missing. They must not be encoded as biological
zero.

## Aggregation Rules

### Within a sample

Aggregate cells within each region and broad cell type. Keep cell counts and
the source sample identity.

### Within a donor

When a donor has multiple technical samples for the same region and cell type,
merge the sufficient statistics across those samples. This produces one
donor-level estimate per region and cell type.

### Within a dataset

The default atlas value should be the equal-weight mean of eligible donor-level
estimates. Do not pool all cells first, because donors or samples with more
nuclei would dominate the result.

Display alongside every value:

- number of eligible donors;
- total number of nuclei;
- number of samples;
- a low-coverage flag;
- donor-level spread or confidence interval when possible.

### Across datasets

Do not concatenate all cells from all studies. First create one donor-balanced
estimate within each dataset, then combine eligible dataset estimates with
equal study weight by default.

Because assay chemistry, sampling, and annotation can shift absolute
expression scales, the interface should expose two cross-dataset views:

- a descriptive equal-study mean on the harmonized expression scale;
- a within-dataset percentile/rank view for robust spatial comparison.

Report dataset coverage for every region/cell-type/gene combination. An
“overall” value based on one dataset is not a replicated cross-dataset result.

## Cell-Type and Region Harmonization

Preserve both:

- the original source annotation;
- the harmonized DigitalBrain label used by the interface.

Use a versioned crosswalk rather than overwriting source labels. Start with a
broad shared cell-class vocabulary for cross-dataset comparison; expose finer
labels only within datasets that support them.

Likewise, preserve the source region name/ontology and map it to a versioned
DigitalBrain/Allen display region. Coarse or proxy mappings must be marked as
such and must not be presented as exact cytoarchitectonic masks.

## Gene Harmonization

Use stable gene IDs as the primary key and gene symbols as display/search
aliases. Do not merge different stable IDs merely because their symbols are
identical. Record:

- reference genome/build;
- gene annotation release;
- feature type;
- original ID and symbol;
- canonical display symbol;
- any explicit duplicate-resolution rule.

The current demonstration's uppercase-symbol union is acceptable for UI
prototyping but is not sufficient as the authoritative whole-atlas gene
registry.

## Input-Scale Checks

The raw summarizer expects non-negative raw counts from `X`, `raw.X`, or a
declared count layer. Before processing, it checks a matrix sample for
count-like integer values.

Do not apply counts-per-10,000 normalization to data that are already
normalized or log transformed. Such inputs need an explicit scale declaration
and a separate conversion path.

## Quality-Control Gates

At minimum, audit:

- duplicate cell IDs within and across H5AD shards;
- missing donor/sample/region/cell-type labels;
- region × donor and region × sample coverage;
- dataset/region nesting and confounding;
- number of cells per donor × region × cell type;
- gene-ID uniqueness and feature compatibility;
- count-like matrix scale;
- negative/non-finite values;
- source-file checksums;
- annotation and crosswalk versions.

Recommended display defaults are:

- at least 20 nuclei for a donor × region × cell-type estimate;
- at least 2 donors for a descriptive dataset mean;
- at least 3 donors for donor-level spread/uncertainty;
- explicit low-coverage or unavailable labels rather than zero filling.

These are display gates, not universal inferential thresholds.

## Browser Delivery

Collaborator summary H5AD files are intermediate scientific summaries; the
static HTML should not open them directly. A central build step should:

1. validate and merge the summary shards;
2. create the versioned gene, dataset, donor, region, and cell-type registries;
3. generate donor-balanced dataset summaries;
4. generate equal-study overall summaries;
5. attach coverage and missingness masks;
6. publish gene-major, chunked data through object storage or a small query API.

For the full atlas, avoid one monolithic binary per dataset. Gene-major chunks
or an API allow a search to fetch only the requested genes.

## Interpretation

The output supports descriptive abundance, detection, coverage, and
donor-to-donor variability. It does not by itself provide differential
expression, batch-corrected integration, causal inference, or independent
validation.

