#!/usr/bin/env python3
"""Create donor/sample/region/cell-type summary shards from raw H5AD files.

The output is an intermediate scientific handoff, not the browser runtime
matrix. Each summary H5AD preserves atomic dataset x donor x sample x region x
cell-type strata, mean log1p(CP10K), detection fraction, and optional
pseudobulk raw counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp


FIELD_DEFAULTS = {
    "gene_symbol": ["Gene", "gene_symbols", "feature_name"],
    "donor": ["donor_id", "publication_donor_id"],
    "sample": ["sample_id"],
    "region": ["region_acronym", "atlas_ontology", "roi"],
    "cell_type": ["supercluster_term", "cell_type"],
    "cell_id": ["observation_joinid"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-size", type=int, default=512)
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Inspect metadata and matrix scale without aggregating expression.",
    )
    parser.add_argument(
        "--omit-pseudobulk",
        action="store_true",
        help="Do not store the optional pseudobulk raw-count layer.",
    )
    return parser.parse_args()


def safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(value).strip())
    if not cleaned:
        raise ValueError("empty dataset or file identifier")
    return cleaned


def candidates(value: Any, default: Iterable[str]) -> list[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def resolve_column(
    frame: pd.DataFrame,
    requested: Any,
    default: Iterable[str],
) -> str | None:
    for name in candidates(requested, default):
        if name in frame.columns:
            return name
    return None


def sha256_file(path: Path, block_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def string_series(
    frame: pd.DataFrame,
    column: str | None,
    fixed_value: Any,
    *,
    fallback: str | None = None,
) -> pd.Series:
    if column is not None:
        values = frame[column].astype("string").fillna("Unspecified")
        values = values.replace("", "Unspecified")
        return values.astype(str)
    if fixed_value is not None:
        return pd.Series(
            np.repeat(str(fixed_value), len(frame)),
            index=frame.index,
            dtype="object",
        )
    if fallback is not None:
        return pd.Series(
            np.repeat(fallback, len(frame)),
            index=frame.index,
            dtype="object",
        )
    raise KeyError("required metadata field is unavailable and has no fixed value")


def matrix_from_source(atlas: ad.AnnData, source: str):
    if source == "X":
        return atlas.X
    if source == "raw.X":
        if atlas.raw is None:
            raise KeyError("matrix source raw.X requested but AnnData.raw is absent")
        return atlas.raw.X
    if source.startswith("layer:"):
        layer = source.split(":", 1)[1]
        if layer not in atlas.layers:
            raise KeyError(f"matrix layer {layer!r} is absent")
        return atlas.layers[layer]
    raise ValueError("matrix.source must be X, raw.X, or layer:<name>")


def feature_frame(
    var: pd.DataFrame,
    var_names: pd.Index,
    symbol_request: Any,
) -> tuple[pd.DataFrame, str]:
    symbol_column = resolve_column(
        var,
        symbol_request,
        FIELD_DEFAULTS["gene_symbol"],
    )
    if symbol_column is None:
        raise KeyError(
            "no gene-symbol column found; configure fields.gene_symbol"
        )
    gene_ids = var_names.astype(str)
    if not pd.Index(gene_ids).is_unique:
        raise ValueError("var_names/gene IDs must be unique within each H5AD")
    symbols = (
        var[symbol_column]
        .astype("string")
        .fillna(pd.Series(gene_ids, index=var.index))
        .astype(str)
        .to_numpy()
    )
    symbols = np.where(
        np.isin(np.char.lower(symbols.astype(str)), ["", "nan", "none"]),
        gene_ids,
        symbols,
    )
    result = pd.DataFrame(
        {
            "gene_id": gene_ids,
            "gene_symbol": symbols,
        },
        index=pd.Index(gene_ids, name="gene_id_index"),
    )
    return result, symbol_column


def sample_matrix_audit(matrix, n_obs: int, n_vars: int) -> dict[str, Any]:
    rows = min(n_obs, 256)
    columns = min(n_vars, 2048)
    block = matrix[:rows, :columns]
    if sp.issparse(block):
        values = np.asarray(block.data)
        minimum = float(values.min()) if values.size else 0.0
        maximum = float(values.max()) if values.size else 0.0
        finite = bool(np.all(np.isfinite(values)))
        nonnegative = bool(np.all(values >= 0))
        integer_fraction = (
            float(np.mean(np.isclose(values, np.round(values))))
            if values.size
            else 1.0
        )
    else:
        values = np.asarray(block)
        minimum = float(np.nanmin(values)) if values.size else 0.0
        maximum = float(np.nanmax(values)) if values.size else 0.0
        finite = bool(np.all(np.isfinite(values)))
        nonnegative = bool(np.all(values >= 0))
        nonzero = values[values != 0]
        integer_fraction = (
            float(np.mean(np.isclose(nonzero, np.round(nonzero))))
            if nonzero.size
            else 1.0
        )
    return {
        "sample_rows": rows,
        "sample_columns": columns,
        "minimum": minimum,
        "maximum": maximum,
        "finite": finite,
        "nonnegative": nonnegative,
        "integer_fraction": integer_fraction,
        "count_like": finite and nonnegative and integer_fraction >= 0.999,
    }


def build_group_frame(
    atlas: ad.AnnData,
    *,
    dataset_id: str,
    file_id: str,
    field_config: dict[str, Any],
    fixed: dict[str, Any],
) -> tuple[pd.DataFrame, dict[str, str | None], list[str]]:
    resolved: dict[str, str | None] = {}
    warnings: list[str] = []
    for logical in ("donor", "sample", "region", "cell_type", "cell_id"):
        resolved[logical] = resolve_column(
            atlas.obs,
            field_config.get(logical),
            FIELD_DEFAULTS[logical],
        )

    if resolved["donor"] is None and fixed.get("donor") is None:
        raise KeyError(
            f"{file_id}: donor metadata is required; do not treat cells as replicates"
        )
    if resolved["region"] is None and fixed.get("region") is None:
        raise KeyError(f"{file_id}: region metadata is required")
    if resolved["cell_type"] is None and fixed.get("cell_type") is None:
        raise KeyError(f"{file_id}: cell-type metadata is required")
    if resolved["sample"] is None and fixed.get("sample") is None:
        warnings.append(
            "sample metadata unavailable; file_id used as a technical sample"
        )

    group = pd.DataFrame(index=atlas.obs.index)
    group["dataset_id"] = dataset_id
    group["file_id"] = file_id
    group["donor_id"] = string_series(
        atlas.obs,
        resolved["donor"],
        fixed.get("donor"),
    )
    group["sample_id"] = string_series(
        atlas.obs,
        resolved["sample"],
        fixed.get("sample"),
        fallback=file_id,
    )
    group["region_id"] = string_series(
        atlas.obs,
        resolved["region"],
        fixed.get("region"),
    )
    group["cell_type"] = string_series(
        atlas.obs,
        resolved["cell_type"],
        fixed.get("cell_type"),
    )

    covariates = field_config.get("covariates", {})
    for logical, requested in covariates.items():
        column = resolve_column(atlas.obs, requested, [])
        resolved[f"covariate:{logical}"] = column
        if column is not None or logical in fixed:
            group[str(logical)] = string_series(
                atlas.obs,
                column,
                fixed.get(logical),
                fallback="Unspecified",
            )

    return group, resolved, warnings


def factorize_groups(group: pd.DataFrame) -> tuple[np.ndarray, pd.DataFrame]:
    multi = pd.MultiIndex.from_frame(group)
    codes, uniques = pd.factorize(multi, sort=True)
    strata = uniques.to_frame(index=False)
    strata.columns = group.columns
    strata.index = pd.Index(
        [f"stratum_{index:06d}" for index in range(len(strata))],
        name="summary_row",
    )
    return codes.astype(np.int64), strata


def summarize_file(
    *,
    path: Path,
    output_path: Path,
    dataset_id: str,
    dataset_label: str,
    file_id: str,
    field_config: dict[str, Any],
    fixed: dict[str, Any],
    matrix_source: str,
    target_sum: float,
    chunk_size: int,
    include_pseudobulk: bool,
    audit_only: bool,
) -> dict[str, Any]:
    atlas = ad.read_h5ad(path, backed="r")
    try:
        feature_var = atlas.raw.var if matrix_source == "raw.X" else atlas.var
        feature_names = (
            atlas.raw.var_names if matrix_source == "raw.X" else atlas.var_names
        )
        features, symbol_column = feature_frame(
            feature_var,
            feature_names,
            field_config.get("gene_symbol"),
        )
        matrix = matrix_from_source(atlas, matrix_source)
        if int(matrix.shape[1]) != len(features):
            raise ValueError("matrix and feature metadata have different widths")
        gene_count = int(matrix.shape[1])
        matrix_audit = sample_matrix_audit(matrix, atlas.n_obs, gene_count)
        if not matrix_audit["count_like"]:
            raise ValueError(
                f"{path}: matrix sample is not count-like; do not renormalize "
                "an already normalized/log-transformed matrix"
            )

        group, resolved, warnings = build_group_frame(
            atlas,
            dataset_id=dataset_id,
            file_id=file_id,
            field_config=field_config,
            fixed=fixed,
        )
        codes, strata = factorize_groups(group)
        group_count = len(strata)
        counts = np.bincount(codes, minlength=group_count).astype(np.int64)
        strata["n_cells"] = counts

        cell_id_column = resolved.get("cell_id")
        within_file_cell_ids_unique = None
        if cell_id_column is not None:
            within_file_cell_ids_unique = bool(
                atlas.obs[cell_id_column].astype(str).is_unique
            )
            if not within_file_cell_ids_unique:
                warnings.append(
                    f"duplicate cell IDs detected in obs[{cell_id_column!r}]"
                )

        audit = {
            "dataset_id": dataset_id,
            "dataset_label": dataset_label,
            "file_id": file_id,
            "source_path": str(path),
            "source_sha256": sha256_file(path),
            "n_cells": int(atlas.n_obs),
            "n_genes": gene_count,
            "n_strata": int(group_count),
            "donor_count": int(group["donor_id"].nunique()),
            "sample_count": int(group["sample_id"].nunique()),
            "region_count": int(group["region_id"].nunique()),
            "cell_type_count": int(group["cell_type"].nunique()),
            "resolved_fields": resolved,
            "gene_symbol_field": symbol_column,
            "matrix_source": matrix_source,
            "matrix_audit": matrix_audit,
            "obs_names_unique": bool(atlas.obs_names.is_unique),
            "within_file_cell_ids_unique": within_file_cell_ids_unique,
            "warnings": warnings,
        }
        if audit_only:
            return audit

        sum_log = np.zeros((group_count, gene_count), dtype=np.float64)
        detected = np.zeros_like(sum_log)
        pseudobulk = (
            np.zeros_like(sum_log) if include_pseudobulk else None
        )

        for start in range(0, atlas.n_obs, chunk_size):
            stop = min(atlas.n_obs, start + chunk_size)
            block = matrix[start:stop]
            if sp.issparse(block):
                raw = block.tocsr(copy=True)
            else:
                raw = sp.csr_matrix(np.asarray(block))
            if raw.data.size and (
                not np.all(np.isfinite(raw.data))
                or np.any(raw.data < 0)
            ):
                raise ValueError(f"{path}: negative or non-finite count value")

            local_codes = codes[start:stop]
            membership = sp.csr_matrix(
                (
                    np.ones(stop - start, dtype=np.float64),
                    (local_codes, np.arange(stop - start)),
                ),
                shape=(group_count, stop - start),
            )
            if pseudobulk is not None:
                pseudobulk += (membership @ raw).toarray()

            normalized = raw.astype(np.float64, copy=True)
            library_sizes = np.asarray(raw.sum(axis=1)).ravel()
            scales = np.divide(
                target_sum,
                library_sizes,
                out=np.zeros_like(library_sizes, dtype=np.float64),
                where=library_sizes > 0,
            )
            normalized.data *= np.repeat(scales, np.diff(normalized.indptr))
            np.log1p(normalized.data, out=normalized.data)
            sum_log += (membership @ normalized).toarray()

            binary = raw.copy()
            binary.data = np.ones_like(binary.data, dtype=np.float64)
            detected += (membership @ binary).toarray()
            print(
                f"[{dataset_id}/{file_id}] {stop:,}/{atlas.n_obs:,} cells",
                flush=True,
            )

        divisor = counts[:, None]
        mean_log = np.divide(
            sum_log,
            divisor,
            out=np.zeros_like(sum_log),
            where=divisor > 0,
        ).astype(np.float32)
        detection_fraction = np.divide(
            detected,
            divisor,
            out=np.zeros_like(detected),
            where=divisor > 0,
        ).astype(np.float32)

        summary = ad.AnnData(
            X=mean_log,
            obs=strata,
            var=features,
        )
        summary.layers["detection_fraction"] = detection_fraction
        if pseudobulk is not None:
            summary.layers["pseudobulk_counts"] = sp.csr_matrix(pseudobulk)
        summary.uns["digitalbrain_summary"] = {
            "schema_version": 2,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "dataset_id": dataset_id,
            "dataset_label": dataset_label,
            "file_id": file_id,
            "source_sha256": audit["source_sha256"],
            "matrix_source": matrix_source,
            "input_scale": "raw_counts",
            "normalization": {
                "target_sum": target_sum,
                "transform": "log1p",
            },
            "atomic_unit": (
                "dataset x file x donor x sample x region x cell type "
                "x configured covariates"
            ),
            "x_metric": "mean_log1p_counts_per_target_sum",
            "detection_layer": "detection_fraction",
            "pseudobulk_layer": (
                "pseudobulk_counts" if pseudobulk is not None else "omitted"
            ),
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        summary.write_h5ad(output_path, compression="gzip")
        audit["summary_path"] = str(output_path)
        audit["summary_bytes"] = output_path.stat().st_size
        audit["summary_sha256"] = sha256_file(output_path)
        return audit
    finally:
        atlas.file.close()


def main() -> None:
    args = parse_args()
    if args.chunk_size < 1:
        raise SystemExit("--chunk-size must be positive")
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    if int(config.get("schema_version", 0)) != 2:
        raise ValueError("configuration schema_version must be 2")
    matrix_config = config.get("matrix", {})
    if matrix_config.get("input_scale", "raw_counts") != "raw_counts":
        raise ValueError(
            "this summarizer currently accepts only declared raw_counts input"
        )
    matrix_source = str(matrix_config.get("source", "X"))
    target_sum = float(
        config.get("normalization", {}).get("target_sum", 10000)
    )
    field_config = {
        **FIELD_DEFAULTS,
        **config.get("fields", {}),
    }
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    audits: list[dict[str, Any]] = []
    for dataset in config["datasets"]:
        dataset_id = safe_id(dataset["id"])
        dataset_label = str(dataset.get("label", dataset_id))
        dataset_fixed = dict(dataset.get("fixed", {}))
        for file_item in dataset["files"]:
            file_id = safe_id(file_item["id"])
            path = (config_path.parent / file_item["path"]).resolve()
            if not path.is_file():
                raise FileNotFoundError(path)
            fixed = {**dataset_fixed, **file_item.get("fixed", {})}
            summary_path = (
                output_dir
                / dataset_id
                / f"{file_id}.summary.h5ad"
            )
            audit = summarize_file(
                path=path,
                output_path=summary_path,
                dataset_id=dataset_id,
                dataset_label=dataset_label,
                file_id=file_id,
                field_config=field_config,
                fixed=fixed,
                matrix_source=matrix_source,
                target_sum=target_sum,
                chunk_size=args.chunk_size,
                include_pseudobulk=not args.omit_pseudobulk,
                audit_only=args.audit_only,
            )
            if "summary_path" in audit:
                audit["summary_file"] = str(
                    summary_path.relative_to(output_dir)
                )
                del audit["summary_path"]
            audits.append(audit)

    manifest = {
        "schema_version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "audit_only": args.audit_only,
        "config": str(config_path),
        "normalization": {
            "target_sum": target_sum,
            "transform": "log1p",
        },
        "files": audits,
        "totals": {
            "file_count": len(audits),
            "dataset_count": len({item["dataset_id"] for item in audits}),
            "cell_count": sum(item["n_cells"] for item in audits),
        },
        "important": (
            "Files are storage shards. Dataset, donor, sample, region and "
            "cell type remain separate biological/technical axes."
        ),
    }
    manifest_path = output_dir / (
        "audit_manifest.json" if args.audit_only else "summary_manifest.json"
    )
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"[done] wrote {manifest_path}", flush=True)


if __name__ == "__main__":
    main()
