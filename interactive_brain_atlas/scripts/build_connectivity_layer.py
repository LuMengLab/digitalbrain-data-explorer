#!/usr/bin/env python3
"""Build the browser connectivity asset from the project FC and SC matrices."""

from __future__ import annotations

import csv
import json
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = APP_DIR.parents[1]
REGION_DATA_PATH = APP_DIR / "data" / "regions.js"
FC_PATH = PROJECT_ROOT / "hierarchical clustering" / "SCFC" / "FC_FU2_mean_GSR.csv"
SC_PATH = (
    PROJECT_ROOT
    / "hierarchical clustering"
    / "SCFC"
    / "SC_group_average_nwk_density.csv"
)
OUTPUT_PATH = APP_DIR / "data" / "connectivity.js"


def read_region_data(path: Path) -> dict:
    text = path.read_text().strip()
    prefix = "window.DIGITALBRAIN_REGION_DATA = "
    start = text.find(prefix)
    if start < 0 or not text.endswith(";"):
        raise ValueError("Unexpected regions.js wrapper.")
    return json.loads(text[start + len(prefix) : -1])


def read_matrix(path: Path) -> tuple[list[str], dict[tuple[str, str], float]]:
    with path.open(newline="") as handle:
        rows = list(csv.reader(handle))
    labels = rows[0][1:]
    if len(rows) != len(labels) + 1:
        raise ValueError(f"{path.name} is not square.")
    values: dict[tuple[str, str], float] = {}
    for row_index, row in enumerate(rows[1:]):
        row_label = row[0]
        if row_label != labels[row_index] or len(row) != len(labels) + 1:
            raise ValueError(f"{path.name} row labels or dimensions are inconsistent.")
        for column_index, column_label in enumerate(labels):
            values[(row_label, column_label)] = float(row[column_index + 1])
    maximum_error = max(
        abs(values[(left, right)] - values[(right, left)])
        for left in labels
        for right in labels
    )
    if maximum_error > 1e-9:
        raise ValueError(f"{path.name} is not symmetric: max error {maximum_error}.")
    return labels, values


def quantile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def main() -> None:
    region_data = read_region_data(REGION_DATA_PATH)
    fc_labels, fc_values = read_matrix(FC_PATH)
    sc_labels, sc_values = read_matrix(SC_PATH)
    if set(fc_labels) != set(sc_labels):
        raise ValueError("FC and SC matrices do not contain the same regions.")

    region_by_name = {region["name"]: region for region in region_data["regions"]}
    missing = sorted(set(fc_labels) - set(region_by_name))
    if missing:
        raise ValueError(f"Connectivity labels absent from the atlas: {missing}")

    nodes = [
        {
            "id": region["id"],
            "acronym": region["acronym"],
            "name": region["name"],
            "group": region["group"],
        }
        for region in region_data["regions"]
        if region["name"] in set(fc_labels)
    ]
    node_index_by_name = {node["name"]: index for index, node in enumerate(nodes)}
    edges = []
    functional_values = []
    structural_values = []
    for left_index, left in enumerate(nodes):
        for right_index in range(left_index + 1, len(nodes)):
            right = nodes[right_index]
            functional = fc_values[(left["name"], right["name"])]
            structural = sc_values[(left["name"], right["name"])]
            edges.append(
                [
                    node_index_by_name[left["name"]],
                    node_index_by_name[right["name"]],
                    round(functional, 8),
                    round(structural, 8),
                ]
            )
            functional_values.append(functional)
            structural_values.append(structural)

    metadata = {
        "regionCount": len(nodes),
        "edgeCount": len(edges),
        "regionUniverse": "55 regions shared by FC, SC, and Table 2 clustering exports",
        "functional": {
            "source": str(FC_PATH.relative_to(PROJECT_ROOT)),
            "label": "Functional connectivity",
            "range": [min(functional_values), max(functional_values)],
            "quantiles": {
                str(percentile): quantile(functional_values, percentile / 100)
                for percentile in [90, 92, 94, 96, 98, 99]
            },
        },
        "structural": {
            "source": str(SC_PATH.relative_to(PROJECT_ROOT)),
            "label": "Structural connectivity",
            "range": [min(structural_values), max(structural_values)],
            "quantiles": {
                str(percentile): quantile(structural_values, percentile / 100)
                for percentile in [90, 92, 94, 96, 98, 99]
            },
        },
        "interpretation": (
            "Connectivity-derived region links; edge display is descriptive and "
            "thresholded by within-matrix percentile."
        ),
    }
    output = {"metadata": metadata, "nodes": nodes, "edges": edges}
    OUTPUT_PATH.write_text(
        "window.DIGITALBRAIN_CONNECTIVITY_DATA = "
        + json.dumps(output, separators=(",", ":"))
        + ";\n"
    )
    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "nodes": len(nodes),
                "edges": len(edges),
                "functionalRange": metadata["functional"]["range"],
                "structuralRange": metadata["structural"]["range"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
