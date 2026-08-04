"""从上游 audit manifest 读出基因图谱统计所需的源文件清单与字段名。

字段名逐文件解析（manifest 的 resolved_fields），因为细胞类型字段在 99 个文件里
有两种取值；硬编码单一字段会静默漏掉 HBCA 的两个文件。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import json

import h5py
import numpy as np

AUDIT_MANIFEST = Path(
    "/data/DigitalBrain/data/scBrainCellAtlas/outputs"
    "/external_three_sources_audit_2026-08-02/audit_manifest.json"
)

# Overview 页面（digitalneuron_data.js）的口径，用作披露基准。
EXPLORER_CELLS = 16_352_123


@dataclass(frozen=True)
class SourceEntry:
    dataset_id: str
    file_id: str
    source_path: str
    matrix_source: str
    region_field: str
    region_gyral_field: str
    cell_type_field: str
    donor_field: str
    n_cells: int


@dataclass(frozen=True)
class Inventory:
    usable: list[SourceEntry]
    skipped: list[str]
    explorer_cells: int
    usable_cells: int

    @property
    def excluded_cells(self) -> int:
        return self.explorer_cells - self.usable_cells


def load_inventory(manifest_path: Path = AUDIT_MANIFEST) -> Inventory:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    usable: list[SourceEntry] = []
    skipped: list[str] = []
    usable_cells = 0

    for record in payload["files"]:
        matrix_source = record.get("matrix_source")
        if not matrix_source:
            # status=skipped, reason=no_count_like_matrix_source：无原始 counts，
            # 无法计算检出率，必须排除。
            skipped.append(record["dataset_id"])
            continue

        fields = record.get("resolved_fields") or {}
        n_cells = int(record.get("n_cells_selected") or 0)
        usable_cells += n_cells
        usable.append(
            SourceEntry(
                dataset_id=record["dataset_id"],
                file_id=record["file_id"],
                source_path=record["source_path"],
                matrix_source=matrix_source,
                region_field=fields["region"],
                region_gyral_field=fields["region_gyral"],
                cell_type_field=fields["cell_type"],
                donor_field=fields["donor"],
                n_cells=n_cells,
            )
        )

    return Inventory(
        usable=usable,
        skipped=skipped,
        explorer_cells=EXPLORER_CELLS,
        usable_cells=usable_cells,
    )


@dataclass(frozen=True)
class Vocabularies:
    regions: frozenset[str]
    cell_types: frozenset[str]


def read_obs_categories(obs_group: h5py.Group, field: str) -> set[str]:
    """读一个 obs 分类字段的全部取值，兼容 categorical 与纯数组两种编码。"""
    node = obs_group[field]
    if isinstance(node, h5py.Group):
        return set(np.asarray(node["categories"]).astype(str).tolist())
    return set(np.asarray(node).astype(str).tolist())


def collect_vocabularies(inventory: Inventory) -> Vocabularies:
    regions: set[str] = set()
    cell_types: set[str] = set()
    for entry in inventory.usable:
        with h5py.File(entry.source_path, "r") as handle:
            obs = handle["obs"]
            regions |= read_obs_categories(obs, entry.region_field)
            cell_types |= read_obs_categories(obs, entry.cell_type_field)
    return Vocabularies(regions=frozenset(regions), cell_types=frozenset(cell_types))
