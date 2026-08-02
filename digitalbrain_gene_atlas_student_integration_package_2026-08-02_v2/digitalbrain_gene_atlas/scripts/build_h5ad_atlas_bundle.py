#!/usr/bin/env python3
"""Build a browser-friendly DigitalBrain expression bundle from H5AD files.

The browser never opens the large H5AD matrices directly. This script streams
each sparse matrix once and exports group-level mean log-normalized expression
and detection fraction for every gene. Add datasets to the JSON configuration
and rerun the script to extend the atlas.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import scipy.sparse as sp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("data/datasets.example.json"),
        help="Dataset configuration JSON.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/data"),
        help="Output directory for manifest and binary matrices.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=768,
        help="Number of cells streamed per sparse matrix block.",
    )
    return parser.parse_args()


def canonical_symbol(value: Any, fallback: str) -> str:
    symbol = str(value).strip()
    if not symbol or symbol.lower() in {"nan", "none"}:
        symbol = fallback
    return symbol.upper()


def dataset_features(
    dataset: dict[str, Any],
    config_dir: Path,
    symbol_field: str,
) -> tuple[list[str], list[str], int]:
    path = (config_dir / dataset["path"]).resolve()
    atlas = ad.read_h5ad(path, backed="r")
    if symbol_field not in atlas.var.columns:
        raise KeyError(f"{path}: missing var[{symbol_field!r}]")
    ids = [str(value) for value in atlas.var_names]
    symbols = [
        canonical_symbol(value, feature_id)
        for value, feature_id in zip(atlas.var[symbol_field], ids, strict=True)
    ]
    cell_count = int(atlas.n_obs)
    atlas.file.close()
    return symbols, ids, cell_count


def aggregate_dataset(
    dataset: dict[str, Any],
    *,
    config_dir: Path,
    output_dir: Path,
    symbol_field: str,
    cell_type_field: str,
    cell_types: list[str],
    global_gene_index: dict[str, int],
    chunk_size: int,
    target_sum: float,
) -> dict[str, Any]:
    path = (config_dir / dataset["path"]).resolve()
    atlas = ad.read_h5ad(path, backed="r")
    if cell_type_field not in atlas.obs.columns:
        raise KeyError(f"{path}: missing obs[{cell_type_field!r}]")

    local_ids = [str(value) for value in atlas.var_names]
    local_symbols = [
        canonical_symbol(value, feature_id)
        for value, feature_id in zip(
            atlas.var[symbol_field], local_ids, strict=True
        )
    ]
    local_to_global = np.fromiter(
        (global_gene_index[symbol] for symbol in local_symbols),
        dtype=np.int64,
        count=len(local_symbols),
    )

    group_names = ["All cells", *cell_types]
    group_lookup = {name: index + 1 for index, name in enumerate(cell_types)}
    observation_groups = (
        atlas.obs[cell_type_field]
        .astype("string")
        .fillna("Unannotated")
        .map(group_lookup)
        .to_numpy(dtype=np.int64)
    )
    group_count = len(group_names)
    local_gene_count = atlas.n_vars
    sums = np.zeros((group_count, local_gene_count), dtype=np.float64)
    detections = np.zeros_like(sums)
    counts = np.zeros(group_count, dtype=np.int64)

    for start in range(0, atlas.n_obs, chunk_size):
        stop = min(atlas.n_obs, start + chunk_size)
        matrix = atlas.X[start:stop]
        if not sp.issparse(matrix):
            matrix = sp.csr_matrix(matrix)
        else:
            matrix = matrix.tocsr(copy=True)

        library_sizes = np.asarray(matrix.sum(axis=1)).ravel()
        scales = np.divide(
            target_sum,
            library_sizes,
            out=np.zeros_like(library_sizes, dtype=np.float64),
            where=library_sizes > 0,
        )
        matrix.data = matrix.data.astype(np.float64, copy=False)
        matrix.data *= np.repeat(scales, np.diff(matrix.indptr))
        np.log1p(matrix.data, out=matrix.data)

        batch_groups = observation_groups[start:stop]
        rows = np.concatenate(
            [np.zeros(stop - start, dtype=np.int64), batch_groups]
        )
        columns = np.concatenate(
            [np.arange(stop - start), np.arange(stop - start)]
        )
        membership = sp.csr_matrix(
            (np.ones(rows.size, dtype=np.float64), (rows, columns)),
            shape=(group_count, stop - start),
        )
        sums += (membership @ matrix).toarray()

        binary = matrix.copy()
        binary.data.fill(1.0)
        detections += (membership @ binary).toarray()
        counts += np.bincount(rows, minlength=group_count)

        print(
            f"{dataset['id']}: {stop:,}/{atlas.n_obs:,} cells",
            flush=True,
        )

    atlas.file.close()
    divisor = counts[:, None]
    local_means = np.divide(
        sums,
        divisor,
        out=np.zeros_like(sums),
        where=divisor > 0,
    )
    local_detection = np.divide(
        detections,
        divisor,
        out=np.zeros_like(detections),
        where=divisor > 0,
    )

    global_shape = (group_count, len(global_gene_index))
    means = np.zeros(global_shape, dtype="<f4")
    detection = np.zeros(global_shape, dtype="<f4")
    for local_index, global_index in enumerate(local_to_global):
        means[:, global_index] += local_means[:, local_index].astype(np.float32)
        detection[:, global_index] = np.maximum(
            detection[:, global_index],
            local_detection[:, local_index].astype(np.float32),
        )

    binary_name = f"{dataset['id']}_expression.f32"
    binary_path = output_dir / binary_name
    with binary_path.open("wb") as stream:
        means.tofile(stream)
        detection.tofile(stream)

    return {
        "id": dataset["id"],
        "label": dataset["label"],
        "shortLabel": dataset.get("short_label", dataset["label"]),
        "regionAcronym": dataset["region_acronym"],
        "regionName": dataset["region_name"],
        "cellCount": int(counts[0]),
        "groupCounts": counts.tolist(),
        "binary": binary_name,
        "binaryBytes": binary_path.stat().st_size,
    }


def main() -> None:
    args = parse_args()
    config_path = args.config.resolve()
    config_dir = config_path.parent
    config = json.loads(config_path.read_text())
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    symbol_field = config.get("gene_symbol_field", "Gene")
    cell_type_field = config.get("cell_type_field", "supercluster_term")
    target_sum = float(config.get("normalization", {}).get("target_sum", 10000))
    datasets = config["datasets"]

    global_symbols: list[str] = []
    global_ids: list[str] = []
    global_gene_index: dict[str, int] = {}
    dataset_cell_counts: dict[str, int] = {}
    cell_type_set: set[str] = set()

    for dataset in datasets:
        symbols, ids, cell_count = dataset_features(
            dataset, config_dir, symbol_field
        )
        dataset_cell_counts[dataset["id"]] = cell_count
        for symbol, feature_id in zip(symbols, ids, strict=True):
            if symbol not in global_gene_index:
                global_gene_index[symbol] = len(global_symbols)
                global_symbols.append(symbol)
                global_ids.append(feature_id)
        path = (config_dir / dataset["path"]).resolve()
        atlas = ad.read_h5ad(path, backed="r")
        cell_type_set.update(
            atlas.obs[cell_type_field]
            .astype("string")
            .fillna("Unannotated")
            .tolist()
        )
        atlas.file.close()

    cell_types = sorted(cell_type_set)
    dataset_manifests = [
        aggregate_dataset(
            dataset,
            config_dir=config_dir,
            output_dir=output_dir,
            symbol_field=symbol_field,
            cell_type_field=cell_type_field,
            cell_types=cell_types,
            global_gene_index=global_gene_index,
            chunk_size=args.chunk_size,
            target_sum=target_sum,
        )
        for dataset in datasets
    ]

    manifest = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "normalization": {
            "label": f"Mean log1p(counts per {int(target_sum):,})",
            "targetSum": target_sum,
            "transform": "log1p",
            "detectionLabel": "Nuclei with detected transcript",
        },
        "matrix": {
            "dtype": "float32-little-endian",
            "layout": "metric, group, gene",
            "metrics": ["meanExpression", "detectionFraction"],
            "groupNames": ["All cells", *cell_types],
            "groupCount": len(cell_types) + 1,
            "geneCount": len(global_symbols),
        },
        "genes": {
            "symbols": global_symbols,
            "ids": global_ids,
        },
        "datasets": dataset_manifests,
        "summary": {
            "datasetCount": len(datasets),
            "cellCount": sum(dataset_cell_counts.values()),
            "geneCount": len(global_symbols),
            "cellTypeCount": len(cell_types),
        },
    }
    manifest_path = output_dir / "atlas_manifest.json"
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
