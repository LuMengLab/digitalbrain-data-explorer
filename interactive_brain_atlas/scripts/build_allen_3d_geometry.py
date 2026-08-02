#!/usr/bin/env python3
"""Build a browser-friendly surface-point representation of the Allen 3D atlas.

The source NIfTI remains the authoritative geometry. This script samples its
outer surface and every inter-parcel boundary so the dependency-free browser
viewer can render real anatomy without loading a 277 MB uncompressed volume.
"""

from __future__ import annotations

import gzip
import csv
import io
import json
import re
import struct
from pathlib import Path

import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = APP_DIR.parents[1]
SOURCE_DIR = (
    PROJECT_ROOT
    / "data"
    / "external"
    / "allen_human_reference_atlas_3d_2020"
)
NIFTI_PATH = SOURCE_DIR / "annotation_full.nii.gz"
LABEL_PATH = SOURCE_DIR / "itksnap_label_description_Br.txt"
ONTOLOGY_PATH = PROJECT_ROOT / "hierarchical clustering" / "Ontology_flat.json"
AUDIT_PATH = APP_DIR / "audits" / "allen_3d_region_mapping_audit.json"
CROSSWALK_PATH = APP_DIR / "data" / "allen_3d_broad_crosswalk.json"
OUTPUT_PATH = APP_DIR / "data" / "allen_3d_geometry.js"
CROSSWALK_AUDIT_PATH = (
    APP_DIR / "audits" / "allen_3d_whole_brain_display_crosswalk.csv"
)

SAMPLE_STEP = 2
MAX_OUTER_POINTS_PER_LABEL = 120
MAX_BOUNDARY_POINTS_PER_LABEL = 90


def read_nifti(path: Path) -> tuple[np.ndarray, dict]:
    with gzip.open(path, "rb") as handle:
        payload = handle.read()

    if struct.unpack("<i", payload[:4])[0] == 348:
        endian = "<"
    elif struct.unpack(">i", payload[:4])[0] == 348:
        endian = ">"
    else:
        raise ValueError("The annotation file is not a NIfTI-1 volume.")

    dimensions = struct.unpack(f"{endian}8h", payload[40:56])
    datatype, bitpix = struct.unpack(f"{endian}2h", payload[70:74])
    pixdim = struct.unpack(f"{endian}8f", payload[76:108])
    voxel_offset = int(struct.unpack(f"{endian}f", payload[108:112])[0])
    qform_code = struct.unpack(f"{endian}h", payload[252:254])[0]
    quaternion = struct.unpack(f"{endian}3f", payload[256:268])
    qoffset = struct.unpack(f"{endian}3f", payload[268:280])

    if dimensions[0] != 3 or datatype != 768 or bitpix != 32:
        raise ValueError(
            "Expected a three-dimensional unsigned 32-bit Allen annotation volume."
        )
    if qform_code == 0 or any(abs(value) > 1e-7 for value in quaternion):
        raise ValueError("Expected the axis-aligned qform supplied by the Allen atlas.")

    shape = tuple(int(value) for value in dimensions[1:4])
    dtype = np.dtype(f"{endian}u4")
    volume = np.frombuffer(payload, dtype=dtype, offset=voxel_offset).reshape(
        shape, order="F"
    )
    sampled = np.array(
        volume[::SAMPLE_STEP, ::SAMPLE_STEP, ::SAMPLE_STEP], copy=True
    )
    return sampled, {
        "sourceShape": list(shape),
        "sampleStep": SAMPLE_STEP,
        "voxelSizeMm": [float(value) for value in pixdim[1:4]],
        "qoffsetMm": [float(value) for value in qoffset],
    }


def read_labels(path: Path, ontology_path: Path) -> list[dict]:
    ontology = json.loads(ontology_path.read_text())
    by_raw_id = {str(node["raw_id"]): node for node in ontology}
    labels = []
    pattern = re.compile(
        r'^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+1\s+1\s+1\s+"(.+) - (\d+)"$'
    )
    for line in path.read_text().strip().splitlines():
        match = pattern.match(line)
        if not match:
            raise ValueError(f"Unrecognized label-description row: {line}")
        value, red, green, blue, acronym, raw_id = match.groups()
        node = by_raw_id.get(raw_id)
        if node is None:
            raise ValueError(f"Ontology node {raw_id} is absent.")
        labels.append(
            {
                "value": int(value),
                "acronym": acronym,
                "name": node["name"],
                "rawId": int(raw_id),
                "color": f"#{int(red):02x}{int(green):02x}{int(blue):02x}",
            }
        )
    return labels


def boundary_masks(volume: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    boundary = np.zeros(volume.shape, dtype=bool)
    outer = np.zeros(volume.shape, dtype=bool)

    for axis in range(3):
        left = [slice(None)] * 3
        right = [slice(None)] * 3
        left[axis] = slice(None, -1)
        right[axis] = slice(1, None)
        left = tuple(left)
        right = tuple(right)

        left_values = volume[left]
        right_values = volume[right]
        different = left_values != right_values
        left_nonzero = left_values != 0
        right_nonzero = right_values != 0

        boundary[left] |= different & left_nonzero
        boundary[right] |= different & right_nonzero
        outer[left] |= different & left_nonzero & ~right_nonzero
        outer[right] |= different & right_nonzero & ~left_nonzero

        first = [slice(None)] * 3
        last = [slice(None)] * 3
        first[axis] = 0
        last[axis] = -1
        first = tuple(first)
        last = tuple(last)
        boundary[first] |= volume[first] != 0
        boundary[last] |= volume[last] != 0
        outer[first] |= volume[first] != 0
        outer[last] |= volume[last] != 0

    return boundary, outer


def grouped_coordinates(
    coordinates: np.ndarray, values: np.ndarray
) -> dict[int, np.ndarray]:
    order = np.argsort(values, kind="stable")
    sorted_values = values[order]
    sorted_coordinates = coordinates[order]
    unique_values, starts = np.unique(sorted_values, return_index=True)
    ends = np.r_[starts[1:], len(sorted_values)]
    return {
        int(value): sorted_coordinates[start:end]
        for value, start, end in zip(unique_values, starts, ends)
    }


def evenly_sample(coordinates: np.ndarray, maximum: int) -> np.ndarray:
    if len(coordinates) <= maximum:
        return coordinates
    indices = np.linspace(0, len(coordinates) - 1, maximum, dtype=np.int64)
    return coordinates[indices]


def flatten_points(
    labels: list[dict],
    grouped: dict[int, np.ndarray],
    maximum: int,
) -> list[int]:
    output: list[int] = []
    for label_index, label in enumerate(labels):
        sampled = evenly_sample(
            grouped.get(label["rawId"], np.empty((0, 3), dtype=np.int64)),
            maximum,
        )
        for x, y, z in sampled:
            output.extend(
                [
                    int(x) * SAMPLE_STEP,
                    int(y) * SAMPLE_STEP,
                    int(z) * SAMPLE_STEP,
                    label_index,
                ]
            )
    return output


def main() -> None:
    volume, spatial = read_nifti(NIFTI_PATH)
    labels = read_labels(LABEL_PATH, ONTOLOGY_PATH)
    label_values = {label["rawId"] for label in labels}
    observed_values = {int(value) for value in np.unique(volume) if value != 0}
    if observed_values != label_values:
        missing = sorted(label_values - observed_values)
        unexpected = sorted(observed_values - label_values)
        raise ValueError(f"Label mismatch; missing={missing}, unexpected={unexpected}")

    boundary, outer = boundary_masks(volume)
    nonzero_coordinates = np.argwhere(volume != 0)
    minimum = nonzero_coordinates.min(axis=0) * SAMPLE_STEP
    maximum = nonzero_coordinates.max(axis=0) * SAMPLE_STEP
    del nonzero_coordinates

    boundary_coordinates = np.argwhere(boundary)
    boundary_values = volume[tuple(boundary_coordinates.T)]
    outer_coordinates = np.argwhere(outer)
    outer_values = volume[tuple(outer_coordinates.T)]
    boundary_grouped = grouped_coordinates(boundary_coordinates, boundary_values)
    outer_grouped = grouped_coordinates(outer_coordinates, outer_values)

    for label in labels:
        points = boundary_grouped[label["rawId"]]
        centroid = points.mean(axis=0) * SAMPLE_STEP
        label["centroidVoxel"] = [round(float(value), 2) for value in centroid]
        label["boundaryVoxelCount"] = int(len(points))
        label["outerVoxelCount"] = int(len(outer_grouped.get(label["rawId"], [])))

    audit = json.loads(AUDIT_PATH.read_text())
    broad_crosswalk = json.loads(CROSSWALK_PATH.read_text())["mappings"]
    label_index_by_value = {
        label["value"]: index for index, label in enumerate(labels)
    }
    label_index_by_acronym = {
        label["acronym"]: index for index, label in enumerate(labels)
    }
    region_mappings = {}
    for row in audit["rows"]:
        display_region = row["displayRegion"]
        if row["mappingStatus"] == "recoverable_exact_or_union":
            region_mappings[display_region] = {
                "status": row["mappingStatus"],
                "labelIndices": [
                    label_index_by_value[value] for value in row["atlasValues"]
                ],
                "atlasAcronyms": row["atlasAcronyms"],
                "basis": "Direct ontology match or union of annotated descendants.",
            }
            continue

        proxy = broad_crosswalk.get(display_region)
        if proxy is None:
            raise ValueError(
                f"Missing display crosswalk for non-exact region {display_region}."
            )
        unknown_acronyms = [
            acronym
            for acronym in proxy["atlasAcronyms"]
            if acronym not in label_index_by_acronym
        ]
        if unknown_acronyms:
            raise ValueError(
                f"Unknown Allen acronyms for {display_region}: {unknown_acronyms}"
            )
        region_mappings[display_region] = {
            "status": proxy["status"],
            "labelIndices": [
                label_index_by_acronym[acronym]
                for acronym in proxy["atlasAcronyms"]
            ],
            "atlasAcronyms": proxy["atlasAcronyms"],
            "basis": proxy["basis"],
        }

    spatial["nonzeroVoxelBounds"] = {
        "minimum": [int(value) for value in minimum],
        "maximum": [int(value) for value in maximum],
    }
    spatial["orientation"] = {
        "sourceAxes": ["left-right", "posterior-anterior", "inferior-superior"],
        "viewerAxes": ["left-right", "inferior-superior", "posterior-anterior"],
    }
    outer_points = flatten_points(
        labels, outer_grouped, MAX_OUTER_POINTS_PER_LABEL
    )
    boundary_points = flatten_points(
        labels, boundary_grouped, MAX_BOUNDARY_POINTS_PER_LABEL
    )
    output = {
        "metadata": {
            "name": "Allen Human Reference Atlas – 3D, 2020",
            "version": "1.0.0",
            "rrid": "SCR_017764",
            "license": "CC BY 4.0",
            "source": (
                "https://download.alleninstitute.org/informatics-archive/"
                "allen_human_reference_atlas_3d_2020/version_1/"
                "annotation_full.nii.gz"
            ),
            "labelCount": len(labels),
            "exactDigitalBrainRegionCount": sum(
                mapping["status"] == "recoverable_exact_or_union"
                for mapping in region_mappings.values()
            ),
            "proxyDigitalBrainRegionCount": sum(
                mapping["status"]
                in {"coarse_ontology_proxy", "curated_gyral_proxy"}
                for mapping in region_mappings.values()
            ),
            "placedDigitalBrainRegionCount": sum(
                len(mapping["labelIndices"]) > 0
                for mapping in region_mappings.values()
            ),
            "outerPointCount": len(outer_points) // 4,
            "boundaryPointCount": len(boundary_points) // 4,
            "representation": (
                "Decimated surface samples derived from the official voxel labels"
            ),
            **spatial,
        },
        "labels": labels,
        "outerPoints": outer_points,
        "boundaryPoints": boundary_points,
        "regionMappings": region_mappings,
    }
    OUTPUT_PATH.write_text(
        "window.ALLEN_3D_ATLAS = "
        + json.dumps(output, separators=(",", ":"))
        + ";\n"
    )
    crosswalk_buffer = io.StringIO()
    writer = csv.writer(crosswalk_buffer)
    writer.writerow(
        ["display_region", "display_status", "allen_3d_acronyms", "mapping_basis"]
    )
    for display_region, mapping in region_mappings.items():
        writer.writerow(
            [
                display_region,
                mapping["status"],
                "|".join(mapping["atlasAcronyms"]),
                mapping["basis"],
            ]
        )
    CROSSWALK_AUDIT_PATH.write_text(crosswalk_buffer.getvalue())
    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "crosswalkAudit": str(CROSSWALK_AUDIT_PATH),
                "labels": len(labels),
                "outerPoints": len(outer_points) // 4,
                "boundaryPoints": len(boundary_points) // 4,
                "mappedDigitalBrainRegions": output["metadata"][
                    "placedDigitalBrainRegionCount"
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
