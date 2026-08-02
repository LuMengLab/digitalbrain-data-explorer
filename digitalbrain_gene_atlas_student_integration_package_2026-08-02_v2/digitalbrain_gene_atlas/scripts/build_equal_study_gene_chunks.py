#!/usr/bin/env python3
"""Convert a DigitalBrain summary H5AD into browser gene-major chunks.

The source H5AD is a dense region/cell-type by gene summary. Reading it through
AnnData can materialize dense layers, so this converter accesses the HDF5
datasets directly and writes independently compressed blocks of a few hundred
genes. The browser loads the search index once and fetches only blocks required
by the active query/reference genes.

Both stage-3 equal-study summaries (dataset coverage) and stage-2 individual
dataset summaries (donor coverage) are accepted. The browser payload keeps the
legacy ``datasetCoverage`` matrix id for schema compatibility and records its
actual unit in the manifest.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--geometry", type=Path, required=True)
    parser.add_argument("--region-names", type=Path, required=True)
    parser.add_argument("--chunk-genes", type=int, default=256)
    parser.add_argument("--compression-level", type=int, default=6)
    return parser.parse_args()


def text(value: Any) -> str:
    if isinstance(value, (bytes, np.bytes_)):
        return value.decode("utf-8")
    return str(value)


def categorical(group: h5py.Group | h5py.Dataset) -> np.ndarray:
    if isinstance(group, h5py.Dataset):
        return string_array(group)
    categories = np.asarray([text(value) for value in group["categories"][:]])
    codes = group["codes"][:]
    return categories[codes]


def string_array(dataset: h5py.Dataset) -> np.ndarray:
    return np.asarray([text(value) for value in dataset[:]], dtype=object)


def scalar(group: h5py.Group, key: str, fallback: Any) -> Any:
    if key not in group:
        return fallback
    value = group[key][()]
    return text(value) if isinstance(value, (bytes, np.bytes_)) else value.item()


def obs_numeric(
    obs: h5py.Group,
    key: str,
    row_count: int,
    fallback: int | bool,
    dtype: Any,
) -> np.ndarray:
    if key not in obs:
        return np.full(row_count, fallback, dtype=dtype)
    return obs[key][:].astype(dtype)


def sha256_file(path: Path, block_size: int = 16 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def compact_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")))


def gzip_json(path: Path, payload: Any, level: int) -> None:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            compresslevel=level,
            fileobj=raw,
            mtime=0,
        ) as stream:
            stream.write(encoded)


def load_geometry_keys(path: Path) -> set[str]:
    source = path.read_text()
    payload = source.split("=", 1)[1].strip().rstrip(";")
    return set(json.loads(payload)["regionMappings"])


def preferred_symbol_indices(
    symbols: np.ndarray,
    ids: np.ndarray,
    id_kinds: np.ndarray,
    occurrences: np.ndarray,
) -> tuple[list[str], list[int]]:
    lookup: dict[str, int] = {}

    def score(index: int) -> tuple[int, int, int]:
        return (
            1 if id_kinds[index] == "stable_id" else 0,
            int(occurrences[index]),
            -index,
        )

    for index, gene_id in enumerate(ids):
        lookup[str(gene_id).upper()] = index
    for index, symbol in enumerate(symbols):
        token = str(symbol).strip().upper()
        if not token:
            continue
        current = lookup.get(token)
        if current is None or score(index) > score(current):
            lookup[token] = index
    tokens = sorted(lookup)
    return tokens, [lookup[token] for token in tokens]


def main() -> None:
    args = parse_args()
    if args.chunk_genes < 32:
        raise SystemExit("--chunk-genes must be at least 32")
    if not 1 <= args.compression_level <= 9:
        raise SystemExit("--compression-level must be between 1 and 9")
    input_path = args.input.resolve()
    output_dir = args.output.resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise SystemExit(f"refusing to overwrite non-empty output: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    chunk_dir = output_dir / "chunks"
    chunk_dir.mkdir()

    region_names = json.loads(args.region_names.resolve().read_text())
    geometry_keys = load_geometry_keys(args.geometry.resolve())

    with h5py.File(input_path, "r") as atlas:
        mean = atlas["X"]
        layers = atlas["layers"]
        detection = layers["detection_fraction"]
        if "dataset_coverage" in layers:
            coverage = layers["dataset_coverage"]
            coverage_unit = "datasets"
            summary_scope = "equal-study"
        elif "donor_coverage" in layers:
            coverage = layers["donor_coverage"]
            coverage_unit = "donors"
            summary_scope = "individual-dataset"
        else:
            raise ValueError("H5AD requires dataset_coverage or donor_coverage")
        row_count, gene_count = map(int, mean.shape)
        if detection.shape != mean.shape or coverage.shape != mean.shape:
            raise ValueError("required H5AD matrices have inconsistent shapes")

        obs = atlas["obs"]
        row_ids = string_array(obs["summary_row"])
        region_ids = categorical(obs["region_id"])
        region_gyral = categorical(obs["region_gyral"])
        cell_types = categorical(obs["broad_cell_type"])
        n_cells = obs["n_cells"][:].astype(np.int64)
        n_datasets = obs_numeric(obs, "n_datasets", row_count, 1, np.int64)
        n_donors = obs_numeric(obs, "n_donors", row_count, 0, np.int64)
        n_samples = obs_numeric(obs, "n_samples", row_count, 0, np.int64)
        low_coverage_key = (
            "low_dataset_coverage"
            if "low_dataset_coverage" in obs
            else "low_coverage"
        )
        low_coverage = obs_numeric(
            obs, low_coverage_key, row_count, False, bool
        )

        rows = [
            {
                "id": str(row_ids[index]),
                "regionId": str(region_ids[index]),
                "regionGyral": str(region_gyral[index]),
                "cellType": str(cell_types[index]),
                "nCells": int(n_cells[index]),
                "nDatasets": int(n_datasets[index]),
                "nDonors": int(n_donors[index]),
                "nSamples": int(n_samples[index]),
                "lowDatasetCoverage": bool(low_coverage[index]),
            }
            for index in range(row_count)
        ]

        region_rows: dict[str, list[int]] = defaultdict(list)
        region_gyral_values: dict[str, list[str]] = defaultdict(list)
        for index, region_id in enumerate(region_ids):
            region_rows[str(region_id)].append(index)
            region_gyral_values[str(region_id)].append(str(region_gyral[index]))
        regions = []
        for region_id in sorted(region_rows):
            normalized = region_id.replace("+", " ")
            geometry_key = (
                region_id
                if region_id in geometry_keys
                else normalized if normalized in geometry_keys else None
            )
            gyral = Counter(region_gyral_values[region_id]).most_common(1)[0][0]
            label = region_names.get(region_id) or region_names.get(geometry_key or "")
            if not label:
                label = f"{region_id} · {gyral}" if gyral != region_id else region_id
            indices = region_rows[region_id]
            regions.append(
                {
                    "id": region_id,
                    "acronym": region_id,
                    "label": label,
                    "gyral": gyral,
                    "geometryKey": geometry_key,
                    "rowIndices": indices,
                    "cellTypes": sorted(
                        set(str(cell_types[index]) for index in indices)
                    ),
                    "nCells": int(sum(int(n_cells[index]) for index in indices)),
                    "nDatasets": int(max(int(n_datasets[index]) for index in indices)),
                    "nDonors": int(max(int(n_donors[index]) for index in indices)),
                }
            )

        var = atlas["var"]
        gene_ids = string_array(var["canonical_gene_id"])
        gene_symbols = categorical(var["gene_symbol"])
        id_kinds = categorical(var["id_kind"])
        source_occurrences = var["source_occurrences"][:].astype(np.int64)
        if len(gene_ids) != gene_count:
            raise ValueError("gene registry width does not match expression matrix")
        search_tokens, search_indices = preferred_symbol_indices(
            gene_symbols,
            gene_ids,
            id_kinds,
            source_occurrences,
        )
        gene_index = {
            "schemaVersion": 1,
            "symbols": gene_symbols.tolist(),
            "ids": gene_ids.tolist(),
            "idKinds": id_kinds.tolist(),
            "sourceOccurrences": source_occurrences.tolist(),
            "searchTokens": search_tokens,
            "searchIndices": search_indices,
        }
        gene_index_path = output_dir / "gene_index.json.gz"
        gzip_json(gene_index_path, gene_index, args.compression_level)

        chunks = []
        total_chunk_bytes = 0
        for chunk_index, start in enumerate(range(0, gene_count, args.chunk_genes)):
            stop = min(start + args.chunk_genes, gene_count)
            width = stop - start
            mean_block = np.asarray(mean[:, start:stop], dtype="<f4", order="C")
            detection_block = np.asarray(
                detection[:, start:stop], dtype="<f4", order="C"
            )
            coverage_slice = coverage[:, start:stop]
            coverage_block = np.asarray(coverage_slice, dtype=np.uint8, order="C")
            if not np.all(np.isfinite(mean_block)):
                raise ValueError(f"non-finite mean values in gene block {chunk_index}")
            if not np.all(np.isfinite(detection_block)):
                raise ValueError(
                    f"non-finite detection values in gene block {chunk_index}"
                )
            if np.any(detection_block < 0) or np.any(detection_block > 1):
                raise ValueError(f"detection outside [0, 1] in block {chunk_index}")
            if np.any(mean_block < 0):
                raise ValueError(f"negative mean expression in block {chunk_index}")
            if np.any(coverage_slice > 255):
                raise ValueError(f"{coverage_unit} coverage exceeds uint8 capacity")

            mean_max = float(mean_block.max(initial=0))
            mean_scale = mean_max / np.iinfo(np.uint16).max if mean_max > 0 else 1.0
            detection_scale = 1.0 / np.iinfo(np.uint16).max
            encoded_mean = np.rint(mean_block / mean_scale).astype("<u2")
            encoded_detection = np.rint(
                detection_block / detection_scale
            ).astype("<u2")

            name = f"chunk_{chunk_index:04d}.bin.gz"
            path = chunk_dir / name
            with path.open("wb") as raw:
                with gzip.GzipFile(
                    filename="",
                    mode="wb",
                    compresslevel=args.compression_level,
                    fileobj=raw,
                    mtime=0,
                ) as stream:
                    stream.write(encoded_mean.tobytes(order="C"))
                    stream.write(encoded_detection.tobytes(order="C"))
                    stream.write(coverage_block.tobytes(order="C"))
            size = path.stat().st_size
            total_chunk_bytes += size
            chunks.append(
                {
                    "index": chunk_index,
                    "start": start,
                    "count": width,
                    "file": f"chunks/{name}",
                    "encoding": "quantized-u16",
                    "bytesPerValue": 5,
                    "meanScale": mean_scale,
                    "detectionScale": detection_scale,
                    "compressedBytes": size,
                    "sha256": sha256_file(path),
                }
            )
            print(
                f"[chunk] {chunk_index + 1:,}/{(gene_count + args.chunk_genes - 1) // args.chunk_genes:,} "
                f"genes={start:,}:{stop:,} compressed={size / 1048576:.2f} MiB",
                flush=True,
            )

        stage2 = atlas["uns"]["digitalbrain_stage2"]
        dataset_id = scalar(stage2, "dataset_id", "")
        input_datasets = int(scalar(stage2, "input_datasets", 0))
        if summary_scope == "individual-dataset":
            input_datasets = 1
        source_meta = {
            "inputDatasets": input_datasets,
            "xMetric": scalar(stage2, "x_metric", "equal-study mean"),
            "detectionMetric": scalar(
                stage2, "detection_metric", "equal-study detection fraction"
            ),
            "missingGeneRule": scalar(
                stage2,
                "missing_gene_rule",
                "dataset coverage is authoritative; uncovered storage zeros are missing",
            ),
            "sourceCreatedAt": scalar(stage2, "created_at", ""),
            "datasetId": dataset_id,
            "scope": summary_scope,
            "coverageUnit": coverage_unit,
        }

    if summary_scope == "equal-study":
        normalization_label = "Equal-study mean of donor-balanced log1p(CP10K)"
        detection_label = "Equal-study mean detection fraction"
        coverage_label = "Number of represented datasets"
    else:
        normalization_label = "Equal-donor mean log1p(CP10K)"
        detection_label = "Equal-donor mean detection fraction"
        coverage_label = "Number of represented donors"

    manifest = {
        "schemaVersion": 3,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "file": input_path.name,
            "sha256": sha256_file(input_path),
            **source_meta,
        },
        "normalization": {
            "label": normalization_label,
            "detectionLabel": detection_label,
            "coverageLabel": coverage_label,
            "regionalAggregation": "Equal mean across represented broad cell types",
        },
        "matrix": {
            "rowCount": row_count,
            "geneCount": gene_count,
            "chunkGeneCount": args.chunk_genes,
            "layout": "metric-major; each metric is row-major [summaryRow, geneWithinChunk]",
            "encoding": "quantized-u16",
            "bytesPerValue": 5,
            "metrics": [
                {
                    "id": "mean",
                    "dtype": "uint16-little-endian",
                    "bytes": 2,
                    "decode": "encoded * chunk.meanScale",
                },
                {
                    "id": "detection",
                    "dtype": "uint16-little-endian",
                    "bytes": 2,
                    "decode": "encoded * chunk.detectionScale",
                },
                {
                    "id": "datasetCoverage",
                    "dtype": "uint8",
                    "bytes": 1,
                    "unit": coverage_unit,
                },
            ],
        },
        "genes": {
            "indexFile": "gene_index.json.gz",
            "encoding": "gzip-json",
            "searchTokenCount": len(search_tokens),
        },
        "rows": rows,
        "regions": regions,
        "cellTypes": sorted(set(str(value) for value in cell_types)),
        "chunks": chunks,
        "summary": {
            "datasetCount": int(source_meta["inputDatasets"]),
            "regionCount": len(regions),
            "mappedRegionCount": sum(
                region["geometryKey"] is not None for region in regions
            ),
            "cellCount": int(n_cells.sum()),
            "geneCount": gene_count,
            "cellTypeCount": len(set(str(value) for value in cell_types)),
            "chunkCount": len(chunks),
            "chunkBytes": total_chunk_bytes,
            "geneIndexBytes": gene_index_path.stat().st_size,
        },
    }
    compact_json(output_dir / "manifest.json", manifest)
    print(
        f"[done] rows={row_count:,} genes={gene_count:,} chunks={len(chunks):,} "
        f"data={total_chunk_bytes / 1073741824:.2f} GiB -> {output_dir}",
        flush=True,
    )


if __name__ == "__main__":
    main()
