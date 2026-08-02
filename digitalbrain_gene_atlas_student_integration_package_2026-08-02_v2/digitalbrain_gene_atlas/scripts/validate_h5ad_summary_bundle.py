#!/usr/bin/env python3
"""Validate a DigitalBrain raw-summary handoff directory."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import anndata as ad
import numpy as np
import scipy.sparse as sp


def sha256_file(path: Path, block_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def values_are_finite(matrix, row_count: int, chunk_size: int = 64) -> bool:
    for start in range(0, row_count, chunk_size):
        block = matrix[start : start + chunk_size]
        values = block.data if sp.issparse(block) else np.asarray(block)
        if not np.all(np.isfinite(values)):
            return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    root = args.bundle.resolve()
    manifest_path = root / "summary_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if int(manifest.get("schema_version", 0)) != 2:
        raise ValueError("summary manifest schema_version must be 2")

    checked_cells = 0
    for item in manifest["files"]:
        path = root / item["summary_file"]
        if not path.is_file():
            raise FileNotFoundError(path)
        if path.stat().st_size != int(item["summary_bytes"]):
            raise ValueError(f"{path}: byte-size mismatch")
        if sha256_file(path) != item["summary_sha256"]:
            raise ValueError(f"{path}: SHA-256 mismatch")
        atlas = ad.read_h5ad(path, backed="r")
        try:
            if atlas.shape != (item["n_strata"], item["n_genes"]):
                raise ValueError(f"{path}: matrix shape mismatch")
            required_obs = {
                "dataset_id",
                "file_id",
                "donor_id",
                "sample_id",
                "region_id",
                "cell_type",
                "n_cells",
            }
            if not required_obs.issubset(atlas.obs.columns):
                raise ValueError(f"{path}: required obs metadata missing")
            if "detection_fraction" not in atlas.layers:
                raise ValueError(f"{path}: detection layer missing")
            if not values_are_finite(atlas.X, atlas.n_obs):
                raise ValueError(f"{path}: non-finite mean expression")
            detection = atlas.layers["detection_fraction"]
            if not values_are_finite(detection, atlas.n_obs):
                raise ValueError(f"{path}: non-finite detection values")
            for start in range(0, atlas.n_obs, 64):
                block = detection[start : start + 64]
                values = (
                    block.data if sp.issparse(block) else np.asarray(block)
                )
                if np.any(values < 0) or np.any(values > 1):
                    raise ValueError(f"{path}: detection outside [0, 1]")
            cell_count = int(atlas.obs["n_cells"].sum())
            if cell_count != int(item["n_cells"]):
                raise ValueError(f"{path}: cell-count mismatch")
            checked_cells += cell_count
            print(
                f"[pass] {item['dataset_id']}/{item['file_id']} "
                f"cells={cell_count:,} strata={atlas.n_obs:,} "
                f"genes={atlas.n_vars:,}"
            )
        finally:
            atlas.file.close()

    if checked_cells != int(manifest["totals"]["cell_count"]):
        raise ValueError("bundle total cell-count mismatch")
    print(
        f"[done] files={len(manifest['files'])} "
        f"cells={checked_cells:,} schema=2"
    )


if __name__ == "__main__":
    main()

