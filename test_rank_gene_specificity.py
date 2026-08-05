"""Task 16 的契约测试：按数据特异性给基因排名，与生物学先验合并成精选清单。

覆盖率不能当筛选指标（已实测）：区域级覆盖对几乎所有基因都是 150-163 区，
而细胞类型覆盖与特异性 Spearman rho = -0.675 —— 覆盖率最高的 APP/FUS 特异性
只有 1.2x（31 类表达几乎一样，明细面板等于没信息），覆盖率低的 CX3CR1/FOXJ1
反而是 300x 的清晰标记。所以主指标是特异性，覆盖率只作下限门槛。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


def load_module():
    name = "rank_gene_specificity"
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HERE / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def row(module, region, cell_type, gene, mean, n_cells, donor="d1", dataset="ds1"):
    stage_b = module.stage_b
    return stage_b.CacheRow(
        dataset=dataset,
        donor=donor,
        region=region,
        cell_type=cell_type,
        gene=gene,
        mean=mean,
        detection=min(1.0, mean / 4.0),
        n_cells=n_cells,
    )


@pytest.fixture
def fixture_rows(request):
    """三个基因，特异性依次递减：

    MARKER   只在 Microglia 高（10.0），其余类近零        -> 特异性极高
    BROAD    31 类全在 2.0 左右                            -> 特异性 ~1
    SPARSE   只有一个 (region, cellType) 组合有数据        -> 应被覆盖门槛淘汰
    """
    module = load_module()
    regions = [f"R{i}" for i in range(10)]
    types = ["Microglia", "Astrocyte", "Oligodendrocyte", "Vascular"]
    rows = []
    for region in regions:
        for cell_type in types:
            rows.append(
                row(module, region, cell_type, "MARKER",
                    10.0 if cell_type == "Microglia" else 0.02, 100)
            )
            rows.append(row(module, region, cell_type, "BROAD", 2.0, 100))
    rows.append(row(module, "R0", "Astrocyte", "SPARSE", 5.0, 100))
    return module, rows


def test_specificity_is_the_peak_class_over_the_median_class(fixture_rows):
    module, rows = fixture_rows
    scored = module.score_genes(rows)

    marker = scored["MARKER"]
    assert marker.peak_cell_type == "Microglia"
    assert marker.peak_value == pytest.approx(10.0)
    # 4 类的中位表达 = median(10.0, 0.02, 0.02, 0.02) = 0.02
    assert marker.specificity > 100

    broad = scored["BROAD"]
    # 每类都是 2.0，峰值 / 中位 = 1
    assert broad.specificity == pytest.approx(1.0, abs=0.01)


def test_coverage_is_reported_but_not_used_for_ranking(fixture_rows):
    module, rows = fixture_rows
    scored = module.score_genes(rows)

    # BROAD 覆盖满（40 组合），MARKER 同样满 —— 覆盖率区分不出两者，
    # 而它们的解读价值差两个数量级。
    assert scored["BROAD"].combos == scored["MARKER"].combos
    assert scored["SPARSE"].combos == 1


def test_a_gene_measured_in_too_few_combinations_is_dropped(fixture_rows):
    module, rows = fixture_rows
    scored = module.score_genes(rows)
    picked = module.select_by_cell_type(scored, per_type=2, min_combos=5)
    # SPARSE 的明细面板几乎全是 No data，不值 357 KB。
    assert "SPARSE" not in picked


def test_selection_gives_every_cell_type_its_own_quota(fixture_rows):
    module, rows = fixture_rows
    # 让 Astrocyte 也有一个专属标记，验证配额是按类分配而非全局排序。
    rows = rows + [
        row(module, f"R{i}", cell_type, "ASTRO_MARKER",
            8.0 if cell_type == "Astrocyte" else 0.01, 100)
        for i in range(10)
        for cell_type in ("Microglia", "Astrocyte", "Oligodendrocyte", "Vascular")
    ]
    scored = module.score_genes(rows)
    picked = module.select_by_cell_type(scored, per_type=1, min_combos=5)

    # 全局排序会让 MARKER(1000x) 挤掉 ASTRO_MARKER(800x)；按类配额则两者都在，
    # 因为它们的峰值分属不同细胞类型。31 类各有代表才是明细面板的价值所在。
    assert "MARKER" in picked
    assert "ASTRO_MARKER" in picked


def test_prior_genes_survive_even_with_low_specificity(fixture_rows):
    module, rows = fixture_rows
    scored = module.score_genes(rows)
    # BROAD 特异性 1.0，纯数据驱动绝不会选它；但若它是 APP 这类高频查询的
    # 疾病基因，读者仍然期待能看到明细。
    merged = module.merge_with_prior(
        module.select_by_cell_type(scored, per_type=1, min_combos=5),
        prior=["BROAD", "NOT_IN_DATA"],
        known=set(scored),
    )
    assert "BROAD" in merged
    # 先验里写错或本次导出无数据的符号不该进清单，否则前端会拿到 404。
    assert "NOT_IN_DATA" not in merged


def test_a_class_with_no_data_does_not_count_as_zero(fixture_rows):
    module, rows = fixture_rows
    scored = module.score_genes(rows)
    # 只有 4 类有数据，不能把另外 27 类当 0 参与中位数计算 ——
    # 那会把每个基因的特异性都虚高成「峰值 / 0」。
    assert scored["MARKER"].n_cell_types == 4
    assert scored["BROAD"].n_cell_types == 4


def test_shipped_prior_list_holds_only_real_hgnc_symbols():
    """先验里的错字会默默消失（被 merge_with_prior 丢掉），永远拿不到明细。"""
    module = load_module()
    prior = module.read_symbol_list(module.DEFAULT_PRIOR_LIST)
    coding = set(module.export.protein_coding_symbols())

    assert 100 < len(prior) < 400, f"prior list has {len(prior)} symbols"
    unknown = [symbol for symbol in prior if symbol not in coding]
    assert unknown == [], f"not HGNC protein-coding symbols: {unknown}"
    # 高频查询的疾病基因必須在列，它们的特异性只有 1.2x，纯数据驱动选不上。
    for symbol in ("APP", "MAPT", "APOE", "HTT", "FUS"):
        assert symbol in prior


def test_peak_class_needs_enough_regions_to_be_believable():
    """实测到的缺陷：TH 的峰值类算出来是 Bergmann glia，而该类只在 2 个区
    有数据（最大值在红核 RN，典型的中脑多巴胺 ambient RNA 渗漏）。两个值的
    中位数没有统计意义，不能拿它去占一个细胞类型的配额。
    """
    module = load_module()
    rows = []
    # NOISY 类：只有 2 个区，但值极高
    for region in ("R0", "R1"):
        rows.append(row(module, region, "Bergmann glia", "G", 9.0, 100))
    # 真实类：40 个区，值中等
    for i in range(40):
        rows.append(row(module, f"S{i}", "Microglia", "G", 3.0, 100))
    for i in range(40):
        rows.append(row(module, f"S{i}", "Astrocyte", "G", 0.05, 100))

    scored = module.score_genes(rows, min_regions_for_peak=20)
    assert scored["G"].peak_cell_type == "Microglia", (
        "a class seen in only 2 regions must not win the peak"
    )
    # 峰值类退让后，特异性要跟着用退让后的峰值重算，否则得分与标签不一致。
    assert scored["G"].peak_value == pytest.approx(3.0)


def test_peak_falls_back_only_when_a_qualifying_class_exists():
    """若没有任何类达到区数门槛，不能把基因丢成无峰值——退回原始峰值并如实标记。"""
    module = load_module()
    rows = [row(module, "R0", "Bergmann glia", "G", 9.0, 100)]
    scored = module.score_genes(rows, min_regions_for_peak=20)
    assert scored["G"].peak_cell_type == "Bergmann glia"
    assert scored["G"].peak_regions == 1


def test_cli_rekeying_preserves_every_field():
    """main() 把缓存主键换回 HGNC 符号时是手工重列字段的，漏掉了 peak_regions，
    于是诊断表整列写成 0 —— 而它恰好就是用来暴露「峰值类只覆盖 2 个区」的那一列。
    其他测试直接调 write_ranking，绕过了这段重建，所以查不出来。
    """
    module = load_module()
    original = module.GeneScore(
        symbol="ENSG00000168329",
        specificity=12.5,
        peak_cell_type="Microglia",
        peak_value=3.0,
        combos=2310,
        n_cell_types=31,
        n_regions=163,
        peak_regions=42,
    )
    renamed = module.rekey(original, "CX3CR1")

    assert renamed.symbol == "CX3CR1"
    assert renamed.peak_regions == 42, "peak_regions 丢了，诊断表这一列就整列为 0"
    for field in ("specificity", "peak_cell_type", "peak_value", "combos",
                  "n_cell_types", "n_regions"):
        assert getattr(renamed, field) == getattr(original, field), field


def test_ranking_csv_puts_eligible_genes_first(tmp_path, fixture_rows):
    """诊断表按纯特异性排序会让 top 全是噪声：实测到前 15 名全为嗅觉
    受体(OR2F2/OR10H2/OR8K3)、毛发角蛋白(KRTAP12-4)、精子蛋白(SPACA5B)——
    脑内本不该表达，得分来自极低表达下的噪声（combos 仅 11-154）。
    门槛本就会把它们排除出清单，但人工审阅 CSV 时依旧会被带偏。
    """
    module, rows = fixture_rows
    scored = module.score_genes(rows)
    out = tmp_path / "ranking.csv"
    module.write_ranking(out, scored, min_combos=5)

    import csv

    records = list(csv.DictReader(out.open(encoding="utf-8")))
    assert "eligible" in records[0], "the CSV must say which rows passed the threshold"
    assert "peak_regions" in records[0], "peak_regions is what exposes a 2-region peak"
    # SPARSE 特异性最高（只一个组合），但不合格，必须排在合格行之后。
    eligible_flags = [record["eligible"] for record in records]
    assert eligible_flags == sorted(eligible_flags, reverse=True), (
        f"eligible rows must come first, got {eligible_flags}"
    )
    assert records[-1]["symbol"] == "SPARSE"
