"""Stage B：把 Stage A 的逐文件缓存合并成跨数据集的 (region, cell_type, gene) 统计。

两种聚合规则都算，前端可切换：

- cell_weighted   : Σ(组均值 x 组细胞数) / Σ组细胞数
- donor_balanced  : donor 内按细胞加权 -> 数据集内 donor 等权 -> 跨数据集等权

两者都能从 donor 级缓存直接推导，Stage A 无额外成本。
区域级取值由细胞类型级按同一规则汇总——必须与前端的子集重算口径一致，
否则「全选所有类型」得到的值会与不过滤时不同。

缺失 != 零：没有任何 donor 覆盖的组合不写入结果，键直接不存在。
"""

from __future__ import annotations

import importlib.util
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent

RULES = ("cell_weighted", "donor_balanced")


def _load_sibling(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class CacheRow:
    """Stage A 缓存里的一行：一个 (dataset, donor, region, cell_type, gene) 的统计。"""

    dataset: str
    donor: str
    region: str
    cell_type: str
    gene: str
    mean: float
    detection: float
    n_cells: int


@dataclass(frozen=True)
class Support:
    datasets: int
    donors: int
    cells: int


@dataclass(frozen=True)
class MergeResult:
    rule: str
    mean: dict               # (region, cell_type, gene) -> 平均表达
    detection: dict          # (region, cell_type, gene) -> 检出率
    cells: dict              # (region, cell_type, gene) -> 细胞数，前端子集重算的权重
    support: dict            # (region, cell_type, gene) -> Support
    regions: dict            # (region, gene) -> 区域级平均表达
    region_detection: dict   # (region, gene) -> 区域级检出率
    region_support: dict     # (region, gene) -> Support


def _weighted(pairs):
    """按细胞数加权平均；总细胞数为 0 时返回 None 交由调用方按缺失处理。"""
    total = sum(cells for _value, cells in pairs)
    if total <= 0:
        return None
    return sum(value * cells for value, cells in pairs) / total


def _mean(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _combine(rows, rule: str):
    """把同一 (region, cell_type, gene) 的多行按规则合成一个 (mean, detection)。"""
    if rule == "cell_weighted":
        return (
            _weighted([(r.mean, r.n_cells) for r in rows]),
            _weighted([(r.detection, r.n_cells) for r in rows]),
        )

    # donor_balanced：donor 内按细胞加权 -> 数据集内 donor 等权 -> 数据集等权。
    per_donor = defaultdict(list)
    for r in rows:
        per_donor[(r.dataset, r.donor)].append(r)

    per_dataset_mean = defaultdict(list)
    per_dataset_detect = defaultdict(list)
    for (dataset, _donor), donor_rows in per_donor.items():
        donor_mean = _weighted([(r.mean, r.n_cells) for r in donor_rows])
        donor_detect = _weighted([(r.detection, r.n_cells) for r in donor_rows])
        if donor_mean is None:
            continue
        per_dataset_mean[dataset].append(donor_mean)
        per_dataset_detect[dataset].append(donor_detect)

    dataset_means = [_mean(v) for v in per_dataset_mean.values()]
    dataset_detects = [_mean(v) for v in per_dataset_detect.values()]
    return _mean(dataset_means), _mean(dataset_detects)


def merge(rows, rule: str = "cell_weighted") -> MergeResult:
    if rule not in RULES:
        raise ValueError(f"unknown rule {rule!r}, expected one of {RULES}")

    by_group = defaultdict(list)
    for r in rows:
        # 细胞数为 0 的组不携带信息，直接丢弃（不得当成 0 表达）。
        if r.n_cells <= 0:
            continue
        by_group[(r.region, r.cell_type, r.gene)].append(r)

    mean: dict = {}
    detection: dict = {}
    cells: dict = {}
    support: dict = {}

    for key, group_rows in by_group.items():
        combined_mean, combined_detect = _combine(group_rows, rule)
        if combined_mean is None:
            continue
        mean[key] = combined_mean
        detection[key] = combined_detect
        cells[key] = sum(r.n_cells for r in group_rows)
        support[key] = Support(
            datasets=len({r.dataset for r in group_rows}),
            donors=len({(r.dataset, r.donor) for r in group_rows}),
            cells=cells[key],
        )

    regions, region_detection, region_support = _rollup_regions(
        mean, detection, cells, support, rule
    )
    return MergeResult(
        rule=rule,
        mean=mean,
        detection=detection,
        cells=cells,
        support=support,
        regions=regions,
        region_detection=region_detection,
        region_support=region_support,
    )


def _rollup_regions(mean, detection, cells, support, rule: str):
    """由细胞类型级汇总到区域级，规则与前端子集重算保持一致。"""
    grouped = defaultdict(list)
    for (region, cell_type, gene), value in mean.items():
        inner = (region, cell_type, gene)
        grouped[(region, gene)].append(
            (value, detection[inner], cells[inner], support[inner])
        )

    regions: dict = {}
    region_detection: dict = {}
    region_support: dict = {}
    for key, items in grouped.items():
        if rule == "cell_weighted":
            regions[key] = _weighted([(m, c) for m, _d, c, _s in items])
            region_detection[key] = _weighted([(d, c) for _m, d, c, _s in items])
        else:
            regions[key] = _mean([m for m, _d, _c, _s in items])
            region_detection[key] = _mean([d for _m, d, _c, _s in items])
        region_support[key] = Support(
            datasets=max(s.datasets for _m, _d, _c, s in items),
            donors=max(s.donors for _m, _d, _c, s in items),
            cells=sum(c for _m, _d, c, _s in items),
        )
    return regions, region_detection, region_support


def rows_from_cache(path: Path, index, genes=None) -> list[CacheRow]:
    """读一个 Stage A 缓存并展开成 CacheRow，基因主键统一为 Ensembl。

    每个文件只存自身基因集，统一基因空间是本阶段的职责。
    genes 给定时只展开这些主键，避免为全部 6 万基因建行。
    """
    stage_a = _load_sibling("gene_atlas_stage_a")
    result = stage_a.read_cache(path)
    gene_keys, _audit = index.primary_keys(result.gene_ids.tolist())

    wanted = None if genes is None else set(genes)
    columns = [
        (j, key)
        for j, key in enumerate(gene_keys)
        if wanted is None or key in wanted
    ]

    rows: list[CacheRow] = []
    for i, key in enumerate(result.group_keys):
        n_cells = int(result.n_cells[i])
        if n_cells <= 0:
            continue
        mean_row = result.mean[i]
        detect_row = result.detection[i]
        for j, gene in columns:
            value = float(mean_row[j])
            detect = float(detect_row[j])
            # 全零组合不占体积：零表达在合并后仍是零，缺失才是缺键。
            if value == 0.0 and detect == 0.0:
                continue
            rows.append(
                CacheRow(
                    dataset=result.dataset_id,
                    donor=key.donor,
                    region=key.region,
                    cell_type=key.cell_type,
                    gene=gene,
                    mean=value,
                    detection=detect,
                    n_cells=n_cells,
                )
            )
    return rows
