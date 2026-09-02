# DigitalBrain Atlas Explorer

An offline-first, dependency-free prototype for exploring cell-class composition
across the DigitalBrain regional hierarchy.

## What is implemented

- Rotatable and zoomable anatomy derived from the bilateral 0.5-mm Allen Human
  Reference Atlas – 3D, 2020 annotation volume.
- 141 real voxel parcels rendered as decimated outer-surface and inter-parcel
  boundary samples in one integrated 3D scene.
- 106 repository-derived regional labels and expanded anatomical names.
- Overall cell-composition mode using multi-colour regional glyphs.
- Cell-class coloring, abundance filtering, region search, preset views, hover
  labels, and a selected-region composition panel.
- Optional real inter-parcel boundaries with collision-limited mapped-region
  acronym labels.
- Continuous screen-projected parcel envelopes and outlines derived from each
  Allen label's sampled surface.
- Switchable anatomy styles: the original sampled **Tiny flecks** view and the
  continuous **Boundaries** view.
- Bilateral surface markers for 105 of 106 DigitalBrain profiles, including the
  full cortical, hippocampal and brainstem analysis sets.
- Solid marker outlines for exact mappings and dashed outlines for broad
  anatomical proxies.
- Independent atlas layers for cell profiles, functional connectivity and
  structural connectivity.
- FC/SC links across the 55-region shared connectivity universe, with an
  adjustable 0% to 100% matrix-percentile cutoff and region-specific
  strongest-connection lists.
- Rainbow link hue encoding from threshold percentile to the strongest matrix
  value, with an explicit percentile and raw-weight colour bar.
- Persistent DMN labels and rings for the nine core or commonly associated DMN
  nodes represented in the 55-region connectivity vocabulary.
- Curated region overview, role, function and network annotations for all 55
  connectivity nodes.
- Selectable connection rows with raw FC/SC weight, matrix percentile and a
  cautious pair-specific interpretation. FC weights are labelled as
  fMRI-derived matrix weights rather than Pearson correlations.
- Unified search across region anatomy, connection pairs and ten functional
  systems. Function focus highlights annotated regions and their strongest
  within-set links.
- CSV import for replacement cell-composition values.
- Responsive layout and reduced-motion support.

## Run locally

From the project root:

```bash
python3 -m http.server 8765 --directory code/interactive_brain_atlas
```

Then open `http://127.0.0.1:8765/`.

The app has no package-install or build step.

## Data status

The region identities are generated from:

- `hierarchical clustering/clustering trees from DB/emd_swd_ir_distance_matrix.csv`
- `hierarchical clustering/region_acronym2name.json`

The included cell-class proportions are deterministic illustrative values and
must not be interpreted as DigitalBrain results.

The connectivity layers use the project matrices:

- `hierarchical clustering/SCFC/FC_FU2_mean_GSR.csv`
- `hierarchical clustering/SCFC/SC_group_average_nwk_density.csv`

Both contain the same 55 regions and 1,485 undirected region pairs. Links are
descriptively thresholded by within-matrix percentile. They must not be
interpreted as causal pathways, directed edges or a reconstructed connectome.

## Functional annotation layer

`data/atlas_knowledge.js` supplies the explanatory layer for the 55 connectivity
nodes. It contains concise anatomical summaries, functional associations,
network labels, DMN membership and ten searchable functional topics. These
annotations are curated orientation aids: they are not inferred from the
DigitalBrain model, the displayed FC/SC weights or a subject-specific fMRI
network parcellation.

The DMN display is deliberately limited to core or commonly associated DMN
territories available in this 55-region vocabulary. It is not a complete DMN
map. Region-function and connection explanations should receive domain-expert
review before publication-facing use.

Connectivity hue represents within-matrix percentile across all 1,485 pairs.
The detail panel also reports the original matrix weight. Because the FC matrix
contains values above 1, the viewer does not describe these values as Pearson
correlation coefficients. Pair explanations provide biological context for an
observed weight but do not treat shared function as proof of the connection.

## Rotation-stable overlays

Region markers use deterministic fixed atlas-space anchors. Cell profiles keep
one fixed anchor in each available hemisphere. Because the FC/SC matrices are
region-level and non-lateralized, connectivity uses one fixed canonical
hemisphere anchor per region rather than switching to whichever hemisphere is
front-facing.

Nodes and links are drawn as persistent overlays after the anatomy. Rotation
changes their projection and perspective only; it never changes membership,
thresholding or edge existence. Region labels use a stable priority order and
are not culled by front/back depth.

The 3D anatomy is derived from the official bilateral
`annotation_full.nii.gz` volume. The browser asset stores decimated samples of
the real outer surface and inter-parcel voxel boundaries; it is not an invented
ellipsoid or broad-group contour. Regional glyphs sit on the currently visible
surface of their mapped parcel in both hemispheres and rotate with the anatomy.
Atlas parcels retain their source anatomical colours. Cell abundance is encoded
by the circular regional markers, preventing anatomy samples from being
mistaken for additional cell observations.

The **Region boundaries** toggle adds translucent parcel envelopes and
continuous projected outlines over the sampled anatomy. These are
screen-projection orientation outlines derived from real parcel surfaces, not
measurement-grade meshes.

The former separate sagittal illustration is disabled and is not used by the
viewer. Anatomy and cell overlays now occupy the same rotatable object.

## Real 3D geometry audit

The official Allen Human Reference Atlas – 3D, 2020 contains 141 voxel labels
in the related developmental ontology. It does not exactly match the
DigitalBrain 106-label analysis vocabulary:

- 49 displayed labels are recoverable directly or as unions of annotated
  descendants.
- 13 have only a coarser enclosing 3D parcel.
- 44 have no exact counterpart in the 141-label volume.
- The displayed vocabulary contains overlapping parent/child or repeated
  ontology components, so it is not a non-overlapping parcellation.

See `audits/allen_3d_region_mapping_audit.csv` and
`audits/allen_3d_region_mapping_audit.json`.

## Whole-brain display crosswalk

To keep the cell atlas visible across cortex, hippocampus and brainstem, the
viewer adds an explicit lower-precision display crosswalk for labels without
exact voxel support:

- 49 profiles use exact or union-of-descendant Allen geometry.
- 13 use the nearest available ontology-enclosing parcel.
- 43 use a curated gyral or whole-structure proxy.
- 1 label, spinal cord, remains unplaced because it is outside the brain volume.

Examples include A23/PCC → caudal cingulate gyrus; A24/MFC → rostral
cingulate gyrus; A25/MFC → subcallosal gyrus; and A32/MFC → paracingulate plus
rostral cingulate gyri.

The editable source is `data/allen_3d_broad_crosswalk.json`; the generated
106-row report is `audits/allen_3d_whole_brain_display_crosswalk.csv`. Broad
proxies support orientation and exploration but must not be described as exact
cytoarchitectonic masks or voxel-level replication.

To regenerate the catalogue, audit, and browser geometry:

```bash
node code/interactive_brain_atlas/scripts/build_region_catalogue.mjs
node code/interactive_brain_atlas/scripts/audit_allen_3d_coverage.mjs
python3 code/interactive_brain_atlas/scripts/build_allen_3d_geometry.py
python3 code/interactive_brain_atlas/scripts/build_connectivity_layer.py
```

The geometry builder uses NumPy and reads the NIfTI header directly, so nibabel
is not required. The generated `data/allen_3d_geometry.js` contains 141 labels,
9,828 outer-surface points, and 12,578 parcel-boundary points.

## Connect the observed atlas composition

Use the **Import CSV** button with a long-format file:

```csv
region,cell_type,proportion
CA4Cpy DGC,Excitatory neuron,0.62
CA4Cpy DGC,Astrocyte,0.14
```

Requirements:

- `region` matches a displayed regional acronym.
- `cell_type` matches one of the seven current cell-class labels.
- `proportion` may be a fraction from 0 to 1 or a percentage from 0 to 100.
- Imported values are normalized within each region.

For a publication-facing version, preserve the source dataset, aggregation
unit, denominator, donor handling, and uncertainty for each displayed value.
Do not interpret the 56 broad proxy placements as exact geometry.
