import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(appDir, "..", "..");
const matrixPath = path.join(
  projectRoot,
  "hierarchical clustering",
  "clustering trees from DB",
  "emd_swd_ir_distance_matrix.csv",
);
const ontologyPath = path.join(
  projectRoot,
  "hierarchical clustering",
  "Ontology_flat.json",
);
const labelDescriptionPath = path.join(
  projectRoot,
  "data",
  "external",
  "allen_human_reference_atlas_3d_2020",
  "itksnap_label_description_Br.txt",
);
const outputDir = path.join(appDir, "audits");

const matrixText = await fs.readFile(matrixPath, "utf8");
const displayLabels = matrixText.split(/\r?\n/, 1)[0].split(",").slice(1);
const ontology = JSON.parse(await fs.readFile(ontologyPath, "utf8"));
const byAcronym = new Map(ontology.map((node) => [node.acronym, node]));
const byRawId = new Map(ontology.map((node) => [String(node.raw_id), node]));

const atlasLabels = (await fs.readFile(labelDescriptionPath, "utf8"))
  .trim()
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+1\s+1\s+1\s+"(.+) - (\d+)"$/,
    );
    if (!match) throw new Error(`Unrecognized label-description row: ${line}`);
    const [, value, red, green, blue, acronym, rawId] = match;
    const node = byRawId.get(rawId);
    if (!node) throw new Error(`Atlas structure ${rawId} is absent from local ontology.`);
    return {
      value: Number(value),
      red: Number(red),
      green: Number(green),
      blue: Number(blue),
      acronym,
      rawId,
      node,
    };
  });

function componentStatus(acronym) {
  const node = byAcronym.get(acronym);
  if (!node) throw new Error(`Unknown local ontology acronym: ${acronym}`);
  const direct = atlasLabels.filter((label) => label.rawId === String(node.raw_id));
  if (direct.length) {
    return { status: "direct", labels: direct };
  }
  const descendants = atlasLabels.filter((label) =>
    label.node.atlas_path.includes(acronym),
  );
  if (descendants.length) {
    return { status: "union_of_annotated_descendants", labels: descendants };
  }
  const ancestors = atlasLabels.filter((label) =>
    node.atlas_path.includes(label.node.acronym),
  );
  if (ancestors.length) {
    return { status: "coarser_ancestor_only", labels: ancestors };
  }
  return { status: "no_3d_counterpart", labels: [] };
}

const rows = displayLabels.map((displayRegion) => {
  const components = byAcronym.has(displayRegion)
    ? [displayRegion]
    : displayRegion.split(/\s+/);
  const componentMappings = components.map((acronym) => ({
    acronym,
    ...componentStatus(acronym),
  }));
  const exact = componentMappings.every((mapping) =>
    ["direct", "union_of_annotated_descendants"].includes(mapping.status),
  );
  const anyExact = componentMappings.some((mapping) =>
    ["direct", "union_of_annotated_descendants"].includes(mapping.status),
  );
  const allCoarse = componentMappings.every(
    (mapping) => mapping.status === "coarser_ancestor_only",
  );
  const mappingStatus = exact
    ? "recoverable_exact_or_union"
    : anyExact
      ? "partial"
      : allCoarse
        ? "coarse_only"
        : "unmapped";
  const mappedLabels = [
    ...new Map(
      componentMappings
        .flatMap((mapping) => mapping.labels)
        .map((label) => [label.value, label]),
    ).values(),
  ];
  return {
    displayRegion,
    components,
    mappingStatus,
    componentMappings,
    atlasValues: mappedLabels.map((label) => label.value),
    atlasAcronyms: mappedLabels.map((label) => label.acronym),
  };
});

const componentInstances = displayLabels.flatMap((displayRegion) => {
  const components = byAcronym.has(displayRegion)
    ? [displayRegion]
    : displayRegion.split(/\s+/);
  return components.map((acronym) => ({
    displayRegion,
    acronym,
    node: byAcronym.get(acronym),
  }));
});
const overlapPairs = [];
for (let leftIndex = 0; leftIndex < componentInstances.length; leftIndex += 1) {
  const left = componentInstances[leftIndex];
  for (
    let rightIndex = leftIndex + 1;
    rightIndex < componentInstances.length;
    rightIndex += 1
  ) {
    const right = componentInstances[rightIndex];
    if (left.displayRegion === right.displayRegion) continue;
    const same = left.acronym === right.acronym;
    const leftAncestor = right.node.atlas_path.includes(left.acronym);
    const rightAncestor = left.node.atlas_path.includes(right.acronym);
    if (same || leftAncestor || rightAncestor) {
      overlapPairs.push({
        left_display_region: left.displayRegion,
        left_component: left.acronym,
        right_display_region: right.displayRegion,
        right_component: right.acronym,
        relationship: same
          ? "shared_component"
          : leftAncestor
            ? "left_is_ancestor"
            : "right_is_ancestor",
      });
    }
  }
}

const counts = Object.fromEntries(
  ["recoverable_exact_or_union", "partial", "coarse_only", "unmapped"].map(
    (status) => [status, rows.filter((row) => row.mappingStatus === status).length],
  ),
);
const summary = {
  displayed_region_count: displayLabels.length,
  component_instance_count: componentInstances.length,
  allen_3d_voxel_label_count: atlasLabels.length,
  mapping_status_counts: counts,
  overlapping_display_component_pairs: overlapPairs.length,
  interpretation:
    "The 106 displayed labels are a mixed-level analysis vocabulary, not a non-overlapping 3D parcellation.",
};

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const csvRows = [
  [
    "display_region",
    "component_acronyms",
    "mapping_status",
    "component_statuses",
    "allen_3d_label_values",
    "allen_3d_acronyms",
  ],
  ...rows.map((row) => [
    row.displayRegion,
    row.components.join("|"),
    row.mappingStatus,
    row.componentMappings
      .map((mapping) => `${mapping.acronym}:${mapping.status}`)
      .join("|"),
    row.atlasValues.join("|"),
    row.atlasAcronyms.join("|"),
  ]),
];

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, "allen_3d_region_mapping_audit.csv"),
  `${csvRows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
);
await fs.writeFile(
  path.join(outputDir, "allen_3d_region_mapping_audit.json"),
  `${JSON.stringify({ summary, rows, overlapPairs }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
