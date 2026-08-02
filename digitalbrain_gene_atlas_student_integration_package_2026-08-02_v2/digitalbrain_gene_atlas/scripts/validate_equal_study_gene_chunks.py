#!/usr/bin/env python3
"""Validate browser gene chunks against the equal-study source H5AD.

The default audit checks metadata, selected biologically familiar genes, and a
deterministic random sample of rows/features. Pass ``--verify-all-hashes`` to
also recompute every chunk SHA-256 before deployment or handoff.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

import h5py
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--sample-genes", type=int, default=64)
    parser.add_argument("--sample-rows", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20260801)
    parser.add_argument("--verify-all-hashes", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path, block_size: int = 16 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    args = parse_args()
    source_path = args.input.resolve()
    bundle = args.bundle.resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("schemaVersion") != 3:
        raise ValueError("manifest schemaVersion must be 3")
    if source_path.name != manifest["source"]["file"]:
        raise ValueError("source filename does not match the manifest")
    if sha256_file(source_path) != manifest["source"]["sha256"]:
        raise ValueError("source H5AD SHA-256 does not match the manifest")

    with gzip.open(bundle / manifest["genes"]["indexFile"], "rt") as stream:
        gene_index = json.load(stream)
    row_count = int(manifest["matrix"]["rowCount"])
    gene_count = int(manifest["matrix"]["geneCount"])
    chunk_width = int(manifest["matrix"]["chunkGeneCount"])
    if len(gene_index["symbols"]) != gene_count:
        raise ValueError("gene-index width does not match the manifest")
    if len(manifest["rows"]) != row_count:
        raise ValueError("row registry height does not match the manifest")

    token_lookup = dict(
        zip(gene_index["searchTokens"], gene_index["searchIndices"], strict=True)
    )
    familiar = [
        token_lookup[token]
        for token in ("ASIC2", "GAPDH", "AKT2", "SNAP25", "GFAP", "MBP")
        if token in token_lookup
    ]
    rng = np.random.default_rng(args.seed)
    random_genes = rng.choice(
        gene_count,
        size=min(args.sample_genes, gene_count),
        replace=False,
    ).tolist()
    gene_indices = sorted(set(familiar + random_genes))
    row_indices = np.sort(
        rng.choice(row_count, size=min(args.sample_rows, row_count), replace=False)
    )

    if args.verify_all_hashes:
        for descriptor in manifest["chunks"]:
            path = bundle / descriptor["file"]
            if path.stat().st_size != int(descriptor["compressedBytes"]):
                raise ValueError(f"{path}: compressed byte-size mismatch")
            if sha256_file(path) != descriptor["sha256"]:
                raise ValueError(f"{path}: SHA-256 mismatch")

    maximum_mean_error = 0.0
    maximum_detection_error = 0.0
    with h5py.File(source_path, "r") as atlas:
        if atlas["X"].shape != (row_count, gene_count):
            raise ValueError("source X shape does not match the manifest")
        for chunk_index in sorted({index // chunk_width for index in gene_indices}):
            descriptor = manifest["chunks"][chunk_index]
            path = bundle / descriptor["file"]
            if not args.verify_all_hashes:
                if path.stat().st_size != int(descriptor["compressedBytes"]):
                    raise ValueError(f"{path}: compressed byte-size mismatch")
                if sha256_file(path) != descriptor["sha256"]:
                    raise ValueError(f"{path}: SHA-256 mismatch")
            decoded = gzip.decompress(path.read_bytes())
            width = int(descriptor["count"])
            value_count = row_count * width
            expected_bytes = value_count * int(descriptor["bytesPerValue"])
            if len(decoded) != expected_bytes:
                raise ValueError(f"{path}: decoded byte-size mismatch")
            if descriptor["encoding"] != "quantized-u16":
                raise ValueError(f"{path}: unsupported encoding")
            mean = (
                np.frombuffer(decoded, dtype="<u2", count=value_count).reshape(
                    row_count, width
                )
                * float(descriptor["meanScale"])
            )
            detection = (
                np.frombuffer(
                decoded,
                dtype="<u2",
                count=value_count,
                offset=value_count * 2,
                ).reshape(row_count, width)
                * float(descriptor["detectionScale"])
            )
            coverage = np.frombuffer(
                decoded,
                dtype=np.uint8,
                count=value_count,
                offset=value_count * 4,
            ).reshape(row_count, width)
            local_genes = [
                index
                for index in gene_indices
                if int(descriptor["start"])
                <= index
                < int(descriptor["start"]) + width
            ]
            local_indices = np.asarray(local_genes) - int(descriptor["start"])
            start = int(descriptor["start"])
            stop = start + width
            source_mean = atlas["X"][:, start:stop][
                np.ix_(row_indices, local_indices)
            ]
            source_detection = atlas["layers"]["detection_fraction"][:, start:stop][
                np.ix_(row_indices, local_indices)
            ]
            source_coverage = atlas["layers"]["dataset_coverage"][:, start:stop][
                np.ix_(row_indices, local_indices)
            ]
            mean_error = np.abs(
                mean[np.ix_(row_indices, local_indices)] - source_mean
            )
            detection_error = np.abs(
                detection[np.ix_(row_indices, local_indices)] - source_detection
            )
            chunk_mean_error = float(mean_error.max(initial=0))
            chunk_detection_error = float(detection_error.max(initial=0))
            maximum_mean_error = max(maximum_mean_error, chunk_mean_error)
            maximum_detection_error = max(
                maximum_detection_error, chunk_detection_error
            )
            if chunk_mean_error > float(descriptor["meanScale"]) / 2 + 1e-6:
                raise ValueError(f"{path}: mean quantization error exceeds its bound")
            if (
                chunk_detection_error
                > float(descriptor["detectionScale"]) / 2 + 1e-7
            ):
                raise ValueError(f"{path}: detection quantization error exceeds its bound")
            np.testing.assert_array_equal(
                coverage[np.ix_(row_indices, local_indices)], source_coverage
            )

    print(
        f"[pass] rows={len(row_indices):,} genes={len(gene_indices):,} "
        f"chunks={len({index // chunk_width for index in gene_indices}):,} "
        f"max_mean_error={maximum_mean_error:.3g} "
        f"max_detection_error={maximum_detection_error:.3g} "
        f"source={source_path.name}"
    )


if __name__ == "__main__":
    main()
