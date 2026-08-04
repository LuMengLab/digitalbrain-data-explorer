from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_stage_b.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_stage_b", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def row(module, dataset, donor, region, cell_type, gene, mean, detection, n_cells):
    return module.CacheRow(
        dataset=dataset,
        donor=donor,
        region=region,
        cell_type=cell_type,
        gene=gene,
        mean=mean,
        detection=detection,
        n_cells=n_cells,
    )


def two_donor_rows(module):
    """同一数据集内两个 donor：均值 1.0（10 细胞）与 4.0（30 细胞）。"""
    return [
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 1.0, 0.2, 10),
        row(module, "d1", "B", "EC", "Astrocyte", "ENSG1", 4.0, 0.6, 30),
    ]


def test_cell_weighted_rule_matches_the_closed_form():
    module = load_module()
    out = module.merge(two_donor_rows(module), rule="cell_weighted")
    # 细胞加权 = (1*10 + 4*30) / 40 = 3.25
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 3.25
    assert out.detection[("EC", "Astrocyte", "ENSG1")] == 0.5  # (0.2*10+0.6*30)/40


def test_donor_balanced_rule_ignores_donor_size():
    module = load_module()
    out = module.merge(two_donor_rows(module), rule="donor_balanced")
    # donor 等权：(1.0 + 4.0) / 2 = 2.5，与 10 vs 30 的细胞数无关
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 2.5
    assert out.detection[("EC", "Astrocyte", "ENSG1")] == 0.4  # (0.2+0.6)/2


def test_donor_balanced_gives_equal_weight_to_each_dataset():
    module = load_module()
    # d1 有 3 个 donor（均值 1/1/1），d2 只有 1 个（均值 5）。
    # 数据集等权：(1 + 5) / 2 = 3，d2 不应被 d1 淹没。
    rows = [
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 1.0, 0.1, 10),
        row(module, "d1", "B", "EC", "Astrocyte", "ENSG1", 1.0, 0.1, 10),
        row(module, "d1", "C", "EC", "Astrocyte", "ENSG1", 1.0, 0.1, 10),
        row(module, "d2", "D", "EC", "Astrocyte", "ENSG1", 5.0, 0.9, 10),
    ]
    out = module.merge(rows, rule="donor_balanced")
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 3.0
    # 细胞加权规则下同一份数据会被大队列支配：(1*30 + 5*10)/40 = 2.0
    weighted = module.merge(rows, rule="cell_weighted")
    assert weighted.mean[("EC", "Astrocyte", "ENSG1")] == 2.0


def test_multiple_rows_of_one_donor_are_averaged_within_that_donor_first():
    module = load_module()
    # 同 donor 的两行（例如两个 sample / 两个 Gyral 分区）先在 donor 内平均。
    rows = [
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 2.0, 0.2, 10),
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 4.0, 0.4, 30),
        row(module, "d1", "B", "EC", "Astrocyte", "ENSG1", 9.0, 0.9, 5),
    ]
    out = module.merge(rows, rule="donor_balanced")
    # donor A 内按细胞加权 = (2*10 + 4*30)/40 = 3.5；再与 donor B 等权 = (3.5 + 9)/2 = 6.25
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 6.25


def test_missing_group_is_absent_not_zero():
    module = load_module()
    out = module.merge(two_donor_rows(module), rule="cell_weighted")
    # 某区某类型无任何 donor 覆盖时，键不得存在（缺失 != 零表达）
    assert ("Pn", "Astrocyte", "ENSG1") not in out.mean
    assert ("EC", "Microglia", "ENSG1") not in out.mean


def test_support_counts_datasets_donors_and_cells():
    module = load_module()
    rows = [
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 1.0, 0.2, 10),
        row(module, "d1", "B", "EC", "Astrocyte", "ENSG1", 4.0, 0.6, 30),
        row(module, "d2", "C", "EC", "Astrocyte", "ENSG1", 2.0, 0.5, 7),
    ]
    out = module.merge(rows, rule="cell_weighted")
    support = out.support[("EC", "Astrocyte", "ENSG1")]
    assert support.datasets == 2
    assert support.donors == 3
    assert support.cells == 47


def test_region_level_values_follow_the_same_rule_as_the_frontend():
    module = load_module()
    # EC 区两个类型：Astrocyte(均值 1.9，30 细胞) 与 Microglia(均值 0.4，10 细胞)
    rows = [
        row(module, "d1", "A", "EC", "Astrocyte", "ENSG1", 1.9, 0.81, 30),
        row(module, "d1", "A", "EC", "Microglia", "ENSG1", 0.4, 0.10, 10),
    ]
    weighted = module.merge(rows, rule="cell_weighted")
    # 细胞加权：(1.9*30 + 0.4*10) / 40 = 1.525 —— 必须与前端子集重算一致
    assert round(weighted.regions[("EC", "ENSG1")], 6) == 1.525

    balanced = module.merge(rows, rule="donor_balanced")
    # 等权：(1.9 + 0.4) / 2 = 1.15
    assert round(balanced.regions[("EC", "ENSG1")], 6) == 1.15


def test_unknown_rule_is_rejected():
    module = load_module()
    try:
        module.merge(two_donor_rows(module), rule="whatever")
    except ValueError:
        return
    raise AssertionError("unknown rule must raise ValueError")
