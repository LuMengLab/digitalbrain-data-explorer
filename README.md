# DigitalBrain has moved

Visit **https://digitalbrain-human.com/** for the current website.

DigitalBrain 已迁移，请访问新站。此 GitHub Pages 地址保留为迁移指引。

Research data and static atlas payloads have been removed from the maintained Git history. Do not republish data from old clones or release bundles.

---

## Historical source documentation

The source below requires separately managed local data. The former full Pages release is retired.

# DigitalBrain Data Explorer

An interactive, browser-based explorer for harmonized single-cell brain data,
paired with a spatial 3D brain atlas. Everything lives on one page: you drill
through the data cohort with a few dropdowns, and the same selection is
reflected both in summary charts and on a rotatable anatomical brain.

## What the page shows

The page opens on the **3D Atlas** and can be switched to the **Overview**
charts at any time using the toggle in the scope banner.

- **Filters (top):** three linked dropdowns — Collection, Dataset, Donor — that
  drive every other panel.
- **Scope banner:** the current scope title plus live metrics — number of
  Datasets, Donors, and Cells in the current selection — and the **3D Atlas /
  Overview** view switch.
- **Two linked views:** a spatial 3D atlas and a set of distribution charts,
  both recomputed whenever the scope changes.

## Navigating the data

The data is organized as a **Collection → Dataset → Donor** hierarchy. Selecting
a collection narrows to a dataset, and a dataset narrows to an individual donor.
At each level the scope banner and every panel update automatically:

- **All Collections** — pooled view across everything.
- **Collection** — all datasets/donors in one collection.
- **Dataset** — all donors in one dataset.
- **Donor** — a single donor's profile.

Each donor carries donor-normalized metadata (name, age, gender, cell count),
disease/condition **status** labels, the set of sampled **Brodmann** and
**gyral** brain regions, and per-region / per-cell-type counts.

## Overview view (charts & tables)

**Collection / Dataset overview cards** summarize the scope: Datasets, Donors,
Total cells, Brain regions (broken down into **Brodmann** and **Gyral** counts),
and Cell types, along with disease/condition status badges and a region summary.

**Donor details** show the selected donor's name, age, gender, cell count,
status badges, and highlights.

**Cell Type Distribution**

- Metric modes: **Composition**, **Diversity**, **Comparison**.
- Ranges: **Top 10**, **Top 10 + Other**, **All**.
- Rendered as an interactive **Chart** or a sortable **Table**, with
  auto-generated insight callouts.

**Brain Region Distribution**

- Metric modes: **Composition**, **Coverage**, **Comparison**.
- Region axis: **Brodmann** or **Gyral**.
- Rendered as a **Chart** or **Table**, with insight callouts.

## 3D Atlas view

A rotatable, zoomable anatomical brain derived from the **Allen Human Reference
Atlas – 3D, 2020** (141 real voxel parcels; up to 105 of 106 DigitalBrain
regional profiles placed across cortex, hippocampus, and brainstem). Selecting a
scope in the explorer pushes that scope's real per-region cell counts and
cell-class composition onto the atlas, so you see *where* the selected cells sit.

- **Three atlas layers:** *Cell profiles*, *Functional* connectivity, and
  *Structural* connectivity, switchable independently.
- **Cell profiles:** cell-class coloring, per-class visibility toggles, a
  minimum-abundance filter, and a per-region **cell-class composition** panel.
  Markers distinguish **exact anatomy** from **broad anatomical proxy**
  placements.
- **Connectivity (FC/SC):** a shared 55-region universe (1,485 undirected
  pairs) with an adjustable **Top 10% → Top 1%** within-matrix percentile
  threshold, a rainbow strength scale, optional **DMN** node labels, each
  region's strongest connections, and per-pair weight + percentile with a
  cautious, non-causal interpretation.
- **Search & focus:** one search box spanning regions, connection pairs, and ten
  functional systems (e.g. *memory*, *DMN*, `A23 A32`); functional focus
  highlights related regions and their strongest links.
- **Anatomy & view controls:** two anatomy styles (**Tiny flecks** /
  **Boundaries**), toggles for 3D anatomy and auto-rotate, preset **Lateral /
  Dorsal / Anterior** views, and zoom in/out/reset.
- **Region detail panel:** region code and name, anatomical group, focus
  statistic, curated region role / functions / network tags, composition bars,
  member regions, connections, and atlas-context metadata.

## Data & interpretation

This is a scientifically cautious prototype. Please read the following before
drawing conclusions:

- Region identities come from the **106-region DigitalBrain hierarchy** and are
  matched to the atlas on the **Brodmann axis**.
- The source data stores only **marginal** distributions (region totals and
  cell-type totals, not a joint region × cell-type matrix). The per-region
  composition shown in the atlas is therefore **scope-level, not
  region-resolved**.
- The bundled cell-class proportions are **illustrative** and must not be read
  as DigitalBrain results.
- Functional/structural connectivity are read from the project's **55-region FC
  and SC matrices**; links are **undirected** and descriptively thresholded by
  matrix percentile. FC values are fMRI-derived matrix weights, **not** Pearson
  correlation coefficients, and imply no direction or causality.
- 3D anatomy comes from the Allen Human Reference Atlas – 3D, 2020. **Broad
  proxy** placements are orientation aids, **not** exact cytoarchitectonic masks.

## Running it

The site is fully static — no build step or package install is required. To view
it locally, serve this directory with any static file server and open
`index.html`, for example:

```bash
python -m http.server 8000
```

Then open `http://127.0.0.1:8000/`.
