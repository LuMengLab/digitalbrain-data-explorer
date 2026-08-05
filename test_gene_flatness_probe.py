"""`scripts/gene_flatness_probe.py` 的契约测试：跨类平坦度怎么算才可信。

这支探针存在的唯一理由，是 rank 脚本的 specificity（峰值类 / 全类中位）判不出
平坦度 —— 一个基因在多数类都高时，中位会被自己抬起来，比值反而很低。所以下面
`test_specificity_understates_a_broadly_high_gene` 是本文件最重要的一条：它把两个
指标放在同一批数据上对照，防止有人日后拿 specificity 去筛 housekeeping。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


def load_module(name: str):
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HERE / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def row(module, region, cell_type, gene, mean, detection, n_cells=100):
    return module.stage_b.CacheRow(
        dataset="ds1",
        donor="d1",
        region=region,
        cell_type=cell_type,
        gene=gene,
        mean=mean,
        detection=detection,
        n_cells=n_cells,
    )


# 每类 30 个区，稳稳高于 MIN_REGIONS = 20；THIN 只给 2 个区。
REGIONS = [f"R{i}" for i in range(30)]


@pytest.fixture
def probe_rows():
    module = load_module("gene_flatness_probe")
    rows = []
    for region in REGIONS:
        # FLAT：四类全 1.0，检出率也一样 -> fold 应当 ~1
        for cell_type in ("Neuron", "Astrocyte", "Microglia", "Vascular"):
            rows.append(row(module, region, cell_type, "FLAT", 1.0, 0.8))
        # MARKER：只有 Microglia 高
        rows.append(row(module, region, "Microglia", "MARKER", 10.0, 0.9))
        for cell_type in ("Neuron", "Astrocyte", "Vascular"):
            rows.append(row(module, region, cell_type, "MARKER", 0.1, 0.05))
        # BROADLY_HIGH：三个神经元类都高、只有 Microglia 低（ENO2 的形状）
        for cell_type, value in (("N1", 2.0), ("N2", 1.9), ("N3", 1.8)):
            rows.append(row(module, region, cell_type, "BROADLY_HIGH", value, 0.8))
        rows.append(row(module, region, "Microglia", "BROADLY_HIGH", 0.2, 0.1))
        # FLOOR：均值最低的类与检出率最低的类故意不是同一个
        rows.append(row(module, region, "Neuron", "FLOOR", 1.0, 0.9))
        rows.append(row(module, region, "Astrocyte", "FLOOR", 0.9, 0.2))
        rows.append(row(module, region, "Microglia", "FLOOR", 0.8, 0.85))
    # THIN：只在 2 个区有数据的类，且值极低。若参与比较会把 FLAT 的倍数抬到 100 倍。
    for region in REGIONS[:2]:
        rows.append(row(module, region, "Splatter", "FLAT", 0.01, 0.01))
    return module, rows


def test_flat_gene_and_marker_gene_are_separated_by_max_over_min(probe_rows):
    module, rows = probe_rows
    scored = module.flatness(rows)

    assert scored["FLAT"].fold == pytest.approx(1.0, abs=0.01)
    assert scored["MARKER"].fold == pytest.approx(100.0, rel=0.01)
    assert scored["MARKER"].top_class == "Microglia"


def test_a_class_measured_in_too_few_regions_cannot_set_the_floor(probe_rows):
    module, rows = probe_rows
    scored = module.flatness(rows)

    # Splatter 只有 2 个区，被 min_regions 排除，所以 FLAT 仍然是平的。
    assert scored["FLAT"].n_classes == 4
    assert scored["FLAT"].bottom_class != "Splatter"
    # 放低门槛后它就能挤进来并把倍数虚高 100 倍 —— 这正是要防的。
    loose = module.flatness(rows, min_regions=1)
    assert loose["FLAT"].bottom_class == "Splatter"
    assert loose["FLAT"].fold > 50


def test_detection_floor_is_reported_separately_from_the_lowest_mean(probe_rows):
    module, rows = probe_rows
    scored = module.flatness(rows)["FLOOR"]

    # 均值最低的是 Microglia(0.8)，但真正没测到的是 Astrocyte(检出率 0.2)。
    assert scored.bottom_class == "Microglia"
    assert scored.weakest_detection_class == "Astrocyte"
    assert scored.det_min == pytest.approx(0.2)
    assert scored.det_median == pytest.approx(0.85)


def test_specificity_understates_a_broadly_high_gene(probe_rows):
    """同一批数据上，peak/median 说它平，max/min 说它不平 —— 后者才对。"""
    module, rows = probe_rows
    rank = load_module("rank_gene_specificity")

    specificity = rank.score_genes(rows)["BROADLY_HIGH"].specificity
    fold = module.flatness(rows)["BROADLY_HIGH"].fold

    # 峰 2.0 / 类中位 1.85 ≈ 1.08，看着比 FLAT 还平；实际最高/最低是 10 倍。
    assert specificity < 1.2
    assert fold == pytest.approx(10.0, rel=0.01)
