"use client";

import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Metric = "mean" | "detection";

type AtlasLabel = {
  acronym: string;
  name: string;
  color: string;
  centroidVoxel: [number, number, number];
};

type AtlasGeometry = {
  metadata: {
    name: string;
    voxelSizeMm: [number, number, number];
    qoffsetMm: [number, number, number];
    nonzeroVoxelBounds: {
      minimum: [number, number, number];
      maximum: [number, number, number];
    };
  };
  labels: AtlasLabel[];
  outerPoints: number[];
  boundaryPoints: number[];
  regionMappings: Record<
    string,
    {
      status: string;
      labelIndices: number[];
      atlasAcronyms: string[];
      basis: string;
    }
  >;
};

type AtlasManifest = {
  schemaVersion: number;
  generatedAt: string;
  source: {
    file: string;
    sha256: string;
    inputDatasets: number;
    xMetric: string;
    detectionMetric: string;
    missingGeneRule: string;
    sourceCreatedAt?: string;
    datasetId?: string;
    scope?: "equal-study" | "individual-dataset";
    coverageUnit?: "datasets" | "donors";
  };
  normalization: {
    label: string;
    detectionLabel: string;
    coverageLabel?: string;
    regionalAggregation: string;
  };
  matrix: {
    rowCount: number;
    geneCount: number;
    chunkGeneCount: number;
  };
  genes: {
    indexFile: string;
    encoding: string;
  };
  rows: SummaryRow[];
  regions: RegionDescriptor[];
  cellTypes: string[];
  chunks: ChunkDescriptor[];
  summary: {
    datasetCount: number;
    regionCount: number;
    mappedRegionCount: number;
    cellCount: number;
    geneCount: number;
    cellTypeCount: number;
    chunkCount: number;
    chunkBytes: number;
    geneIndexBytes: number;
  };
};

type AtlasSourceConfig = {
  bundlePath?: string;
  label?: string;
  defaultDatasetId?: string;
  datasets?: AtlasDatasetOption[];
};

type AtlasDatasetOption = {
  id: string;
  label: string;
  bundlePath: string;
  description?: string;
};

type SummaryRow = {
  id: string;
  regionId: string;
  regionGyral: string;
  cellType: string;
  nCells: number;
  nDatasets: number;
  nDonors: number;
  nSamples: number;
  lowDatasetCoverage: boolean;
  datasetId?: string;
  datasetIds?: string[];
  donorId?: string;
  donorIds?: string[];
  sampleId?: string;
  sampleIds?: string[];
};

type RegionDescriptor = {
  id: string;
  acronym: string;
  label: string;
  gyral: string;
  geometryKey: string | null;
  rowIndices: number[];
  cellTypes: string[];
  nCells: number;
  nDatasets: number;
  nDonors: number;
};

type ChunkDescriptor = {
  index: number;
  start: number;
  count: number;
  file: string;
  encoding: "quantized-u16";
  bytesPerValue: number;
  meanScale: number;
  detectionScale: number;
  compressedBytes: number;
  sha256: string;
};

type GeneIndex = {
  symbols: string[];
  ids: string[];
  idKinds: string[];
  sourceOccurrences: number[];
  searchTokens: string[];
  searchIndices: number[];
};

type ExpressionChunk = {
  descriptor: ChunkDescriptor;
  mean: Float32Array;
  detection: Float32Array;
  datasetCoverage: Uint8Array;
};

type Point3D = { x: number; y: number; z: number };
type BrainRegionValue = {
  id: string;
  acronym: string;
  label: string;
  value: number;
  gyral: string;
  geometryKey: string | null;
  nCells: number;
  nDatasets: number;
  nDonors: number;
};

type GeneProfile = {
  geneIndex: number;
  symbol: string;
  color: string;
  regionValues: Record<string, number>;
  regionCoverage: Record<string, number>;
};

type CellGeneValue = {
  symbol: string;
  color: string;
  value: number;
  coverage: number;
};

type SheetValue = string | number | boolean | null | undefined;

type WorkbookSheet = {
  name: string;
  rows: SheetValue[][];
};

type GeneExportSelection = {
  role: string;
  geneIndex: number;
};

declare global {
  interface Window {
    ALLEN_3D_ATLAS?: AtlasGeometry;
  }
}

const EXAMPLE_SETS = [
  { label: "ASIC2", genes: ["ASIC2"] },
  { label: "AKT2 program", genes: ["AKT2", "CYP46A1", "CPT1C", "SNTA1"] },
  { label: "Synaptic", genes: ["SNAP25", "SYT1", "SLC17A7", "GAD1"] },
];

const REFERENCE_GENES = [
  ["GAPDH", "Housekeeping"],
  ["ACTB", "Housekeeping"],
  ["SNAP25", "Pan-neuronal"],
  ["SLC17A7", "Excitatory"],
  ["GAD1", "Inhibitory"],
  ["GFAP", "Astrocyte"],
  ["MBP", "Oligodendrocyte"],
  ["AIF1", "Microglia"],
  ["PDGFRA", "OPC"],
];

const REGION_COLORS: Record<string, string> = {
  a23: "#ff9b73",
  a32: "#ffd166",
};

const GENE_COLORS = [
  "#ff8f6b",
  "#64cbe6",
  "#ffd166",
  "#42d6b0",
  "#9aa7ff",
  "#d889ff",
  "#f4a340",
  "#8bd17c",
  "#ff77a8",
  "#9ec3cf",
];

const ATLAS_GENE_LAYER_LIMIT = 9;
const DEFAULT_BUNDLE_PATH = "/data/equal_study_v2";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "\"":
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function columnName(index: number) {
  let label = "";
  let current = index + 1;
  while (current > 0) {
    current -= 1;
    label = String.fromCharCode(65 + (current % 26)) + label;
    current = Math.floor(current / 26);
  }
  return label;
}

function sheetXml(rows: SheetValue[][]) {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === "") return "";
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          if (typeof value === "boolean") {
            return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const lastCell = rows.length
    ? `${columnName(Math.max(...rows.map((row) => row.length), 1) - 1)}${rows.length}`
    : "A1";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCell}"/><sheetData>${body}</sheetData></worksheet>`;
}

function textBytes(value: string) {
  return new TextEncoder().encode(value);
}

function makeXlsxZip(files: Array<{ name: string; data: Uint8Array }>) {
  const parts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const records: Array<{
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }> = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textBytes(file.name);
    const crc = crc32(file.data);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.byteLength, true);
    view.setUint32(22, file.data.byteLength, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    records.push({ nameBytes, data: file.data, crc, offset });
    parts.push(header, file.data);
    offset += header.byteLength + file.data.byteLength;
  }

  const centralOffset = offset;
  for (const record of records) {
    const header = new Uint8Array(46 + record.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.data.byteLength, true);
    view.setUint32(24, record.data.byteLength, true);
    view.setUint16(28, record.nameBytes.length, true);
    view.setUint32(42, record.offset, true);
    header.set(record.nameBytes, 46);
    centralParts.push(header);
    offset += header.byteLength;
  }

  const centralSize = offset - centralOffset;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, records.length, true);
  endView.setUint16(10, records.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return new Blob([...parts, ...centralParts, end], { type: XLSX_MIME });
}

function makeXlsxWorkbook(sheets: WorkbookSheet[]) {
  const worksheetOverrides = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const workbookSheets = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${xmlEscape(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  const workbookRels = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  const files = [
    {
      name: "[Content_Types].xml",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheetOverrides}</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`,
      ),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: textBytes(sheetXml(sheet.rows)),
    })),
  ];
  return makeXlsxZip(files);
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatValue(value: number, metric: Metric) {
  if (metric === "detection") return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  if (value === 0) return "0";
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

function metricLabel(metric: Metric) {
  return metric === "mean" ? "Mean expression" : "Detected nuclei";
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function lowerBound(values: string[], needle: string) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle] < needle) left = middle + 1;
    else right = middle;
  }
  return left;
}

function geneValue(
  manifest: AtlasManifest,
  chunks: Map<number, ExpressionChunk>,
  geneIndex: number,
  rowIndex: number,
  metric: Metric,
): { value: number; coverage: number } | null {
  const chunkIndex = Math.floor(geneIndex / manifest.matrix.chunkGeneCount);
  const chunk = chunks.get(chunkIndex);
  if (!chunk) return null;
  const localGene = geneIndex - chunk.descriptor.start;
  const offset = rowIndex * chunk.descriptor.count + localGene;
  const coverage = chunk.datasetCoverage[offset] ?? 0;
  if (coverage === 0) return null;
  const values = metric === "mean" ? chunk.mean : chunk.detection;
  return { value: values[offset] ?? 0, coverage };
}

function aggregateRegionGene(
  manifest: AtlasManifest,
  chunks: Map<number, ExpressionChunk>,
  region: RegionDescriptor,
  geneIndex: number,
  metric: Metric,
) {
  const byCellType = new Map<string, { value: number; coverage: number }[]>();
  region.rowIndices.forEach((rowIndex) => {
    const result = geneValue(manifest, chunks, geneIndex, rowIndex, metric);
    if (!result) return;
    const cellType = manifest.rows[rowIndex].cellType;
    const values = byCellType.get(cellType) ?? [];
    values.push(result);
    byCellType.set(cellType, values);
  });
  const available = Array.from(byCellType.values()).map((values) => ({
    value: values.reduce((sum, item) => sum + item.value, 0) / values.length,
    coverage: Math.max(...values.map((item) => item.coverage)),
  }));
  if (!available.length) return { value: 0, coverage: 0, representedRows: 0 };
  return {
    value: available.reduce((sum, item) => sum + item.value, 0) / available.length,
    coverage: Math.max(...available.map((item) => item.coverage)),
    representedRows: available.length,
  };
}

function joinOptionalIds(row: SummaryRow, plural: "datasetIds" | "donorIds" | "sampleIds") {
  const singular =
    plural === "datasetIds" ? row.datasetId : plural === "donorIds" ? row.donorId : row.sampleId;
  const values = row[plural] ?? (singular ? [singular] : []);
  return values.join("; ");
}

function collectRegionOptionalIds(
  manifest: AtlasManifest,
  region: RegionDescriptor,
  plural: "datasetIds" | "donorIds" | "sampleIds",
) {
  const values = new Set<string>();
  region.rowIndices.forEach((rowIndex) => {
    joinOptionalIds(manifest.rows[rowIndex], plural)
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => values.add(value));
  });
  return Array.from(values).join("; ");
}

function makeExportFilename(geneIndex: GeneIndex, selectedGenes: number[]) {
  const genePart =
    selectedGenes.length === 1
      ? geneIndex.symbols[selectedGenes[0]]
      : `${selectedGenes.length}_genes`;
  const cleaned = genePart.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  return `digitalbrain_gene_atlas_${cleaned}_${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function buildSelectionWorkbook({
  manifest,
  datasetLabel,
  geneIndex,
  chunks,
  selectedGenes,
  referenceGene,
  selectedRegionIds,
  metric,
}: {
  manifest: AtlasManifest;
  datasetLabel: string;
  geneIndex: GeneIndex;
  chunks: Map<number, ExpressionChunk>;
  selectedGenes: number[];
  referenceGene: number | null;
  selectedRegionIds: string[] | null;
  metric: Metric;
}) {
  const exportedAt = new Date().toISOString();
  const selectedGeneSet = new Set(selectedGenes);
  const geneSelections: GeneExportSelection[] = selectedGenes.map((geneIndexValue) => ({
    role: "query_gene",
    geneIndex: geneIndexValue,
  }));
  if (referenceGene !== null) {
    geneSelections.push({
      role: selectedGeneSet.has(referenceGene) ? "reference_gene_also_query" : "reference_gene",
      geneIndex: referenceGene,
    });
  }
  const selectedRegionSet = selectedRegionIds === null ? null : new Set(selectedRegionIds);
  const exportRegions = manifest.regions.filter(
    (region) => selectedRegionSet === null || selectedRegionSet.has(region.id),
  );
  const selectionScope =
    selectedRegionIds === null ? "all_regions" : `${exportRegions.length}_selected_regions`;

  const metadataRows: SheetValue[][] = [
    ["field", "value"],
    ["exported_at", exportedAt],
    ["source_file", manifest.source.file],
    ["source_sha256", manifest.source.sha256],
    ["source_created_at", manifest.source.sourceCreatedAt ?? ""],
    ["dataset_selection", datasetLabel],
    ["dataset_id", manifest.source.datasetId ?? ""],
    ["summary_scope", manifest.source.scope ?? "equal-study"],
    ["source_input_dataset_count", manifest.source.inputDatasets],
    ["total_cell_count", manifest.summary.cellCount],
    ["total_gene_feature_count", manifest.summary.geneCount],
    ["total_region_count", manifest.summary.regionCount],
    ["mapped_region_count", manifest.summary.mappedRegionCount],
    ["cell_type_count", manifest.summary.cellTypeCount],
    ["active_ui_metric", metric],
    ["mean_metric", manifest.normalization.label],
    ["detection_metric", manifest.normalization.detectionLabel],
    ["coverage_metric", manifest.normalization.coverageLabel ?? "Number of represented datasets"],
    ["coverage_unit", manifest.source.coverageUnit ?? "datasets"],
    ["regional_aggregation", manifest.normalization.regionalAggregation],
    ["selected_region_scope", selectionScope],
    ["selected_region_count", exportRegions.length],
    ["selected_genes", selectedGenes.map((index) => geneIndex.symbols[index]).join(", ")],
    [
      "reference_gene",
      referenceGene === null ? "" : geneIndex.symbols[referenceGene],
    ],
    ["missing_gene_rule", manifest.source.missingGeneRule],
    [
      "donor_information",
      "This browser bundle exports donor/sample counts per stratum. Individual donor/sample IDs are exported only when a future bundle includes those fields.",
    ],
    [
      "scientific_scope",
      "Descriptive abundance summary only; not differential expression, causality or validation evidence.",
    ],
  ];

  const regionalRows: SheetValue[][] = [
    [
      "gene_role",
      "gene_symbol",
      "gene_id",
      "id_kind",
      "source_occurrences",
      "region_id",
      "region_acronym",
      "region_label",
      "region_gyral",
      "geometry_status",
      "region_n_cells",
      "region_n_datasets",
      "region_n_donors",
      "region_n_cell_types",
      "low_coverage_cell_types",
      "dataset_ids",
      "donor_ids",
      "sample_ids",
      "mean_log1p_cp10k",
      "detection_fraction",
      "max_coverage_count",
      "represented_cell_type_count",
    ],
  ];

  const cellTypeRowsForWorkbook: SheetValue[][] = [
    [
      "gene_role",
      "gene_symbol",
      "gene_id",
      "id_kind",
      "source_occurrences",
      "region_id",
      "region_acronym",
      "region_label",
      "region_gyral",
      "cell_type",
      "summary_row_id",
      "n_cells",
      "n_datasets",
      "n_donors",
      "n_samples",
      "dataset_ids",
      "donor_ids",
      "sample_ids",
      "low_coverage",
      "mean_log1p_cp10k",
      "detection_fraction",
      "coverage_count",
    ],
  ];

  exportRegions.forEach((region) => {
    geneSelections.forEach((selection) => {
      const mean = aggregateRegionGene(
        manifest,
        chunks,
        region,
        selection.geneIndex,
        "mean",
      );
      const detection = aggregateRegionGene(
        manifest,
        chunks,
        region,
        selection.geneIndex,
        "detection",
      );
      regionalRows.push([
        selection.role,
        geneIndex.symbols[selection.geneIndex],
        geneIndex.ids[selection.geneIndex],
        geneIndex.idKinds[selection.geneIndex],
        geneIndex.sourceOccurrences[selection.geneIndex],
        region.id,
        region.acronym,
        region.label,
        region.gyral,
        region.geometryKey ? "3D_mapped" : "quantitative_only",
        region.nCells,
        region.nDatasets,
        region.nDonors,
        new Set(region.rowIndices.map((rowIndex) => manifest.rows[rowIndex].cellType)).size,
        region.rowIndices.filter((rowIndex) => manifest.rows[rowIndex].lowDatasetCoverage).length,
        collectRegionOptionalIds(manifest, region, "datasetIds"),
        collectRegionOptionalIds(manifest, region, "donorIds"),
        collectRegionOptionalIds(manifest, region, "sampleIds"),
        mean.representedRows > 0 ? mean.value : null,
        detection.representedRows > 0 ? detection.value : null,
        Math.max(mean.coverage, detection.coverage),
        Math.max(mean.representedRows, detection.representedRows),
      ]);

      region.rowIndices.forEach((rowIndex) => {
        const row = manifest.rows[rowIndex];
        const meanValue = geneValue(manifest, chunks, selection.geneIndex, rowIndex, "mean");
        const detectionValue = geneValue(
          manifest,
          chunks,
          selection.geneIndex,
          rowIndex,
          "detection",
        );
        cellTypeRowsForWorkbook.push([
          selection.role,
          geneIndex.symbols[selection.geneIndex],
          geneIndex.ids[selection.geneIndex],
          geneIndex.idKinds[selection.geneIndex],
          geneIndex.sourceOccurrences[selection.geneIndex],
          region.id,
          region.acronym,
          region.label,
          region.gyral,
          row.cellType,
          row.id,
          row.nCells,
          row.nDatasets,
          row.nDonors,
          row.nSamples,
          joinOptionalIds(row, "datasetIds"),
          joinOptionalIds(row, "donorIds"),
          joinOptionalIds(row, "sampleIds"),
          row.lowDatasetCoverage,
          meanValue?.value ?? null,
          detectionValue?.value ?? null,
          Math.max(meanValue?.coverage ?? 0, detectionValue?.coverage ?? 0),
        ]);
      });
    });
  });

  return makeXlsxWorkbook([
    { name: "regional_abundance", rows: regionalRows },
    { name: "cell_type_abundance", rows: cellTypeRowsForWorkbook },
    { name: "selection_metadata", rows: metadataRows },
  ]);
}

async function fetchGzipBuffer(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Data block ${url} is unavailable.`);
  const compressed = await response.arrayBuffer();
  const bytes = new Uint8Array(compressed);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return compressed;
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function fetchAtlasBundle(option: AtlasDatasetOption) {
  const bundlePath = option.bundlePath.replace(/\/$/, "");
  const manifestResponse = await fetch(`${bundlePath}/manifest.json`);
  if (!manifestResponse.ok) throw new Error(`The ${option.label} manifest is unavailable.`);
  const manifest = (await manifestResponse.json()) as AtlasManifest;
  const geneBuffer = await fetchGzipBuffer(`${bundlePath}/${manifest.genes.indexFile}`);
  const geneIndex = JSON.parse(new TextDecoder().decode(geneBuffer)) as GeneIndex;
  if (geneIndex.symbols.length !== manifest.matrix.geneCount) {
    throw new Error(`The ${option.label} gene index has an unexpected shape.`);
  }
  return { bundlePath, manifest, geneIndex };
}

function useAtlasData() {
  const [manifest, setManifest] = useState<AtlasManifest | null>(null);
  const [geneIndex, setGeneIndex] = useState<GeneIndex | null>(null);
  const [chunks, setChunks] = useState<Map<number, ExpressionChunk>>(new Map());
  const [datasetOptions, setDatasetOptions] = useState<AtlasDatasetOption[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState("");
  const [loadingDatasetId, setLoadingDatasetId] = useState("");
  const [geometry, setGeometry] = useState<AtlasGeometry | null>(() =>
    typeof window === "undefined" ? null : (window.ALLEN_3D_ATLAS ?? null),
  );
  const [loadingGenes, setLoadingGenes] = useState(false);
  const [error, setError] = useState("");
  const [bundlePath, setBundlePath] = useState(DEFAULT_BUNDLE_PATH);
  const chunksRef = useRef<Map<number, ExpressionChunk>>(new Map());
  const pendingRef = useRef<Map<number, Promise<ExpressionChunk>>>(new Map());
  const bundleGenerationRef = useRef(0);
  const selectionRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const configResponse = await fetch("/data/atlas_source.json");
        const config = configResponse.ok
          ? ((await configResponse.json()) as AtlasSourceConfig)
          : { bundlePath: DEFAULT_BUNDLE_PATH };
        const fallbackOption: AtlasDatasetOption = {
          id: "all_equal_study",
          label: config.label ?? "Combined atlas · equal study",
          bundlePath: config.bundlePath || DEFAULT_BUNDLE_PATH,
        };
        const options = (config.datasets?.length ? config.datasets : [fallbackOption]).map(
          (option) => ({ ...option, bundlePath: option.bundlePath.replace(/\/$/, "") }),
        );
        const initialOption =
          options.find((option) => option.id === config.defaultDatasetId) ?? options[0];
        if (!initialOption) throw new Error("No atlas dataset is configured.");
        if (active) {
          setDatasetOptions(options);
          setLoadingDatasetId(initialOption.id);
        }
        const loaded = await fetchAtlasBundle(initialOption);
        if (!active) return;
        bundleGenerationRef.current += 1;
        setBundlePath(loaded.bundlePath);
        setManifest(loaded.manifest);
        setGeneIndex(loaded.geneIndex);
        setActiveDatasetId(initialOption.id);
        setLoadingDatasetId("");
      } catch (loadError) {
        if (active) {
          setLoadingDatasetId("");
          setError(loadError instanceof Error ? loadError.message : "Data loading failed.");
        }
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const selectDataset = useCallback(
    async (datasetId: string) => {
      if (!datasetId || datasetId === activeDatasetId) return true;
      const option = datasetOptions.find((candidate) => candidate.id === datasetId);
      if (!option) {
        setError("The selected atlas dataset is not configured.");
        return false;
      }
      const requestId = selectionRequestRef.current + 1;
      selectionRequestRef.current = requestId;
      setLoadingDatasetId(datasetId);
      setError("");
      try {
        const loaded = await fetchAtlasBundle(option);
        if (requestId !== selectionRequestRef.current) return false;
        bundleGenerationRef.current += 1;
        chunksRef.current = new Map();
        pendingRef.current = new Map();
        setChunks(new Map());
        setBundlePath(loaded.bundlePath);
        setManifest(loaded.manifest);
        setGeneIndex(loaded.geneIndex);
        setActiveDatasetId(datasetId);
        return true;
      } catch (loadError) {
        if (requestId === selectionRequestRef.current) {
          setError(loadError instanceof Error ? loadError.message : "Dataset loading failed.");
        }
        return false;
      } finally {
        if (requestId === selectionRequestRef.current) setLoadingDatasetId("");
      }
    },
    [activeDatasetId, datasetOptions],
  );

  const loadGenes = useCallback(
    async (geneIndices: number[]) => {
      if (!manifest || !geneIndices.length) return;
      const generation = bundleGenerationRef.current;
      const required = Array.from(
        new Set(
          geneIndices
            .filter((index) => index >= 0 && index < manifest.matrix.geneCount)
            .map((index) => Math.floor(index / manifest.matrix.chunkGeneCount)),
        ),
      ).filter((index) => !chunksRef.current.has(index));
      if (!required.length) return;
      setLoadingGenes(true);
      try {
        await Promise.all(
          required.map(async (chunkIndex) => {
            let pending = pendingRef.current.get(chunkIndex);
            if (!pending) {
              const descriptor = manifest.chunks[chunkIndex];
              if (!descriptor) return;
              pending = (async () => {
                const buffer = await fetchGzipBuffer(
                  `${bundlePath}/${descriptor.file}`,
                );
                const valueCount = manifest.matrix.rowCount * descriptor.count;
                const expectedBytes = valueCount * descriptor.bytesPerValue;
                if (buffer.byteLength !== expectedBytes) {
                  throw new Error(`Gene block ${chunkIndex} has an unexpected shape.`);
                }
                if (descriptor.encoding !== "quantized-u16") {
                  throw new Error(`Gene block ${chunkIndex} uses an unsupported encoding.`);
                }
                const encodedMean = new Uint16Array(buffer, 0, valueCount);
                const encodedDetection = new Uint16Array(
                  buffer,
                  valueCount * 2,
                  valueCount,
                );
                const mean = new Float32Array(valueCount);
                const detection = new Float32Array(valueCount);
                for (let index = 0; index < valueCount; index += 1) {
                  mean[index] = encodedMean[index] * descriptor.meanScale;
                  detection[index] =
                    encodedDetection[index] * descriptor.detectionScale;
                }
                return {
                  descriptor,
                  mean,
                  detection,
                  datasetCoverage: new Uint8Array(buffer, valueCount * 4, valueCount),
                };
              })();
              pendingRef.current.set(chunkIndex, pending);
            }
            const chunk = await pending;
            if (generation !== bundleGenerationRef.current) return;
            chunksRef.current.set(chunkIndex, chunk);
            if (pendingRef.current.get(chunkIndex) === pending) {
              pendingRef.current.delete(chunkIndex);
            }
          }),
        );
        if (generation === bundleGenerationRef.current) {
          setChunks(new Map(chunksRef.current));
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Gene data loading failed.");
      } finally {
        setLoadingGenes(false);
      }
    },
    [bundlePath, manifest],
  );

  useEffect(() => {
    if (window.ALLEN_3D_ATLAS) return;
    const script = document.createElement("script");
    script.src = "/data/allen_3d_geometry.js";
    script.async = true;
    script.onload = () => setGeometry(window.ALLEN_3D_ATLAS ?? null);
    script.onerror = () => setError("The 3D anatomy layer could not be loaded.");
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  const activeDataset =
    datasetOptions.find((option) => option.id === activeDatasetId) ?? null;
  return {
    manifest,
    geneIndex,
    chunks,
    geometry,
    loadingGenes,
    loadGenes,
    error,
    datasetOptions,
    activeDataset,
    selectedDatasetId: loadingDatasetId || activeDatasetId,
    datasetLoading: Boolean(loadingDatasetId),
    selectDataset,
  };
}

function RegionSelector({
  regions,
  selectedRegionIds,
  focusedRegion,
  onShowAll,
  onShowMapped,
  onToggle,
}: {
  regions: RegionDescriptor[];
  selectedRegionIds: string[] | null;
  focusedRegion: string;
  onShowAll: () => void;
  onShowMapped: () => void;
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = useMemo(
    () => (selectedRegionIds === null ? null : new Set(selectedRegionIds)),
    [selectedRegionIds],
  );
  const mappedCount = regions.filter((region) => region.geometryKey).length;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return regions;
    return regions.filter((region) =>
      [region.id, region.acronym, region.label, region.gyral]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [regions, search]);

  return (
    <section className="region-filter panel" aria-label="Brain region display selection">
      <div className="region-filter-heading">
        <div className="query-heading">
          <span className="step-number">02</span>
          <div>
            <p className="eyebrow">Brain-region filter</p>
            <h2>Choose regions to display</h2>
          </div>
        </div>
        <p>
          Filter expression spots, regional bars and the region sidebar together.
          Subset selections receive a cyan 3D border; the focused parcel is amber.
        </p>
      </div>
      <div className="region-filter-tools">
        <label className="region-search">
          <span className="search-icon" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search region code, name or gyral label"
            aria-label="Search brain regions"
          />
        </label>
        <div className="region-presets" aria-label="Region selection presets">
          <button
            type="button"
            className={selected === null ? "active" : ""}
            onClick={onShowAll}
          >
            All {regions.length}
          </button>
          <button
            type="button"
            className={
              selected !== null &&
              selected.size === mappedCount &&
              regions.filter((region) => region.geometryKey).every((region) => selected.has(region.id))
                ? "active"
                : ""
            }
            onClick={onShowMapped}
          >
            3D mapped {mappedCount}
          </button>
          <span>
            {selected === null ? `All ${regions.length} shown` : `${selected.size} selected`}
          </span>
        </div>
      </div>
      <div className="region-options">
        {filtered.map((region) => {
          const active = selected === null || selected.has(region.id);
          const focused = region.id === focusedRegion;
          return (
            <button
              type="button"
              key={region.id}
              className={`${active ? "active" : ""} ${focused ? "focused" : ""}`}
              aria-pressed={active}
              onClick={() => onToggle(region.id)}
              title={region.geometryKey ? "3D and quantitative region" : "Quantitative-only region"}
            >
              <i aria-hidden="true">{active ? "✓" : ""}</i>
              <strong>{region.acronym}</strong>
              <span>{region.label}</span>
              <em>{region.geometryKey ? "3D" : "data"}</em>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="region-empty">No brain region matches “{search}”.</p>
        )}
      </div>
      <p className="region-filter-note">
        Quantitative-only regions can be filtered and compared, but cannot receive a 3D border until an anatomical geometry crosswalk is supplied.
      </p>
    </section>
  );
}

function BrainViewer({
  geometry,
  regions,
  geneProfiles,
  selectedRegion,
  highlightedRegionIds,
  onSelect,
  autoRotate,
}: {
  geometry: AtlasGeometry | null;
  regions: BrainRegionValue[];
  geneProfiles: GeneProfile[];
  selectedRegion: string;
  highlightedRegionIds: string[];
  onSelect: (id: string) => void;
  autoRotate: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotationRef = useRef({ x: -0.08, y: -0.68, zoom: 1 });
  const targetRef = useRef({ x: -0.08, y: -0.68, zoom: 1 });
  const dragRef = useRef({
    active: false,
    moved: false,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
  });
  const hitTargetsRef = useRef<Array<{ id: string; x: number; y: number; radius: number }>>([]);
  const highlightedRegions = useMemo(
    () => new Set(highlightedRegionIds),
    [highlightedRegionIds],
  );

  const decoded = useMemo(() => {
    if (!geometry) return null;
    const bounds = geometry.metadata.nonzeroVoxelBounds;
    const voxelSize = geometry.metadata.voxelSizeMm;
    const voxelOffset = geometry.metadata.qoffsetMm;
    const physicalMinimum = bounds.minimum.map(
      (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
    );
    const physicalMaximum = bounds.maximum.map(
      (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
    );
    const center = physicalMinimum.map(
      (value, axis) => (value + physicalMaximum[axis]) / 2,
    );
    const scale = Math.max(
      ...physicalMinimum.map(
        (value, axis) => (physicalMaximum[axis] - value) / 2,
      ),
    );
    const voxelToPoint = (voxel: number[]): Point3D => {
      const physical = voxel.map(
        (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
      );
      return {
        x: (physical[0] - center[0]) / scale,
        y: (physical[2] - center[2]) / scale,
        z: (physical[1] - center[1]) / scale,
      };
    };
    const decodeGroups = (flat: number[]) => {
      const groups: Point3D[][] = Array.from(
        { length: geometry.labels.length },
        () => [],
      );
      for (let index = 0; index < flat.length; index += 4) {
        groups[flat[index + 3]].push(
          voxelToPoint([flat[index], flat[index + 1], flat[index + 2]]),
        );
      }
      return groups;
    };
    return {
      outer: decodeGroups(geometry.outerPoints),
      boundary: decodeGroups(geometry.boundaryPoints),
      voxelToPoint,
    };
  }, [geometry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geometry || !decoded) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let previous = performance.now();
    let width = 1;
    let height = 1;
    let pixelRatio = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const rotate = (point: Point3D) => {
      const rotation = rotationRef.current;
      const cy = Math.cos(rotation.y);
      const sy = Math.sin(rotation.y);
      const cx = Math.cos(rotation.x);
      const sx = Math.sin(rotation.x);
      const x1 = point.x * cy - point.z * sy;
      const z1 = point.x * sy + point.z * cy;
      return {
        x: x1,
        y: point.y * cx - z1 * sx,
        z: point.y * sx + z1 * cx,
      };
    };
    const project = (point: Point3D) => {
      const rotated = rotate(point);
      const baseScale = Math.min(width * 0.34, height * 0.43) * rotationRef.current.zoom;
      const perspective = 3.2 / (3.1 + rotated.z);
      return {
        x: width * 0.5 + rotated.x * baseScale * perspective,
        y: height * 0.5 - rotated.y * baseScale * perspective,
        z: rotated.z,
        perspective,
      };
    };
    const drawPointGroups = (groups: Point3D[][], alpha: number, size: number) => {
      context.fillStyle = `rgba(131, 162, 183, ${alpha})`;
      for (const points of groups) {
        for (const point of points) {
          const projected = project(point);
          const pointSize = Math.max(0.55, size * projected.perspective);
          context.fillRect(projected.x, projected.y, pointSize, pointSize);
        }
      }
    };
    const render = (now: number) => {
      const delta = Math.min(50, now - previous);
      previous = now;
      if (autoRotate && !dragRef.current.active) {
        targetRef.current.y += delta * 0.00011;
      }
      const rotation = rotationRef.current;
      const target = targetRef.current;
      rotation.x += (target.x - rotation.x) * 0.1;
      rotation.y += (target.y - rotation.y) * 0.1;
      rotation.zoom += (target.zoom - rotation.zoom) * 0.12;

      context.clearRect(0, 0, width, height);
      const wash = context.createRadialGradient(
        width * 0.5,
        height * 0.46,
        10,
        width * 0.5,
        height * 0.46,
        Math.min(width, height) * 0.48,
      );
      wash.addColorStop(0, "rgba(53, 100, 123, 0.17)");
      wash.addColorStop(1, "rgba(8, 20, 33, 0)");
      context.fillStyle = wash;
      context.fillRect(0, 0, width, height);

      drawPointGroups(decoded.outer, 0.075, 1.2);
      drawPointGroups(decoded.boundary, 0.25, 0.95);

      const displayedGenes = geneProfiles.slice(0, ATLAS_GENE_LAYER_LIMIT);
      const maximum = Math.max(
        ...displayedGenes.flatMap((profile) =>
          regions.map((region) => profile.regionValues[region.id] ?? 0),
        ),
        0,
      );
      const hitTargets: Array<{ id: string; x: number; y: number; radius: number }> = [];
      const parcels = regions
        .filter(
          (region) =>
            region.geometryKey && geometry.regionMappings[region.geometryKey],
        )
        .map((region) => {
          const mapping = geometry.regionMappings[region.geometryKey!];
          const points =
            mapping?.labelIndices.flatMap((labelIndex) => decoded.boundary[labelIndex]) ?? [];
          const centroids =
            mapping?.labelIndices.map((labelIndex) =>
              decoded.voxelToPoint(geometry.labels[labelIndex].centroidVoxel),
            ) ?? [];
          const centroid =
            centroids.length > 0
              ? centroids.reduce(
                  (sum, point) => ({
                    x: sum.x + point.x / centroids.length,
                    y: sum.y + point.y / centroids.length,
                    z: sum.z + point.z / centroids.length,
                  }),
                  { x: 0, y: 0, z: 0 },
                )
              : { x: 0, y: 0, z: 0 };
          return {
            ...region,
            points,
            centroid,
            depth: project(centroid).z,
          };
        })
        .sort((left, right) => left.depth - right.depth);

      for (const parcel of parcels) {
        const selected = parcel.id === selectedRegion;
        const highlighted = highlightedRegions.has(parcel.id);
        const outlined = selected || highlighted;
        const color = REGION_COLORS[parcel.id.toLowerCase()] ?? "#ff9b73";
        const outlineColor = selected ? "#ffd166" : "#64cbe6";

        context.save();
        context.fillStyle = outlined
          ? hexToRgba(outlineColor, selected ? 0.82 : 0.58)
          : "rgba(207, 230, 236, 0.18)";
        context.shadowColor = outlineColor;
        context.shadowBlur = outlined ? (selected ? 9 : 5) : 0;
        parcel.points.forEach((point, index) => {
          if (!outlined && index % 4 !== 0) return;
          const projected = project(point);
          const pointSize = (selected ? 2.45 : highlighted ? 1.85 : 0.85) * projected.perspective;
          context.fillRect(
            projected.x - pointSize / 2,
            projected.y - pointSize / 2,
            pointSize,
            pointSize,
          );
        });
        context.restore();

        if (displayedGenes.length > 0 && maximum > 0) {
          context.save();
          context.shadowBlur = selected ? 7 : 3;
          for (let index = 0; index < parcel.points.length; index += 1) {
            const profile = displayedGenes[index % displayedGenes.length];
            const value = profile.regionValues[parcel.id] ?? 0;
            const intensity = value / maximum;
            if (intensity <= 0) continue;
            const deterministic =
              ((index * 67 + profile.geneIndex * 13 + parcel.id.charCodeAt(0)) % 100) /
              100;
            const density = Math.min(0.92, 0.04 + intensity * 0.68 + (selected ? 0.14 : 0));
            if (deterministic > density) continue;
            const projected = project(parcel.points[index]);
            const jitterPhase = profile.geneIndex * 2.1 + index * 0.027;
            const scatter = displayedGenes.length > 1 ? 0.5 + intensity * 1.15 : 0;
            const pointSize =
              (selected ? 2.05 : 0.95 + intensity * 1.15) * projected.perspective;
            context.fillStyle = hexToRgba(
              profile.color,
              selected ? 0.78 : 0.36 + intensity * 0.42,
            );
            context.shadowColor = profile.color;
            context.fillRect(
              projected.x + Math.cos(jitterPhase) * scatter - pointSize / 2,
              projected.y + Math.sin(jitterPhase) * scatter - pointSize / 2,
              pointSize,
              pointSize,
            );
          }
          context.restore();
        }

        const markerPoint = project(parcel.centroid);
        const radius = selected ? 27 : 21;
        hitTargets.push({ id: parcel.id, x: markerPoint.x, y: markerPoint.y, radius });
        context.save();
        context.fillStyle = selected ? hexToRgba(color, 0.42) : "rgba(222, 239, 242, 0.1)";
        context.strokeStyle = selected ? color : "rgba(203, 228, 238, 0.28)";
        context.lineWidth = selected ? 1.4 : 0.8;
        context.beginPath();
        context.arc(markerPoint.x, markerPoint.y, selected ? 7 : 5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }
      hitTargetsRef.current = hitTargets;
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [autoRotate, decoded, geneProfiles, geometry, highlightedRegions, regions, selectedRegion]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      active: true,
      moved: false,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
      drag.moved = true;
    }
    targetRef.current.y += dx * 0.008;
    targetRef.current.x = Math.max(
      -1.15,
      Math.min(1.15, targetRef.current.x + dy * 0.006),
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    drag.active = false;
    if (!drag.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = [...hitTargetsRef.current]
        .sort(
          (left, right) =>
            Math.hypot(left.x - x, left.y - y) -
            Math.hypot(right.x - x, right.y - y),
        )
        .find((target) => Math.hypot(target.x - x, target.y - y) <= target.radius);
      if (hit) onSelect(hit.id);
    }
  };

  return (
    <div className="brain-stage">
      <canvas
        ref={canvasRef}
        aria-label="Rotatable Allen-derived 3D brain atlas with gene expression parcels"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => {
          event.preventDefault();
          targetRef.current.zoom = Math.max(
            0.72,
            Math.min(1.55, targetRef.current.zoom - event.deltaY * 0.0008),
          );
        }}
      />
      {!geometry && <div className="viewer-loading">Preparing 3D anatomy…</div>}
      <div className="orientation-cue" aria-hidden="true">
        <span>A</span>
        <span>P</span>
      </div>
      <div className="view-controls" aria-label="Manual brain rotation controls">
        <button
          type="button"
          onClick={() => {
            targetRef.current.y -= 0.38;
          }}
          aria-label="Rotate view left"
        >
          L
        </button>
        <button
          type="button"
          onClick={() => {
            targetRef.current.y += 0.38;
          }}
          aria-label="Rotate view right"
        >
          R
        </button>
        <button
          type="button"
          onClick={() => {
            targetRef.current.x = Math.max(-1.15, targetRef.current.x - 0.3);
          }}
          aria-label="Rotate view upward"
        >
          U
        </button>
        <button
          type="button"
          onClick={() => {
            targetRef.current.x = Math.min(1.15, targetRef.current.x + 0.3);
          }}
          aria-label="Rotate view downward"
        >
          D
        </button>
        <button
          type="button"
          onClick={() => {
            targetRef.current = { x: -0.08, y: -0.68, zoom: 1 };
          }}
          aria-label="Reset brain view"
        >
          0
        </button>
      </div>
      <div className="drag-cue">Drag to rotate · scroll to zoom · click a region dot</div>
    </div>
  );
}

function RegionHistogram({
  regions,
  geneProfiles,
  referenceValues,
  referenceCoverage,
  metric,
  selectedRegion,
  onSelect,
}: {
  regions: BrainRegionValue[];
  geneProfiles: GeneProfile[];
  referenceValues: Record<string, number>;
  referenceCoverage: Record<string, number>;
  metric: Metric;
  selectedRegion: string;
  onSelect: (id: string) => void;
}) {
  const displayedGenes = geneProfiles.slice(0, 12);
  const maximum = Math.max(
    ...regions.flatMap((region) => [
      ...displayedGenes.map((profile) => profile.regionValues[region.id] ?? 0),
      referenceValues[region.id] ?? 0,
    ]),
    metric === "detection" ? 0.01 : 0.001,
  );
  return (
    <div className="histogram">
      <div className="histogram-axis">
        <span>{formatValue(maximum, metric)}</span>
        <span>{formatValue(maximum / 2, metric)}</span>
        <span>0</span>
      </div>
      <div className="histogram-plot">
        <div className="histogram-grid" aria-hidden="true" />
        {regions.map((region) => {
          const reference = referenceValues[region.id] ?? 0;
          const geneMaximum = Math.max(
            ...displayedGenes.map((profile) => profile.regionValues[region.id] ?? 0),
            0,
          );
          return (
            <button
              className={`bar-group ${selectedRegion === region.id ? "selected" : ""}`}
              key={region.id}
              onClick={() => onSelect(region.id)}
              type="button"
              aria-label={`Select ${region.label}`}
            >
              <div className="bar-values">
                <span>
                  {displayedGenes.length === 1
                    ? formatValue(geneMaximum, metric)
                    : `${displayedGenes.length} genes`}
                </span>
              </div>
              <div className="paired-bars multi-gene-bars">
                {displayedGenes.map((profile) => {
                  const value = profile.regionValues[region.id] ?? 0;
                  const covered = (profile.regionCoverage[region.id] ?? 0) > 0;
                  return (
                    <span
                      className="bar gene-bar"
                      key={profile.geneIndex}
                      style={{
                        height: covered
                          ? `${Math.max(2, (value / maximum) * 100)}%`
                          : "0%",
                        background: profile.color,
                      }}
                      title={`${profile.symbol}: ${covered ? formatValue(value, metric) : "not covered"}`}
                    />
                  );
                })}
                <span
                  className="bar reference-bar"
                  style={{
                    height:
                      (referenceCoverage[region.id] ?? 0) > 0
                        ? `${Math.max(2, (reference / maximum) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
              <strong>{region.acronym}</strong>
              <small>{region.gyral}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RegionSidebar({
  regions,
  geneProfiles,
  referenceValues,
  referenceCoverage,
  metric,
  selectedRegion,
  onSelect,
  geometry,
}: {
  regions: BrainRegionValue[];
  geneProfiles: GeneProfile[];
  referenceValues: Record<string, number>;
  referenceCoverage: Record<string, number>;
  metric: Metric;
  selectedRegion: string;
  onSelect: (id: string) => void;
  geometry: AtlasGeometry | null;
}) {
  const displayedGenes = geneProfiles.slice(0, 6);
  const maximum = Math.max(
    ...regions.flatMap((region) => [
      ...displayedGenes.map((profile) => profile.regionValues[region.id] ?? 0),
      referenceValues[region.id] ?? 0,
    ]),
    metric === "detection" ? 0.01 : 0.001,
  );

  return (
    <aside className="region-sidebar" aria-label="Brain regions">
      <div className="region-sidebar-heading">
        <span>Regions</span>
        <strong>{regions.length}</strong>
      </div>
      <div className="region-list">
        {regions.map((region) => {
          const mapping = region.geometryKey
            ? geometry?.regionMappings[region.geometryKey]
            : undefined;
          const reference = referenceValues[region.id] ?? 0;
          return (
            <button
              type="button"
              key={region.id}
              className={`region-card ${selectedRegion === region.id ? "selected" : ""}`}
              onClick={() => onSelect(region.id)}
            >
              <span className="region-code">{region.acronym}</span>
              <div className="region-card-copy">
                <strong>{region.label}</strong>
                <small>{mapping?.basis ?? "Quantitative profile · no 3D mapping"}</small>
              </div>
              <div className="region-card-bars">
                {displayedGenes.map((profile) => {
                  const value = profile.regionValues[region.id] ?? 0;
                  const covered = (profile.regionCoverage[region.id] ?? 0) > 0;
                  return (
                    <span key={profile.geneIndex}>
                      <i
                        style={{
                          background: profile.color,
                          width: covered ? `${(value / maximum) * 100}%` : "0%",
                        }}
                      />
                      <em>{profile.symbol}</em>
                      <b>{covered ? formatValue(value, metric) : "—"}</b>
                    </span>
                  );
                })}
                <span className="reference-line">
                  <i
                    style={{
                      width:
                        (referenceCoverage[region.id] ?? 0) > 0
                          ? `${(reference / maximum) * 100}%`
                          : "0%",
                    }}
                  />
                  <em>Reference</em>
                  <b>
                    {(referenceCoverage[region.id] ?? 0) > 0
                      ? formatValue(reference, metric)
                      : "—"}
                  </b>
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export default function GeneAtlasExplorer() {
  const {
    manifest,
    geneIndex,
    chunks,
    geometry,
    loadingGenes,
    loadGenes,
    error,
    datasetOptions,
    activeDataset,
    selectedDatasetId,
    datasetLoading,
    selectDataset,
  } = useAtlasData();
  const [metric, setMetric] = useState<Metric>("mean");
  const [queryText, setQueryText] = useState("");
  const [selectedGenes, setSelectedGenes] = useState<number[]>([]);
  const [referenceGene, setReferenceGene] = useState<number | null>(null);
  const [selectedRegion, setSelectedRegion] = useState("A23");
  const [selectedRegionIds, setSelectedRegionIds] = useState<string[] | null>(null);
  const [rotationMode, setRotationMode] = useState<"manual" | "spin">("manual");
  const [searchMessage, setSearchMessage] = useState("");
  const [downloadNotice, setDownloadNotice] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  const initializedDatasetRef = useRef("");
  const datasetSelectionSnapshotRef = useRef<{
    geneSymbols: string[];
    referenceSymbol: string | null;
    selectedRegion: string;
    selectedRegionIds: string[] | null;
  } | null>(null);

  const resolveGene = useCallback(
    (token: string) => {
      if (!geneIndex) return undefined;
      const normalized = token.trim().toUpperCase();
      if (!normalized) return undefined;
      const position = lowerBound(geneIndex.searchTokens, normalized);
      if (geneIndex.searchTokens[position] !== normalized) return undefined;
      return geneIndex.searchIndices[position];
    },
    [geneIndex],
  );

  useEffect(() => {
    if (!manifest || !geneIndex || !activeDataset) return;
    if (initializedDatasetRef.current === activeDataset.id) return;
    const snapshot = datasetSelectionSnapshotRef.current;
    const requestedGenes = snapshot?.geneSymbols ?? ["ASIC2"];
    const nextGenes = requestedGenes.flatMap((symbol) => {
      const index = resolveGene(symbol);
      return index === undefined ? [] : [index];
    });
    const referenceSymbol = snapshot?.referenceSymbol ?? "GAPDH";
    const reference = referenceSymbol ? resolveGene(referenceSymbol) : undefined;
    const preferredRegion = snapshot?.selectedRegion ?? "A23";
    const nextRegion = manifest.regions.some((region) => region.id === preferredRegion)
      ? preferredRegion
      : manifest.regions[0]?.id ?? "";
    const availableRegionIds = new Set(manifest.regions.map((region) => region.id));
    const nextRegionSelection =
      snapshot?.selectedRegionIds === null || snapshot?.selectedRegionIds === undefined
        ? null
        : snapshot.selectedRegionIds.filter((id) => availableRegionIds.has(id));
    const missing = requestedGenes.filter((symbol) => resolveGene(symbol) === undefined);
    initializedDatasetRef.current = activeDataset.id;
    datasetSelectionSnapshotRef.current = null;
    const timer = window.setTimeout(() => {
      setSelectedGenes(nextGenes);
      if (reference !== undefined) setReferenceGene(reference);
      else setReferenceGene(null);
      setSelectedRegion(nextRegion);
      setSelectedRegionIds(nextRegionSelection?.length ? nextRegionSelection : null);
      setSearchMessage(
        missing.length
          ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not measured in ${activeDataset.label}.`
          : "",
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeDataset, geneIndex, manifest, resolveGene]);

  useEffect(() => {
    const requested = [
      ...selectedGenes,
      ...(referenceGene === null ? [] : [referenceGene]),
    ];
    void loadGenes(requested);
  }, [loadGenes, referenceGene, selectedGenes]);

  const suggestions = useMemo(() => {
    if (!geneIndex || queryText.trim().length < 1) return [];
    const needle = queryText.trim().toUpperCase();
    const start = lowerBound(geneIndex.searchTokens, needle);
    const selected = new Set(selectedGenes);
    const unique = new Set<number>();
    for (let index = start; index < geneIndex.searchTokens.length; index += 1) {
      if (!geneIndex.searchTokens[index].startsWith(needle)) break;
      const gene = geneIndex.searchIndices[index];
      if (!selected.has(gene)) unique.add(gene);
      if (unique.size === 6) break;
    }
    return Array.from(unique);
  }, [geneIndex, queryText, selectedGenes]);

  const addGenes = useCallback(
    (tokens: string[], replace = false) => {
      if (!geneIndex) return;
      const resolved: number[] = [];
      const missing: string[] = [];
      tokens.forEach((token) => {
        const index = resolveGene(token);
        if (index === undefined) missing.push(token);
        else resolved.push(index);
      });
      if (resolved.length) {
        setSelectedGenes((current) =>
          Array.from(new Set(replace ? resolved : [...current, ...resolved])),
        );
        setQueryText("");
      }
      setSearchMessage(
        missing.length
          ? `${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found in the selected dataset's feature registry.`
          : "",
      );
    },
    [geneIndex, resolveGene],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const tokens = queryText
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length) addGenes(tokens);
    else if (suggestions[0] !== undefined && geneIndex) {
      addGenes([geneIndex.symbols[suggestions[0]]]);
    }
  };

  const changeAtlasDataset = useCallback(
    (datasetId: string) => {
      if (!geneIndex || datasetId === activeDataset?.id) return;
      const previousGenes = [...selectedGenes];
      const previousReference = referenceGene;
      datasetSelectionSnapshotRef.current = {
        geneSymbols: selectedGenes.map((index) => geneIndex.symbols[index]),
        referenceSymbol:
          referenceGene === null ? null : geneIndex.symbols[referenceGene],
        selectedRegion,
        selectedRegionIds,
      };
      setSelectedGenes([]);
      setReferenceGene(null);
      setQueryText("");
      setSearchMessage("");
      setDownloadNotice(null);
      void selectDataset(datasetId).then((success) => {
        if (success) return;
        datasetSelectionSnapshotRef.current = null;
        setSelectedGenes(previousGenes);
        setReferenceGene(previousReference);
      });
    },
    [
      activeDataset?.id,
      geneIndex,
      referenceGene,
      selectDataset,
      selectedGenes,
      selectedRegion,
      selectedRegionIds,
    ],
  );

  const regionGeneAggregate = useCallback(
    (region: RegionDescriptor, gene: number) => {
      if (!manifest) return { value: 0, coverage: 0 };
      return aggregateRegionGene(manifest, chunks, region, gene, metric);
    },
    [chunks, manifest, metric],
  );

  const geneProfiles = useMemo<GeneProfile[]>(() => {
    if (!manifest || !geneIndex) return [];
    return selectedGenes.map((gene, order) => {
      const regionAggregates = manifest.regions.map((region) => [
        region.id,
        regionGeneAggregate(region, gene),
      ] as const);
      return {
        geneIndex: gene,
        symbol: geneIndex.symbols[gene],
        color: GENE_COLORS[order % GENE_COLORS.length],
        regionValues: Object.fromEntries(
          regionAggregates.map(([id, aggregate]) => [id, aggregate.value]),
        ),
        regionCoverage: Object.fromEntries(
          regionAggregates.map(([id, aggregate]) => [id, aggregate.coverage]),
        ),
      };
    });
  }, [geneIndex, manifest, regionGeneAggregate, selectedGenes]);

  const regionValues = useMemo<BrainRegionValue[]>(() => {
    if (!manifest) return [];
    return manifest.regions.map((region) => {
      const present = geneProfiles.flatMap((profile) =>
        (profile.regionCoverage[region.id] ?? 0) > 0
          ? [profile.regionValues[region.id] ?? 0]
          : [],
      );
      return {
        id: region.id,
        acronym: region.acronym,
        label: region.label,
        value:
          present.length > 0
            ? present.reduce((sum, value) => sum + value, 0) / present.length
            : 0,
        gyral: region.gyral,
        geometryKey: region.geometryKey,
        nCells: region.nCells,
        nDatasets: region.nDatasets,
        nDonors: region.nDonors,
      };
    });
  }, [geneProfiles, manifest]);

  const displayedRegionValues = useMemo(() => {
    if (selectedRegionIds === null) return regionValues;
    const selected = new Set(selectedRegionIds);
    return regionValues.filter((region) => selected.has(region.id));
  }, [regionValues, selectedRegionIds]);

  const showAllRegions = useCallback(() => {
    setSelectedRegionIds(null);
  }, []);

  const showMappedRegions = useCallback(() => {
    if (!manifest) return;
    const mapped = manifest.regions
      .filter((region) => region.geometryKey)
      .map((region) => region.id);
    setSelectedRegionIds(mapped);
    if (!mapped.includes(selectedRegion)) setSelectedRegion(mapped[0] ?? "");
  }, [manifest, selectedRegion]);

  const toggleDisplayedRegion = useCallback((id: string) => {
    if (selectedRegionIds === null) {
      setSelectedRegionIds([id]);
      setSelectedRegion(id);
      return;
    }
    if (selectedRegionIds.includes(id)) {
      if (selectedRegionIds.length === 1) return;
      const next = selectedRegionIds.filter((regionId) => regionId !== id);
      setSelectedRegionIds(next);
      if (id === selectedRegion) setSelectedRegion(next[0] ?? "");
      return;
    }
    setSelectedRegionIds([...selectedRegionIds, id]);
    setSelectedRegion(id);
  }, [selectedRegion, selectedRegionIds]);

  const referenceProfiles = useMemo(() => {
    if (!manifest || referenceGene === null) {
      return { values: {} as Record<string, number>, coverage: {} as Record<string, number> };
    }
    const aggregates = manifest.regions.map((region) => [
      region.id,
      regionGeneAggregate(region, referenceGene),
    ] as const);
    return {
      values: Object.fromEntries(aggregates.map(([id, value]) => [id, value.value])),
      coverage: Object.fromEntries(
        aggregates.map(([id, value]) => [id, value.coverage]),
      ),
    };
  }, [manifest, referenceGene, regionGeneAggregate]);

  const selectedRegionDescriptor =
    manifest?.regions.find((region) => region.id === selectedRegion) ??
    manifest?.regions[0] ??
    null;
  const selectedRegionValue =
    regionValues.find((region) => region.id === selectedRegionDescriptor?.id)?.value ?? 0;

  const cellTypeRows = useMemo(() => {
    if (!manifest || !selectedRegionDescriptor) return [];
    const rowGroups = new Map<string, number[]>();
    selectedRegionDescriptor.rowIndices.forEach((rowIndex) => {
      const cellType = manifest.rows[rowIndex].cellType;
      const indices = rowGroups.get(cellType) ?? [];
      indices.push(rowIndex);
      rowGroups.set(cellType, indices);
    });
    return Array.from(rowGroups.entries())
      .map(([cellType, rowIndices]) => {
        const geneValues: CellGeneValue[] = geneProfiles.map((profile) => {
          const results = rowIndices.flatMap((rowIndex) => {
            const result = geneValue(
              manifest,
              chunks,
              profile.geneIndex,
              rowIndex,
              metric,
            );
            return result ? [result] : [];
          });
          return {
            symbol: profile.symbol,
            color: profile.color,
            value:
              results.length > 0
                ? results.reduce((sum, result) => sum + result.value, 0) /
                  results.length
                : 0,
            coverage:
              results.length > 0
                ? Math.max(...results.map((result) => result.coverage))
                : 0,
          };
        });
        const coveredQuery = geneValues.filter((gene) => gene.coverage > 0);
        const query =
          coveredQuery.length > 0
            ? coveredQuery.reduce((sum, gene) => sum + gene.value, 0) /
              coveredQuery.length
            : 0;
        const referenceResults =
          referenceGene === null
            ? []
            : rowIndices.flatMap((rowIndex) => {
                const result = geneValue(
                  manifest,
                  chunks,
                  referenceGene,
                  rowIndex,
                  metric,
                );
                return result ? [result] : [];
              });
        const rows = rowIndices.map((rowIndex) => manifest.rows[rowIndex]);
        return {
          name: cellType,
          query,
          queryCoverage: coveredQuery.length,
          geneValues,
          reference:
            referenceResults.length > 0
              ? referenceResults.reduce((sum, result) => sum + result.value, 0) /
                referenceResults.length
              : 0,
          referenceCoverage:
            referenceResults.length > 0
              ? Math.max(...referenceResults.map((result) => result.coverage))
              : 0,
          count: rows.reduce((sum, row) => sum + row.nCells, 0),
          datasetCount: Math.max(...rows.map((row) => row.nDatasets)),
          donorCount: Math.max(...rows.map((row) => row.nDonors)),
          sampleCount: Math.max(...rows.map((row) => row.nSamples)),
          lowDatasetCoverage: rows.some((row) => row.lowDatasetCoverage),
        };
      })
      .sort((left, right) => right.query - left.query);
  }, [chunks, geneProfiles, manifest, metric, referenceGene, selectedRegionDescriptor]);

  const cellMaximum = Math.max(
    ...cellTypeRows.flatMap((row) => [
      ...row.geneValues.filter((gene) => gene.coverage > 0).map((gene) => gene.value),
      ...(row.referenceCoverage > 0 ? [row.reference] : []),
    ]),
    metric === "detection" ? 0.01 : 0.001,
  );

  const availableReferences = useMemo(() => {
    if (!geneIndex) return [];
    return REFERENCE_GENES.flatMap(([symbol, label]) => {
      const index = resolveGene(symbol);
      return index === undefined ? [] : [{ symbol, label, index }];
    });
  }, [geneIndex, resolveGene]);

  const referenceLabel =
    geneIndex && referenceGene !== null
      ? geneIndex.symbols[referenceGene]
      : "Reference";

  const exportGeneIndices = useMemo(
    () =>
      Array.from(
        new Set([
          ...selectedGenes,
          ...(referenceGene === null ? [] : [referenceGene]),
        ]),
      ),
    [referenceGene, selectedGenes],
  );
  const exportReady =
    Boolean(manifest && geneIndex && selectedGenes.length > 0) &&
    exportGeneIndices.every((gene) =>
      chunks.has(Math.floor(gene / (manifest?.matrix.chunkGeneCount ?? 1))),
    );
  const exportRegionCount =
    selectedRegionIds === null
      ? manifest?.regions.length ?? 0
      : selectedRegionIds.length;
  const exportSignature = `${activeDataset?.id ?? "loading"}|${metric}|${referenceGene ?? "none"}|${selectedGenes.join(",")}|${
    selectedRegionIds?.join(",") ?? "all"
  }`;
  const downloadMessage =
    downloadNotice?.signature === exportSignature ? downloadNotice.message : "";
  const exportStatusText =
    selectedGenes.length === 0
      ? "Add a gene to export"
      : exportReady
        ? `${selectedGenes.length} query ${selectedGenes.length === 1 ? "gene" : "genes"} · ${exportRegionCount} regions`
        : "Preparing selected gene blocks";

  const downloadSelectionWorkbook = useCallback(() => {
    if (!manifest || !geneIndex || selectedGenes.length === 0) return;
    const missing = exportGeneIndices.filter(
      (gene) => !chunks.has(Math.floor(gene / manifest.matrix.chunkGeneCount)),
    );
    if (missing.length > 0) {
      setDownloadNotice({
        signature: exportSignature,
        message: "Preparing selected gene blocks",
      });
      void loadGenes(exportGeneIndices);
      return;
    }
    const workbook = buildSelectionWorkbook({
      manifest,
      datasetLabel: activeDataset?.label ?? manifest.source.file,
      geneIndex,
      chunks,
      selectedGenes,
      referenceGene,
      selectedRegionIds,
      metric,
    });
    const url = URL.createObjectURL(workbook);
    const link = document.createElement("a");
    link.href = url;
    link.download = makeExportFilename(geneIndex, selectedGenes);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setDownloadNotice({
      signature: exportSignature,
      message: `Workbook exported: ${selectedGenes.length} query ${
        selectedGenes.length === 1 ? "gene" : "genes"
      } across ${exportRegionCount} regions`,
    });
  }, [
    chunks,
    activeDataset?.label,
    exportGeneIndices,
    exportRegionCount,
    exportSignature,
    geneIndex,
    loadGenes,
    manifest,
    metric,
    referenceGene,
    selectedGenes,
    selectedRegionIds,
  ]);

  if (error && !manifest) {
    return (
      <main className="fatal-state">
        <span>DigitalBrain</span>
        <h1>The atlas could not be opened.</h1>
        <p>{error}</p>
      </main>
    );
  }

  return (
    <div className="atlas-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>DigitalBrain</strong>
            <span>Gene Atlas</span>
          </div>
        </div>
        <div className="dataset-summary">
          <span className="live-dot" />
          {manifest ? (
            <>
              <strong>{compactNumber(manifest.summary.cellCount)} cells</strong>
              <span>·</span>
              <span>{compactNumber(manifest.summary.geneCount)} features</span>
              <span>·</span>
              <span>{manifest.summary.regionCount} regions</span>
            </>
          ) : (
            <span>Loading transcriptomic atlas…</span>
          )}
        </div>
        <label className="dataset-control">
          <span>Dataset</span>
          <select
            value={selectedDatasetId}
            disabled={datasetLoading || datasetOptions.length < 2}
            aria-busy={datasetLoading}
            aria-label="Selected atlas dataset"
            title={activeDataset?.description}
            onChange={(event) => changeAtlasDataset(event.target.value)}
          >
            {datasetOptions.length === 0 && (
              <option value="">Loading atlas datasets…</option>
            )}
            {datasetOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main className="atlas-main">
        {error && (
          <div className="atlas-inline-error" role="alert">
            {error}
          </div>
        )}
        <section className="query-console" aria-label="Gene query controls">
          <div className="query-heading">
            <span className="step-number">01</span>
            <div>
              <p className="eyebrow">Gene or gene set</p>
              <h1>Map expression across anatomy</h1>
            </div>
          </div>
          <div className="search-zone">
            <form className="gene-search" onSubmit={submitSearch}>
              <span className="search-icon" aria-hidden="true" />
              <input
                value={queryText}
                onChange={(event) => {
                  setQueryText(event.target.value);
                  setSearchMessage("");
                }}
                placeholder="Search symbols or IDs, or paste a comma-separated set"
                aria-label="Search genes or gene sets"
              />
              <button type="submit">Add</button>
              {suggestions.length > 0 && geneIndex && (
                <div className="gene-suggestions">
                  {suggestions.map((index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => addGenes([geneIndex.symbols[index]])}
                    >
                      <strong>{geneIndex.symbols[index]}</strong>
                      <span>{geneIndex.ids[index]}</span>
                    </button>
                  ))}
                </div>
              )}
            </form>
            <div className="query-chips">
              {geneIndex &&
                selectedGenes.map((index, order) => (
                  <button
                    key={index}
                    type="button"
                    style={{
                      borderColor: hexToRgba(GENE_COLORS[order % GENE_COLORS.length], 0.44),
                      background: hexToRgba(GENE_COLORS[order % GENE_COLORS.length], 0.13),
                      color: GENE_COLORS[order % GENE_COLORS.length],
                    }}
                    onClick={() =>
                      setSelectedGenes((genes) => genes.filter((gene) => gene !== index))
                    }
                    aria-label={`Remove ${geneIndex.symbols[index]}`}
                  >
                    {geneIndex.symbols[index]} <span>×</span>
                  </button>
                ))}
              {selectedGenes.length === 0 && <span className="empty-chip">Add a gene to begin</span>}
            </div>
            <div className="examples">
              <span>Examples</span>
              {EXAMPLE_SETS.map((example) => (
                <button
                  type="button"
                  key={example.label}
                  onClick={() => addGenes(example.genes, true)}
                >
                  {example.label}
                </button>
              ))}
            </div>
            {loadingGenes && <p className="search-message">Loading requested gene block…</p>}
            {searchMessage && <p className="search-message">{searchMessage}</p>}
          </div>
          <div className="metric-control">
            <span>Measure</span>
            <div>
              <button
                type="button"
                className={metric === "mean" ? "active" : ""}
                onClick={() => setMetric("mean")}
              >
                Mean expression
              </button>
              <button
                type="button"
                className={metric === "detection" ? "active" : ""}
                onClick={() => setMetric("detection")}
              >
                % detected
              </button>
            </div>
            <div className="export-control">
              <button
                type="button"
                onClick={downloadSelectionWorkbook}
                disabled={!exportReady}
              >
                Download Excel
              </button>
              <span>{downloadMessage || exportStatusText}</span>
            </div>
          </div>
        </section>

        <RegionSelector
          regions={manifest?.regions ?? []}
          selectedRegionIds={selectedRegionIds}
          focusedRegion={selectedRegion}
          onShowAll={showAllRegions}
          onShowMapped={showMappedRegions}
          onToggle={toggleDisplayedRegion}
        />

        <section className="analysis-grid">
          <article className="panel brain-panel">
            <div className="panel-heading dark-heading">
              <div>
                <p className="eyebrow">Spatial distribution</p>
                <h2>3D expression atlas</h2>
              </div>
              <div className="motion-picker" aria-label="Atlas rotation mode">
                <span>Motion</span>
                <button
                  type="button"
                  className={rotationMode === "manual" ? "active" : ""}
                  onClick={() => setRotationMode("manual")}
                >
                  Manual
                </button>
                <button
                  type="button"
                  className={rotationMode === "spin" ? "active" : ""}
                  onClick={() => setRotationMode("spin")}
                >
                  Spin
                </button>
              </div>
            </div>
            <div className="brain-workspace">
              <BrainViewer
                geometry={geometry}
                regions={displayedRegionValues}
                geneProfiles={geneProfiles}
                selectedRegion={selectedRegion}
                highlightedRegionIds={selectedRegionIds ?? []}
                onSelect={setSelectedRegion}
                autoRotate={rotationMode === "spin"}
              />
              <RegionSidebar
                regions={displayedRegionValues}
                geneProfiles={geneProfiles}
                referenceValues={referenceProfiles.values}
                referenceCoverage={referenceProfiles.coverage}
                metric={metric}
                selectedRegion={selectedRegion}
                onSelect={setSelectedRegion}
                geometry={geometry}
              />
            </div>
            <div className="brain-legend">
              <div className="density-note">
                <span className="gradient-key" />
                <span>Cyan boundary = selected filter · amber boundary = focused region</span>
              </div>
              <div className="gene-legend">
                {geneProfiles.slice(0, 6).map((profile) => (
                  <span key={profile.geneIndex}>
                    <i style={{ background: profile.color }} />
                    {profile.symbol}
                  </span>
                ))}
                {geneProfiles.length > 6 && <span>+{geneProfiles.length - 6}</span>}
              </div>
            </div>
          </article>

          <article className="panel quantitative-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Regional abundance</p>
                <h2>Quantitative comparison</h2>
              </div>
              <span className="unit-pill">
                {manifest?.source.scope === "individual-dataset"
                  ? metric === "mean"
                    ? "equal-donor log1p CP10K"
                    : "equal-donor detection"
                  : metric === "mean"
                    ? "equal-study log1p CP10K"
                    : "equal-study detection"}
              </span>
            </div>
            <div className="chart-legend">
              {geneProfiles.slice(0, 8).map((profile) => (
                <span key={profile.geneIndex}>
                  <i style={{ background: profile.color }} />
                  {profile.symbol}
                </span>
              ))}
              {geneProfiles.length > 8 && <span>+{geneProfiles.length - 8} genes</span>}
              <span><i className="reference-swatch" />{referenceLabel}</span>
            </div>
            <RegionHistogram
              regions={displayedRegionValues}
              geneProfiles={geneProfiles}
              referenceValues={referenceProfiles.values}
              referenceCoverage={referenceProfiles.coverage}
              metric={metric}
              selectedRegion={selectedRegion}
              onSelect={setSelectedRegion}
            />
            <div className="region-insight">
              <span>{selectedRegionDescriptor?.acronym ?? "—"}</span>
              <div>
                <strong>{selectedRegionDescriptor?.label ?? "Select a region"}</strong>
                <p>
                  {selectedRegionDescriptor
                    ? `${compactNumber(selectedRegionDescriptor.nCells)} cells · ${
                        geneProfiles.length === 1
                          ? `${formatValue(selectedRegionValue, metric)} cell-type-balanced ${metricLabel(metric).toLowerCase()}`
                          : `${geneProfiles.length} query genes shown separately`
                      }`
                    : "Waiting for atlas data"}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  document.getElementById("cell-type-detail")?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
              >
                Cell types ↓
              </button>
            </div>
          </article>
        </section>

        <section className="cell-detail panel" id="cell-type-detail">
          <div className="detail-heading">
            <div className="query-heading">
              <span className="step-number">03</span>
              <div>
                <p className="eyebrow">Selected region · {selectedRegionDescriptor?.acronym}</p>
                <h2>Expression across cell classes</h2>
              </div>
            </div>
            <div className="reference-control">
              <label htmlFor="referenceGene">Compare with</label>
              <select
                id="referenceGene"
                value={referenceGene ?? ""}
                onChange={(event) => setReferenceGene(Number(event.target.value))}
              >
                {availableReferences.map((reference) => (
                  <option value={reference.index} key={reference.symbol}>
                    {reference.symbol} · {reference.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="cell-table-head">
            <span>Cell class</span>
            <span>Per-gene {metricLabel(metric).toLowerCase()}</span>
            <span>Reference</span>
          </div>
          <div className="cell-type-list">
            {cellTypeRows.map((row, index) => {
              const ratio =
                row.referenceCoverage > 0 && row.reference > 0 && row.queryCoverage > 0
                  ? row.query / row.reference
                  : null;
              return (
                <div className="cell-row" key={row.name}>
                  <div className="cell-name">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{row.name}</strong>
                      <small>
                        {compactNumber(row.count)} cells · {row.datasetCount} datasets · {row.donorCount} donors
                      </small>
                    </div>
                  </div>
                  <div className="cell-gene-stack">
                    {row.geneValues.map((gene: CellGeneValue) => (
                      <div className="mini-gene-row" key={gene.symbol}>
                        <span style={{ color: gene.color }}>{gene.symbol}</span>
                        <div>
                          <i
                            style={{
                              width:
                                gene.coverage > 0
                                  ? `${Math.max(0.6, (gene.value / cellMaximum) * 100)}%`
                                  : "0%",
                              background: gene.color,
                            }}
                          />
                        </div>
                        <b>{gene.coverage > 0 ? formatValue(gene.value, metric) : "—"}</b>
                      </div>
                    ))}
                  </div>
                  <div className="cell-reference">
                    <div>
                      <i
                        style={{
                          width:
                            row.referenceCoverage > 0
                              ? `${Math.max(0.6, (row.reference / cellMaximum) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                    <span>{referenceLabel}</span>
                    <strong>
                      {row.referenceCoverage > 0
                        ? formatValue(row.reference, metric)
                        : "—"}
                    </strong>
                    <em>{ratio === null ? "—" : `${ratio.toFixed(ratio < 10 ? 1 : 0)}×`}</em>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <footer className="data-footer">
          <div>
            <span className="status-badge">
              {activeDataset?.label ?? "Loading H5AD summary"}
            </span>
            <p>
              Values come from {manifest?.source.file ?? "the overall equal-study H5AD"}.
              The browser fetches only the 256-feature block needed for each search.
              {manifest
                ? ` ${manifest.summary.mappedRegionCount}/${manifest.summary.regionCount} regions have a current 3D crosswalk; every region remains in the quantitative view.`
                : ""}
            </p>
          </div>
          <div>
            <strong>{manifest?.normalization.label ?? "Preparing normalization…"}</strong>
            <span>
              Regional values are equal means across represented broad cell types · descriptive abundance, not differential expression or causal evidence
            </span>
          </div>
        </footer>
      </main>
    </div>
  );
}
